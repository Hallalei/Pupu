/** 3D 场景的矩阵和镜头。只算数，不碰画布。 */

export type Mat4 = Float32Array;

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export const chain = (...matrices: Mat4[]) => matrices.reduce(multiply);

export function translate(x: number, y: number, z: number): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

export function scale(s: number): Mat4 {
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
}

export function rotateX(a: number): Mat4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

export function rotateY(a: number): Mat4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

export function rotateZ(a: number): Mat4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
}

export function ortho(size: number, near: number, far: number): Mat4 {
  return new Float32Array([1 / size, 0, 0, 0, 0, 1 / size, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
}

export type Vec3 = [number, number, number];

export function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function lookAt(eye: Vec3, target: Vec3): Mat4 {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1]);
}

export function invert(m: Mat4): Mat4 {
  const r = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[] as [
    number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number
  ];
  const b = [
    a00 * a11 - a01 * a10, a00 * a12 - a02 * a10, a00 * a13 - a03 * a10, a01 * a12 - a02 * a11, a01 * a13 - a03 * a11, a02 * a13 - a03 * a12,
    a20 * a31 - a21 * a30, a20 * a32 - a22 * a30, a20 * a33 - a23 * a30, a21 * a32 - a22 * a31, a21 * a33 - a23 * a31, a22 * a33 - a23 * a32
  ] as [number, number, number, number, number, number, number, number, number, number, number, number];
  const det = 1 / (b[0] * b[11] - b[1] * b[10] + b[2] * b[9] + b[3] * b[8] - b[4] * b[7] + b[5] * b[6]);
  r[0] = (a11 * b[11] - a12 * b[10] + a13 * b[9]) * det;
  r[1] = (a02 * b[10] - a01 * b[11] - a03 * b[9]) * det;
  r[2] = (a31 * b[5] - a32 * b[4] + a33 * b[3]) * det;
  r[3] = (a22 * b[4] - a21 * b[5] - a23 * b[3]) * det;
  r[4] = (a12 * b[8] - a10 * b[11] - a13 * b[7]) * det;
  r[5] = (a00 * b[11] - a02 * b[8] + a03 * b[7]) * det;
  r[6] = (a32 * b[2] - a30 * b[5] - a33 * b[1]) * det;
  r[7] = (a20 * b[5] - a22 * b[2] + a23 * b[1]) * det;
  r[8] = (a10 * b[10] - a11 * b[8] + a13 * b[6]) * det;
  r[9] = (a01 * b[8] - a00 * b[10] - a03 * b[6]) * det;
  r[10] = (a30 * b[4] - a31 * b[2] + a33 * b[0]) * det;
  r[11] = (a21 * b[2] - a20 * b[4] - a23 * b[0]) * det;
  r[12] = (a11 * b[7] - a10 * b[9] - a12 * b[6]) * det;
  r[13] = (a00 * b[9] - a01 * b[7] + a02 * b[6]) * det;
  r[14] = (a31 * b[1] - a30 * b[3] - a32 * b[0]) * det;
  r[15] = (a20 * b[3] - a21 * b[1] + a22 * b[0]) * det;
  return r;
}

export const CENTER: Vec3 = [12.5, 10.5, 0];

const FOV = (24 * Math.PI) / 180;
const HALF = Math.tan(FOV / 2);
const NEED_WIDTH = 20;
const NEED_HEIGHT = 17;
const BASE_YAW = -0.34;
const BASE_PITCH = 0.1;
const SWAY_SECONDS = 24; // 镜头来回一趟
const SWAY_YAW = 0.09;
/** 天上的东西跟着镜头转多少。全不跟，远处的月亮在窄面板里会摆出画面。 */
const SKY_FOLLOW = 0.6;

/** 画面上的位置：x、y 是相对画面半宽半高的比例，behind 是比猫远多少。 */
type SkySpot = { x: number; y: number; behind: number };

export const MOON_SIZE = 1.7;
const MOON: SkySpot = { x: -0.42, y: 0.62, behind: 360 };

/** 远处的小气泡。光点在它们和大气泡之间走。 */
export const FAR_BUBBLES: (SkySpot & { size: number; phase: number })[] = [
  { x: 0.3, y: 0.72, behind: 90, size: 0.6, phase: 0.4 },
  { x: 0.6, y: 0.42, behind: 100, size: 0.55, phase: 1.9 },
  { x: -0.05, y: 0.84, behind: 200, size: 0.55, phase: 3.1 },
  { x: 0.64, y: 0.82, behind: 220, size: 0.5, phase: 4.6 }
];

function orbit(target: Vec3, distance: number, yaw: number, pitch: number): Vec3 {
  return [
    target[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.cos(yaw) * Math.cos(pitch) * distance
  ];
}

/** 这一刻的镜头和天上每样东西的位置。窗口宽高比变了，天上的东西跟着画面走，不会出画。 */
export function camera(t: number, aspect: number) {
  const distance = Math.max(NEED_WIDTH / (HALF * aspect), NEED_HEIGHT / HALF);
  const lift = (distance * HALF - NEED_HEIGHT) * 0.84;
  const sway = Math.sin((t / SWAY_SECONDS) * Math.PI * 2) * SWAY_YAW;
  const pitch = BASE_PITCH + Math.sin((t / SWAY_SECONDS) * Math.PI * 4) * 0.018;
  const target: Vec3 = [CENTER[0], CENTER[1] + lift, CENTER[2]];
  const eye = orbit(target, distance, BASE_YAW + sway, pitch);

  const skyEye = orbit(target, distance, BASE_YAW + sway * SKY_FOLLOW, BASE_PITCH);
  const forward = normalize([target[0] - skyEye[0], target[1] - skyEye[1], target[2] - skyEye[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const place = ({ x, y, behind }: SkySpot): Vec3 => {
    const depth = distance + behind;
    const across = x * HALF * aspect * depth;
    const above = y * HALF * depth;
    return [0, 1, 2].map((axis) => skyEye[axis]! + forward[axis]! * depth + right[axis]! * across + up[axis]! * above) as Vec3;
  };

  return {
    eye,
    viewProjection: chain(perspective(FOV, aspect, 4, 900), lookAt(eye, target)),
    moonAt: place(MOON),
    farAt: FAR_BUBBLES.map(place)
  };
}
