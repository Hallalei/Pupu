// 配对窗口。接口在 src/pair-preload.ts：info() 说明为什么要配对，pair() 换凭据。
const $ = (id) => document.getElementById(id);
const form = $("form");
const code = $("code");
const submit = $("submit");
const error = $("error");
let info = null;

function showError(text) {
  error.textContent = text || "";
  error.hidden = !text;
}

async function load() {
  info = await window.pupuPairing.info();
  $("hint").textContent = `连的是 ${info.host}。码 10 分钟内有效，用一次就作废。`;
  if (info.reason === "desktop") {
    $("title").textContent = "重新连上 Pupu";
    $("lead").textContent = "这个 App 的授权被吊销了。在已经连上的手机或浏览器上生成一个配对码，填在这里。";
  } else if (info.reason === "computer") {
    $("title").textContent = "重新授权这台电脑";
    $("lead").textContent = "这台电脑的授权被吊销了，Pupu 现在用不了它。要让 Pupu 接着用这台电脑，点下面的按钮。";
    code.hidden = true;
    submit.textContent = "重新授权";
  }
  if (info.codeOptional) code.placeholder = "本机开发服务器，可以不填";
  if (info.adoptable) {
    $("adopt-row").hidden = false;
    $("adopt-label").textContent = `沿用命令行桥给「${info.adoptable}」的授权，不新建一台电脑`;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!info) return;
  if (info.reason !== "computer" && !code.value.trim() && !info.codeOptional) {
    showError("先填配对码。");
    return;
  }
  submit.disabled = true;
  showError("");
  const failed = await window.pupuPairing.pair({
    code: code.value.trim(),
    adopt: !$("adopt-row").hidden && $("adopt").checked
  });
  // 成功时主进程会关掉这个窗口。
  if (failed) {
    showError(failed);
    submit.disabled = false;
  }
});

load().catch((cause) => showError(String(cause)));
