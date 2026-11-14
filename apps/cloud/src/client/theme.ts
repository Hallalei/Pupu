/**
 * HeroUI 和样式表都靠 html 上的 dark 类切深色，跟着系统走。
 * 登录页是品牌层，铺的是夜空，`setNight` 让它也用深色那组。
 */
const system = window.matchMedia("(prefers-color-scheme: dark)");
let night = false;

function apply() {
  const dark = system.matches || night;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  syncThemeColor();
}

/** 浏览器标签栏和手机状态栏的颜色跟着窗框走；登录页铺的是夜空，用天空最上面那一档。 */
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(night ? "--color-sky-1" : "--color-frame")
    .trim();
  if (!color) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = color;
}

export function followSystemTheme() {
  apply();
  system.addEventListener("change", apply);
}

export function setNight(on: boolean) {
  night = on;
  apply();
}

/** 窗框换成这个空间的颜色；不在空间里（「我的 Pupu」、资料、设置）用 canvas。 */
export function setFrame(color: string | null) {
  if (color) document.documentElement.dataset.frame = color;
  else delete document.documentElement.dataset.frame;
  syncThemeColor();
}
