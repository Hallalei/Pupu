/**
 * 浏览器任务卡片的实时画面：在电脑上截 Pupu 浏览器的图、涂掉敏感的格子、压成小 JPEG，经桥发到云端。
 *
 * 用的是定时截图（Electron 的 capturePage，带 stayHidden），不是 Page.startScreencast：窗口平时是隐藏的，
 * screencast 只在合成器出新帧时推，隐藏窗口一帧也不推；CDP 的 Page.captureScreenshot 在隐藏窗口上也会一直等。Playwright 的录屏
 * （packages/playwright-core/src/server/chromium/crPage.ts，Apache-2.0）用的是 screencast + ack，
 * 我们借了它「JPEG、限宽、按帧确认」的思路：这里一次只截一张，上一张没发完不截下一张。
 *
 * 涂掉的格子：密码框、银行卡号/有效期/CVC、一次性验证码、带 sensitive 输入过的控件，以及常见支付服务商的
 * 跨域 iframe（看不到里面，整块涂掉）。算不出位置时这一帧不发，宁可卡住也不漏。
 */

/** 按类型和 autocomplete 认出来的敏感输入框。 */
const SENSITIVE_FIELDS = `input[type=password i], input[autocomplete*="cc-" i], input[autocomplete*="password" i], input[autocomplete="one-time-code" i]`;
/** 名字、id、标签、占位字里有这些词的输入框也算敏感。快照里按无障碍名字再认一遍（见 browser-snapshot.ts）。 */
export const SENSITIVE_NAME = /(pass(word|wd)?|pwd|cvv|cvc|csc|card.?num|cc.?num|security.?code|otp|one.?time|verification.?code|ssn|身份证|密码|验证码|卡号)/i;
/**
 * 快照里按名字认敏感框用这个更窄的：画面上多涂一块没关系，快照里多藏会让模型读不到「Passenger name」「laptop」这类普通字段。
 * 英文词要整词出现。
 */
export const SENSITIVE_LABEL = /(\b(password|passwd|passcode|pwd|cvv|cvc|csc|otp|ssn|pin)\b|card.?number|security.?code|one.?time.?(code|password)|verification.?code|身份证|密码|口令|验证码|校验码|卡号|安全码)/i;

/** 在页面里跑：返回要涂掉的矩形（CSS 像素，相对视口）和视口大小。 */
export const SENSITIVE_RECTS_SCRIPT = `(() => {
  const out = [];
  const add = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
      out.push([r.left, r.top, r.width, r.height]);
    }
  };
  const fields = '${SENSITIVE_FIELDS}';
  const named = ${SENSITIVE_NAME.toString()};
  const seen = new Set();
  const visit = (root) => {
    for (const el of root.querySelectorAll(fields)) { seen.add(el); add(el); }
    for (const el of root.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])')) {
      if (seen.has(el)) continue;
      const hint = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
      if (named.test(hint)) { seen.add(el); add(el); }
    }
    for (const frame of root.querySelectorAll('iframe')) {
      let doc = null;
      try { doc = frame.contentDocument; } catch (e) { doc = null; }
      if (doc) {
        const r = frame.getBoundingClientRect();
        const before = out.length;
        visit(doc);
        for (let i = before; i < out.length; i++) { out[i][0] += r.left; out[i][1] += r.top; }
        continue;
      }
      const text = [frame.src, frame.name, frame.title].join(' ');
      if (/stripe|braintree|adyen|paypal|checkout\\.com|recurly|squareup|pay\\.google|apple\\.com\\/apple-pay|card|payment|password|login|signin|captcha/i.test(text)) add(frame);
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
  };
  visit(document);
  return { width: innerWidth, height: innerHeight, rects: out };
})()`;

/**
 * 在页面里跑：返回敏感输入框本身（数组，按 objectId 取回再换成 backendNodeId），给快照用来隐去它们的值。
 * 和上面涂画面用同一套规则，同源 iframe 和 shadow root 里的也算。
 */
export const SENSITIVE_ELEMENTS_SCRIPT = `(() => {
  const out = [];
  const fields = '${SENSITIVE_FIELDS}';
  const named = ${SENSITIVE_NAME.toString()};
  const visit = (root) => {
    for (const el of root.querySelectorAll(fields)) out.push(el);
    for (const el of root.querySelectorAll('input:not([type=hidden]), textarea')) {
      if (out.includes(el)) continue;
      const hint = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
      if (named.test(hint)) out.push(el);
    }
    for (const frame of root.querySelectorAll('iframe')) {
      let doc = null;
      try { doc = frame.contentDocument; } catch (e) { doc = null; }
      if (doc) visit(doc);
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
  };
  visit(document);
  return out;
})()`;

export type Rect = readonly [x: number, y: number, width: number, height: number];

/** 在 BGRA 位图上把矩形涂成实心深灰，四周多涂几像素。坐标已经换算成位图像素。 */
export function paintRects(bitmap: Buffer, width: number, height: number, rects: readonly Rect[], pad = 4): void {
  for (const [x, y, w, h] of rects) {
    const left = Math.max(0, Math.floor(x - pad));
    const top = Math.max(0, Math.floor(y - pad));
    const right = Math.min(width, Math.ceil(x + w + pad));
    const bottom = Math.min(height, Math.ceil(y + h + pad));
    for (let row = top; row < bottom; row++) {
      const start = (row * width + left) * 4;
      const end = (row * width + right) * 4;
      for (let index = start; index < end; index += 4) {
        bitmap[index] = 0x44;
        bitmap[index + 1] = 0x44;
        bitmap[index + 2] = 0x44;
        bitmap[index + 3] = 0xff;
      }
    }
  }
}

/** CSS 像素的矩形换到输出图上的像素。 */
export function scaleRects(rects: readonly Rect[], cssWidth: number, outWidth: number): Rect[] {
  const scale = cssWidth > 0 ? outWidth / cssWidth : 1;
  return rects.map(([x, y, w, h]) => [x * scale, y * scale, w * scale, h * scale] as const);
}

/** CDP 的 quad（四个点八个数）围成的矩形。 */
export function quadRect(quad: readonly number[]): Rect | null {
  if (quad.length < 8) return null;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
}

export function isRects(value: unknown): value is { width: number; height: number; rects: Rect[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.width === "number" &&
    typeof record.height === "number" &&
    Array.isArray(record.rects) &&
    record.rects.every((rect) => Array.isArray(rect) && rect.length === 4 && rect.every((n) => typeof n === "number" && Number.isFinite(n)))
  );
}
