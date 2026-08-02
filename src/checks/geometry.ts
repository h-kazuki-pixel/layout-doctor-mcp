import type { CheckId, GeometryRaw } from "../types.js";

export interface GeometryOptions {
  checks: CheckId[];
  minOverlapPx: number;
  minOverlapArea: number;
  viewportWidth: number;
  viewportHeight: number;
  maxFindings: number;
}

/**
 * ブラウザ内で実行される幾何解析。
 *
 * 重要な制約:
 * - この関数はシリアライズされてブラウザへ送られるため、外部変数を参照できない。
 *   必要な値はすべて引数 `opt` で受け取ること。
 * - 戻り値は構造化クローン可能な値のみ(DOMノードを返さない)。
 * - 測定中にDOMを変更しない(レイアウトを動かすと結果が変わるため)。
 */
export function collectGeometry(opt: GeometryOptions): GeometryRaw {
  const t0 = performance.now();
  const OV = opt.minOverlapPx;
  const AREA = opt.minOverlapArea;
  const want = (id: string): boolean => opt.checks.indexOf(id as CheckId) !== -1;

  const findings: GeometryRaw["findings"] = [];
  const add = (f: GeometryRaw["findings"][number]): void => {
    if (findings.length < opt.maxFindings) findings.push(f);
  };

  // ---------- 共通ユーティリティ ----------

  /** 要素を一意に指すCSSセレクタを組み立てる */
  function selectorOf(el: Element): string {
    if (el === document.body) return "body";
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 6) {
      let part = cur.tagName.toLowerCase();
      const id = cur.getAttribute("id");
      if (id && /^[A-Za-z][\w-]*$/.test(id)) {
        parts.unshift(`#${id}`);
        return parts.join(" > ");
      }
      const cls = (cur.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((c) => c && /^[A-Za-z][\w-]*$/.test(c))
        .slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.tagName === (cur as Element).tagName
        ) as Element[];
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function rectOf(r: DOMRect): { x: number; y: number; w: number; h: number } {
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  const trim = (s: string, n: number): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };

  /** 描画されていない要素(display:none / visibility:hidden / 面積ゼロ)を除く */
  function isRendered(cs: CSSStyleDeclaration, r: DOMRect): boolean {
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (r.width <= 0 || r.height <= 0) return false;
    return true;
  }

  /**
   * スクリーンリーダー専用テキストの慣用パターン。
   * 視覚的に隠す意図的な手法なので、不可視テキストとして報告しない。
   */
  function isScreenReaderOnly(cs: CSSStyleDeclaration, r: DOMRect): boolean {
    if (r.width <= 1 && r.height <= 1) return true;
    if (cs.clipPath && cs.clipPath !== "none") return true;
    if (cs.clip && cs.clip !== "auto") return true;
    const left = parseFloat(cs.left);
    if (!isNaN(left) && left < -999) return true;
    const ti = parseFloat(cs.textIndent);
    if (!isNaN(ti) && ti < -999) return true;
    return false;
  }

  /** 祖先方向にたどって、内容を切り取っている最初の要素を返す */
  function clippingAncestor(el: Element): { el: Element; overflow: string } | null {
    let cur: Element | null = el.parentElement;
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      if (ox === "hidden" || ox === "clip" || oy === "hidden" || oy === "clip") {
        return { el: cur, overflow: `${ox}/${oy}` };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 祖先のクリップ領域すべてで切り取ったあとの、実際に見えている矩形を返す。
   * overflow:hidden の外へ出た文字は画面に現れないため、重なり判定から除く必要がある。
   * 完全に切り取られている場合は null。
   */
  function visibleRect(
    el: Element,
    r: { x: number; y: number; w: number; h: number }
  ): { x: number; y: number; w: number; h: number } | null {
    let left = r.x;
    let top = r.y;
    let right = r.x + r.w;
    let bottom = r.y + r.h;
    // 要素自身の overflow も内容を切り取るため、自分から辿り始める
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < 30) {
      const cs = getComputedStyle(cur);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const cr = cur.getBoundingClientRect();
        if (cs.overflowX !== "visible") {
          left = Math.max(left, cr.left);
          right = Math.min(right, cr.right);
        }
        if (cs.overflowY !== "visible") {
          top = Math.max(top, cr.top);
          bottom = Math.min(bottom, cr.bottom);
        }
        if (right - left <= 0 || bottom - top <= 0) return null;
      }
      cur = cur.parentElement;
      depth++;
    }
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /** 背景が透けない要素か(衝突が視認されうるか)の粗い判定 */
  function hasVisibleSurface(cs: CSSStyleDeclaration): boolean {
    const bg = cs.backgroundColor;
    const opaque = bg !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg);
    const hasImage = cs.backgroundImage !== "none";
    const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth);
    return opaque || hasImage || (!isNaN(bw) && bw > 0);
  }

  // ---------- 要素の一括収集(レイアウト読み取りは1周で済ませる) ----------

  interface ElInfo {
    el: Element;
    cs: CSSStyleDeclaration;
    r: DOMRect;
  }
  const infos: ElInfo[] = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "META" || tag === "LINK" || tag === "HEAD") continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!isRendered(cs, r)) continue;
    infos.push({ el, cs, r });
  }

  const docEl = document.documentElement;
  const vw = opt.viewportWidth;

  // ---------- G1b: 水平スクロールの発生 ----------
  // 空白領域へのはみ出しは画像比較では捉えられない。文書幅の比較なら確実に分かる。
  if (want("horizontal-scroll")) {
    const over = docEl.scrollWidth - vw;
    if (over > OV) {
      let widest: ElInfo | null = null;
      for (const info of infos) {
        const right = info.r.right;
        if (right > vw + OV && (!widest || right > widest.r.right)) widest = info;
      }
      add({
        check: "horizontal-scroll",
        severity: "error",
        elements: widest
          ? [{ selector: selectorOf(widest.el), text: trim(widest.el.textContent ?? "", 30), rect: rectOf(widest.r) }]
          : [{ selector: "body" }],
        evidence:
          `文書の幅がビューポートを ${over}px 超えています` +
          `(文書 ${docEl.scrollWidth}px / ビューポート ${vw}px)。横スクロールが発生します。` +
          (widest ? ` 最も右に出ている要素の右端は ${Math.round(widest.r.right)}px です。` : ""),
        suggest:
          "はみ出している要素の width / margin / padding を見直すか、" +
          "画像や表に max-width:100% を指定してください。",
      });
    }
  }

  // ---------- G3: 内容の切り捨て ----------
  // overflow:hidden で隠れた内容は、レンダリング結果を見ても分からない。
  if (want("content-clipped")) {
    for (const { el, cs, r } of infos) {
      const overX = el.scrollWidth - el.clientWidth;
      const overY = el.scrollHeight - el.clientHeight;
      if (overX <= OV && overY <= OV) continue;
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      const clippedX = overX > OV && (ox === "hidden" || ox === "clip");
      const clippedY = overY > OV && (oy === "hidden" || oy === "clip");
      if (!clippedX && !clippedY) continue;

      // 1行省略の ellipsis は意図的な表現なので格下げする
      const isEllipsis = cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";
      const dirs: string[] = [];
      if (clippedX) dirs.push(`横に ${overX}px`);
      if (clippedY) dirs.push(`縦に ${overY}px`);
      add({
        check: "content-clipped",
        severity: isEllipsis ? "info" : "error",
        elements: [{ selector: selectorOf(el), text: trim(el.textContent ?? "", 40), rect: rectOf(r) }],
        evidence:
          `内容が ${dirs.join("・")} はみ出しており、overflow:${clippedX ? ox : oy} で切り取られています` +
          `(内容 ${el.scrollWidth}×${el.scrollHeight}px / 表示領域 ${el.clientWidth}×${el.clientHeight}px)。` +
          (isEllipsis ? " text-overflow:ellipsis が指定されているため、意図的な省略の可能性があります。" : ""),
        suggest: isEllipsis
          ? undefined
          : "コンテナの高さ・幅を広げるか、overflow を auto にしてスクロールできるようにしてください。",
      });
    }
  }

  // ---------- G1a: ビューポート外へのはみ出し ----------
  if (want("viewport-overflow")) {
    for (const { el, cs, r } of infos) {
      if (el === document.body || el === docEl) continue;
      if (cs.position === "fixed") continue; // 固定要素は意図的に画面外へ置かれることがある
      const outRight = r.right - vw;
      const outLeft = -r.left;
      if (outRight <= OV && outLeft <= OV) continue;
      // 祖先が切り取っている場合は G3 の担当なので二重報告しない
      if (clippingAncestor(el)) continue;
      // 子要素が同じはみ出しを持つ場合、親だけを報告して重複を避ける
      const parent = el.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        if (pr.right - vw > OV && Math.abs(pr.right - r.right) < 1) continue;
      }
      const side = outRight > outLeft ? "右" : "左";
      const amount = Math.round(Math.max(outRight, outLeft));
      add({
        check: "viewport-overflow",
        severity: "error",
        elements: [{ selector: selectorOf(el), text: trim(el.textContent ?? "", 40), rect: rectOf(r) }],
        evidence: `要素がビューポートの${side}端から ${amount}px はみ出しています(要素 ${Math.round(r.left)}〜${Math.round(r.right)}px / ビューポート 0〜${vw}px)。`,
        suggest: "幅指定・絶対配置の位置・負のマージンを確認してください。",
      });
    }
  }

  // ---------- G2: 親コンテナからのはみ出し ----------
  if (want("container-overflow")) {
    for (const { el, r } of infos) {
      const parent = el.parentElement;
      if (!parent || parent === document.body || parent === docEl) continue;
      const pcs = getComputedStyle(parent);
      // 親が切り取る設定なら G3 の担当
      if (["hidden", "clip", "auto", "scroll"].indexOf(pcs.overflowX) !== -1) continue;
      if (["hidden", "clip", "auto", "scroll"].indexOf(pcs.overflowY) !== -1) continue;
      // 絶対配置は親の外に出す意図があることが多い
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" || cs.position === "fixed") continue;
      const pr = parent.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) continue;

      const outR = r.right - pr.right;
      const outL = pr.left - r.left;
      const outB = r.bottom - pr.bottom;
      const worst = Math.max(outR, outL, outB);
      if (worst <= OV) continue;
      const dir = worst === outR ? "右" : worst === outL ? "左" : "下";
      add({
        check: "container-overflow",
        severity: "warning",
        elements: [
          { selector: selectorOf(el), text: trim(el.textContent ?? "", 30), rect: rectOf(r) },
          { selector: selectorOf(parent), rect: rectOf(pr) },
        ],
        evidence: `子要素が親コンテナの${dir}側に ${Math.round(worst)}px はみ出しています。`,
        suggest: "親の幅・高さが内容に対して不足しています。min-width の指定や、折り返しの設定を確認してください。",
      });
    }
  }

  // ---------- G6: 不可視テキスト ----------
  // この検査だけは面積ゼロの要素も対象にする(font-size:0 は高さがゼロになるため、
  // 描画済み要素のフィルタを通すと検出できない)。
  if (want("invisible-text")) {
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "META" || tag === "LINK" || tag === "HEAD") continue;
      const own = Array.prototype.filter
        .call(el.childNodes, (n: Node) => n.nodeType === 3 && (n.textContent ?? "").trim())
        .map((n: Node) => n.textContent ?? "")
        .join("");
      if (!own.trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (isScreenReaderOnly(cs, r)) continue;
      const fs = parseFloat(cs.fontSize);
      if (!isNaN(fs) && fs < 1) {
        add({
          check: "invisible-text",
          severity: "warning",
          elements: [{ selector: selectorOf(el), text: trim(own, 30), rect: rectOf(r) }],
          evidence: `font-size が ${cs.fontSize} のためテキストが表示されません。`,
          suggest: "font-size を読める大きさに戻すか、要素自体を削除してください。",
        });
        continue;
      }
      if (r.width <= 0 || r.height <= 0) continue;
      if (cs.backgroundImage === "none" && cs.color === cs.backgroundColor) {
        add({
          check: "invisible-text",
          severity: "warning",
          elements: [{ selector: selectorOf(el), text: trim(own, 30), rect: rectOf(r) }],
          evidence: `文字色と背景色がどちらも ${cs.color} で完全に一致しており、テキストが読めません。`,
          suggest: "文字色または背景色を変更してください。",
        });
      }
    }
  }

  // ---------- テキスト矩形の抽出(G4用) ----------
  const wantOverlap = want("text-overlap");
  const wantCollision = want("element-collision");

  interface TextRect {
    x: number;
    y: number;
    w: number;
    h: number;
    block: number;
    el: Element;
    text: string;
  }
  const textRects: TextRect[] = [];

  if (wantOverlap) {
    // ブロック整形コンテキストの判定。
    // inline-block 系を含めないと、横に並んだカード同士の重なりを見逃す。
    const BLOCKISH = [
      "block",
      "flex",
      "grid",
      "list-item",
      "table",
      "table-cell",
      "table-row",
      "table-caption",
      "flow-root",
      "inline-block",
      "inline-flex",
      "inline-grid",
      "inline-table",
    ];
    const blockCache = new Map<Element, Element>();
    const blockIds = new Map<Element, number>();
    let nextBlockId = 0;

    function blockOf(el: Element | null): Element {
      if (!el) return document.body;
      const cached = blockCache.get(el);
      if (cached) return cached;
      let cur: Element | null = el;
      while (cur && cur !== document.body) {
        if (BLOCKISH.indexOf(getComputedStyle(cur).display) !== -1) {
          blockCache.set(el, cur);
          return cur;
        }
        cur = cur.parentElement;
      }
      blockCache.set(el, document.body);
      return document.body;
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n: Node) =>
        (n.textContent ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TITLE") continue;
      const pcs = getComputedStyle(parent);
      if (pcs.display === "none" || pcs.visibility === "hidden") continue;
      if (isScreenReaderOnly(pcs, parent.getBoundingClientRect())) continue;

      const blk = blockOf(parent);
      let bid = blockIds.get(blk);
      if (bid === undefined) {
        bid = nextBlockId++;
        blockIds.set(blk, bid);
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width <= 0 || r.height <= 0) continue;
        // 祖先の overflow で切り取られた部分は画面に出ないので、見えている範囲だけを使う
        const vis = visibleRect(parent, { x: r.left, y: r.top, w: r.width, h: r.height });
        if (!vis) continue;
        textRects.push({
          x: vis.x,
          y: vis.y,
          w: vis.w,
          h: vis.h,
          block: bid,
          el: parent,
          text: trim(node.textContent ?? "", 24),
        });
      }
    }
  }

  const tExtract = performance.now();

  // ---------- 交差判定(y座標順に並べ、重なりうる範囲だけを見る) ----------
  function overlapArea(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ): number {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w < OV || h < OV) return 0;
    const area = w * h;
    return area >= AREA ? area : 0;
  }

  // ---------- G4: テキストの重なり ----------
  if (wantOverlap && textRects.length > 1) {
    const sorted = textRects.slice().sort((p, q) => p.y - q.y);
    const seen = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const aBottom = a.y + a.h;
      for (let j = i + 1; j < sorted.length && sorted[j].y < aBottom; j++) {
        const b = sorted[j];
        if (a.block === b.block) continue; // 同じ行内で隣り合う語は重なりではない
        if (a.el === b.el) continue;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const area = overlapArea(a, b);
        if (!area) continue;
        const sa = selectorOf(a.el);
        const sb = selectorOf(b.el);
        const key = sa < sb ? sa + "|" + sb : sb + "|" + sa;
        if (seen.has(key)) continue;
        seen.add(key);
        const ow = Math.round(Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oh = Math.round(Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        add({
          check: "text-overlap",
          severity: "error",
          elements: [
            { selector: sa, text: a.text, rect: { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) } },
            { selector: sb, text: b.text, rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } },
          ],
          evidence: `テキスト「${a.text}」と「${b.text}」が ${ow}×${oh}px(面積 ${Math.round(area)}px²)重なっており、文字が読めなくなります。`,
          suggest: "どちらかの位置・余白を調整するか、重ねる意図がある場合は背景を不透明にしてください。",
        });
      }
    }
  }

  // ---------- G5: 非テキスト要素の衝突(既定オフ) ----------
  if (wantCollision) {
    const boxes = infos.filter((info) => hasVisibleSurface(info.cs) && info.cs.position !== "fixed");
    const sorted = boxes.slice().sort((p, q) => p.r.top - q.r.top);
    const seen = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const aBottom = a.r.bottom;
      for (let j = i + 1; j < sorted.length && sorted[j].r.top < aBottom; j++) {
        const b = sorted[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const area = overlapArea(
          { x: a.r.left, y: a.r.top, w: a.r.width, h: a.r.height },
          { x: b.r.left, y: b.r.top, w: b.r.width, h: b.r.height }
        );
        if (!area) continue;
        const sa = selectorOf(a.el);
        const sb = selectorOf(b.el);
        const key = sa < sb ? sa + "|" + sb : sb + "|" + sa;
        if (seen.has(key)) continue;
        seen.add(key);
        add({
          check: "element-collision",
          severity: "warning",
          elements: [
            { selector: sa, rect: rectOf(a.r) },
            { selector: sb, rect: rectOf(b.r) },
          ],
          evidence: `2つの要素が面積 ${Math.round(area)}px² 重なっています。意図的な重ね置き(バッジ・オーバーレイ)の可能性もあります。`,
          suggest: "重なりが意図通りか確認してください。意図的な場合はこの検査を無効にできます。",
        });
      }
    }
  }

  const tCompare = performance.now();

  return {
    findings,
    stats: {
      elementCount: infos.length,
      textRectCount: textRects.length,
      extractMs: Math.round(tExtract - t0),
      compareMs: Math.round(tCompare - tExtract),
    },
  };
}
