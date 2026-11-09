/** 片子才有的模型。Pupu 本体全部来自产品的 pupu-voxels.ts，这里只加气泡、头像和云。 */
import { MAIN, PALETTE, cubeGrid, mesh, type Mesh } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import { line, type Line } from "./text.ts";

// 头像底色来自官网 site.css。mesh() 按字母查色板，这里把片子要的颜色加进去，不改产品文件。
Object.assign(PALETTE, { A: "#34557f", Z: "#ad7638", Y: "#4b7f6a", I: "#17181e", X: "#ffffff" });

type Grid = ReturnType<typeof cubeGrid>;

/** pupu-voxels 没导出 Grid，从它造出来的实例上拿构造函数。 */
export function newGrid(): Grid {
  const Made = cubeGrid("X").constructor as new () => Grid;
  return new Made();
}

/** 圆角矩形里的格子。 */
function inside(x: number, y: number, w: number, h: number, r: number) {
  const dx = x < r ? r - x - 0.5 : x >= w - r ? x - (w - r) + 0.5 : 0;
  const dy = y < r ? r - y - 0.5 : y >= h - r ? y - (h - r) + 0.5 : 0;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 聊天气泡。正面在 z=0，厚度往后长，边缘收一圈，和 Pupu 的大气泡一个样子。
 * 右下或左下带一个小尾巴。pivot 取中心，模型原点就是气泡正面中心。
 */
export function chatBubble(w: number, h: number, depth: number, tail: "left" | "right" | "none" = "left"): Mesh {
  const grid = newGrid();
  const r = Math.min(7, Math.floor(h / 3));
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!inside(x, y, w, h, r)) continue;
      const rim = !inside(x, y, w, h, r) || !inside(x - 1, y, w, h, r) || !inside(x + 1, y, w, h, r) || !inside(x, y - 1, w, h, r) || !inside(x, y + 1, w, h, r);
      for (let z = -depth; z < 0; z++) {
        if (rim && (z === -1 || z === -depth)) continue;
        grid.set(x, y, z, z === -1 || (z === -2 && rim) ? "W" : "w");
      }
    }
  }
  if (tail !== "none") {
    const size = Math.round(h * 0.34);
    for (let step = 0; step < size; step++) {
      const reach = size - step;
      for (let k = 0; k < reach; k++) {
        const x = tail === "left" ? r + k : w - r - 1 - k;
        const y = -1 - step;
        for (let z = -depth + 1; z < -1; z++) grid.set(x, y, z, z === -2 ? "W" : "w");
      }
    }
  }
  return mesh(grid, [w / 2, h / 2, 0]);
}

/** 圆头像：一块圆饼，字的格子凸出来。 */
export function avatar(color: string, letter: Line | null, radius = 12, depth = 4): Mesh {
  const grid = newGrid();
  const size = radius * 2;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const dx = x - radius + 0.5;
      const dy = y - radius + 0.5;
      if (dx * dx + dy * dy > radius * radius) continue;
      for (let z = -depth; z < 0; z++) grid.set(x, y, z, color);
    }
  }
  if (letter) {
    const ox = Math.round(radius - letter.width / 2);
    const oy = radius - 7;
    for (const cell of letter.cells) grid.set(cell.x + ox, cell.y + oy, 0, "c");
  }
  return mesh(grid, [radius, radius, 0]);
}

/** 句子上的高亮：一块薄片，和官网 mark 一个意思。颜色由实例的色调给。 */
export function slab(w: number, h: number): Mesh {
  const grid = newGrid();
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    if ((x === 0 || x === w - 1) && (y === 0 || y === h - 1)) continue;
    grid.set(x, y, 0, "X");
  }
  return mesh(grid, [w / 2, h / 2, 0]);
}

/** Pupu 的头像：深色圆饼上一张像素小猫脸，和官网 Cat 的 head 变体同一块像素。 */
export function avatarPupu(radius = 12, depth = 4): Mesh {
  const grid = newGrid();
  const size = radius * 2;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const dx = x - radius + 0.5;
      const dy = y - radius + 0.5;
      if (dx * dx + dy * dy > radius * radius) continue;
      for (let z = -depth; z < 0; z++) grid.set(x, y, z, "I");
    }
  }
  for (let row = 1; row <= 13; row++) {
    for (let column = 4; column < 20; column++) {
      const cell = MAIN[row]![column]!;
      if (cell === "." || "Wwk".includes(cell)) continue;
      grid.set(column, size - 5 - row, 0, cell);
    }
  }
  return mesh(grid, [radius, radius, 0]);
}

/** 太阳：和月亮一样是一块像素圆盘，没有环形山。 */
export function disc(radius = 9): Mesh {
  const grid = newGrid();
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      if (x * x + y * y > radius * radius + 5) continue;
      grid.set(x, y, 0, "X");
    }
  }
  return mesh(grid);
}

export function cube(color: string): Mesh {
  return mesh(cubeGrid(color), [0.5, 0.5, 0.5]);
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * 体素的台阶法线一照就是一道道条纹。这里把占位图模糊一遍，取梯度当法线：
 * 轮廓还是方块，明暗却像一团真的云。高度和朝向再压进遮蔽值。
 */
function smoothCloud(made: Mesh, grid: Grid, w: number, h: number, d: number) {
  const M = 8;
  const sx = w + M * 2;
  const sy = h + M * 2;
  const sz = d + M * 2;
  let field = new Float32Array(sx * sy * sz);
  const at = (x: number, y: number, z: number) => (z * sy + y) * sx + x;
  for (const [x, y, z] of grid.entries()) {
    const ix = x + (w >> 1) + M;
    const iy = y + M;
    const iz = z + (d >> 1) + M;
    if (ix >= 0 && iy >= 0 && iz >= 0 && ix < sx && iy < sy && iz < sz) field[at(ix, iy, iz)] = 1;
  }
  const R = 4;
  const blur = (stride: number, count: number, lines: (emit: (start: number) => void) => void) => {
    const out = new Float32Array(field.length);
    lines((start) => {
      let sum = 0;
      for (let i = -R; i <= R; i++) if (i >= 0 && i < count) sum += field[start + i * stride]!;
      for (let i = 0; i < count; i++) {
        out[start + i * stride] = sum / (R * 2 + 1);
        if (i + R + 1 < count) sum += field[start + (i + R + 1) * stride]!;
        if (i - R >= 0) sum -= field[start + (i - R) * stride]!;
      }
    });
    field = out;
  };
  for (let pass = 0; pass < 2; pass++) {
    blur(1, sx, (emit) => { for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) emit(at(0, y, z)); });
    blur(sx, sy, (emit) => { for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) emit(at(x, 0, z)); });
    blur(sx * sy, sz, (emit) => { for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) emit(at(x, y, 0)); });
  }
  const v = made.vertices;
  let top = 1;
  for (let i = 1; i < v.length; i += 11) top = Math.max(top, v[i]!);
  const cl = (value: number, high: number) => Math.min(Math.max(Math.round(value), 1), high - 2);
  for (let i = 0; i < v.length; i += 11) {
    const x = cl(v[i]! + (w >> 1) + M, sx);
    const y = cl(v[i + 1]! + M, sy);
    const z = cl(v[i + 2]! + (d >> 1) + M, sz);
    let nx = field[at(x - 1, y, z)]! - field[at(x + 1, y, z)]!;
    let ny = field[at(x, y - 1, z)]! - field[at(x, y + 1, z)]!;
    let nz = field[at(x, y, z - 1)]! - field[at(x, y, z + 1)]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    v[i + 3] = nx;
    v[i + 4] = ny;
    v[i + 5] = nz;
    const height = Math.min(Math.max(v[i + 1]! / top, 0), 1);
    const inner = 1 - Math.min(Math.max((field[at(x, y, z)]! - 0.34) * 2.6, 0), 1);
    v[i + 9] = (0.3 + 0.7 * height ** 0.7) * (0.45 + 0.55 * inner) * (v[i + 9]! * 0.25 + 0.75);
  }
}

/**
 * 积云：底下平，上面一团团鼓起来。比登录页的云细，要贴着镜头飞过去。
 * 高度带来的明暗写进每个顶点的遮蔽值，夜里和清晨只换色调。
 */
export function cumulus(seed: number, w = 120, h = 56, d = 84): Mesh {
  const next = random(seed * 7919 + 13);
  const grid = newGrid();
  const fill = (cx: number, cy: number, cz: number, r: number, squash: number) => {
    const ry = r * squash;
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      for (let z = Math.floor(cz - r); z <= cz + r; z++) {
        for (let y = Math.max(0, Math.floor(cy - ry)); y <= cy + ry; y++) {
          if (((x - cx) / r) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / r) ** 2 > 1) continue;
          grid.set(x - (w >> 1), y, z - (d >> 1), "X");
        }
      }
    }
  };
  const lumps: [number, number, number, number][] = [];
  const big = 6 + Math.floor(next() * 3);
  for (let index = 0; index < big; index++) {
    const a = (index / big) * Math.PI * 2 + next();
    const spread = next() ** 0.6;
    const cx = w / 2 + Math.cos(a) * spread * w * 0.32;
    const cz = d / 2 + Math.sin(a) * spread * d * 0.3;
    const r = (15 + next() * 11) * (1.1 - spread * 0.45);
    const cy = r * 0.4;
    lumps.push([cx, cy, cz, r]);
    fill(cx, cy, cz, r, 0.82);
  }
  for (let index = 0; index < 54; index++) {
    const [cx, cy, cz, r] = lumps[Math.floor(next() * lumps.length)]!;
    const a = next() * Math.PI * 2;
    const b = next() * 1.2;
    const s = r * (0.3 + next() * 0.32);
    fill(cx + Math.cos(a) * Math.cos(b) * r * 0.86, cy + Math.sin(b) * r * 0.74, cz + Math.sin(a) * Math.cos(b) * r * 0.86, s, 0.88);
  }
  const made = mesh(grid);
  smoothCloud(made, grid, w, h, d);
  return made;
}

export { line };
