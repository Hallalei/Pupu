/**
 * 这栋楼就是 Pupu 的图标：24×24 的像素，一格一个房间，房间的墙刷成那一格的颜色。
 * 走在里面只觉得这家公司爱用撞色，退到云外才看出那是一张脸。
 */
import { chain, rotateY, translate, type Mat4, type Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";
import { MAIN, PALETTE, mesh, type Mesh } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import { newGrid } from "../film/models.ts";
import type { Sink } from "../film/stage.ts";
import { S } from "./cast.ts";

export const CELL = 48;
export const DEPTH = 44;
export const SLAB = 3;
export const WALL = 2;
export const BACK = -230;

export type Cell = { col: number; row: number; ch: string; x: number; y: number; z: number; tint: Vec3; index: number };

export const hex = (value: string): Vec3 => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255) as Vec3;
const dim = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];

export const cx = (col: number) => (col - 12) * CELL + CELL / 2;
export const fy = (row: number) => (21 - row) * CELL + SLAB;

function planeOf(col: number, row: number): number {
  if (row <= 12) return 0;
  const paw = (col >= 4 && col <= 8) || (col >= 15 && col <= 19);
  if (row <= 15 && paw) return 66;
  if (row === 13) return 0;
  return 36;
}

export const CELLS: Cell[] = [];
const byKey = new Map<string, Cell>();
export const cellAt = (col: number, row: number) => byKey.get(`${col}:${row}`);

MAIN.forEach((text, row) => {
  [...text].forEach((ch, col) => {
    if (ch === ".") return;
    const cell: Cell = { col, row, ch, x: (col - 12) * CELL, y: (21 - row) * CELL, z: planeOf(col, row), tint: hex(PALETTE[ch]!), index: CELLS.length };
    CELLS.push(cell);
    byKey.set(`${col}:${row}`, cell);
  });
});

/** 隔断：key 是这格左边那堵墙。 */
export const OPEN = new Set<string>(["11:8", "12:8", "13:8", "12:11", "14:11", "14:12"]);
export const FLAP = new Set<string>(["9:8", "10:8", "13:11"]);
export const DOOR = new Set<string>(["8:8", "11:11"]);
/** 地板上的洞：key 是洞所在的那一格，落到下一层。 */
export const HATCH = new Set<string>(["13:8", "13:9", "13:10", "14:11"]);

type Item = { name: string; m: Mat4; tint: Vec3; cell: number; glow: number };
const STATIC: Item[] = [];

function block(cell: Cell, cxx: number, cyy: number, czz: number, w: number, h: number, d: number, tint: Vec3, glow = 0, name = "cube") {
  STATIC.push({ name, m: chain(translate(cxx, cyy, czz), S(w, h, d)), tint, cell: cell.index, glow });
}

function floor(cell: Cell, wall: Vec3) {
  const { x, y, z } = cell;
  const tint = dim(wall, 0.72);
  const cy = y + SLAB / 2;
  const front = z;
  const depth = DEPTH;
  if (HATCH.has(`${cell.col}:${cell.row}`)) {
    const c = x + CELL / 2;
    const hole = 9;
    const back = z - 28;
    const near = z - 12;
    block(cell, c - (CELL / 2 + hole) / 2, cy, z - depth / 2, CELL / 2 - hole, SLAB, depth, tint);
    block(cell, c + (CELL / 2 + hole) / 2, cy, z - depth / 2, CELL / 2 - hole, SLAB, depth, tint);
    block(cell, c, cy, (near + front) / 2, hole * 2, SLAB, front - near, tint);
    block(cell, c, cy, (back + z - depth) / 2, hole * 2, SLAB, back - (z - depth), tint);
    return;
  }
  block(cell, x + CELL / 2, cy, z - depth / 2, CELL, SLAB, depth, tint);
}

function partition(cell: Cell, left: boolean) {
  const { x, y, z, tint } = cell;
  const wx = left ? x : x + CELL;
  const key = `${cell.col + (left ? 0 : 1)}:${cell.row}`;
  if (OPEN.has(key)) return;
  const wall = dim(tint, 0.86);
  const h = CELL - SLAB;
  const cy = y + SLAB + h / 2;
  const door = DOOR.has(key);
  if (!FLAP.has(key) && !door) {
    block(cell, wx, cy, z - DEPTH / 2, WALL, h, DEPTH, wall, 0.6);
    return;
  }
  const hole = door ? 32 : 16;
  const a = door ? z - 12 : z - 13;
  const b = door ? z - 32 : z - 29;
  block(cell, wx, y + SLAB + hole + (h - hole) / 2, z - DEPTH / 2, WALL, h - hole, DEPTH, wall, 0.6);
  block(cell, wx, y + SLAB + hole / 2, (z + a) / 2, WALL, hole, z - a, wall, 0.6);
  block(cell, wx, y + SLAB + hole / 2, (b + z - DEPTH) / 2, WALL, hole, b - (z - DEPTH), wall, 0.6);
}

for (const cell of CELLS) {
  const { x, y, z, tint, col, row } = cell;
  block(cell, x + CELL / 2, y + CELL / 2, z - DEPTH - 1, CELL, CELL, 2, tint, 1);
  block(cell, x + CELL / 2, y + CELL / 2, (z - DEPTH - 2 + BACK) / 2, CELL, CELL, z - DEPTH - 2 - BACK, dim(tint, 0.8));
  floor(cell, tint);
  const up = cellAt(col, row - 1);
  if (!up || up.z !== z) block(cell, x + CELL / 2, y + CELL + SLAB / 2, z - DEPTH / 2, CELL, SLAB, DEPTH, dim(tint, 0.72));
  const left = cellAt(col - 1, row);
  if (left?.z === z) partition(cell, true);
  else {
    partition(cell, true);
  }
  const right = cellAt(col + 1, row);
  if (!right || right.z !== z) partition(cell, false);
}

const SHELLS = STATIC.length;
const HERO = new Set(["8:8", "9:8", "10:8", "11:8", "12:8", "13:8", "13:9", "13:10", "11:11", "12:11", "13:11", "14:11", "13:12", "14:12"]);
const SHIRTS: Vec3[] = [[0.25, 0.36, 0.55], [0.62, 0.26, 0.24], [0.2, 0.46, 0.42], [0.86, 0.84, 0.8], [0.34, 0.3, 0.42], [0.8, 0.56, 0.24], [0.42, 0.48, 0.56]];
const PANTS: Vec3[] = [[0.2, 0.2, 0.26], [0.3, 0.26, 0.24], [0.24, 0.28, 0.36]];
const HAIR = ["pShort", "pPart", "pBob", "pLong", "pBun", "pBald", "pCurly", "pRed", "pBobR"];
const noise = (n: number) => {
  const v = Math.sin(n * 12.9898 + 4.1) * 43758.5453;
  return v - Math.floor(v);
};

export type Seat = { cell: Cell; head: string; shirt: Vec3; pants: Vec3; x: number; y: number; z: number; yaw: number; phase: number };
export const SEATS: Seat[] = [];

/** 普通房间：一张桌子一个人，或者一盆植物。谁也不是主角，人多了楼才像活的。 */
function furnish(cell: Cell) {
  const { col, row, x, y, z, tint } = cell;
  if (HERO.has(`${col}:${row}`)) return;
  const n = cell.index * 7.13;
  const cxx = x + CELL / 2;
  const floorY = y + SLAB;
  const dir = noise(n) < 0.5 ? 1 : -1;
  const poster: Vec3 = noise(n + 1) < 0.5 ? [0.96, 0.93, 0.86] : dim(tint, 0.68);
  block(cell, cxx + (noise(n + 2) - 0.5) * 20, floorY + 27, z - DEPTH + 0.4, 9 + noise(n + 3) * 7, 11 + noise(n + 4) * 6, 0.5, poster, 0.9);
  block(cell, cxx, y + CELL - 2.5, z - 20, 0.5, 5, 0.5, [0.25, 0.25, 0.28]);
  block(cell, cxx, y + CELL - 6, z - 20, 8, 2.4, 8, [0.97, 0.93, 0.8], 3);
  if (noise(n + 5) > 0.74) {
    STATIC.push({ name: "plant", m: chain(translate(cxx + dir * 10, floorY, z - 26), S(0.9, 0.9, 0.9)), tint: [1, 1, 1], cell: cell.index, glow: 0 });
    block(cell, cxx - dir * 8, floorY + 13, z - 41, 18, 26, 5, dim(tint, 0.6));
    return;
  }
  const dz = z - 24;
  const wood: Vec3 = [0.74, 0.56, 0.38];
  block(cell, cxx - dir * 9, floorY + 11.4, dz, 18, 1.2, 22, wood);
  block(cell, cxx - dir * 16, floorY + 5.4, dz - 8, 1.2, 10.8, 1.2, [0.3, 0.31, 0.35]);
  block(cell, cxx - dir * 16, floorY + 5.4, dz + 8, 1.2, 10.8, 1.2, [0.3, 0.31, 0.35]);
  block(cell, cxx - dir * 2, floorY + 5.4, dz - 8, 1.2, 10.8, 1.2, [0.3, 0.31, 0.35]);
  block(cell, cxx - dir * 2, floorY + 5.4, dz + 8, 1.2, 10.8, 1.2, [0.3, 0.31, 0.35]);
  const yaw = dir * 0.9;
  const m = chain(translate(cxx - dir * 13, floorY + 12, dz), rotateY(yaw));
  STATIC.push({ name: "cube", m: chain(m, translate(0, 2.2, -0.6), S(1, 3.4, 1)), tint: [0.3, 0.31, 0.35], cell: cell.index, glow: 0 });
  STATIC.push({ name: "cube", m: chain(m, translate(0, 7.8, -0.5), S(13.6, 8.8, 0.8)), tint: [0.13, 0.13, 0.16], cell: cell.index, glow: 0 });
  STATIC.push({ name: "cube", m: chain(m, translate(0, 7.8, 0), S(12.6, 7.8, 0.14)), tint: [0.72, 0.82, 0.95], cell: cell.index, glow: 2 });
  block(cell, cxx + dir * 8, floorY + 7, dz, 7.6, 1.2, 7.6, [0.3, 0.32, 0.36]);
  block(cell, cxx + dir * 8, floorY + 3.4, dz, 1.2, 6.4, 1.2, [0.3, 0.31, 0.35]);
  SEATS.push({
    cell,
    head: HAIR[Math.floor(noise(n + 6) * HAIR.length)]!,
    shirt: SHIRTS[Math.floor(noise(n + 7) * SHIRTS.length)]!,
    pants: PANTS[Math.floor(noise(n + 8) * PANTS.length)]!,
    x: cxx + dir * 8,
    y: floorY,
    z: dz,
    yaw: -dir * 1.05,
    phase: noise(n + 9) * 9
  });
}

for (const cell of CELLS) furnish(cell);

/** 墙上的光：lit 是这间屋开灯的量。 */
export function drawShell(sink: Sink, lit: Float32Array, gain: number, clean = 0, recolor?: (cell: Cell) => Vec3 | null) {
  STATIC.forEach((item, index) => {
    const on = lit[item.cell]! * gain;
    const cell = CELLS[item.cell]!;
    const swap = recolor?.(cell);
    const base: Vec3 = swap ? [0, 1, 2].map((at) => (item.tint[at]! / Math.max(cell.tint[at]!, 0.01)) * swap[at]!) as Vec3 : item.tint;
    if (index < SHELLS || clean <= 0) {
      sink.put(item.name, item.m, base, item.glow * on);
      return;
    }
    /* 退得够远，屋里的东西就化进墙色，只剩一格一格的像素。 */
    if (clean >= 0.99) return;
    const wall = swap ?? cell.tint;
    const tint: Vec3 = [0, 1, 2].map((at) => item.tint[at]! + (wall[at]! - item.tint[at]!) * clean) as Vec3;
    sink.put(item.name, item.name === "plant" ? chain(item.m, S(1 - clean, 1 - clean, 1 - clean)) : item.m, tint, (item.glow + (1 - item.glow) * clean) * on);
  });
}

export function box(sink: Sink, x: number, y: number, z: number, w: number, h: number, d: number, tint: Vec3, glow = 0) {
  sink.put("cube", chain(translate(x, y, z), S(w, h, d)), tint, glow);
}

export function boxIn(sink: Sink, m: Mat4, x: number, y: number, z: number, w: number, h: number, d: number, tint: Vec3, glow = 0) {
  sink.put("cube", chain(m, translate(x, y, z), S(w, h, d)), tint, glow);
}

const WOOD: Vec3 = [0.74, 0.56, 0.38];
const STEEL: Vec3 = [0.3, 0.31, 0.35];

export function desk(sink: Sink, x: number, y: number, z: number, w: number, d: number, tint: Vec3 = WOOD) {
  box(sink, x, y + 11.4, z, w, 1.2, d, tint);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sink, x + sx * (w / 2 - 1.2), y + 5.4, z + sz * (d / 2 - 1.2), 1.2, 10.8, 1.2, STEEL);
}

export function chair(sink: Sink, x: number, y: number, z: number, yaw: number, tint: Vec3) {
  const m = chain(translate(x, y, z), rotateY(yaw));
  boxIn(sink, m, 0, 7, 0.4, 7.6, 1.2, 7.6, tint);
  boxIn(sink, m, 0, 11.6, -3.4, 7.6, 8.4, 1.2, tint);
  boxIn(sink, m, 0, 3.4, 0, 1.2, 6.4, 1.2, STEEL);
  boxIn(sink, m, 0, 0.5, 0, 6.4, 1, 1.4, STEEL);
  boxIn(sink, m, 0, 0.5, 0, 1.4, 1, 6.4, STEEL);
}

export type Screen = "chart" | "code" | "blank" | "done";

export function monitor(sink: Sink, x: number, y: number, z: number, yaw: number, power: number, kind: Screen, t: number, color: Vec3 = [0.72, 0.82, 0.95]) {
  const m = chain(translate(x, y, z), rotateY(yaw));
  boxIn(sink, m, 0, 0.3, 0, 5, 0.6, 3.6, STEEL);
  boxIn(sink, m, 0, 2.2, -0.6, 1, 3.4, 1, STEEL);
  boxIn(sink, m, 0, 7.8, -0.5, 13.6, 8.8, 0.8, [0.13, 0.13, 0.16]);
  boxIn(sink, m, 0, 7.8, -0.02, 12.6, 7.8, 0.14, color, 0.95 * power);
  if (power < 0.03) return;
  const ink: Vec3 = [0.2, 0.26, 0.38];
  if (kind === "chart") {
    [2.2, 3.6, 2.8, 4.6, 5.8].forEach((h, index) => boxIn(sink, m, -4 + index * 2, 4.8 + h / 2, 0.1, 1.2, h, 0.1, [0.95, 0.72, 0.3], 1.4 * power));
  } else if (kind === "code") {
    for (let index = 0; index < 6; index++) {
      const shift = Math.floor(t * 9 + index);
      const w = 3 + ((shift * 7) % 5) * 1.5;
      boxIn(sink, m, -5.4 + w / 2, 10.4 - index * 1.1, 0.1, w, 0.5, 0.1, ink, 0.9 * power);
    }
  } else if (kind === "done") {
    boxIn(sink, m, -1.4, 7, 0.1, 0.9, 2.6, 0.1, [0.22, 0.72, 0.42], 1.6 * power);
    boxIn(sink, m, 1.2, 8.1, 0.1, 0.9, 5, 0.1, [0.22, 0.72, 0.42], 1.6 * power);
  }
}

export function propMeshes(): Record<string, { mesh: Mesh }> {
  const cup = newGrid();
  for (let y = 0; y < 7; y++) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (x * x + z * z > 11) continue;
    if (y >= 1 && x * x + z * z < 5) continue;
    cup.set(x, y, z, "X");
  }
  for (const [x, y] of [[4, 5], [5, 5], [5, 4], [5, 3], [5, 2], [4, 2]] as const) for (const z of [0]) cup.set(x, y, z, "X");

  const plant = newGrid();
  for (let y = 0; y < 5; y++) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (x * x + z * z <= 10) plant.set(x, y, z, "Z");
  }
  const blobs: [number, number, number, number][] = [[0, 9, 0, 3.6], [-3, 12, 1, 3], [3, 11, -1, 3.2], [0, 15, 0, 2.8], [2, 7, 3, 2.4], [-3, 8, -3, 2.4]];
  for (const [bx, by, bz, r] of blobs) {
    for (let x = -6; x <= 6; x++) for (let y = 4; y <= 19; y++) for (let z = -6; z <= 6; z++) {
      if ((x - bx) ** 2 + (y - by) ** 2 + (z - bz) ** 2 <= r * r) plant.set(x, y, z, (x + y + z) % 3 === 0 ? "e" : "E");
    }
  }
  return { cup: { mesh: mesh(cup) }, plant: { mesh: mesh(plant) } };
}
