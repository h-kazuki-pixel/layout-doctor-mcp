import type { CheckId } from "./types.js";

/** 既定で実行する検査。element-collision(G5)は偽陽性が読めないため既定では走らせない */
export const DEFAULT_CHECKS: CheckId[] = [
  "placeholder-left",
  "draft-text-left",
  "broken-reference",
  "duplicate-id",
  "viewport-overflow",
  "horizontal-scroll",
  "container-overflow",
  "content-clipped",
  "text-overlap",
  "invisible-text",
];

export const ALL_CHECKS: CheckId[] = [...DEFAULT_CHECKS, "element-collision"];

/**
 * 重なり・はみ出しの最小サイズ。
 * これ未満は「数ピクセルのずれ」として無視する。
 * 由来: Althomali らの評価で、人間には知覚できない2px程度の差が
 * 誤分類の主因になっていたため。
 */
export const MIN_OVERLAP_PX = 3;
export const MIN_OVERLAP_AREA = 24;

/** レンダリング完了とみなすまでの最大待ち時間(ミリ秒) */
export const RENDER_TIMEOUT_MS = 15_000;

/** 応答が長くなりすぎないよう、返す所見の上限 */
export const MAX_FINDINGS = 100;

/** プレースホルダとみなす文字列(S1: 出たら error) */
export const PLACEHOLDER_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "undefined", re: /\bundefined\b/ },
  { label: "null", re: /(^|[\s>(\[,:])null([\s<),\].]|$)/ },
  { label: "NaN", re: /\bNaN\b/ },
  { label: "[object Object]", re: /\[object [A-Z]\w*\]/ },
  { label: "未展開のテンプレート {{...}}", re: /\{\{[^}]{1,80}\}\}/ },
  { label: "未展開のテンプレート ${...}", re: /\$\{[^}]{1,80}\}/ },
  { label: "未展開のテンプレート <%= %>", re: /<%=?[^%]{1,80}%>/ },
];

/** 仮テキストとみなす文字列(S1b: 出たら warning) */
export const DRAFT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "Lorem ipsum", re: /\blorem ipsum\b/i },
  { label: "TODO", re: /\bTODO\b/ },
  { label: "FIXME", re: /\bFIXME\b/ },
  { label: "ダミーテキスト", re: /ダミーテキスト/ },
  { label: "サンプルテキスト", re: /サンプルテキスト/ },
  { label: "ここに〜を入れる", re: /ここに[^。\n]{0,20}を(入力|入れて|記入)/ },
];
