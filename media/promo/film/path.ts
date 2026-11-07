/** 镜头和光流的路径工具。 */
import type { Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";

export const clamp = (x: number, a = 0, b = 1) => Math.min(Math.max(x, a), b);
export const smooth = (a: number, b: number, x: number) => {
  const c = clamp((x - a) / (b - a));
  return c * c * (3 - 2 * c);
};
export const smoother = (a: number, b: number, x: number) => {
  const c = clamp((x - a) / (b - a));
  return c * c * c * (c * (c * 6 - 15) + 10);
};
export const mix = (a: number, b: number, k: number) => a + (b - a) * k;
export const mix3 = (a: Vec3, b: Vec3, k: number): Vec3 => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

export function bezier(a: Vec3, b: Vec3, c: Vec3, d: Vec3, t: number): Vec3 {
  const q = 1 - t;
  const w0 = q * q * q;
  const w1 = 3 * q * q * t;
  const w2 = 3 * q * t * t;
  const w3 = t * t * t;
  return [a[0] * w0 + b[0] * w1 + c[0] * w2 + d[0] * w3, a[1] * w0 + b[1] * w1 + c[1] * w2 + d[1] * w3, a[2] * w0 + b[2] * w1 + c[2] * w2 + d[2] * w3];
}

export type Key = { t: number; eye: Vec3; target: Vec3; fov: number; focus?: number; aperture?: number; roll?: number };

function catmull(p0: number, p1: number, p2: number, p3: number, t0: number, t1: number, t2: number, t3: number, t: number) {
  const m1 = ((p2 - p0) / (t2 - t0)) * (t2 - t1);
  const m2 = ((p3 - p1) / (t3 - t1)) * (t2 - t1);
  const u = (t - t1) / (t2 - t1);
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}

/** 按时间过关键帧的样条。 */
export function track(keys: Key[], t: number) {
  const last = keys.length - 1;
  let index = 0;
  while (index < last - 1 && t >= keys[index + 1]!.t) index += 1;
  const k1 = keys[index]!;
  const k2 = keys[index + 1]!;
  const k0 = keys[index - 1] ?? { ...k1, t: k1.t - (k2.t - k1.t) };
  const k3 = keys[index + 2] ?? { ...k2, t: k2.t + (k2.t - k1.t) };
  const tt = clamp(t, k1.t, k2.t);
  const at = (pick: (k: Key) => number) => catmull(pick(k0), pick(k1), pick(k2), pick(k3), k0.t, k1.t, k2.t, k3.t, tt);
  const vec = (pick: (k: Key) => Vec3): Vec3 => [at((k) => pick(k)[0]), at((k) => pick(k)[1]), at((k) => pick(k)[2])];
  return {
    eye: vec((k) => k.eye),
    target: vec((k) => k.target),
    fov: at((k) => k.fov),
    focus: at((k) => k.focus ?? 0),
    aperture: at((k) => k.aperture ?? 0),
    roll: at((k) => k.roll ?? 0)
  };
}

/** 手持的微微晃动。 */
export function drift(t: number, seed: number): Vec3 {
  const n = (f: number, p: number) => Math.sin(t * f + p + seed) * 0.6 + Math.sin(t * f * 2.3 + p * 1.7 + seed) * 0.4;
  return [n(0.7, 0.3), n(0.9, 1.9), n(0.6, 3.7)];
}
