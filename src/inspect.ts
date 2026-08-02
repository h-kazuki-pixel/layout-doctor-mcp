import { readFileSync } from "node:fs";
import type { CheckId, CheckReport, Finding, GeometryRaw } from "./types.js";
import { BrowserSession, type PageSource, type RenderOptions } from "./browser.js";
import { baseDirOf, runStaticChecks } from "./checks/static.js";
import { collectGeometry, type GeometryOptions } from "./checks/geometry.js";
import { DEFAULT_CHECKS, MAX_FINDINGS, MIN_OVERLAP_AREA, MIN_OVERLAP_PX } from "./constants.js";

export interface InspectOptions {
  source: PageSource;
  viewport: { width: number; height: number };
  checks?: CheckId[];
  minOverlapPx?: number;
  minOverlapArea?: number;
  allowNetwork?: boolean;
  executablePath?: string;
  settleMs?: number;
}

/** Stage 0 のみで完結する検査(ブラウザを立ち上げる必要がない) */
const STATIC_ONLY: CheckId[] = [
  "placeholder-left",
  "draft-text-left",
  "broken-reference",
  "duplicate-id",
];

export async function inspect(opt: InspectOptions, session?: BrowserSession): Promise<CheckReport> {
  const started = Date.now();
  const checks = opt.checks?.length ? opt.checks : DEFAULT_CHECKS;
  const notes: string[] = [];
  const raw: Array<Omit<Finding, "id">> = [];

  // ---------- Stage 0: 静的検査 ----------
  const needStatic = checks.some((c) => STATIC_ONLY.includes(c));
  if (needStatic) {
    let html: string;
    let baseDir: string | undefined;
    if (opt.source.kind === "html") {
      html = opt.source.value;
    } else if (opt.source.kind === "path") {
      html = readFileSync(opt.source.value, "utf8");
      baseDir = baseDirOf(opt.source.value);
    } else {
      html = "";
      notes.push("URL指定のため、静的検査はレンダリング後のHTMLに対して実施します。");
    }
    if (html) {
      const s = runStaticChecks({ html, baseDir, checks });
      raw.push(...s.findings);
      notes.push(...s.notes);
    }
  }

  // ---------- Stage 1: 幾何解析 ----------
  const geoChecks = checks.filter((c) => !STATIC_ONLY.includes(c));
  let stats: GeometryRaw["stats"] | undefined;

  if (geoChecks.length > 0 || opt.source.kind === "url") {
    const owned = !session;
    const sess = session ?? new BrowserSession();
    const render: RenderOptions = {
      viewport: opt.viewport,
      allowNetwork: opt.allowNetwork ?? false,
      executablePath: opt.executablePath ?? process.env.LAYOUT_DOCTOR_CHROMIUM,
      settleMs: opt.settleMs ?? 0,
    };
    let page;
    try {
      page = await sess.openPage(opt.source, render);

      // URL指定のときは、実際に描画されたHTMLに対して静的検査をかける
      if (opt.source.kind === "url" && needStatic) {
        const html = await page.content();
        const s = runStaticChecks({ html, checks });
        raw.push(...s.findings);
        notes.push(...s.notes);
      }

      if (geoChecks.length > 0) {
        const geoOpt: GeometryOptions = {
          checks: geoChecks,
          minOverlapPx: opt.minOverlapPx ?? MIN_OVERLAP_PX,
          minOverlapArea: opt.minOverlapArea ?? MIN_OVERLAP_AREA,
          viewportWidth: opt.viewport.width,
          viewportHeight: opt.viewport.height,
          maxFindings: MAX_FINDINGS,
        };
        const result = (await page.evaluate(collectGeometry, geoOpt)) as GeometryRaw;
        raw.push(
          ...result.findings.map((f) => ({
            check: f.check,
            severity: f.severity,
            verdict: "candidate" as const,
            elements: f.elements,
            evidence: f.evidence,
            ...(f.suggest ? { suggest: f.suggest } : {}),
          }))
        );
        stats = result.stats;
      }
    } finally {
      if (page) await page.context().close();
      if (owned) await sess.close();
    }
  }

  // ---------- 集計 ----------
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  raw.sort((a, b) => order[a.severity] - order[b.severity]);

  const counters = new Map<CheckId, number>();
  const findings: Finding[] = raw.slice(0, MAX_FINDINGS).map((f) => {
    const n = (counters.get(f.check) ?? 0) + 1;
    counters.set(f.check, n);
    return { id: `${f.check}-${String(n).padStart(3, "0")}`, ...f };
  });

  if (raw.length > MAX_FINDINGS) {
    notes.push(`所見が ${raw.length} 件見つかりましたが、上位 ${MAX_FINDINGS} 件のみ返しています。`);
  }
  if (stats) {
    notes.push(
      `計測: 要素 ${stats.elementCount} 個 / テキスト矩形 ${stats.textRectCount} 個 ` +
        `(抽出 ${stats.extractMs}ms・判定 ${stats.compareMs}ms)`
    );
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;

  return {
    summary: {
      pass: errors === 0,
      errors,
      warnings,
      infos,
      checksRun: checks,
      durationMs: Date.now() - started,
      viewport: opt.viewport,
    },
    findings,
    notes,
  };
}

/** 人が読む前提の要約テキスト */
export function formatReport(report: CheckReport): string {
  const { summary, findings, notes } = report;
  const lines: string[] = [];
  const head = summary.pass
    ? `検査完了: エラーなし(警告 ${summary.warnings} 件 / 情報 ${summary.infos} 件)`
    : `検査完了: エラー ${summary.errors} 件 / 警告 ${summary.warnings} 件 / 情報 ${summary.infos} 件`;
  lines.push(head);
  lines.push(`ビューポート ${summary.viewport.width}×${summary.viewport.height} / 所要 ${summary.durationMs}ms`);

  if (findings.length === 0) {
    lines.push("");
    lines.push("レイアウトの破綻は見つかりませんでした。");
  } else {
    lines.push("");
    const mark: Record<string, string> = { error: "[エラー]", warning: "[警告]", info: "[情報]" };
    for (const f of findings) {
      lines.push(`${mark[f.severity]} ${f.id}`);
      lines.push(`  ${f.evidence}`);
      for (const el of f.elements) {
        const pos = el.rect ? ` (${el.rect.x}, ${el.rect.y}) ${el.rect.w}×${el.rect.h}px` : "";
        lines.push(`  → ${el.selector}${pos}`);
      }
      if (f.suggest) lines.push(`  対処: ${f.suggest}`);
      lines.push("");
    }
  }

  if (notes.length) {
    lines.push("補足:");
    for (const n of notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}
