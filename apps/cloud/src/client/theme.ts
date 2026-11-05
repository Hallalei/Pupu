/** HeroUI 靠 html 上的 dark 类切深色。系统是深色，或者在私聊里，都用深色那组。 */
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
