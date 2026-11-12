/** 探针的桥这一侧：跑在 utilityProcess 里，只用 bridge/browser.ts 的公开接口，和电脑 App 里的桥一样。 */
import { browse, receiveBrowserReply, useBrowserHost, type BrowserOp, type BrowserReply } from "../../cloud/bridge/browser.ts";

const port = process.parentPort;
const origin = process.argv.at(-1) ?? "";
const report: string[] = [];
let shotWaiter: (() => void) | null = null;

useBrowserHost((request) => port.postMessage(request));
port.on("message", (event) => {
  const message = event.data as BrowserReply | { type: "shot-done"; name: string };
  if (message.type === "browser-result") receiveBrowserReply(message);
  else if (message.type === "shot-done") {
    report.push(`[桥] 截图 ${message.name}`);
    shotWaiter?.();
  }
});

function shot(): Promise<void> {
  return new Promise((resolve) => {
    shotWaiter = resolve;
    port.postMessage({ type: "shot" });
  });
}

async function step(title: string, op: BrowserOp): Promise<string> {
  const result = await browse(op);
  report.push(`\n=== ${title}：${JSON.stringify(op)}`);
  if (!result.ok) {
    report.push(`失败：${result.error}`);
    return "";
  }
  report.push(result.text);
  return result.text;
}

function ref(snapshot: string, pattern: RegExp): number {
  const match = snapshot.match(pattern);
  if (!match) throw new Error(`快照里找不到 ${pattern}`);
  return Number(match[1]);
}

async function main(): Promise<void> {
  let page = await step("打开测试页（127.0.0.1，模拟已批准）", { op: "open", url: `${origin}/`, approved: true });
  await shot();
  page = await step("点「加一」", { op: "click", ref: ref(page, /\[(\d+)\] button "加一"/), label: "加一" });
  const name = ref(page, /\[(\d+)\] textbox "名字"/);
  page = await step("在「名字」里输入", { op: "type", ref: name, text: "小猫" });
  page = await step("点「打招呼」", { op: "click", ref: ref(page, /\[(\d+)\] button "打招呼"/) });
  await step("读全文", { op: "read" });
  await shot();
  await step("没批准点表单的提交按钮，应被拦", { op: "click", ref: ref(page, /\[(\d+)\] button "查"/) });
  await step("没批准按回车，应被拦", { op: "key", key: "Enter" });
  page = await step("在查询框里输入", { op: "type", ref: ref(page, /\[(\d+)\] textbox "查询"/), text: "猫" });
  await step("Tab 到提交按钮", { op: "key", key: "Tab" });
  await step("没批准在提交按钮上按空格，应被拦", { op: "key", key: "Space" });
  await step("批准过的下载（先 302 重定向）", { op: "download", url: `${origin}/file`, approved: true });
  await step("批准过也不开 file:", { op: "open", url: "file:///etc/hosts", approved: true });
  await step("没批准打开 127.0.0.1，应被拦", { op: "open", url: `${origin}/` });
  await step("没批准下载，应被拦", { op: "download", url: `${origin}/two` });
  await step("点链接「下一页」", { op: "click", ref: ref(page, /\[(\d+)\] link "下一页"/) });
  await step("打开 file:// 应被拒", { op: "open", url: "file:///etc/hosts" });
  await step("打开外网 example.com", { op: "open", url: "https://example.com/" });
  await shot();
  await step("按 query 只看一部分", { op: "look", query: "domain" });
}

main()
  .catch((error: unknown) => report.push(`[桥] 出错：${error instanceof Error ? error.message : String(error)}`))
  .finally(() => port.postMessage({ type: "report", lines: report }));
