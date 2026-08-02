import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckId, Finding, Severity } from "../types.js";
import { DRAFT_PATTERNS, PLACEHOLDER_PATTERNS } from "../constants.js";

export interface StaticInput {
  html: string;
  /** HTMLの出所。ファイル由来なら相対パスを解決できる */
  baseDir?: string;
  checks: CheckId[];
}

export interface StaticResult {
  findings: Omit<Finding, "id">[];
  notes: string[];
}

/** <script> <style> <pre> <code> の中身を空白へ置換する。テンプレート構文の解説文を誤検出しないため */
function stripNonProse(html: string): string {
  return html.replace(
    /<(script|style|pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (m) => " ".repeat(m.length)
  );
}

/** HTMLタグを取り除き、可視テキストに近い文字列を得る */
function visibleText(html: string): string {
  return stripNonProse(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
}

function attrValues(html: string): string {
  const out: string[] = [];
  const re = /\b(alt|title|placeholder|aria-label|value|content)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[2]);
  return out.join(" \u0001 ");
}

/** ローカル参照とみなせるパスか(外部URL・データURIは対象外) */
function isLocalRef(ref: string): boolean {
  if (!ref) return false;
  if (/^(https?:)?\/\//i.test(ref)) return false;
  if (/^(data|mailto|tel|javascript|blob):/i.test(ref)) return false;
  if (ref.startsWith("#")) return false;
  return true;
}

export function runStaticChecks(input: StaticInput): StaticResult {
  const findings: Omit<Finding, "id">[] = [];
  const notes: string[] = [];
  const want = (id: CheckId): boolean => input.checks.includes(id);
  const html = input.html;

  const push = (
    check: CheckId,
    severity: Severity,
    evidence: string,
    selector: string,
    suggest?: string,
    text?: string
  ): void => {
    findings.push({
      check,
      severity,
      verdict: "static",
      elements: [{ selector, ...(text ? { text } : {}) }],
      evidence,
      ...(suggest ? { suggest } : {}),
    });
  };

  // ---------- S1 / S1b: プレースホルダ・仮テキストの残留 ----------
  if (want("placeholder-left") || want("draft-text-left")) {
    const prose = visibleText(html);
    const attrs = attrValues(html);
    const haystacks: Array<{ label: string; body: string }> = [
      { label: "本文", body: prose },
      { label: "属性値", body: attrs },
    ];

    const scan = (
      patterns: typeof PLACEHOLDER_PATTERNS,
      check: CheckId,
      severity: Severity,
      suggest: string
    ): void => {
      if (!want(check)) return;
      for (const { label, re } of patterns) {
        for (const hay of haystacks) {
          const m = hay.body.match(re);
          if (!m) continue;
          const idx = m.index ?? 0;
          const around = hay.body.slice(Math.max(0, idx - 25), idx + m[0].length + 25).replace(/\s+/g, " ").trim();
          push(
            check,
            severity,
            `${hay.label}に ${label} が残っています。該当箇所: 「…${around}…」`,
            "html",
            suggest,
            m[0]
          );
          break; // 同じパターンは本文・属性で1件ずつに留める
        }
      }
    };

    scan(
      PLACEHOLDER_PATTERNS,
      "placeholder-left",
      "error",
      "変数の埋め込みが失敗しています。値が未定義でないか、テンプレートエンジンが適用されているかを確認してください。"
    );
    scan(
      DRAFT_PATTERNS,
      "draft-text-left",
      "warning",
      "公開前に実際の文言へ差し替えてください。"
    );
  }

  // ---------- S2: 参照切れ ----------
  if (want("broken-reference")) {
    if (!input.baseDir) {
      notes.push(
        "HTMLを文字列として受け取ったため、相対パスの参照切れは検査できません。path または url で渡すと検査されます。"
      );
    } else {
      const refs: Array<{ ref: string; where: string }> = [];
      const tagRe = /<(?:img|script|source|video|audio|iframe)\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi;
      const linkRe = /<link\b[^>]*?\bhref\s*=\s*"([^"]+)"/gi;
      const cssRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(html)) !== null) refs.push({ ref: m[1], where: "src属性" });
      while ((m = linkRe.exec(html)) !== null) refs.push({ ref: m[1], where: "link要素" });
      while ((m = cssRe.exec(html)) !== null) refs.push({ ref: m[1], where: "CSSのurl()" });

      const seen = new Set<string>();
      for (const { ref, where } of refs) {
        if (!isLocalRef(ref)) continue;
        const clean = ref.split(/[?#]/)[0];
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        const abs = isAbsolute(clean) ? clean : resolve(input.baseDir, clean);
        if (!existsSync(abs)) {
          push(
            "broken-reference",
            "error",
            `${where} の参照先 "${ref}" が見つかりません(探した場所: ${abs})。`,
            "html",
            "パスの綴りを確認するか、ファイルを配置してください。",
            ref
          );
        }
      }
    }
  }

  // ---------- S3: id重複 ----------
  if (want("duplicate-id")) {
    const counts = new Map<string, number>();
    const idRe = /\bid\s*=\s*"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(stripNonProse(html))) !== null) {
      const id = m[1].trim();
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      if (n > 1) {
        push(
          "duplicate-id",
          "warning",
          `id="${id}" が ${n} 箇所で使われています。アンカーリンクや label の参照先が意図しない要素になります。`,
          `#${id}`,
          "id は文書内で一意にしてください。共通のスタイルを当てたい場合は class を使います。",
          id
        );
      }
    }
  }

  return { findings, notes };
}

/** file:// URL またはパスから、相対パス解決用のディレクトリを得る */
export function baseDirOf(pathOrUrl: string): string | undefined {
  try {
    if (pathOrUrl.startsWith("file://")) return dirname(fileURLToPath(pathOrUrl));
    if (/^https?:\/\//i.test(pathOrUrl)) return undefined;
    return dirname(resolve(pathOrUrl));
  } catch {
    return undefined;
  }
}
