// 配对窗口。接口在 src/pair-preload.ts：info() 说明为什么要配对，pair() 用配对码换凭据，
// google() 在系统浏览器里用 Google 登录，cancel() 不等浏览器了。
const $ = (id) => document.getElementById(id);
const form = $("form");
const code = $("code");
const submit = $("submit");
const google = $("google");
const switcher = $("switch");
const error = $("error");
let info = null;
/** 开了 Google 登录时先给 Google，配对码收在「用配对码」后面。 */
let mode = "code";
let waiting = false;

function showError(text) {
  error.textContent = text || "";
  error.hidden = !text;
}

function adopt() {
  return !$("adopt-row").hidden && $("adopt").checked;
}

function codeLead() {
  return info.reason === "desktop"
    ? "这个 App 的授权被吊销了。在已经连上的手机或浏览器上生成一个配对码，填在这里。"
    : "在已经连上的手机或浏览器上打开设置，点「生成配对码」，把码填在这里。";
}

function render() {
  const googleMode = mode === "google";
  code.hidden = googleMode || info.reason === "computer";
  submit.hidden = googleMode;
  google.hidden = !googleMode;
  switcher.hidden = !info.google || waiting;
  switcher.textContent = googleMode ? "用配对码" : "用 Google 登录";
  google.textContent = waiting ? "取消" : "用 Google 登录";
  google.classList.toggle("secondary", waiting);
  if (info.reason === "computer") return;
  if (waiting) {
    $("lead").textContent = "在打开的浏览器里选你的 Google 账号。登录好了会自动回到这里。";
  } else if (googleMode) {
    $("lead").textContent =
      info.reason === "desktop"
        ? "这个 App 的授权被吊销了。用你的 Google 账号再登录一次。"
        : "用你的 Google 账号登录，这个 App 和这台电脑就一起连上了。";
  } else {
    $("lead").textContent = codeLead();
  }
  $("hint").textContent = googleMode
    ? `连的是 ${info.host}。会在系统浏览器里打开 Google 的登录页。`
    : `连的是 ${info.host}。码 10 分钟内有效，用一次就作废。`;
}

async function load() {
  info = await window.pupuPairing.info();
  if (info.reason === "desktop") $("title").textContent = "重新连上 Pupu";
  if (info.reason === "computer") {
    $("title").textContent = "重新授权这台电脑";
    $("lead").textContent = "这台电脑的授权被吊销了，Pupu 现在用不了它。要让 Pupu 接着用这台电脑，点下面的按钮。";
    submit.textContent = "重新授权";
  }
  if (info.codeOptional) code.placeholder = "本机开发服务器，可以不填";
  if (info.adoptable) {
    $("adopt-row").hidden = false;
    $("adopt-label").textContent = `沿用命令行桥给「${info.adoptable}」的授权，不新建一台电脑`;
  }
  mode = info.google ? "google" : "code";
  render();
  if (mode === "google") google.focus();
}

google.addEventListener("click", async () => {
  if (!info) return;
  if (waiting) {
    await window.pupuPairing.cancel();
    return;
  }
  waiting = true;
  showError("");
  render();
  const failed = await window.pupuPairing.google({ adopt: adopt() });
  // 成功时主进程会关掉这个窗口。
  waiting = false;
  render();
  if (failed && failed !== "已取消。") showError(failed);
});

switcher.addEventListener("click", () => {
  mode = mode === "google" ? "code" : "google";
  showError("");
  render();
  if (mode === "code") code.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!info || mode !== "code") return;
  if (info.reason !== "computer" && !code.value.trim() && !info.codeOptional) {
    showError("先填配对码。");
    return;
  }
  submit.disabled = true;
  showError("");
  const failed = await window.pupuPairing.pair({ code: code.value.trim(), adopt: adopt() });
  // 成功时主进程会关掉这个窗口。
  if (failed) {
    showError(failed);
    submit.disabled = false;
  }
});

load().catch((cause) => showError(String(cause)));
