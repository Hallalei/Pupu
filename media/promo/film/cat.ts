/** 把 Pupu 摆出来。姿势和登录页 pupu-art.ts 的 pose 一样：呼吸、头、耳朵、尾巴、三个点。 */
import { chain, rotateX, rotateY, rotateZ, scale, translate, type Mat4, type Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";
import { BUBBLE_FRONT, bodyGrid, bubbleGrid, cubeGrid, dotGrid, earGrid, headGrid, mesh, moonGrid, pawsGrid, type Eyes, type Mesh } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import type { Sink } from "./stage.ts";

const HEAD_PIVOT: Vec3 = [12, 11, -5];
const EAR_LEFT_PIVOT: Vec3 = [7, 20, -3];
const EAR_RIGHT_PIVOT: Vec3 = [17, 20, -3];
const DOT_COLUMNS = [8, 11, 14];

export function catMeshes(): Record<string, { mesh: Mesh; caster?: boolean }> {
  const out: Record<string, { mesh: Mesh; caster?: boolean }> = {};
  for (const eyes of ["open", "half", "closed", "right"] as const) out[`head-${eyes}`] = { mesh: mesh(headGrid(eyes), HEAD_PIVOT) };
  out.earLeft = { mesh: mesh(earGrid("left"), EAR_LEFT_PIVOT) };
  out.earRight = { mesh: mesh(earGrid("right"), EAR_RIGHT_PIVOT) };
  out.catBubble = { mesh: mesh(bubbleGrid()) };
  out.dot = { mesh: mesh(dotGrid()) };
  out.paws = { mesh: mesh(pawsGrid()) };
  out.body = { mesh: mesh(bodyGrid()) };
  out.tailFur = { mesh: mesh(cubeGrid("g"), [0.5, 0.5, 0.5]) };
  out.tailDark = { mesh: mesh(cubeGrid("D"), [0.5, 0.5, 0.5]) };
  out.tailLight = { mesh: mesh(cubeGrid("c"), [0.5, 0.5, 0.5]) };
  out.moon = { mesh: mesh(moonGrid()), caster: false };
  return out;
}

const bump = (t: number, from: number, to: number, ramp: number) => {
  const smooth = (x: number) => {
    const c = Math.min(Math.max(x, 0), 1);
    return c * c * (3 - 2 * c);
  };
  return smooth((t - from) / ramp) * (1 - smooth((t - to + ramp) / ramp));
};

export type CatPose = {
  eyes: Eyes;
  /** 转头看右边的量，0 到 1。 */
  glance: number;
  /** 右耳抖的量，0 到 1。 */
  flick: number;
  /** 三个点露出来的量。 */
  dots: number;
  /** 气泡发光。 */
  glow: number;
  /** 三个点亮起来：Pupu 在想。 */
  dotGlow?: number;
};

export function drawCat(sink: Sink, base: Mat4, t: number, pose: CatPose) {
  const breath = Math.sin((t / 4) * Math.PI * 2);
  const root = chain(base, translate(0, Math.sin((t / 8) * Math.PI * 2) * 0.35, 0), rotateZ(Math.sin((t / 12) * Math.PI * 2) * 0.008));
  const head = chain(
    root,
    translate(HEAD_PIVOT[0], HEAD_PIVOT[1] + breath * 0.14, HEAD_PIVOT[2]),
    rotateY(pose.glance * 0.26 + Math.sin((t / 12) * Math.PI * 2) * 0.03),
    rotateX(breath * 0.012 + pose.glance * 0.02)
  );
  const from = (pivot: Vec3) => translate(pivot[0] - HEAD_PIVOT[0], pivot[1] - HEAD_PIVOT[1], pivot[2] - HEAD_PIVOT[2]);
  sink.put("catBubble", root, [1, 1, 1], pose.glow);
  sink.put("paws", root);
  sink.put("body", chain(root, translate(0, breath * 0.08, 0)));
  sink.put(`head-${pose.eyes}`, head);
  sink.put("earLeft", chain(head, from(EAR_LEFT_PIVOT)));
  sink.put("earRight", chain(head, from(EAR_RIGHT_PIVOT), rotateZ(-pose.flick * 0.24)));
  if (pose.dots > 0.01) {
    DOT_COLUMNS.forEach((column, index) => {
      const phase = (t / 2 - index * 0.16 + 10) % 1;
      const pop = bump(phase, 0, 0.42, 0.2);
      const hot = pose.dotGlow ?? 0;
      const lit: Vec3 = [1 + hot * 5, 1 + hot * 3, 1 + hot * 0.8];
      sink.put("dot", chain(root, translate(column, 5, BUBBLE_FRONT - 0.6 + pop * 0.85 * pose.dots - (1 - pose.dots) * 0.5)), lit, hot * 3.2, 1, 0, 1);
    });
  }
  for (let index = 0; index < 11; index++) {
    const swing = Math.sin((t / 5) * Math.PI * 2 - index * 0.42) * index * 0.1;
    const part = index === 10 ? "tailLight" : index % 4 === 3 ? "tailDark" : "tailFur";
    sink.put(part, chain(root, translate(8 - index * 1 + swing, 7 + index * index * 0.09, -9), scale(2.3 - index * 0.03)));
  }
  return root;
}

export function blink(t: number, moments: number[]): Eyes | null {
  for (const start of moments) {
    const step = t - start;
    if (step >= 0.09 && step < 0.18) return "closed";
    if (step >= 0 && step < 0.27) return "half";
  }
  return null;
}
export { bump };
