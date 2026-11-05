// 配对窗口左边的动画，和网页登录页同一份。CSP 不让内联脚本，打成 dist/pair-art.js。
import { mountPupuArt } from "../../cloud/src/client/pupu-art.ts";

mountPupuArt(document.getElementById("art") as HTMLCanvasElement);
