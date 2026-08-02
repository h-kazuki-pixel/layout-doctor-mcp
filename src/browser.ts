import { chromium, type Browser, type LaunchOptions, type Page } from "playwright";
import { RENDER_TIMEOUT_MS } from "./constants.js";

/**
 * 測定を安定させるための注入CSS。
 * アニメーションを止めないと、同じページを2回測っても違う結果になる。
 */
const STABILIZE_CSS = `*,*::before,*::after{
  animation:none !important;
  transition:none !important;
  caret-color:transparent !important;
  scroll-behavior:auto !important;
}`;

export interface RenderOptions {
  viewport: { width: number; height: number };
  /** 外部ネットワークへのアクセスを許可するか。既定は不許可 */
  allowNetwork: boolean;
  /** 利用者が指定したChromium実行ファイル */
  executablePath?: string;
  /** レンダリング後の追加待機(ミリ秒) */
  settleMs: number;
}

export interface PageSource {
  kind: "html" | "path" | "url";
  value: string;
}

export class BrowserSession {
  private browser: Browser | null = null;

  async launch(executablePath?: string): Promise<Browser> {
    if (this.browser) return this.browser;
    const opts: LaunchOptions = { headless: true };
    if (executablePath) opts.executablePath = executablePath;
    try {
      this.browser = await chromium.launch(opts);
    } catch (err) {
      throw new Error(buildLaunchErrorMessage(err));
    }
    return this.browser;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /** 決定論的な状態まで整えたページを返す */
  async openPage(source: PageSource, opt: RenderOptions): Promise<Page> {
    const browser = await this.launch(opt.executablePath);
    const context = await browser.newContext({
      viewport: opt.viewport,
      deviceScaleFactor: 1,
      // 時計・乱数に依存する表示のばらつきを避けるため、ロケールとタイムゾーンを固定する
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await context.newPage();

    if (!opt.allowNetwork) {
      // 外部への通信を止める。決定論・オフライン動作・安全性を同時に満たす。
      await page.route("**/*", (route) => {
        const url = route.request().url();
        const isLocal =
          url.startsWith("file:") ||
          url.startsWith("data:") ||
          url.startsWith("blob:") ||
          url.startsWith("about:") ||
          /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
        if (isLocal) void route.continue();
        else void route.abort();
      });
    }

    try {
      if (source.kind === "html") {
        await page.setContent(source.value, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      } else {
        const url = source.kind === "path" ? pathToFileUrl(source.value) : source.value;
        await page.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      }
    } catch (err) {
      await context.close();
      throw new Error(buildNavigateErrorMessage(source, err, opt.allowNetwork));
    }

    await page.addStyleTag({ content: STABILIZE_CSS });
    // フォントが差し替わると文字幅が変わり、座標がすべてずれる。読み込み完了を待つ。
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);
    if (opt.settleMs > 0) await page.waitForTimeout(opt.settleMs);
    // レイアウトが確定するまで2フレーム待つ
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    );
    return page;
  }
}

function pathToFileUrl(p: string): string {
  const abs = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
  return `file://${abs}`;
}

function buildLaunchErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browserType\.launch/i.test(raw)) {
    return [
      "Chromium が見つからないため起動できませんでした。",
      "",
      "対処のいずれかを行ってください:",
      "  1. ブラウザをインストールする:  npx playwright install chromium",
      "  2. 既にあるChromeを使う: executablePath 引数に実行ファイルのパスを渡す",
      "     (macOSの例: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome)",
      "  3. 環境変数で指定する: LAYOUT_DOCTOR_CHROMIUM=/path/to/chrome",
      "",
      `元のエラー: ${raw.split("\n")[0]}`,
    ].join("\n");
  }
  return `ブラウザの起動に失敗しました: ${raw}`;
}

function buildNavigateErrorMessage(source: PageSource, err: unknown, allowNetwork: boolean): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (source.kind === "url" && !allowNetwork) {
    return [
      `URL "${source.value}" を開けませんでした。`,
      "既定では localhost 以外への通信を遮断しています。",
      "外部サイトを検査する場合は allowNetwork を true にしてください。",
      `元のエラー: ${raw.split("\n")[0]}`,
    ].join("\n");
  }
  if (source.kind === "path") {
    return [
      `ファイル "${source.value}" を開けませんでした。`,
      "パスが正しいか、絶対パスで指定しているかを確認してください。",
      `元のエラー: ${raw.split("\n")[0]}`,
    ].join("\n");
  }
  return `ページの読み込みに失敗しました: ${raw.split("\n")[0]}`;
}
