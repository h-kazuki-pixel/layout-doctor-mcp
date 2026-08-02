/** 所見の深刻度 */
export type Severity = "error" | "warning" | "info";

/**
 * 所見の可視性判定。
 * - static: レンダリング画像を見なくても確定する検査(Stage 0 / DOM のみで確定する Stage 1)
 * - candidate: 幾何的には検出したが、人間に見えるかは未判定(Stage 2 が v0.5 で判定する)
 */
export type Verdict = "static" | "candidate";

/** 検査ID。README・出力の双方で同じ文字列を使う */
export type CheckId =
  | "placeholder-left" // S1  プレースホルダ残留
  | "draft-text-left" // S1b 仮テキスト残留
  | "broken-reference" // S2  参照切れ
  | "duplicate-id" // S3  id重複
  | "viewport-overflow" // G1a ビューポート外はみ出し
  | "horizontal-scroll" // G1b 水平スクロール発生
  | "container-overflow" // G2  親からのはみ出し
  | "content-clipped" // G3  内容の切り捨て
  | "text-overlap" // G4  テキスト重なり
  | "element-collision" // G5  非テキスト要素の衝突(既定オフ)
  | "invisible-text"; // G6  不可視テキスト

/** 所見に関与した要素 */
export interface FindingElement {
  /** その要素を一意に指すCSSセレクタ */
  selector: string;
  /** 要素の抜粋テキスト(空の場合あり) */
  text?: string;
  /** 位置とサイズ(CSSピクセル、ビューポート左上基準) */
  rect?: Rect;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 1件の所見 */
export interface Finding {
  /** 連番つきID(例: "text-overlap-001") */
  id: string;
  check: CheckId;
  severity: Severity;
  verdict: Verdict;
  /** 関与要素。1件の場合と2件(重なり・はみ出し)の場合がある */
  elements: FindingElement[];
  /** 数値を含む、人間が読んで理解できる根拠 */
  evidence: string;
  /** 修正の手がかり。断定はせず候補を示す */
  suggest?: string;
}

export interface CheckSummary {
  pass: boolean;
  errors: number;
  warnings: number;
  infos: number;
  /** 実行した検査ID */
  checksRun: CheckId[];
  /** 計測にかかった時間(ミリ秒) */
  durationMs: number;
  /** 検査対象のビューポート */
  viewport: { width: number; height: number };
}

export interface CheckReport {
  summary: CheckSummary;
  findings: Finding[];
  /** 実行時に発生した非致命的な問題(例: 相対パスが解決できず参照切れ検査を格下げした) */
  notes: string[];
}

/** 検査対象の指定方法 */
export type PageSourceKind = "html" | "path" | "url";

/** ブラウザ内で収集した生データ(Stage 1) */
export interface GeometryRaw {
  findings: Array<{
    check: CheckId;
    severity: Severity;
    elements: FindingElement[];
    evidence: string;
    suggest?: string;
  }>;
  stats: {
    elementCount: number;
    textRectCount: number;
    extractMs: number;
    compareMs: number;
  };
}
