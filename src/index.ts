#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatReport, inspect } from "./inspect.js";
import { DEFAULT_CHECKS, MIN_OVERLAP_AREA, MIN_OVERLAP_PX } from "./constants.js";
import type { CheckId, PageSourceKind } from "./types.js";

const VERSION = "0.1.0";

const CheckEnum = z.enum([
  "placeholder-left",
  "draft-text-left",
  "broken-reference",
  "duplicate-id",
  "viewport-overflow",
  "horizontal-scroll",
  "container-overflow",
  "content-clipped",
  "text-overlap",
  "element-collision",
  "invisible-text",
]);

const InputSchema = z
  .object({
    html: z.string().min(1).optional().describe("検査するHTML文字列"),
    path: z.string().min(1).optional().describe("検査するHTMLファイルの絶対パス"),
    url: z.string().url().optional().describe("検査するページのURL(既定では localhost のみ)"),
    viewport: z
      .object({
        width: z.number().int().min(200).max(4000),
        height: z.number().int().min(200).max(4000),
      })
      .describe("ビューポート(CSSピクセル)。スライドは1280x720、Webは1280x800が目安"),
    checks: z.array(CheckEnum).optional().describe("実行する検査。省略時は element-collision 以外"),
    minOverlapPx: z.number().int().min(0).max(100).optional().describe(`重なりの最小幅(既定${MIN_OVERLAP_PX})`),
    minOverlapArea: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe(`重なりの最小面積px2(既定${MIN_OVERLAP_AREA})`),
    allowNetwork: z.boolean().optional().describe("外部通信を許可する(既定false)"),
    executablePath: z.string().optional().describe("使用するChromiumのパス"),
    settleMs: z.number().int().min(0).max(5000).optional().describe("描画後の追加待機ms"),
    format: z.enum(["text", "json"]).optional().describe("出力形式(既定text)"),
  })
  .strict();

type InputType = z.infer<typeof InputSchema>;

const DESCRIPTION = `HTMLをレンダリングしてレイアウトの破綻を検出する。検査専用でファイルは変更しない。

比較用のベースライン画像は不要。DOMの座標と文字の描画矩形を実測するため、
「どの要素が何ピクセルはみ出しているか」が数値で返る。

検出: 文字の重なり / 画面外や親からのはみ出し / overflow:hidden による切り捨て /
横スクロールの発生 / undefined・{{name}} 等の未展開 / 参照切れ / id重複 / 不可視テキスト

引数:
  - html | path | url のいずれか1つ(必須)
  - viewport (必須): { width, height }。幅で結果が変わるため既定値なし
  - checks (任意): 検査の絞り込み。既定は element-collision 以外すべて
  - format (任意): "text"(既定)または "json"
  その他: minOverlapPx, minOverlapArea, allowNetwork, executablePath, settleMs

戻り値: summary(pass, errors, warnings, infos)と findings の配列。
各所見は check / severity / verdict / elements(selector, text, rect)/ evidence / suggest を持つ。
verdict は "static"(確定)か "candidate"(座標上は検出、可視性は未判定)。

対象外: デザインの評価、コントラスト比などのアクセシビリティ検査、前回との差分比較。`;

const server = new McpServer({ name: "layout-doctor-mcp", version: VERSION });

server.registerTool(
  "layout_check",
  {
    title: "レイアウト破綻の検査",
    description: DESCRIPTION,
    inputSchema: InputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: InputType) => {
    const given = (["html", "path", "url"] as const).filter((k) => params[k] !== undefined);
    if (given.length === 0) {
      return errorResult(
        "検査対象が指定されていません。html(HTML文字列)・path(ファイルの絶対パス)・url のいずれか1つを指定してください。"
      );
    }
    if (given.length > 1) {
      return errorResult(
        `検査対象が複数指定されています(${given.join(", ")})。1つだけ指定してください。` +
          "ファイルを検査するなら path、生成したばかりのHTMLなら html を使います。"
      );
    }

    const kind = given[0] as PageSourceKind;
    const value = params[kind] as string;

    try {
      const report = await inspect({
        source: { kind, value },
        viewport: params.viewport,
        checks: params.checks as CheckId[] | undefined,
        minOverlapPx: params.minOverlapPx,
        minOverlapArea: params.minOverlapArea,
        allowNetwork: params.allowNetwork,
        executablePath: params.executablePath,
        settleMs: params.settleMs,
      });

      const text = params.format === "json" ? JSON.stringify(report, null, 2) : formatReport(report);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(msg);
    }
  }
);

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        `layout-doctor-mcp v${VERSION}`,
        "",
        "HTMLをレンダリングしてレイアウトの破綻を検出するMCPサーバーです。検査専用で、ファイルは変更しません。",
        "",
        "使い方: MCPクライアント(Claude Desktop など)の設定に次を追加します。",
        '  "layout-doctor": { "command": "npx", "args": ["-y", "layout-doctor-mcp"] }',
        "",
        "初回はChromiumの導入が必要です:  npx playwright install chromium",
        "既存のChromeを使う場合は環境変数 LAYOUT_DOCTOR_CHROMIUM にパスを指定してください。",
        "",
        `検査項目(既定): ${DEFAULT_CHECKS.join(", ")}`,
        `既定で無効: element-collision`,
        "",
      ].join("\n")
    );
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`layout-doctor-mcp v${VERSION} started\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`起動に失敗しました: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
