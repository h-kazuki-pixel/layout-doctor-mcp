import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStaticChecks } from "../src/checks/static.js";
import { DEFAULT_CHECKS } from "../src/constants.js";

const run = (html: string, baseDir?: string) =>
  runStaticChecks({ html, baseDir, checks: DEFAULT_CHECKS });

const has = (html: string, check: string, baseDir?: string): boolean =>
  run(html, baseDir).findings.some((f) => f.check === check);

// ---------- S1 プレースホルダ残留 ----------

test("S1: undefined を検出する", () => {
  assert.ok(has("<body><p>価格: undefined 円</p></body>", "placeholder-left"));
});

test("S1: 未展開の {{ }} を検出する", () => {
  assert.ok(has("<body><h1>ようこそ {{userName}} さん</h1></body>", "placeholder-left"));
});

test("S1: 未展開の ${ } を検出する", () => {
  assert.ok(has("<body><p>${total}</p></body>", "placeholder-left"));
});

test("S1: [object Object] を検出する", () => {
  assert.ok(has("<body><p>[object Object]</p></body>", "placeholder-left"));
});

test("S1: 属性値の undefined も検出する", () => {
  assert.ok(has('<body><img src="a.png" alt="undefined"></body>', "placeholder-left"));
});

test("S1: NaN を検出する", () => {
  assert.ok(has("<body><span>合計 NaN 件</span></span></body>", "placeholder-left"));
});

// 偽陽性の防止

test("S1: <code> 内のテンプレート構文は検出しない", () => {
  const html = "<body><p>使い方の説明</p><code>{{name}} と書きます</code></body>";
  assert.equal(has(html, "placeholder-left"), false);
});

test("S1: <pre> 内のテンプレート構文は検出しない", () => {
  assert.equal(has("<body><pre>${value}</pre></body>", "placeholder-left"), false);
});

test("S1: <script> 内の undefined は検出しない", () => {
  assert.equal(
    has("<body><p>正常</p><script>if (x === undefined) {}</script></body>", "placeholder-left"),
    false
  );
});

test("S1: 正常なページでは何も出ない", () => {
  const html = "<body><h1>料金プラン</h1><p>月額 980 円です。</p></body>";
  assert.equal(run(html).findings.length, 0);
});

test("S1: 英単語の一部に undefined が含まれる場合は誤検出しない", () => {
  // 単語境界を使っているため "undefinedness" は検出されない
  assert.equal(has("<body><p>The term is undefinedness in logic</p></body>", "placeholder-left"), false);
});

// ---------- S1b 仮テキスト ----------

test("S1b: Lorem ipsum を warning として検出する", () => {
  const f = run("<body><p>Lorem ipsum dolor sit amet</p></body>").findings.find(
    (x) => x.check === "draft-text-left"
  );
  assert.ok(f);
  assert.equal(f.severity, "warning");
});

test("S1b: TODO を検出する", () => {
  assert.ok(has("<body><p>TODO: ここを書く</p></body>", "draft-text-left"));
});

// ---------- S2 参照切れ ----------

test("S2: 存在しない画像を検出する", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-"));
  const html = '<body><img src="missing.png"></body>';
  assert.ok(has(html, "broken-reference", dir));
});

test("S2: 存在する画像は検出しない", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-"));
  writeFileSync(join(dir, "ok.png"), "dummy");
  assert.equal(has('<body><img src="ok.png"></body>', "broken-reference", dir), false);
});

test("S2: 外部URLは検査対象外", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-"));
  assert.equal(
    has('<body><img src="https://example.com/a.png"></body>', "broken-reference", dir),
    false
  );
});

test("S2: data URI は検査対象外", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-"));
  assert.equal(has('<body><img src="data:image/png;base64,AAA"></body>', "broken-reference", dir), false);
});

test("S2: baseDir がない場合は補足を返す", () => {
  const r = run('<body><img src="missing.png"></body>');
  assert.equal(r.findings.filter((f) => f.check === "broken-reference").length, 0);
  assert.ok(r.notes.some((n) => n.includes("参照切れは検査できません")));
});

test("S2: クエリ付きのパスも解決できる", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-"));
  writeFileSync(join(dir, "s.css"), "body{}");
  assert.equal(has('<link href="s.css?v=2" rel="stylesheet">', "broken-reference", dir), false);
});

// ---------- S3 id重複 ----------

test("S3: id の重複を検出する", () => {
  const html = '<body><div id="main">A</div><div id="main">B</div></body>';
  const f = run(html).findings.find((x) => x.check === "duplicate-id");
  assert.ok(f);
  assert.ok(f.evidence.includes("2 箇所"));
});

test("S3: 一意な id は検出しない", () => {
  assert.equal(has('<body><div id="a"></div><div id="b"></div></body>', "duplicate-id"), false);
});

// ---------- 検査の選択 ----------

test("checks で絞り込むと他の検査は走らない", () => {
  const html = '<body><p>undefined</p><div id="x"></div><div id="x"></div></body>';
  const r = runStaticChecks({ html, checks: ["duplicate-id"] });
  assert.equal(r.findings.every((f) => f.check === "duplicate-id"), true);
});
