// 配对窗口。接口在 src/pair-preload.ts：info() 说明为什么要配对，pair() 用配对码换凭据，
// google() 在系统浏览器里用 Google 登录，cancel() 不等浏览器了，onStatus() 收主进程推来的状态。
// 正在做哪一次、为什么要配对，都以主进程推来的 status 为准，这里不另记。
const $ = (id) => document.getElementById(id);
const form = $("form");
const code = $("code");
const submit = $("submit");
const google = $("google");
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

/** Google 和配对码在同一屏；等浏览器的时候只留取消；一件在做时另一件灰掉。 */
function render() {
  const computer = status.reason === "computer";
  const waiting = status.busy === "google";
  google.hidden = !info.google || computer;
  google.disabled = status.busy === "code";
  google.textContent = waiting ? "取消" : "通过 Google 继续";
  google.classList.toggle("light", !waiting);
  google.classList.toggle("secondary", waiting);
  $("or").hidden = !info.google || computer || waiting;
  code.hidden = computer || waiting;
  code.disabled = status.busy !== null;
  submit.hidden = waiting;
  // 没填码时「继续」退到后面，主次留给 Google。
  submit.disabled = status.busy !== null || (!computer && !info.codeOptional && !code.value.trim());
  submit.textContent = computer ? "重新授权" : "继续";
  $("title").textContent = computer ? "重新授权" : status.reason === "desktop" ? "重新连上" : "Pupu";
  $("lead").textContent = computer
    ? "这台电脑的授权被吊销了，要让 Pupu 接着用它，点下面的按钮。"
    : waiting
      ? "在打开的浏览器里选你的 Google 账号，登录好了会自动回到这里。"
      : status.reason === "desktop"
        ? "这个 App 的授权被吊销了，再连一次。"
        : "组织大脑，让智能在组织间流动。";
  $("hint").textContent = computer ? info.host : `在已经连上的设备的设置里生成配对码 · ${info.host}`;
}

window.pupuPairing.onStatus((next) => {
  status = next;
  if (info) render();
});

async function load() {
  info = await window.pupuPairing.info();
  status = info.status;
  if (info.codeOptional) code.placeholder = "本机开发服务器，可以不填";
  if (info.adoptable) {
    $("adopt-row").hidden = false;
    $("adopt-label").textContent = `沿用命令行给「${info.adoptable}」的授权，不新建一台电脑`;
  }
  render();
  (info.google ? google : code).focus();
}

code.addEventListener("input", () => {
  if (info) render();
});

google.addEventListener("click", async () => {
  if (!info) return;
  if (status.busy === "google") {
    await window.pupuPairing.cancel();
    return;
  }
  if (status.busy) return;
  showError("");
  const failed = await window.pupuPairing.google({ adopt: adopt() });
  // 成功时主进程会关掉这个窗口。
  if (failed && failed !== "已取消。") showError(failed);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!info || status.busy) return;
  if (status.reason !== "computer" && !code.value.trim() && !info.codeOptional) {
    showError("先填配对码。");
    return;
  }
  showError("");
  const failed = await window.pupuPairing.pair({ code: code.value.trim(), adopt: adopt() });
  // 成功时主进程会关掉这个窗口。
  if (failed) showError(failed);
});

load().catch((cause) => showError(String(cause)));
