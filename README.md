# layout-doctor-mcp

[![CI](https://github.com/h-kazuki-pixel/layout-doctor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/h-kazuki-pixel/layout-doctor-mcp/actions/workflows/ci.yml)

**HTMLを実際にレンダリングして、レイアウトの破綻を数値で検出するMCPサーバー。**

比較用のベースライン画像は要りません。いま生成したその1枚だけで判定します。

> **これは検査専用のツールです。** ファイルの書き換えや自動修正は一切行いません。読み取りのみで動作します。

```
[エラー] text-overlap-001
  テキスト「料金プラン」と「人気No.1」が 59×17px(面積 1003px²)重なっており、文字が読めなくなります。
  → div.hero > h1 (24, 48) 163×36px
  → span.badge (128, 55) 66×17px
  対処: どちらかの位置・余白を調整するか、重ねる意図がある場合は背景を不透明にしてください。
```
## なぜ作ったか

AIにHTMLやスライドを作らせると、コードは正しいのに**表示が壊れている**ことがあります。文字が重なる、枠からはみ出す、`undefined` がそのまま出る。しかし生成した本人はレンダリング結果を見ていないので気づけません。

既存のビジュアルテストツールは、ほぼすべてが**「前回の画像と比べて変わったか」**を見る回帰テストです。いま作ったばかりの1枚には、比べる相手がいません。

スクリーンショットを撮って画像認識に判断させる方法もありますが、視覚モデルは「この要素があの要素より37px右にはみ出している」といった空間的な把握を苦手としています。

このツールは画像を見ません。**DOMの座標と、文字が実際に描画された矩形を実測します。** だから「なんとなく崩れている」ではなく「どの要素が何ピクセルはみ出しているか」が返ります。

## インストール

npmへの公開は準備中です。現在は clone してビルドします。

```bash
git clone https://github.com/h-kazuki-pixel/layout-doctor-mcp.git
cd layout-doctor-mcp
npm install && npm run build
npx playwright install chromium
```

⚠️ **`npx playwright install chromium` は必ずこのディレクトリの中で、`npm install` のあとに実行してください。**別の場所で実行すると、依存とは異なるバージョンの Playwright 用に Chromium が入り、起動時に `Executable doesn't exist at ...` エラーになります。

Linux では共有ライブラリが不足していることがあります。その場合は次を使ってください(管理者権限が必要です)。

```bash
npx playwright install --with-deps chromium
```

### Claude Desktop の設定

設定ファイル `claude_desktop_config.json` の場所:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

次を追記します。`/absolute/path/to` は clone した場所に置き換えてください。

```json
{
  "mcpServers": {
    "layout-doctor": {
      "command": "node",
      "args": ["/absolute/path/to/layout-doctor-mcp/dist/src/index.js"]
    }
  }
}
```

macOS の Claude Desktop は起動時にシェルのPATHを継承しないため、`npx` ではなく **`node` と絶対パスで指定するのが確実**です。

**Chromiumを新たに入れたくない場合**、既にあるChromeを使えます。

```json
{
  "mcpServers": {
    "layout-doctor": {
      "command": "node",
      "args": ["/absolute/path/to/layout-doctor-mcp/dist/src/index.js"],
      "env": {
        "LAYOUT_DOCTOR_CHROMIUM": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      }
    }
  }
}
```
Windows / Linux では、パスを次のように置き換えてください。JSONの中では `\` を `\\` と2つ重ねて書きます。

- Windows: `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`
- Linux: `/usr/bin/google-chrome`(または `/usr/bin/chromium`)

## セットアップをAIに任せる

設定ファイルの手編集につまずいたら、Claude Desktop に以下をそのまま貼り付けてください。

---

layout-doctor-mcp をセットアップしてください。

1. https://github.com/h-kazuki-pixel/layout-doctor-mcp の README を読む
2. clone とビルドのコマンドを1つずつ提示する
3. 私の claude_desktop_config.json に必要な設定を追記する(node と絶対パスを使う)
4. 設定後、動作確認として layout_check を1回実行して結果を見せる

私は非エンジニアです。実行するコマンドは1つずつ提示してください。

---

## 1分お試し

MCPサーバーを立てなくても、動作を確認できます。

```bash
git clone https://github.com/h-kazuki-pixel/layout-doctor-mcp.git
cd layout-doctor-mcp
npm install && npm run build
npx playwright install chromium

cat > /tmp/broken.html <<'EOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif}
.badge{position:absolute;left:120px;top:52px;background:#e74c3c;color:#fff;padding:2px 8px}
</style></head><body>
<div style="padding:24px"><h1>料金プラン</h1><p>月額 undefined 円</p></div>
<span class="badge">人気No.1</span>
</body></html>
EOF

node --input-type=module -e "
import { inspect, formatReport } from './dist/src/inspect.js';
const r = await inspect({ source: { kind: 'path', value: '/tmp/broken.html' },
                          viewport: { width: 800, height: 600 } });
console.log(formatReport(r));
"
```

次のように出力されます。

```
検査完了: エラー 2 件 / 警告 0 件 / 情報 0 件
ビューポート 800×600 / 所要 434ms

[エラー] placeholder-left-001
  本文に undefined が残っています。該当箇所: 「…料金プラン 月額 undefined 円 人気No.1…」
  → html
  対処: 変数の埋め込みが失敗しています。値が未定義でないか、テンプレートエンジンが適用されているかを確認してください。

[エラー] text-overlap-001
  テキスト「料金プラン」と「人気No.1」が 59×17px(面積 1003px²)重なっており、文字が読めなくなります。
  → div > h1 (24, 48) 163×36px
  → span.badge (128, 55) 66×17px
  対処: どちらかの位置・余白を調整するか、重ねる意図がある場合は背景を不透明にしてください。

補足:
  - 計測: 要素 6 個 / テキスト矩形 3 個 (抽出 7ms・判定 1ms)
```
所要時間はブラウザの起動を含むため環境によって大きく変わります。座標もフォントによって数ピクセル前後します。

## 使い方

ツールは `layout_check` の1つだけです。

```jsonc
{
  "path": "/Users/you/work/report.html",
  "viewport": { "width": 1280, "height": 720 }
}
```

`path`(ファイルの**絶対パス**)・`html`(文字列)・`url`(既定では localhost のみ)のいずれか1つと、`viewport` を渡します。

**`viewport` に既定値はありません。** 画面幅によって結果が変わるため、必ず明示してもらう設計にしています。スライドなら 1280×720、一般的なWebページなら 1280×800 が目安です。

### 主な引数

| 引数 | 既定 | 説明 |
|---|---|---|
| `checks` | element-collision 以外すべて | 実行する検査を絞り込む |
| `minOverlapPx` / `minOverlapArea` | 3 / 24 | この大きさ未満の重なり・はみ出しを無視する |
| `allowNetwork` | `false` | 外部への通信を許可する |
| `format` | `"text"` | `"json"` にすると機械処理向けの出力になる |
| `settleMs` | `0` | 遅れて描画される要素がある場合の追加待機 |
| `executablePath` | — | 使用するChromiumのパス |

## 検出できる問題

| 検査 | 深刻度 | 内容 |
|---|---|---|
| `placeholder-left` | error | `undefined` / `NaN` / `{{name}}` など、値が埋まらなかった箇所 |
| `draft-text-left` | warning | Lorem ipsum / TODO などの仮テキストの残留 |
| `broken-reference` | error | 画像・CSS・スクリプトの参照先が存在しない |
| `duplicate-id` | warning | `id` の重複 |
| `viewport-overflow` | error | 要素が画面外へはみ出している |
| `horizontal-scroll` | error | 文書幅が画面を超え、横スクロールが発生する |
| `container-overflow` | warning | 子要素が親コンテナからはみ出している |
| `content-clipped` | error | `overflow:hidden` で内容が切り取られ、読めなくなっている |
| `text-overlap` | error | 文字同士が重なって読めない |
| `invisible-text` | warning | 文字色と背景色が同一、または `font-size` がゼロ |
| `element-collision` | warning | 要素同士の重なり(**既定では無効**) |

### `text-overlap` について

このツールの中心となる検査です。要素の枠(ボックス)同士の重なりは、バッジやオーバーレイなど**意図的なデザインであることが多く**、そのまま報告すると誤検出だらけになります。

そこで、要素ではなく**文字が実際に描画された矩形**同士の交差だけを見ます。文字と文字が重なっているなら、それはほぼ確実に不具合だからです。

さらに、同じ行に並ぶ単語同士(隣り合う `<span>` など)は同じブロック内として除外し、`overflow:hidden` で切り取られて画面に出ていない文字も判定から外しています。

### `element-collision` が既定で無効な理由

要素同士の重なりは、意図的な重ね置きと本当の不具合を機械的に区別できません。誤検出でツール全体の信頼を落とすより、必要な人だけが有効にする形を選びました。`checks` に明示的に含めると実行されます。

## 使わない方がいい場合

- **静的なHTMLしか検査しないなら** — 文字列検査だけで足りる用途(プレースホルダの残留チェックのみ等)であれば、grep や既存のHTMLリンターの方が速く、ブラウザも要りません
- **前回との差分を見たいなら** — このツールは1枚を単体で判定します。「変更前と変わったか」を見たい場合は Applitools や Playwright の視覚回帰の方が適しています
- **複数の画面幅をまとめて調べたいなら** — 指定された1つの幅しか見ません。レスポンシブ対応の網羅検査は対象外です
- **アクセシビリティを総合的に見たいなら** — コントラスト比・ARIA・キーボード操作は扱いません。axe-core 系のツールを使ってください
- **デザインの善し悪しを評価したいなら** — 幾何的に破綻しているかだけを見ます。配色やバランスの判断はしません

## 設計について

このツールは、作者の他のMCPサーバー(jp-dates など)が守っている「完全オフライン・依存ゼロ」の方針から**意図的に外れています。**

レイアウトの破綻は、実際にレンダリングしなければ分かりません。Playwright と Chromium への依存はその代償です。導入がやや重くなる代わりに、推測ではなく実測を返します。

代わりに次を守っています。

- **通信は既定で遮断** — `allowNetwork: true` を指定しない限り、localhost 以外へ通信しません。検査対象のHTMLが外部へリクエストを飛ばすこともありません
- **読み取り専用** — ファイルの作成・変更・削除を一切行いません
- **ツールは1つだけ** — 説明文が長いツールを多数並べると、利用者の毎ターンのコンテキストとコストを圧迫します。`layout_check` の1本に絞り、詳細はこのREADMEに置いています

## 結果の読み方

各所見には `verdict` が付きます。

- `static` — レンダリング結果を見るまでもなく確定している問題(プレースホルダの残留など)
- `candidate` — 座標上は検出したが、**人間の目に見えるかは未判定**

`candidate` には、透明な要素同士の重なりのように「座標は重なっているが実際には見えない」ものが混ざりえます。この切り分け(レンダリング結果を用いた可視性の確認)は v0.5 で追加予定です。

## 検査しないこと

デザインの良し悪し、コントラスト比などのアクセシビリティ全般、前回との差分(ビジュアル回帰)、複数幅にわたるレスポンシブ検査は対象外です。詳しくは「使わない方がいい場合」を参照してください。

## 測定を安定させるための処理

同じ入力なら常に同じ結果を返すため、測定前に次を行っています。

- CSSアニメーションとトランジションを停止(止めないと測るたびに結果が変わります)
- Webフォントの読み込み完了を待機(フォントが差し替わると文字幅が変わり、座標がすべてずれます)
- デバイスピクセル比を 1 に固定、ロケールとタイムゾーンを固定
- **外部への通信を既定で遮断**(`allowNetwork: true` で解除)

## 動作環境

- Node.js 18 以上
- Chromium(Playwright経由、または既存のChrome)
- Linux では Chromium が要求する共有ライブラリが必要です(`npx playwright install --with-deps chromium` で導入されます)

`LAYOUT_DOCTOR_CHROMIUM` には Chromium のほか、製品版の Google Chrome や Microsoft Edge も指定できます(いずれも Chromium 系のため、Playwright の CDP で制御できます)。ただし動作確認は Playwright 同梱の Chromium で行っています。

## 参考にした研究

検査項目の分類と、DOM座標だけでは人間に見えない問題まで拾ってしまうという知見は、以下の研究に基づいています。**論文の記述を参照した独自実装であり、これらのツールのコードは使用していません。**

- Walsh, Snyder, Kapfhammer, McMinn: *Automated Layout Failure Detection for Responsive Web Pages* — レイアウト破綻の5分類
- Althomali, Kapfhammer, McMinn: *Automated visual classification of DOM-based presentation failure reports for responsive web pages* (STVR 2021) — DOM検出の偽陽性と、不透明度操作による可視性判定

## テスト

```bash
npm test
```

テスト50件が通ります(`geometry.test.ts` 28件 / `static.test.ts` 22件)。検査項目ごとに「破綻を検出できること」と「意図的なデザインを誤検出しないこと」を対にして確認しています。

- 重なったテキストを検出する / 隙間なく並んだ2列は重なりとみなさない
- スクリーンリーダー専用テキストを誤検出しない
- `overflow: hidden` で隠れたテキストは重なりとみなさない
- 同じ入力を2回検査すると同じ結果になる(決定論性)
- 外部リソースは既定で読み込まれない

## ライセンス

MIT
