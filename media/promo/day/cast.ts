/** 楼里的人和那只猫。头是体素，身子是几块方块，全靠姿势演戏。 */
import { chain, rotateX, rotateY, rotateZ, scale, translate, type Mat4, type Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";
import { PALETTE, mesh, type Mesh } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import { newGrid } from "../film/models.ts";
import { mix } from "../film/path.ts";
import type { Sink } from "../film/stage.ts";

Object.assign(PALETTE, {
  skinA: "#f6d6b8", skinB: "#e6b48f", skinC: "#cf9670",
  hairK: "#2b2830", hairB: "#5c3b27", hairR: "#8c4b2d", hairG: "#a3a3ab", hairW: "#d9b26a"
});

export const S = (x: number, y: number, z: number): Mat4 => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);

export const at = (m: Mat4, x: number, y: number, z: number): Vec3 => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
];

const HW = 13;
const HH = 12;
const HD = 11;
const PV = 0.8;

type Style = "short" | "part" | "bob" | "long" | "bun" | "bald" | "curly";

function personHead(style: Style, skin: string, hair: string): Mesh {
  const grid = newGrid();
  const isHair = (x: number, y: number, z: number) => {
    const side = x <= 0 || x >= HW - 1;
    switch (style) {
      case "short": return y >= 9 || (z <= 2 && y >= 4) || (side && y >= 7 && z <= 7);
      case "part": return y >= 10 || (y >= 8 && x <= 6 && z >= 7) || (z <= 2 && y >= 4) || (side && y >= 6 && z <= 7);
      case "bob": return y >= 9 || z <= 3 || (x <= 1 || x >= HW - 2) && y >= 2 && z <= 8;
      case "long": return y >= 9 || z <= 3 || (x <= 1 || x >= HW - 2) && z <= 8;
      case "bun": return y >= 9 || (z <= 2 && y >= 3) || (side && y >= 6 && z <= 6);
      case "bald": return (side && y >= 5 && y <= 8) || (z <= 1 && y >= 4 && y <= 8);
      case "curly": return y >= 8 + ((x + z) % 2) || (z <= 2 && y >= 4) || (side && y >= 6);
    }
  };
  for (let x = 0; x < HW; x++) {
    for (let y = 0; y < HH; y++) {
      for (let z = 0; z < HD; z++) {
        const edges = Number(x === 0 || x === HW - 1) + Number(y === 0 || y === HH - 1) + Number(z === 0 || z === HD - 1);
        if (edges >= 2) continue;
        grid.set(x, y, z, isHair(x, y, z) ? hair : skin);
      }
    }
  }
  if (style === "bun") {
    for (let x = 4; x <= 8; x++) for (let y = 12; y <= 15; y++) for (let z = 2; z <= 6; z++) {
      if ((x - 6) ** 2 + (y - 13.5) ** 2 + (z - 4) ** 2 <= 6.5) grid.set(x, y, z, hair);
    }
  }
  if (style === "long") {
    for (let x = 1; x < HW - 1; x++) for (let y = -5; y < 0; y++) for (let z = 0; z <= 3; z++) grid.set(x, y, z, hair);
  }
  if (style === "curly") {
    for (const [x, z] of [[2, 3], [5, 7], [9, 2], [10, 7], [6, 3], [3, 8]] as const) grid.set(x, 12, z, hair);
  }
  return mesh(grid, [HW / 2, 0, HD / 2]);
}

export type Who = { head: string; shirt: Vec3; pants: Vec3; skin: Vec3; phones?: Vec3; glasses?: boolean };

const SKIN: Record<string, Vec3> = { skinA: [0.965, 0.84, 0.72], skinB: [0.9, 0.706, 0.56], skinC: [0.81, 0.59, 0.44] };

/** 头型数得过来，人靠衣服分。 */
const HEADS: [string, Style, string, string][] = [
  ["pShort", "short", "skinA", "hairK"],
  ["pPart", "part", "skinB", "hairK"],
  ["pBob", "bob", "skinA", "hairB"],
  ["pLong", "long", "skinB", "hairK"],
  ["pBun", "bun", "skinA", "hairK"],
  ["pBald", "bald", "skinC", "hairG"],
  ["pCurly", "curly", "skinC", "hairK"],
  ["pRed", "short", "skinA", "hairR"],
  ["pBobR", "bob", "skinC", "hairR"]
];

export const headSkin = (name: string) => SKIN[HEADS.find((row) => row[0] === name)![2]]!;

export function castMeshes(): Record<string, { mesh: Mesh }> {
  const out: Record<string, { mesh: Mesh }> = {};
  for (const [name, style, skin, hair] of HEADS) out[name] = { mesh: personHead(style, skin, hair) };
  out.kBody = { mesh: kittyBody() };
  out.kLeg = { mesh: kittyLeg() };
  return out;
}

export type Pose = {
  x: number; y: number; z: number;
  /** 0 朝镜头，正的朝右。 */
  yaw: number;
  sit?: number;
  /** 走路：相位和走动的量。 */
  step?: number;
  move?: number;
  lean?: number;
  headYaw?: number;
  headPitch?: number;
  headRoll?: number;
  /** 眼珠往哪看。 */
  lookX?: number;
  lookY?: number;
  blink?: number;
  /** 抬手：往前抬的角度。 */
  armL?: number;
  armR?: number;
  /** 打字的量。 */
  type?: number;
  smile?: number;
  t?: number;
};

export function drawPerson(sink: Sink, who: Who, p: Pose) {
  const put = (m: Mat4, w: number, h: number, d: number, tint: Vec3) => sink.put("cube", chain(m, S(w, h, d)), tint);
  const sit = p.sit ?? 0;
  const move = p.move ?? 0;
  const step = p.step ?? 0;
  const t = p.t ?? 0;
  const swing = Math.sin(step) * move;
  const bob = Math.abs(Math.cos(step)) * 0.5 * move;
  const root = chain(translate(p.x, p.y, p.z), rotateY(p.yaw));
  const hipY = mix(7.6, 8.6, sit) + bob + Math.sin(t * 1.7) * 0.06;
  const hip = chain(root, translate(0, hipY, 0), rotateX(p.lean ?? 0));

  put(chain(hip, translate(0, 4.2, 0)), 7.8, 8.4, 4.8, who.shirt);

  const head = chain(hip, translate(0, 8.6, 0.2), rotateY(p.headYaw ?? 0), rotateX(p.headPitch ?? 0), rotateZ(p.headRoll ?? 0));
  sink.put(who.head, chain(head, scale(PV)));
  const lookX = (p.lookX ?? 0) * 0.8;
  const lookY = (p.lookY ?? 0) * 0.5;
  const open = 1 - (p.blink ?? 0) * 0.86;
  const eye = (side: number) => put(chain(head, translate(side * 2.3 + lookX, 3.9 + lookY, HD * 0.4 + 0.1)), 1.5, 2.3 * open, 0.3, [0.1, 0.09, 0.12]);
  eye(-1);
  eye(1);
  if (p.smile) put(chain(head, translate(lookX * 0.5, 1.7, HD * 0.4 + 0.1)), 2.4, 0.5, 0.3, [0.5, 0.25, 0.22]);
  if (who.glasses) {
    for (const side of [-1, 1]) put(chain(head, translate(side * 2.4, 4, HD * 0.4 + 0.25)), 3.4, 0.5, 0.3, [0.14, 0.14, 0.17]);
    put(chain(head, translate(0, 4, HD * 0.4 + 0.25)), 1.6, 0.4, 0.3, [0.14, 0.14, 0.17]);
  }
  if (who.phones) {
    put(chain(head, translate(0, 9.9, 0)), 12, 1, 2.2, who.phones);
    for (const side of [-1, 1]) {
      put(chain(head, translate(side * 5.3, 7, 0)), 1, 6, 2.2, who.phones);
      put(chain(head, translate(side * 5.7, 3.8, 0)), 2, 4.4, 4, who.phones);
    }
  }

  const arm = (side: number, raise: number, tap: number) => {
    const shoulder = chain(hip, translate(side * 5, 7.4, 0), rotateX(-raise - tap), rotateZ(side * 0.08));
    put(chain(shoulder, translate(0, -3.3, 0)), 2.4, 6.8, 2.6, who.shirt);
    put(chain(shoulder, translate(0, -7.2, 0)), 2.4, 2.4, 2.4, who.skin);
  };
  const typing = p.type ?? 0;
  const tapL = typing * (0.09 * Math.sin(t * 19) + 0.05 * Math.sin(t * 31));
  const tapR = typing * (0.09 * Math.sin(t * 23 + 1.3) + 0.05 * Math.sin(t * 29 + 0.4));
  arm(-1, (p.armL ?? 0) + typing * 1.15 + swing * 0.7, tapL);
  arm(1, (p.armR ?? 0) + typing * 1.15 - swing * 0.7, tapR);

  const leg = (side: number, swingAngle: number) => {
    const thighAngle = mix(swingAngle, 1.5, sit);
    const thigh = chain(root, translate(side * 2.1, hipY, 0), rotateX(-thighAngle));
    put(chain(thigh, translate(0, -2, 0)), 3.1, 4, 3.3, who.pants);
    const knee = mix(Math.max(0, -swingAngle) * 1.1 + 0.02, 1.5, sit);
    const shin = chain(thigh, translate(0, -4, 0), rotateX(knee));
    put(chain(shin, translate(0, -1.9, 0)), 3, 3.8, 3.2, who.pants);
    put(chain(shin, translate(0, -3.7, 0.7)), 3.2, 1.2, 4.6, [0.16, 0.15, 0.18]);
  };
  leg(-1, swing * 0.7);
  leg(1, -swing * 0.7);
}

/** 猫。头、耳朵、尾巴和产品同一套，身子和腿是片子才要的。 */
const CS = 0.52;
const LEG = 6;
const HEAD_PIVOT: Vec3 = [12, 11, -5];
const EAR_LEFT_PIVOT: Vec3 = [7, 20, -3];
const EAR_RIGHT_PIVOT: Vec3 = [17, 20, -3];

function kittyBody(): Mesh {
  const grid = newGrid();
  const L = 20;
  const H = 12;
  const W = 12;
  for (let x = 0; x < L; x++) {
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < W; z++) {
        const ex = x === 0 || x === L - 1;
        const ey = y === 0 || y === H - 1;
        const ez = z === 0 || z === W - 1;
        if (Number(ex) + Number(ey) + Number(ez) >= 2) continue;
        const stripe = (x + (y >> 1)) % 5 < 2;
        const color = y >= 9 ? (stripe ? "D" : "d") : y >= 5 ? (stripe && y >= 7 ? "d" : "g") : y >= 2 ? "l" : "c";
        grid.set(x, y, z, color);
      }
    }
  }
  return mesh(grid, [L / 2, H / 2, W / 2]);
}

function kittyLeg(): Mesh {
  const grid = newGrid();
  for (let x = 0; x < 4; x++) for (let y = 0; y < LEG; y++) for (let z = 0; z < 4; z++) {
    grid.set(x, -y - 1, z, y >= LEG - 2 ? "c" : "g");
  }
  return mesh(grid, [2, 0, 2]);
}

export type Kitty = {
  x: number; y: number; z: number;
  /** 身子朝向：0 朝右，π 朝左。 */
  heading: number;
  /** 脸朝哪：0 看镜头，正的往右。 */
  look?: number;
  pitch?: number;
  roll?: number;
  step?: number;
  move?: number;
  sit?: number;
  /** 伸前爪。 */
  reach?: number;
  eyes?: "open" | "half" | "closed" | "right";
  /** 趴下：肚子贴地。 */
  loaf?: number;
  flick?: number;
  t: number;
};

export function drawKitty(sink: Sink, p: Kitty) {
  const root = chain(translate(p.x, p.y, p.z), rotateY(-p.heading), scale(CS));
  const sit = p.sit ?? 0;
  const move = p.move ?? 0;
  const step = p.step ?? 0;
  const loaf = p.loaf ?? 0;
  const t = p.t;
  const pitch = sit * 0.8;
  const lift = Math.abs(Math.sin(step)) * 0.6 * move;
  const breath = Math.sin(t * 1.6) * 0.1;
  const local = chain(translate(-8, mix(LEG + 3.5, 5, Math.max(sit, loaf)) + lift + breath, 0), rotateZ(pitch), translate(8, 2.5, 0));
  sink.put("kBody", chain(root, local));

  const leg = (bx: number, bz: number, angle: number, front: boolean, reach: number) => {
    const top = at(local, bx, -3.5, bz);
    const fold = front ? 1 - loaf * 0.85 : 1 - Math.max(sit, loaf) * 0.75;
    const length = Math.max(top[1] / LEG, 0.2) * Math.min(fold + 0.0, 1);
    sink.put("kLeg", chain(root, translate(top[0], top[1], top[2]), rotateZ(angle + reach), S(1, front ? length * (1 + reach * 0.5) : length, 1)));
  };
  const swing = Math.sin(step) * 0.62 * move;
  leg(6.5, 3.5, swing, true, p.reach ?? 0);
  leg(6.5, -3.5, -swing, true, 0);
  leg(-6.5, 3.5, -swing, false, 0);
  leg(-6.5, -3.5, swing, false, 0);

  const neck = at(local, 9.5, 8 - 6.5 * sit - 6 * loaf, 0);
  const yaw = (p.look ?? 0) + p.heading;
  const head = chain(root, translate(neck[0], neck[1], neck[2]), rotateY(yaw), rotateX(p.pitch ?? 0), rotateZ(p.roll ?? 0), scale(1.32));
  const from = (pivot: Vec3) => translate(pivot[0] - HEAD_PIVOT[0], pivot[1] - HEAD_PIVOT[1], pivot[2] - HEAD_PIVOT[2]);
  sink.put(`head-${p.eyes ?? "open"}`, head);
  sink.put("earLeft", chain(head, from(EAR_LEFT_PIVOT)));
  sink.put("earRight", chain(head, from(EAR_RIGHT_PIVOT), rotateZ(-(p.flick ?? 0) * 0.3)));

  const tail = at(local, -9.5, 4, 0);
  let x = tail[0];
  let y = tail[1];
  let angle = Math.PI * 0.58;
  const curl = Math.max(sit, loaf);
  for (let index = 0; index < 11; index++) {
    angle += Math.sin(t * 2.2 - index * 0.55) * 0.13 - 0.05;
    x += Math.cos(angle) * 1.9;
    y += Math.sin(angle) * 1.9;
    /* 坐着的猫把尾巴绕到脚边，尖儿轻轻点地。 */
    const round = Math.PI * (1.02 - index * 0.085);
    const flat: Vec3 = [-1 + Math.cos(round) * 9.5, 1.5 + (index === 10 ? 0.7 * Math.max(Math.sin(t * 2.4), 0) : 0), Math.sin(round) * 9];
    const part = index === 10 ? "tailLight" : index % 4 === 3 ? "tailDark" : "tailFur";
    sink.put(part, chain(root, translate(mix(x, flat[0], curl), mix(y, flat[1], curl), mix(0, flat[2], curl)), scale(2.6 - index * 0.05)));
  }
  return { root, head, tail: at(root, x, y, 0) };
}
