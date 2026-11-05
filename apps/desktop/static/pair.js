// 配对窗口。接口在 src/pair-preload.ts：info() 说明为什么要配对，pair() 用配对码换凭据，
// google() 在系统浏览器里用 Google 登录，cancel() 不等浏览器了。
const $ = (id) => document.getElementById(id);
const form = $("form");
const code = $("code");
const submit = $("submit");
const google = $("google");
const error = $("error");
let info = null;
let waiting = false;

function showError(text) {
  error.textContent = text || "";
  error.hidden = !text;
}

function adopt() {
  return !$("adopt-row").hidden && $("adopt").checked;
}

/** Google 和配对码在同一屏；等浏览器的时候只留取消。 */
function render() {
  const computer = info.reason === "computer";
  google.hidden = !info.google || computer;
  google.textContent = waiting ? "取消" : "通过 Google 继续";
  google.classList.toggle("light", !waiting);
  google.classList.toggle("secondary", waiting);
  $("or").hidden = !info.google || computer || waiting;
  code.hidden = computer || waiting;
  submit.hidden = waiting;
  // 没填码时「继续」退到后面，主次留给 Google。
  submit.disabled = !computer && !info.codeOptional && !code.value.trim();
  if (computer) return;
  $("lead").textContent = waiting
    ? "在打开的浏览器里选你的 Google 账号，登录好了会自动回到这里。"
    : info.reason === "desktop"
      ? "这个 App 的授权被吊销了，再连一次。"
      : "组织大脑，让智能在组织间流动。";
  $("hint").textContent = `在已经连上的设备的设置里生成配对码 · ${info.host}`;
}

async function load() {
  info = await window.pupuPairing.info();
  if (info.reason === "desktop") $("title").textContent = "重新连上";
  if (info.reason === "computer") {
    $("title").textContent = "重新授权";
    $("lead").textContent = "这台电脑的授权被吊销了，要让 Pupu 接着用它，点下面的按钮。";
    $("hint").textContent = info.host;
    submit.textContent = "重新授权";
  }
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!info) return;
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
