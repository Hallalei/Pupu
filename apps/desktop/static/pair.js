// 配对窗口（规范 SignIn 的宽屏版式）。接口在 src/pair-preload.ts：info() 说明为什么要配对，pair() 用配对码换凭据，
// google() 在系统浏览器里用 Google 登录，cancel() 不等浏览器了，onStatus() 收主进程推来的状态。
// 正在做哪一次、为什么要配对，都以主进程推来的 status 为准，这里不另记。
const $ = (id) => document.getElementById(id);
const form = $("form");
const code = $("code");
const submit = $("submit");
const google = $("google");
const cancel = $("cancel");
const error = $("error");
let info = null;
let status = null;

function showError(text) {
  error.textContent = text || "";
  error.hidden = !text;
}

function adopt() {
  return !$("adopt-row").hidden && $("adopt").checked;
}

function show(element, visible) {
  element.hidden = !visible;
}

/** 窗口的凭据还在，只差这台电脑的（被吊销了，或者配对半路没做完）：点一下就好，不用填码。 */
function oneClick() {
  return status.reason === "computer" || status.reason === "unfinished";
}

/**
 * 天空上一直只有 Pupu 和那句话，换的是卡片里的东西：
 * - 默认：「用 Google 登录」、「或」、配对码、「继续」；窗口的凭据失效了时，顶上多一句为什么。
 * - 在浏览器里等 Google 登录：一句话和「取消」，这时没有主操作。
 * - 整台电脑的授权被吊销：一句话和「重新配对」，不用填码。
 * - 配对半路没做完（窗口的凭据拿到了，这台电脑的没拿到）：一句话和「再试一次」，不用填码。
 * 一件在做时另一件点不了。
 */
function render() {
  const unfinished = status.reason === "unfinished";
  const waiting = status.busy === "google";
  const pairing = status.busy === "code";
  const fields = !oneClick() && !waiting;
  show($("notice"), fields && status.reason === "desktop");
  show($("message"), oneClick() || waiting);
  $("message").textContent = waiting
    ? "在打开的浏览器里选你的 Google 账号，登录好了会自动回到这里。"
    : unfinished
      ? "这台电脑的配对没做完。"
      : "这台电脑的授权被吊销了。要让 Pupu 接着用它，就重新配对。";
  show(google, fields && info.google);
  google.disabled = pairing;
  show($("or"), fields && info.google);
  show(code, fields);
  code.disabled = pairing;
  show($("adopt-row"), fields && Boolean(info.adoptable));
  show(submit, !waiting);
  submit.textContent = unfinished ? "再试一次" : oneClick() ? "重新配对" : "继续";
  // 没填码时「继续」是 action-off，主次留给 Google；填了才换成 action。正在配对时转圈，点不了。
  submit.disabled = !oneClick() && !info.codeOptional && !code.value.trim();
  submit.classList.toggle("busy", pairing);
  submit.toggleAttribute("aria-busy", pairing);
  show(cancel, waiting);
  $("hint").textContent = fields ? `在已经连上的设备的设置里生成配对码 · ${info.host}` : info.host;
}

window.pupuPairing.onStatus((next) => {
  status = next;
  if (info) render();
});

async function load() {
  info = await window.pupuPairing.info();
  status = info.status;
  if (info.codeOptional) code.placeholder = "本机开发服务器，可以不填";
  if (info.adoptable) $("adopt-label").textContent = `沿用命令行给「${info.adoptable}」的授权，不新建一台电脑`;
  render();
  // 光标放进配对码框：填好按回车就是「继续」。
  if (!code.hidden) code.focus();
}

code.addEventListener("input", () => {
  if (info) render();
});

google.addEventListener("click", async () => {
  if (!info || status.busy) return;
  showError("");
  const failed = await window.pupuPairing.google({ adopt: adopt() });
  // 成功时主进程会关掉这个窗口。
  if (failed && failed !== "已取消。") showError(failed);
});

cancel.addEventListener("click", () => {
  void window.pupuPairing.cancel();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!info || status.busy) return;
  if (!oneClick() && !code.value.trim() && !info.codeOptional) return;
  showError("");
  const failed = await window.pupuPairing.pair({ code: code.value.trim(), adopt: adopt() });
  // 成功时主进程会关掉这个窗口。
  if (failed) showError(failed);
});

load().catch((cause) => showError(String(cause)));
