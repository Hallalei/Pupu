// 窗口加载线上网页失败时显示这一页。地址由主进程放在 ?url= 里，只会是 Pupu 自己的页面。
const params = new URLSearchParams(location.search);
const target = params.get("url");
const host = params.get("host");
if (host) document.getElementById("lead").textContent = `连不上 ${host}。网络通了会自动再试。`;

function retry() {
  if (target) location.href = target;
}

document.getElementById("retry").addEventListener("click", retry);
window.addEventListener("online", retry);
setInterval(() => {
  if (navigator.onLine) retry();
}, 30_000);
