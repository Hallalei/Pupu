/**
 * 登录页 3D 场景的模型：把图标的 24×24 像素图立起来，一格一个体素。只算数据，不碰画布。
 *
 * MAIN、PALETTE 抄自 design/icon/pixels.py，改了那边要同步过来，
 * apps/desktop/src/pupu-art.test.ts 会比对。
 * 每个角的遮蔽取法和翻对角线来自 noa 的 terrainMesher.js（packAOMask）。
 */

export const MAIN = [
  "........................",
  ".....O............O.....",
  ".....OO..........OO.....",
  ".....OdOO.OOOO.OOdO.....",
  ".....OpddOddddOddpO.....",
  ".....OppddddddddppO.....",
  ".....OdgdgdgdgdgdgO.....",
  "....OggeeggggggeeggO....",
  "....OgePheggggePhegO....",
  "....OgEPPEggggEPPEgO....",
  "....OllEElcccclEEllO....",
  ".....OlllccNNcclllO.....",
  ".....OllcncnncncllO.....",
  "....OOOOOOnOOnOOOOOO....",
  "...WOcccOWWWWWWOcccOW...",
  "..WWOoOoOWWWWWWOoOoOWW..",
  "..WWWWWWWWWWWWWWWWWWWW..",
  "..WWWWWWkkWkkWkkWWWWWW..",
  "..WWWWWWkkWkkWkkWWWWWW..",
  "..WWWWWWWWWWWWWWWWWWWW..",
  "...wwwwwwwwwwwwwwwwww...",
  ".....ww.................",
  "........................",
  "........................"
];

export const PALETTE: Record<string, string> = {
  D: "#7a532e",
  d: "#ad7638",
  g: "#d8a04e",
  l: "#eec57e",
  c: "#fae7c3",
  O: "#3b2717",
  o: "#8a5c35",
  E: "#4fae5a",
  e: "#2c7a3c",
  P: "#13201a",
  h: "#ffffff",
  N: "#d4826e",
  n: "#7d4a30",
  p: "#e8a090",
  W: "#f5f2ea",
  w: "#d6d0c4",
  k: "#3a3d48"
};

/** 场景才有的颜色：云的亮面、暗面，月亮。 */
const SCENE: Record<string, string> = { C: "#7686a6", B: "#465472", M: "#f4edd8", m: "#d9d0b8" };

/** 夜里自己亮一点的颜色，数字是自发光的强度。 */
const GLOW: Record<string, number> = { h: 0.4, E: 0.1, e: 0.06, W: 0.04, w: 0.03 };

export type Eyes = "open" | "half" | "closed" | "right";

/** 眼睛那一块：两只眼都从第 7 行开始，左眼第 6 列，右眼第 14 列，4×4 格。 */
const EYES: Record<Exclude<Eyes, "open">, string[]> = {
  half: ["gggg", "eeee", "EPPE", "lEEl"],
  closed: ["gggg", "gggg", "nggn", "lnnl"],
  right: ["geeg", "eePh", "EEPP", "lEEl"]
};

/** 换上某种眼睛后的像素图。「open」就是 MAIN。 */
export function art(eyes: Eyes): string[] {
  if (eyes === "open") return MAIN;
  const rows = MAIN.map((row) => [...row]);
  EYES[eyes].forEach((cells, index) => {
    [...cells].forEach((cell, offset) => {
      rows[7 + index]![6 + offset] = cell;
      rows[7 + index]![14 + offset] = cell;
    });
  });
  return rows.map((row) => row.join(""));
}

type Vec3 = [number, number, number];

/** 一块块体素。坐标：x 是列，y 是 23 减行号（往上为正），z 朝镜头为正。 */
class Grid {
  private cells = new Map<number, string>();

  private static key(x: number, y: number, z: number) {
    return (x + 512) | ((y + 512) << 10) | ((z + 512) << 20);
  }

  set(x: number, y: number, z: number, color: string) {
    this.cells.set(Grid.key(x, y, z), color);
  }

  has(x: number, y: number, z: number) {
    return this.cells.has(Grid.key(x, y, z));
  }

  get(x: number, y: number, z: number) {
    return this.cells.get(Grid.key(x, y, z));
  }

  *entries(): Generator<[number, number, number, string]> {
    for (const [key, color] of this.cells) {
      yield [(key & 1023) - 512, ((key >> 10) & 1023) - 512, ((key >> 20) & 1023) - 512, color];
    }
  }
}

/** 一个顶点 11 个数：位置 3、法线 3、颜色 3、遮蔽 1、自发光 1。 */
export const VERTEX_FLOATS = 11;

export type Mesh = { vertices: Float32Array; count: number };

const OCCLUSION = [0.5, 0.68, 0.84, 1];

function rgb(hex: string): Vec3 {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as Vec3;
}

/** 同一种颜色的体素明暗差一点点，看着像手搭的。 */
function grain(x: number, y: number, z: number) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return 0.97 + (n - Math.floor(n)) * 0.06;
}

/** 体素变成三角形：只出露在外面的面，每个角按挨着的体素压暗。 */
export function mesh(grid: Grid, pivot: Vec3 = [0, 0, 0]): Mesh {
  const out: number[] = [];
  for (const [x, y, z, name] of grid.entries()) {
    const color = rgb(PALETTE[name] ?? SCENE[name] ?? "#ff00ff");
    const shade = grain(x, y, z);
    const glow = GLOW[name] ?? 0;
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        const at: Vec3 = [x, y, z];
        const front: Vec3 = [x, y, z];
        front[axis] += sign;
        if (grid.has(...front)) continue;
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const corners = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1]
        ].map(([cu, cv]) => {
          const near = (du: number, dv: number) => {
            const cell: Vec3 = [...front];
            cell[u] += du;
            cell[v] += dv;
            return grid.has(...cell) ? 1 : 0;
          };
          const du = cu! ? 1 : -1;
          const dv = cv! ? 1 : -1;
          const a = near(du, 0);
          const b = near(0, dv);
          const open = a && b ? 0 : 3 - (a + b + near(du, dv));
          const position: Vec3 = [...at];
          if (sign > 0) position[axis] += 1;
          position[u] += cu!;
          position[v] += cv!;
          return { position, occlusion: OCCLUSION[open]! };
        });
        const [a, b, c, d] = corners as [(typeof corners)[0], (typeof corners)[0], (typeof corners)[0], (typeof corners)[0]];
        const order = a.occlusion + c.occlusion < b.occlusion + d.occlusion ? [b, c, d, b, d, a] : [a, b, c, a, c, d];
        const normal: Vec3 = [0, 0, 0];
        normal[axis] = sign;
        for (const corner of order) {
          out.push(
            corner.position[0] - pivot[0],
            corner.position[1] - pivot[1],
            corner.position[2] - pivot[2],
            ...normal,
            color[0] * shade,
            color[1] * shade,
            color[2] * shade,
            corner.occlusion,
            glow
          );
        }
      }
    }
  }
  return { vertices: new Float32Array(out), count: out.length / VERTEX_FLOATS };
}

const HEAD_DEPTH = 11;

/** 猫脸的轮廓：每格离最近的空格有几步，用来把边缘往里收，头就圆了。 */
function edgeDistance(rows: string[]): number[][] {
  const solid = (row: number, column: number) => rows[row]?.[column] !== undefined && rows[row]![column] !== ".";
  return rows.map((cells, row) =>
    [...cells].map((_, column) => {
      if (!solid(row, column)) return 0;
      for (let step = 1; step < 4; step++) {
        for (let dy = -step; dy <= step; dy++) {
          for (let dx = -step; dx <= step; dx++) {
            if (!solid(row + dy, column + dx)) return step;
          }
        }
      }
      return 4;
    })
  );
}

const isEar = (row: number, column: number) => row <= 3 && (column <= 8 || column >= 15);

/** 后脑勺和侧面的毛色：上深下浅，带虎斑。 */
function fur(row: number, column: number) {
  if (row <= 6) return column % 3 === 0 ? "d" : "g";
  if (row <= 9) return "g";
  return "l";
}

/** 头，耳朵除外。正脸在 z=0，图上的描边换成毛色，轮廓交给形状。 */
export function headGrid(eyes: Eyes): Grid {
  const rows = art(eyes).slice(0, 13);
  const edge = edgeDistance(rows.map((cells, row) => [...cells].map((cell, column) => (isEar(row, column) ? "." : cell)).join("")));
  const grid = new Grid();
  rows.forEach((cells, row) => {
    [...cells].forEach((cell, column) => {
      if (cell === "." || isEar(row, column)) return;
      // 额头往后斜，和耳朵接上。
      const slope = row <= 3 ? 2 : row === 4 ? 1 : 0;
      const inset = Math.max(edge[row]![column]! === 1 ? 1 : 0, slope);
      for (let depth = inset; depth < HEAD_DEPTH - inset; depth++) {
        const face = depth === inset && cell !== "O";
        grid.set(column, 23 - row, -depth, face ? cell : fur(row, column));
      }
    });
  });
  // 鼻子嘴巴往前顶一格。
  for (let row = 11; row <= 12; row++) {
    for (let column = 9; column <= 14; column++) grid.set(column, 23 - row, 1, MAIN[row]![column]!);
  }
  return grid;
}

/** 一只耳朵的上半截，比脸靠后；耳根和粉色在头上，耳朵抖的时候头不动。 */
export function earGrid(side: "left" | "right"): Grid {
  const grid = new Grid();
  for (let row = 1; row <= 3; row++) {
    for (let column = 0; column < 24; column++) {
      const cell = MAIN[row]![column]!;
      if (cell === "." || !isEar(row, column)) continue;
      if (side === "left" ? column > 8 : column < 15) continue;
      for (let depth = 2; depth < 6; depth++) grid.set(column, 23 - row, -depth, cell === "O" ? "d" : cell);
    }
  }
  return grid;
}

export const BUBBLE_FRONT = 5;
const BUBBLE_BACK = -2;

/** 气泡：图上第 14 到 21 行的轮廓，猫爪那几格算气泡，往后挤出厚度，四周收圆。 */
export function bubbleGrid(): Grid {
  const rows = MAIN.slice(14, 22).map((cells) => cells.replace(/[Ocok]/g, "W"));
  const grid = new Grid();
  rows.forEach((cells, index) => {
    const row = 14 + index;
    [...cells].forEach((cell, column) => {
      if (cell === ".") return;
      const tail = row === 21;
      const back = tail ? BUBBLE_FRONT - 3 : BUBBLE_BACK;
      for (let z = back; z < BUBBLE_FRONT; z++) {
        const rim = z === BUBBLE_FRONT - 1 || z === back;
        const corner = row === 14 || row === 20;
        if (rim && corner && !tail) continue;
        grid.set(column, 23 - row, z, cell === "w" || z < 1 ? "w" : "W");
      }
    });
  });
  return grid;
}

/** 输入点：两格见方，一格厚。 */
export function dotGrid(): Grid {
  const grid = new Grid();
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) grid.set(x, y, 0, "k");
  return grid;
}

/** 两只爪子搭在气泡上沿，前端垂下来，趾缝照图上的画。 */
export function pawsGrid(): Grid {
  const grid = new Grid();
  for (const left of [4, 15]) {
    for (let x = left; x < left + 5; x++) {
      const toe = (x - left) % 2 === 1 ? "c" : "o";
      for (let z = -3; z <= BUBBLE_FRONT; z++) grid.set(x, 10, z, x === left || x === left + 4 ? "l" : "c");
      grid.set(x, 9, BUBBLE_FRONT, x === left || x === left + 4 ? "l" : "c");
      grid.set(x, 8, BUBBLE_FRONT, toe);
    }
  }
  return grid;
}

/** 身子：藏在气泡后面，镜头转过去才看得到。 */
export function bodyGrid(): Grid {
  const grid = new Grid();
  for (let x = 7; x <= 16; x++) {
    for (let y = 4; y <= 11; y++) {
      for (let z = -13; z <= -3; z++) {
        const corner = (x === 7 || x === 16) && (y === 4 || z === -13);
        if (corner) continue;
        grid.set(x, y, z, z % 3 === 0 ? "d" : "g");
      }
    }
  }
  return grid;
}

/** 一节尾巴，也是飞在气泡之间的光点：一个单位方块。 */
export function cubeGrid(color: string): Grid {
  const grid = new Grid();
  grid.set(0, 0, 0, color);
  return grid;
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** 一朵云：几个扁球叠起来，上面亮下面暗。 */
export function cloudGrid(seed: number): Grid {
  const next = random(seed);
  const puffs = Array.from({ length: 6 }, (_, index) => ({
    x: (index - 2.5) * 5 + next() * 3,
    y: next() * 2,
    z: (next() - 0.5) * 8,
    r: 3.5 + next() * 3.5
  }));
  const grid = new Grid();
  for (let x = -24; x <= 24; x++) {
    for (let y = -6; y <= 9; y++) {
      for (let z = -10; z <= 10; z++) {
        const inside = puffs.some((puff) => ((x - puff.x) / puff.r) ** 2 + ((y - puff.y) / (puff.r * 0.62)) ** 2 + ((z - puff.z) / puff.r) ** 2 < 1);
        if (inside) grid.set(x, y, z, y > 0 ? "C" : "B");
      }
    }
  }
  return grid;
}

/** 月亮：一块像素圆盘，带几块环形山。 */
export function moonGrid(): Grid {
  const grid = new Grid();
  const craters: Vec3[] = [
    [-3, 3, 2],
    [3, -1, 2.4],
    [-1, -4, 1.4]
  ];
  for (let x = -9; x <= 9; x++) {
    for (let y = -9; y <= 9; y++) {
      if (x * x + y * y > 86) continue;
      const pit = craters.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 < r * r);
      grid.set(x, y, 0, pit ? "m" : "M");
    }
  }
  return grid;
}
