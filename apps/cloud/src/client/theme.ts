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
}
