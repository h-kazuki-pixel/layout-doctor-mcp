import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../src/browser.js";
import { inspect } from "../src/inspect.js";
import type { CheckId, CheckReport } from "../src/types.js";

let session: BrowserSession;
const VIEWPORT = { width: 800, height: 600 };

before(async () => {
  session = new BrowserSession();
  await session.launch(process.env.LAYOUT_DOCTOR_CHROMIUM);
});

after(async () => {
  await session.close();
});

async function check(html: string, checks?: CheckId[]): Promise<CheckReport> {
  return inspect(
    { source: { kind: "html", value: html }, viewport: VIEWPORT, checks },
    session
  );
}

const doc = (body: string, style = ""): string =>
  `<!DOCTYPE html><html><head><style>body{margin:0;font-family:sans-serif}${style}</style></head><body>${body}</body></html>`;

const found = (r: CheckReport, c: CheckId) => r.findings.filter((f) => f.check === c);

// ---------- G4 テキストの重なり ----------

test("G4: 重なったテキストを検出する", async () => {
  const r = await check(
    doc(`<p style="position:absolute;left:20px;top:20px">基礎のテキスト行</p>
         <p style="position:absolute;left:30px;top:24px">重なるテキスト</p>`),
    ["text-overlap"]
  );
  const f = found(r, "text-overlap");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.match(f[0].evidence, /重なって/);
  assert.equal(f[0].elements.length, 2);
});

test("G4: 通常の文書では検出しない", async () => {
  const body = Array.from({ length: 30 }, (_, i) =>
    `<section><h2>見出し ${i}</h2><p>本文に <b>強調</b> と <a href="#">リンク</a> と <span>インライン</span> が混ざる段落。The quick brown fox jumps over the lazy dog. 日本語も混在して折り返す。</p><ul><li>A</li><li>B</li></ul></section>`
  ).join("");
  const r = await check(doc(body), ["text-overlap"]);
  assert.equal(found(r, "text-overlap").length, 0);
});

test("G4: 同じ行に並ぶ span を重なりとみなさない", async () => {
  const spans = Array.from({ length: 100 }, (_, i) => `<span>語${i}</span>`).join("");
  const r = await check(doc(`<p>${spans}</p>`), ["text-overlap"]);
  assert.equal(found(r, "text-overlap").length, 0);
});

test("G4: 隙間なく並ぶ2列を重なりとみなさない", async () => {
  const r = await check(
    doc(`<div style="display:flex;gap:0">
      <div style="flex:1">左列の文章が右端まで届く密着密着密着密着</div>
      <div style="flex:1">右列の文章が左端から始まる密着密着密着</div></div>`),
    ["text-overlap"]
  );
  assert.equal(found(r, "text-overlap").length, 0);
});

test("G4: inline-block 同士の重なりを見逃さない", async () => {
  const r = await check(
    doc(`<div style="display:inline-block;width:220px;vertical-align:top">左カードのテキストが右端まで届く長さの文章</div>
         <div style="display:inline-block;width:220px;vertical-align:top;margin-left:-160px">右カードのテキストが重なってくる文章</div>`),
    ["text-overlap"]
  );
  assert.ok(found(r, "text-overlap").length > 0, "inline-block の重なりが検出されること");
});

test("G4: スクリーンリーダー専用テキストは対象外", async () => {
  const r = await check(
    doc(`<p style="position:absolute;left:20px;top:20px">見えるテキスト</p>
         <span style="position:absolute;left:20px;top:20px;width:1px;height:1px;overflow:hidden">読み上げ専用</span>`),
    ["text-overlap"]
  );
  assert.equal(found(r, "text-overlap").length, 0);
});

test("G4: overflow:hidden で隠れたテキストは重なりとみなさない", async () => {
  // 実際のHTMLで見つかった偽陽性の回帰テスト。
  // 切り取られて画面に出ていない文字は、座標上は下の要素と重なっていても問題ではない。
  const r = await check(
    doc(`<div style="width:180px;height:22px;overflow:hidden">この注記は枠に収まりきらないので途中で切れて読めなくなります</div>
         <div style="width:400px;height:40px">次の行にある通常のテキスト</div>`),
    ["text-overlap"]
  );
  assert.equal(found(r, "text-overlap").length, 0);
});

test("G4: 部分的に隠れたテキストは、見えている部分だけで判定する", async () => {
  // 上半分だけが見えている状態で、その見えている部分に別のテキストが重なるケースは検出する
  const r = await check(
    doc(`<div style="position:absolute;left:0;top:0;width:300px;height:20px;overflow:hidden">
           <p style="margin:0">見えている行</p><p style="margin:0">隠れている行</p></div>
         <p style="position:absolute;left:10px;top:3px;margin:0">重なるテキスト</p>`),
    ["text-overlap"]
  );
  const f = found(r, "text-overlap");
  assert.equal(f.length, 1);
  assert.match(f[0].evidence, /見えている行/);
});

test("G4: 閾値未満の微小な重なりは無視する", async () => {
  const r = await inspect(
    {
      source: {
        kind: "html",
        value: doc(`<p style="position:absolute;left:20px;top:20px">AAA</p>
                    <p style="position:absolute;left:20px;top:38px">BBB</p>`),
      },
      viewport: VIEWPORT,
      checks: ["text-overlap"],
      minOverlapPx: 3,
      minOverlapArea: 24,
    },
    session
  );
  assert.equal(found(r, "text-overlap").length, 0);
});

// ---------- G1b 水平スクロール ----------

test("G1b: 横スクロールの発生を検出する", async () => {
  const r = await check(doc(`<div style="width:1200px;height:50px;background:#ccc">広い</div>`), [
    "horizontal-scroll",
  ]);
  const f = found(r, "horizontal-scroll");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
  assert.match(f[0].evidence, /400px 超えて/);
});

test("G1b: 収まっていれば検出しない", async () => {
  const r = await check(doc(`<div style="width:700px">収まる</div>`), ["horizontal-scroll"]);
  assert.equal(found(r, "horizontal-scroll").length, 0);
});

// ---------- G3 内容の切り捨て ----------

test("G3: overflow:hidden による切り捨てを検出する", async () => {
  const r = await check(
    doc(`<div style="width:100px;height:20px;overflow:hidden">この長い文章はコンテナに収まりきらず隠れてしまいます</div>`),
    ["content-clipped"]
  );
  const f = found(r, "content-clipped");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
});

test("G3: ellipsis 指定は情報レベルに格下げする", async () => {
  const r = await check(
    doc(`<div style="width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">長い文章を省略記号で切ります</div>`),
    ["content-clipped"]
  );
  const f = found(r, "content-clipped");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "info");
});

test("G3: overflow:auto はスクロールできるので検出しない", async () => {
  const r = await check(
    doc(`<div style="width:100px;height:20px;overflow:auto">長い文章がスクロールで読める場合は問題としません</div>`),
    ["content-clipped"]
  );
  assert.equal(found(r, "content-clipped").length, 0);
});

// ---------- G1a ビューポート外へのはみ出し ----------

test("G1a: 画面外へのはみ出しを検出する", async () => {
  const r = await check(
    doc(`<div style="position:absolute;left:700px;top:10px;width:300px;background:#f00">はみ出し</div>`),
    ["viewport-overflow"]
  );
  assert.ok(found(r, "viewport-overflow").length > 0);
});

test("G1a: position:fixed は対象外", async () => {
  const r = await check(
    doc(`<div style="position:fixed;left:790px;top:10px;width:200px">固定</div>`),
    ["viewport-overflow"]
  );
  assert.equal(found(r, "viewport-overflow").length, 0);
});

// ---------- G6 不可視テキスト ----------

test("G6: 文字色と背景色が同一の場合を検出する", async () => {
  const r = await check(
    doc(`<p style="color:rgb(255,255,255);background-color:rgb(255,255,255)">見えない文字</p>`),
    ["invisible-text"]
  );
  assert.equal(found(r, "invisible-text").length, 1);
});

test("G6: font-size:0 を検出する", async () => {
  const r = await check(doc(`<p style="font-size:0">読めない</p>`), ["invisible-text"]);
  assert.equal(found(r, "invisible-text").length, 1);
});

test("G6: 通常のテキストは検出しない", async () => {
  const r = await check(doc(`<p style="color:#333;background:#fff">読める文字</p>`), ["invisible-text"]);
  assert.equal(found(r, "invisible-text").length, 0);
});

// ---------- G5 要素の衝突(既定オフ) ----------

test("G5: 既定では実行されない", async () => {
  const r = await check(
    doc(`<div style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:#00f"></div>
         <div style="position:absolute;left:50px;top:50px;width:100px;height:100px;background:#0f0"></div>`)
  );
  assert.equal(found(r, "element-collision").length, 0);
  assert.equal(r.summary.checksRun.includes("element-collision"), false);
});

test("G5: 明示指定すると検出する", async () => {
  const r = await check(
    doc(`<div style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:#00f"></div>
         <div style="position:absolute;left:50px;top:50px;width:100px;height:100px;background:#0f0"></div>`),
    ["element-collision"]
  );
  assert.ok(found(r, "element-collision").length > 0);
  assert.equal(found(r, "element-collision")[0].severity, "warning");
});

// ---------- 再現性・出力形式 ----------

test("同じ入力を2回検査すると同じ結果になる", async () => {
  const html = doc(`<p style="position:absolute;left:20px;top:20px">基礎テキスト</p>
                    <p style="position:absolute;left:26px;top:23px">重なりテキスト</p>
                    <div style="width:1000px">広い</div>`);
  const a = await check(html);
  const b = await check(html);
  assert.deepEqual(
    a.findings.map((f) => [f.check, f.evidence]),
    b.findings.map((f) => [f.check, f.evidence])
  );
});

test("所見のIDは検査ごとに連番になる", async () => {
  const r = await check(
    doc(`<p style="position:absolute;left:20px;top:20px">あああああ</p>
         <p style="position:absolute;left:24px;top:23px">いいいいい</p>
         <p style="position:absolute;left:20px;top:200px">ううううう</p>
         <p style="position:absolute;left:24px;top:203px">えええええ</p>`),
    ["text-overlap"]
  );
  const ids = found(r, "text-overlap").map((f) => f.id);
  assert.deepEqual(ids, ["text-overlap-001", "text-overlap-002"]);
});

test("破綻のないページは pass になる", async () => {
  const r = await check(doc(`<h1>見出し</h1><p>本文です。</p>`));
  assert.equal(r.summary.pass, true);
  assert.equal(r.summary.errors, 0);
});

test("エラーがあると pass が false になる", async () => {
  const r = await check(doc(`<div style="width:1200px">広すぎる</div>`));
  assert.equal(r.summary.pass, false);
  assert.ok(r.summary.errors > 0);
});

test("セレクタで要素を特定できる", async () => {
  const r = await check(
    doc(`<p id="base" style="position:absolute;left:20px;top:20px">下のテキスト</p>
         <p id="over" style="position:absolute;left:24px;top:23px">上のテキスト</p>`),
    ["text-overlap"]
  );
  const sels = found(r, "text-overlap")[0].elements.map((e) => e.selector).sort();
  assert.deepEqual(sels, ["#base", "#over"]);
});

test("所見に座標が含まれる", async () => {
  const r = await check(
    doc(`<p style="position:absolute;left:20px;top:20px">下のテキスト</p>
         <p style="position:absolute;left:24px;top:23px">上のテキスト</p>`),
    ["text-overlap"]
  );
  const rect = found(r, "text-overlap")[0].elements[0].rect;
  assert.ok(rect);
  assert.equal(typeof rect.x, "number");
  assert.ok(rect.w > 0 && rect.h > 0);
});

test("外部リソースは既定で読み込まれない", async () => {
  // 到達不能な外部URLを指定しても、遮断されるためタイムアウトせずに完了する
  const r = await check(
    doc(`<img src="https://invalid.example.invalid/a.png" alt="x"><p>本文</p>`),
    ["horizontal-scroll"]
  );
  assert.equal(r.summary.pass, true);
});
