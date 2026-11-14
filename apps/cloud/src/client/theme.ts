/**
 * HeroUI 和样式表都靠 html 上的 dark 类切深色，跟着系统走，登录页也一样：
 * 规范 SignIn 的天空浅色五段、深色四段，卡片和 Google 按钮也分浅色深色。只有左边的 3D 场景总是夜里。
 */
const system = window.matchMedia("(prefers-color-scheme: dark)");
let sky = false;

function apply() {
  const dark = system.matches;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  syncThemeColor();
}

/** 浏览器标签栏和手机状态栏的颜色跟着窗框走；登录页铺的是天空，用天空最上面那一档。 */
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(sky ? "--color-sky-1" : "--color-frame")
    .trim();
  if (!color) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = color;
}

export function followSystemTheme() {
  apply();
  system.addEventListener("change", apply);
}

/** 登录页铺天空：标签栏换成天空的颜色。 */
export function setSky(on: boolean) {
  sky = on;
  syncThemeColor();
}

/** 窗框换成这个空间的颜色；不在空间里（「我的 Pupu」、资料、设置）用 canvas。 */
export function setFrame(color: string | null) {
  if (color) document.documentElement.dataset.frame = color;
  else delete document.documentElement.dataset.frame;
  syncThemeColor();
}
