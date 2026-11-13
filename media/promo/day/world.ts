/** 《在。》：一栋楼的一天。世界是时间的纯函数。 */
import { chain, normalize, rotateX, rotateY, rotateZ, scale, translate, type Mat4, type Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";
import { MAIN, PALETTE, art } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import { blink, bump, catMeshes } from "../film/cat.ts";
import { chatBubble, cube, cumulus, disc, line, slab } from "../film/models.ts";
import { add3, clamp, mix, mix3, smooth, smoother, sub3, track, type Key } from "../film/path.ts";
import type { Cam, Env, Sink, World } from "../film/stage.ts";
import { LINE, loadFont } from "../film/text.ts";
import { S, castMeshes, drawKitty, drawPerson, headSkin, type Pose, type Who } from "./cast.ts";
import { COPY } from "./copy.ts";
import { CELL, CELLS, SEATS, SLAB, box, boxIn, cellAt, chair, desk, drawShell, fy, hex, monitor, propMeshes, type Cell } from "./office.ts";

const lin = (hex: string): Vec3 => [1, 3, 5].map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255) ** 2.2) as Vec3;
const noise = (n: number) => {
  const v = Math.sin(n * 91.345 + 1.7) * 47453.5453;
  return v - Math.floor(v);
};

const GOLD: Vec3 = [1, 0.74, 0.34];
const INK: Vec3 = [0.03, 0.032, 0.045];
const MARK: Vec3 = [1, 0.72, 0.3];
const MARK_INK: Vec3 = [0.09, 0.05, 0.02];

const Y8 = fy(8);
const Y9 = fy(9);
const Y10 = fy(10);
const Y11 = fy(11);
const Y12 = fy(12);

type Row = { text: string; mark: boolean; line: ReturnType<typeof line>; top: number };
type Msg = { name: string; w: number; h: number; rows: Row[]; cells: { x: number; y: number; glyph: number; row: number }[]; glyphs: number };
const PAD = 9;

function message(name: string, rows: { text: string; mark?: boolean }[]): Msg {
  const h = rows.length * LINE + PAD * 2 - 2;
  const built: Row[] = rows.map((row, index) => ({ text: row.text, mark: row.mark ?? false, line: line(row.text), top: h / 2 - PAD - (index + 1) * LINE + 2 }));
  const w = Math.max(...built.map((row) => row.line.width)) + PAD * 2;
  const cells: Msg["cells"] = [];
  let glyphs = 0;
  built.forEach((row, index) => {
    for (const cell of row.line.cells) cells.push({ x: cell.x - w / 2 + PAD + 0.5, y: cell.y + row.top + 0.5, glyph: cell.glyph + glyphs, row: index });
    glyphs += row.line.glyphs;
  });
  return { name, w, h, rows: built, cells, glyphs };
}

function pop(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 1 - Math.exp(-6.5 * x) * Math.cos(x * 9.5);
}

/** 一段动作：起点到终点的路。 */
type Seg = { t0: number; t1: number; to: Vec3; kind: "walk" | "hop" | "fall"; arc?: number; from?: Vec3 };

function route(start: Vec3, segs: Seg[]) {
  const legs: (Seg & { from: Vec3; base: number; length: number })[] = [];
  let at = start;
  let base = 0;
  for (const seg of segs) {
    const length = Math.hypot(seg.to[0] - at[0], seg.to[1] - at[1], seg.to[2] - at[2]);
    legs.push({ ...seg, from: seg.from ?? at, base, length });
    at = seg.to;
    base += length;
  }
  return (t: number) => {
    let pos = start;
    let move = 0;
    let step = 0;
    let air = 0;
    for (const leg of legs) {
      if (t < leg.t0) break;
      if (t >= leg.t1) {
        pos = leg.to;
        step = (leg.base + leg.length) * 0.5;
        continue;
      }
      const k = (t - leg.t0) / (leg.t1 - leg.t0);
      if (leg.kind === "walk") {
        const e = mix(k, smooth(0, 1, k), 0.6);
        pos = mix3(leg.from, leg.to, e);
        move = bump(k, 0, 1, 0.14);
        step = (leg.base + leg.length * e) * 0.5;
      } else if (leg.kind === "hop") {
        pos = mix3(leg.from, leg.to, k);
        pos = [pos[0], pos[1] + 4 * (leg.arc ?? 8) * k * (1 - k), pos[2]];
        air = 1;
      } else {
        const e = k ** 1.7;
        pos = mix3(leg.from, leg.to, e);
        air = 1;
      }
      break;
    }
    return { pos, move, step, air };
  };
}

type Env0 = { top: string; mid: string; low: string; below: string; key: Vec3; dir: Vec3; rim: Vec3; dome: number; amb: Vec3; stars: number; exp: number; lamp: number };
const SKY: [number, Env0][] = [
  [1.5, { top: "#0a1220", mid: "#142442", low: "#2c4468", below: "#1c2c48", key: [0.3, 0.34, 0.46], dir: [-0.4, 0.6, 0.62], rim: [0.18, 0.24, 0.36], dome: 2.2, amb: [0.016, 0.018, 0.028], stars: 1, exp: 1, lamp: 1 }],
  [5, { top: "#141e38", mid: "#3a4a72", low: "#c98e7a", below: "#3a3a50", key: [0.5, 0.4, 0.42], dir: [-0.8, 0.14, 0.58], rim: [0.5, 0.34, 0.3], dome: 1.8, amb: [0.03, 0.03, 0.04], stars: 0.5, exp: 1, lamp: 1 }],
  [6.5, { top: "#34557f", mid: "#8199b8", low: "#f3bb90", below: "#8d7f90", key: [1.3, 0.8, 0.5], dir: [-0.78, 0.2, 0.6], rim: [1.1, 0.7, 0.42], dome: 1.1, amb: [0.05, 0.045, 0.055], stars: 0.05, exp: 0.9, lamp: 0.75 }],
  [9, { top: "#34557f", mid: "#6f8fb3", low: "#e6ddd0", below: "#9aa3b0", key: [1.3, 1.12, 0.9], dir: [-0.62, 0.5, 0.6], rim: [0.5, 0.46, 0.42], dome: 1.1, amb: [0.06, 0.065, 0.075], stars: 0, exp: 0.9, lamp: 0.25 }],
  [12, { top: "#34557f", mid: "#6f8fb3", low: "#dfe6ea", below: "#9aa3b0", key: [1.4, 1.3, 1.16], dir: [-0.12, 0.8, 0.58], rim: [0.45, 0.45, 0.45], dome: 1.15, amb: [0.065, 0.07, 0.08], stars: 0, exp: 0.88, lamp: 0.2 }],
  [15.5, { top: "#34557f", mid: "#7a93b2", low: "#ecd8bd", below: "#9a9aa4", key: [1.35, 1.08, 0.78], dir: [0.55, 0.5, 0.66], rim: [0.6, 0.5, 0.4], dome: 1.05, amb: [0.06, 0.06, 0.07], stars: 0, exp: 0.9, lamp: 0.25 }],
  [18, { top: "#3a4a78", mid: "#b07a7a", low: "#f0a060", below: "#6a5a70", key: [1.4, 0.66, 0.32], dir: [0.85, 0.16, 0.5], rim: [0.9, 0.5, 0.3], dome: 0.9, amb: [0.05, 0.04, 0.05], stars: 0, exp: 0.92, lamp: 0.8 }],
  [20, { top: "#141e38", mid: "#2a3a62", low: "#7a5a6a", below: "#2a3048", key: [0.5, 0.42, 0.5], dir: [0.6, 0.3, 0.7], rim: [0.3, 0.24, 0.3], dome: 1.8, amb: [0.03, 0.03, 0.04], stars: 0.5, exp: 1, lamp: 1 }],
  [23, { top: "#0a1220", mid: "#142442", low: "#2c4468", below: "#1c2c48", key: [0.3, 0.34, 0.46], dir: [-0.4, 0.6, 0.62], rim: [0.18, 0.24, 0.36], dome: 2.2, amb: [0.016, 0.018, 0.028], stars: 1, exp: 1, lamp: 1 }],
  [25.5, { top: "#0a1220", mid: "#142442", low: "#2c4468", below: "#1c2c48", key: [0.3, 0.34, 0.46], dir: [-0.4, 0.6, 0.62], rim: [0.18, 0.24, 0.36], dome: 2.2, amb: [0.016, 0.018, 0.028], stars: 1, exp: 1, lamp: 1 }]
];

function skyAt(hour: number) {
  let h = hour;
  while (h < SKY[0]![0]) h += 24;
  while (h > SKY[SKY.length - 1]![0]) h -= 24;
  let i = 0;
  while (i < SKY.length - 2 && h >= SKY[i + 1]![0]) i += 1;
  const [ha, a] = SKY[i]!;
  const [hb, b] = SKY[i + 1]!;
  const k = smooth(ha, hb, h);
  return {
    top: mix3(lin(a.top), lin(b.top), k), mid: mix3(lin(a.mid), lin(b.mid), k), low: mix3(lin(a.low), lin(b.low), k), below: mix3(lin(a.below), lin(b.below), k),
    key: mix3(a.key, b.key, k), dir: normalize(mix3(a.dir, b.dir, k)), rim: mix3(a.rim, b.rim, k), dome: mix(a.dome, b.dome, k), amb: mix3(a.amb, b.amb, k),
    stars: mix(a.stars, b.stars, k), exp: mix(a.exp, b.exp, k), lamp: mix(a.lamp, b.lamp, k)
  };
}

export async function buildWorld(): Promise<World> {
  await loadFont();
  const B = await (await fetch("/media/promo/day/beats.json")).json();
  const { open: O, walk: W, meet: M, drop: D, dup: U, cup: C, hand: H, dusk: K, night: N, dawn: A, pull: P, end: E } = B;

  const meshes: World["meshes"] = { ...catMeshes(), ...castMeshes(), ...propMeshes(), cube: { mesh: cube("X") }, spark: { mesh: cube("X"), caster: false }, sun: { mesh: disc(), caster: false } };
  for (let kind = 0; kind < 6; kind++) meshes[`cloud${kind}`] = { mesh: cumulus(kind + 3), caster: false };

  const addMsg = (msg: Msg, tail: "left" | "right" = "left") => {
    meshes[msg.name] = { mesh: chatBubble(msg.w, msg.h, 6, tail) };
    msg.rows.forEach((row, index) => {
      if (row.mark) meshes[`${msg.name}-mark${index}`] = { mesh: slab(row.line.width + 6, LINE + 1) };
    });
    return msg;
  };
  const T = {
    ask: addMsg(message("mAsk", [{ text: COPY.ask }]), "right"),
    here: addMsg(message("mHere", [{ text: COPY.here }]), "left"),
    meetAsk: addMsg(message("mMeetAsk", [{ text: COPY.meetAsk }]), "left"),
    meetSay: addMsg(message("mMeetSay", [{ text: COPY.meetFact, mark: true }, { text: COPY.meetSource }]), "left"),
    dupAsk: addMsg(message("mDupAsk", [{ text: COPY.dupAsk }]), "right"),
    dupSay: addMsg(message("mDupSay", [{ text: COPY.dupSay }]), "right"),
    cupSay: addMsg(message("mCupSay", [{ text: COPY.cupSay }]), "right"),
    cupOk: addMsg(message("mCupOk", [{ text: COPY.cupOk }]), "left"),
    handAsk: addMsg(message("mHandAsk", [{ text: COPY.handAsk }]), "right"),
    handSay: addMsg(message("mHandSay", [{ text: COPY.handSay }]), "left"),
    newAsk: addMsg(message("mNewAsk", [{ text: COPY.newAsk }]), "right"),
    newSay: addMsg(message("mNewSay", [{ text: COPY.newSay }]), "left")
  };

  function drawMsg(sink: Sink, frame: Mat4, msg: Msg, appear: number, typed: number, glow = 0, paper = 1) {
    if (appear <= 0) return;
    const m = chain(frame, scale(Math.max(pop(appear), 0.001)));
    sink.put(msg.name, m, [paper, paper, paper], glow);
    msg.rows.forEach((row, index) => {
      if (row.mark) sink.put(`${msg.name}-mark${index}`, chain(m, translate(-msg.w / 2 + PAD + row.line.width / 2, row.top + LINE / 2 - 0.5, 0)), MARK, 0.45, 1, 0, 0);
    });
    for (const cell of msg.cells) {
      if (cell.glyph >= typed) continue;
      const color = msg.rows[cell.row]!.mark ? MARK_INK : INK;
      sink.cube(m, cell.x, cell.y, msg.rows[cell.row]!.mark ? 1.5 : 0.5, 1, color[0], color[1], color[2], 0);
    }
  }

  /** 在 from 到 to 这段时间里说这句话。 */
  function say(sink: Sink, t: number, msg: Msg, x: number, y: number, z: number, size: number, from: number, to: number, glow = 0.34, yaw = 0, paper = 1) {
    if (t < from || t > to + 0.2) return;
    const appear = t > to ? 1 - (t - to) / 0.2 : (t - from) / 0.38;
    const typed = (t - from) * 26;
    drawMsg(sink, chain(translate(x, y, z), rotateY(yaw), scale(size)), msg, clamp(appear), typed, glow, paper);
  }

  function clock(sink: Sink, text: string, x: number, y: number, z: number, s = 0.4) {
    const row = line(text);
    box(sink, x, y, z, row.width * s + 3, 9 * s + 3.4, 1, [0.09, 0.09, 0.12]);
    const m = chain(translate(x - (row.width * s) / 2, y - 7 * s, z + 0.7), scale(s));
    for (const cell of row.cells) sink.cube(m, cell.x, cell.y, 0, 1, 1, 0.72, 0.34, 1.7);
  }

  /* 人 */
  const who = (head: string, shirt: Vec3, pants: Vec3, extra: Partial<Who> = {}): Who => ({ head, shirt, pants, skin: headSkin(head), ...extra });
  const DARK: Vec3 = [0.2, 0.2, 0.26];
  const meetPeople: { who: Who; x: number }[] = [
    { who: who("pBob", [0.2, 0.46, 0.42], DARK), x: -60 },
    { who: who("pShort", [0.25, 0.36, 0.55], DARK), x: -36 },
    { who: who("pBun", [0.72, 0.34, 0.3], DARK), x: 12 },
    { who: who("pBald", [0.5, 0.52, 0.58], DARK, { glasses: true }), x: 36 }
  ];
  const xiaoman = who("pCurly", [0.25, 0.42, 0.66], DARK);
  const chenmo = who("pRed", [0.24, 0.5, 0.36], DARK, { glasses: true });
  const laozhou = who("pPart", [0.2, 0.22, 0.3], [0.3, 0.26, 0.24], { phones: [0.78, 0.26, 0.22] });
  const newbie = who("pBob", [0.9, 0.7, 0.34], [0.26, 0.3, 0.42]);
  const shaftA = who("pBobR", [0.62, 0.3, 0.42], DARK);
  const shaftB = who("pShort", [0.26, 0.46, 0.5], DARK, { glasses: true });

  /* 猫走过的路 */
  const FRONT = -9;
  const homeSpot: Vec3 = [-158, Y8 + 12, -22];
  const tableY = Y8 + 12;
  /* 杯子沿桌面往桌沿走，一爪一寸，猫跟着挪。 */
  const CUP_CAT: Vec3 = [11, Y11 + 12, -22];
  const CUP_X = 18.5;
  const CUP_Z = -19.6;
  const CUP_STEP = 3.7;
  const SIT_TURN = 0.2;
  const catAt = route(homeSpot, [
    { t0: W.start, t1: W.start + 0.42, to: [-148, Y8, -21], kind: "hop", arc: 5 },
    { t0: W.start + 0.42, t1: W.door - 0.3, to: [-84, Y8, -21], kind: "walk" },
    { t0: W.door - 0.3, t1: W.door + 0.5, to: [-14, Y8, FRONT], kind: "walk" },
    { t0: M.hop, t1: M.land, to: [-12, tableY, -24], kind: "hop", arc: 9 },
    { t0: M.leave, t1: M.leave + 0.46, to: [34, Y8, FRONT], kind: "hop", arc: 6 },
    { t0: M.leave + 0.46, t1: D.start, to: [72, Y8, -20], kind: "walk" },
    { t0: D.start, t1: D.land, to: [72, Y11, -20], kind: "fall" },
    { t0: U.leave, t1: U.leave + 0.5, to: [56, Y11, -21], kind: "walk" },
    { t0: U.leave + 0.5, t1: C.in - 0.32, to: [34, Y11, FRONT], kind: "walk" },
    { t0: C.in - 0.32, t1: C.in, to: CUP_CAT, kind: "hop", arc: 6 },
    { t0: H.leave + 0.5, t1: H.leave + 1.5, to: [-14, Y11 + 12, -21], kind: "walk", from: [11 + 3 * CUP_STEP, Y11 + 12, -22] }
  ]);

  const heading = (t: number) => {
    const keys: [number, number][] = [[0, Math.PI / 2], [W.start - 0.1, Math.PI / 2], [W.start + 0.15, 0], [M.hop - 0.2, 0], [M.hop + 0.3, Math.PI / 2], [M.leave - 0.1, Math.PI / 2], [M.leave + 0.2, 0], [U.leave - 0.2, 0], [U.leave + 0.1, Math.PI], [C.in - 0.1, Math.PI], [C.in + 0.3, SIT_TURN], [H.leave + 0.4, SIT_TURN], [H.leave + 0.7, Math.PI]];
    let value = keys[0]![1];
    for (let index = 0; index + 1 < keys.length; index++) {
      const [ta, va] = keys[index]!;
      const [tb, vb] = keys[index + 1]!;
      if (t >= ta) value = mix(va, vb, smooth(ta, tb, t));
    }
    return value;
  };

  /* 金线：猫走过哪，线就留在哪。 */
  type Knot = { x: number; y: number; z: number; t: number };
  const thread: Knot[] = [];
  for (let t = W.start; t <= H.leave + 1.5; t += 1 / 30) {
    const { pos } = catAt(t);
    const last = thread[thread.length - 1];
    if (!last || Math.hypot(pos[0] - last.x, pos[1] - last.y, pos[2] - last.z) > 2.4) thread.push({ x: pos[0], y: pos[1] + 0.6, z: pos[2], t });
  }
  const segMatrix = (a: Vec3, b: Vec3, w: number): Mat4 => {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(d[0], d[1], d[2]) || 1;
    const z: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
    const up: Vec3 = Math.abs(z[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x = normalize([up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]);
    const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return new Float32Array([x[0] * w, x[1] * w, x[2] * w, 0, y[0] * w, y[1] * w, y[2] * w, 0, z[0] * length, z[1] * length, z[2] * length, 0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 1]);
  };
  const threadSegs = thread.slice(1).map((knot, index) => {
    const prev = thread[index]!;
    return { m: segMatrix([prev.x, prev.y, prev.z], [knot.x, knot.y, knot.z], 0.55), t: knot.t, s: index * 2.4 };
  });

  /* 天亮时从白屋子开始，顺着房间一间间亮过去：一棵生成树，就是那张神经网。 */
  const startCell = cellAt(8, 8)!;
  const depthOf = new Float32Array(CELLS.length).fill(-1);
  depthOf[startCell.index] = 0;
  const edges: { a: Cell; b: Cell; depth: number }[] = [];
  {
    const queue: Cell[] = [startCell];
    let seed = 3;
    while (queue.length) {
      const pick = Math.floor(noise(seed++) * Math.min(queue.length, 5));
      const cell = queue.splice(pick, 1)[0]!;
      const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => cellAt(cell.col + dc!, cell.row + dr!)).filter((c): c is Cell => !!c);
      for (const next of around) {
        if (depthOf[next.index]! >= 0) continue;
        depthOf[next.index] = depthOf[cell.index]! + 1;
        edges.push({ a: cell, b: next, depth: depthOf[next.index]! });
        queue.push(next);
      }
    }
  }
  const WAVE = 0.075;
  /* 网贴着地板走，只在靠墙的地方上下楼，近看不挡人。 */
  type Run = { a: Vec3; b: Vec3; from: number; to: number };
  const nodeX = (cell: Cell) => cell.x + (noise(cell.index * 3.3) < 0.5 ? 6 : 42);
  const runs: Run[] = [];
  for (const { a, b, depth } of edges) {
    const ya = a.y + SLAB + 0.5;
    const yb = b.y + SLAB + 0.5;
    const z = Math.max(a.z, b.z) - 9;
    const ax = nodeX(a);
    const bx = nodeX(b);
    const from = (depth - 1) * WAVE;
    if (a.row === b.row) runs.push({ a: [ax, ya, z], b: [bx, ya, z], from, to: from + WAVE });
    else {
      runs.push({ a: [ax, ya, z], b: [bx, ya, z], from, to: from + WAVE * 0.6 });
      runs.push({ a: [bx, ya, z], b: [bx, yb, z], from: from + WAVE * 0.6, to: from + WAVE });
    }
  }
  const onTime = (cell: Cell) => A.wave + depthOf[cell.index]! * WAVE;
  const offTime = CELLS.map((cell) => K.start + 0.9 + noise(cell.index * 1.31) * (K.dark - K.start - 1.3));

  const lit = new Float32Array(CELLS.length);
  function updateLit(t: number) {
    const pink = cellAt(11, 11)!.index;
    const pink2 = cellAt(12, 11)!.index;
    const white = startCell.index;
    for (const cell of CELLS) {
      const off = offTime[cell.index]!;
      const on = onTime(cell);
      let v = 1 - smooth(off, off + 0.14, t);
      v = Math.max(v, smooth(on, on + 0.2, t));
      lit[cell.index] = v;
    }
    if (t < O.lamp) lit.fill(0);
    if (t >= K.start && t < A.wave) lit[white] = 1;
    if (t >= K.start && t < N.ask) {
      lit[pink] = Math.max(lit[pink]!, 0.3);
      lit[pink2] = Math.max(lit[pink2]!, 0.3);
    }
  }

  /** 电影时间换成一天里的钟点。 */
  function hourAt(t: number) {
    const keys: [number, number][] = [[O.lamp, 9], [M.leave, 10.5], [U.leave, 13.5], [C.in, 15.5], [H.ask, 16.8], [K.start, 18], [K.start + 3, 20], [K.dark, 23], [N.end, 25.5], [A.sun, 30.5], [P.start, 30.8], [60, 31]];
    if (t <= keys[0]![0]) return keys[0]![1];
    for (let index = 0; index + 1 < keys.length; index++) {
      const [ta, va] = keys[index]!;
      const [tb, vb] = keys[index + 1]!;
      if (t <= tb) return mix(va, vb, clamp((t - ta) / (tb - ta)));
    }
    return 31;
  }

  /* 镜头 */
  const FRONT_Y = 15;
  const SHOTS: Key[] = [
    { t: -1, eye: [-158, Y8 + 20, 78], target: [-158, Y8 + 19, -22], fov: 0.5, aperture: 0.5 },
    { t: O.lamp, eye: [-158, Y8 + 20, 66], target: [-158, Y8 + 19, -22], fov: 0.5, aperture: 0.5 },
    { t: W.start, eye: [-152, Y8 + 19, 70], target: [-150, Y8 + 15, -22], fov: 0.5, aperture: 0.5 },
    { t: W.start + 1.4, eye: [-104, Y8 + FRONT_Y + 3, 74], target: [-108, Y8 + 13, -22], fov: 0.5, aperture: 0.5 },
    { t: W.door, eye: [-60, Y8 + 20, 110], target: [-52, Y8 + 16, -22], fov: 0.52, aperture: 0.6 },
    { t: M.ask, eye: [-14, Y8 + 24, 152], target: [-14, Y8 + 21, -28], fov: 0.5, aperture: 0.6 },
    { t: M.hop, eye: [-14, Y8 + 25, 138], target: [-14, Y8 + 22, -28], fov: 0.5, aperture: 0.6 },
    { t: M.say + 0.4, eye: [-14, Y8 + 25, 116], target: [-14, Y8 + 24, -26], fov: 0.5, aperture: 0.7 },
    { t: M.leave, eye: [-6, Y8 + 22, 108], target: [-2, Y8 + 21, -26], fov: 0.5, aperture: 0.7 },
    { t: D.start - 0.3, eye: [64, Y8 + 15, 104], target: [70, Y8 + 8, -20], fov: 0.5, aperture: 0.5 },
    { t: D.land + 0.1, eye: [78, Y11 + 15, 104], target: [76, Y11 + 12, -20], fov: 0.5, aperture: 0.5 },
    { t: U.ask + 0.3, eye: [98, Y12 + 44, 196], target: [98, Y12 + 42, -22], fov: 0.5, aperture: 0.7 },
    { t: U.leave, eye: [96, Y12 + 46, 186], target: [96, Y12 + 44, -22], fov: 0.5, aperture: 0.7 },
    { t: U.leave + 0.7, eye: [46, Y11 + 18, 96], target: [40, Y11 + 16, -22], fov: 0.5, aperture: 0.6 },
    { t: C.in + 0.1, eye: [12, Y11 + 22, 54], target: [6, Y11 + 21, -24], fov: 0.56, aperture: 0.1 },
    { t: C.tap2, eye: [10, Y11 + 20, 44], target: [7, Y11 + 20, -24], fov: 0.56, aperture: 0.25 },
    { t: C.ok, eye: [8, Y11 + 20, 40], target: [5, Y11 + 20, -24], fov: 0.56, aperture: 0.3 },
    { t: C.back + 0.4, eye: [6, Y11 + 22, 52], target: [3, Y11 + 21, -24], fov: 0.56, aperture: 0.3 },
    { t: H.ask + 0.4, eye: [0, Y11 + 25, 92], target: [-2, Y11 + 23, -24], fov: 0.54, aperture: 0.6 },
    { t: K.start, eye: [-2, Y11 + 26, 112], target: [-6, Y11 + 23, -24], fov: 0.54, aperture: 0.6 },
    { t: K.start + 2.5, eye: [-6, Y11 + 44, 340], target: [-8, Y11 + 40, -24], fov: 0.5, aperture: 0.5 },
    { t: K.dark - 0.4, eye: [-60, Y11 + 80, 470], target: [-64, Y11 + 76, -24], fov: 0.5, aperture: 0.4 }
  ];
  const NIGHT_SHOTS: Key[] = [
    { t: N.ask - 0.3, eye: [-166, Y8 + 22, 104], target: [-168, Y8 + 20, -24], fov: 0.5, aperture: 0.25 },
    { t: N.end, eye: [-168, Y8 + 21, 84], target: [-168, Y8 + 20, -24], fov: 0.5, aperture: 0.25 },
    { t: A.enter, eye: [-168, Y8 + 21, 90], target: [-169, Y8 + 20, -24], fov: 0.5, aperture: 0.25 },
    { t: P.start, eye: [-168, Y8 + 22, 84], target: [-168, Y8 + 22, -24], fov: 0.5, aperture: 0.25 }
  ];

  /* 从全楼一下落到那间白屋子，这一下不走样条，不然会冲过头。 */
  function dayShot(t: number) {
    const from = K.dark - 0.4;
    const to = N.ask - 0.3;
    if (t <= from) return track(SHOTS, t);
    if (t >= to) return track(NIGHT_SHOTS, t);
    const a = track(SHOTS, from);
    const b = track(NIGHT_SHOTS, to);
    const k = smoother(0, 1, (t - from) / (to - from));
    const zoom = 1 - (1 - k) ** 2;
    return { ...b, eye: [mix(a.eye[0], b.eye[0], k), mix(a.eye[1], b.eye[1], k), mix(a.eye[2], b.eye[2], zoom)] as Vec3, target: mix3(a.target, b.target, k), aperture: mix(a.aperture, b.aperture, k), focus: 0 };
  }

  function pullCam(t: number) {
    const k = clamp((t - P.start) / (P.face + 0.5 - P.start));
    const e = smoother(0, 1, k);
    const end = smooth(E.brain - 0.5, E.line + 0.4, t);
    const z = 84 * Math.exp(Math.log(2500 / 84) * e) + 100 * smooth(P.face, E.brain, t) + 800 * end;
    const u = smooth(0.2, 0.96, k);
    const eye: Vec3 = [mix(-168, mix(34, 0, end), u), mix(Y8 + 22, mix(470, 540, end), u), z];
    const target: Vec3 = [mix(-168, 0, u), mix(Y8 + 22, 505, u) + 285 * end, -24];
    return { eye, target, fov: 0.5, focus: z + 24, aperture: mix(0.25, 0, smooth(0, 0.3, k)), roll: 0 };
  }

  /* 云海 */
  type Cloud = { kind: number; x: number; y: number; z: number; size: number; speed: number; yaw: number };
  const clouds: Cloud[] = [];
  for (let index = 0; index < 300; index++) {
    const z = 2500 - noise(index * 3.1) ** 0.8 * 7000;
    const x = (noise(index * 5.7) - 0.5) * (5200 + Math.max(0, -z) * 2);
    const far = clamp((800 - z) / 4200);
    const size = 3.6 + far * 12 + noise(index * 2.3) * 3;
    const y = -130 - noise(index * 1.9) * 70 - far * 120;
    if (Math.abs(x) < 640 && z > -420 && z < 180) continue;
    clouds.push({ kind: index % 6, x, y, z, size, speed: 0.4 + noise(index) * 0.5, yaw: noise(index * 7.7) * 6.28 });
  }

  for (let index = 0; index < 44; index++) {
    const side = index % 2 ? 1 : -1;
    const z = 700 + noise(index * 9.1) * 2600;
    const x = side * (660 + noise(index * 4.3) * 900 + (z - 700) * 0.12);
    clouds.push({ kind: index % 6, x, y: 120 + noise(index * 6.7) * 900, z, size: 3 + noise(index * 2.9) * 3.4, speed: 0.6, yaw: noise(index * 3.7) * 6.28 });
  }

  function drawClouds(t: number, sink: Sink, tint: Vec3) {
    for (const cloud of clouds) {
      sink.put(`cloud${cloud.kind}`, chain(translate(cloud.x + t * cloud.speed * 3, cloud.y, cloud.z), rotateY(cloud.yaw), scale(cloud.size)), tint, 0, 1, 1, 1);
    }
  }

  const lamp = (sink: Sink, x: number, y: number, z: number, level: number) => {
    box(sink, x, y - 3, z, 0.5, 6, 0.5, [0.2, 0.2, 0.24]);
    box(sink, x, y - 7, z, 10, 2.6, 10, [0.98, 0.92, 0.76], 3.2 * level);
  };

  function crowd(t: number, sink: Sink, near: boolean, clean: number) {
    if (clean >= 0.99) return;
    for (const seat of SEATS) {
      if (t >= offTime[seat.cell.index]! && t < onTime(seat.cell)) continue;
      const w = { head: seat.head, shirt: seat.shirt, pants: seat.pants, skin: headSkin(seat.head) };
      if (!near) {
        const size = 1 - clean;
        sink.put(seat.head, chain(translate(seat.x, seat.y + 17, seat.z), rotateY(seat.yaw), scale(0.8 * size)));
        box(sink, seat.x, seat.y + 12, seat.z, 7.8 * size, 8.4 * size, 4.8 * size, seat.shirt);
        continue;
      }
      const pose: Pose = { x: seat.x, y: seat.y, z: seat.z, yaw: seat.yaw, sit: 1, type: 0.6 + 0.4 * Math.sin(t * 0.7 + seat.phase), t: t + seat.phase, headYaw: 0.14 * Math.sin(t * 0.4 + seat.phase) };
      drawPerson(sink, w, pose);
    }
  }

  function homeClock(t: number) {
    if (t < K.start) return "9:02";
    if (t >= N.ask - 1.5 && t <= N.end) return "1:26";
    if (t >= A.enter - 0.3) return "8:50";
    const hour = t < N.ask ? mix(18, 25.43, clamp((t - K.start) / (N.ask - 1.5 - K.start))) : mix(25.43, 32.83, clamp((t - N.end) / (A.enter - 0.3 - N.end)));
    return `${Math.floor(hour) % 24}:${String(Math.floor((hour % 1) * 60)).padStart(2, "0")}`;
  }

  function roomHome(t: number, sink: Sink) {
    desk(sink, -166, Y8, -24, 34, 20);
    monitor(sink, -178, Y8 + 12, -26, 0.6, t < O.lamp ? 0 : t >= N.ask - 2 && t < N.end + 1 ? 1 : 0.15, "code", t);
    box(sink, -158, Y8 + 12.3, -22, 13, 0.8, 13, [0.5, 0.62, 0.7]);
    if (t >= O.lamp) clock(sink, homeClock(t), -170, Y8 + 37, -43.2, 0.36);
    if (t >= K.dark - 1 && t < N.end + 1.1) {
      chair(sink, -170, Y8, -37, 0, [0.3, 0.4, 0.5]);
      sink.put("cup", chain(translate(-172, Y8 + 12, -18), scale(0.7)), [0.96, 0.95, 0.92]);
      const going = clamp((t - N.end + 0.15) / 1.1);
      if (going <= 0) {
        const leanIn = t < N.ask ? 0.22 : mix(0.22, 0.02, smooth(N.say + 0.4, N.say + 1, t));
        drawPerson(sink, xiaoman, { x: -170, y: Y8, z: -37, yaw: 0.1, sit: 1, lean: leanIn, type: t < N.ask - 0.1 ? 0.8 : 0, t, headPitch: t > N.say + 0.4 ? -0.02 : 0.14, headYaw: t > N.say ? 0.7 : 0, lookX: t > N.say ? 1 : 0, smile: t > N.say + 0.3 ? 1 : 0, blink: Math.sin(t * 1.3) > 0.97 ? 1 : 0 });
      } else {
        const first = clamp(going * 2);
        const second = clamp(going * 2 - 1);
        const x = mix(mix(-170, -188, first), -212, second);
        drawPerson(sink, xiaoman, { x, y: Y8, z: mix(-37, -22, second), yaw: -1.4, step: x * 0.6, move: 1, t, headYaw: 0.5 });
      }
    }
    if (t >= A.enter - 0.5) {
      const walkK = clamp((t - A.enter) / 0.9);
      const x = mix(-210, -178, walkK);
      const facing = t > A.ask - 0.3 ? 1 : 0;
      const pose: Pose = { x, y: Y8, z: mix(-16, -11, walkK), yaw: walkK < 1 ? 1.3 : 0.55, step: x * 0.55, move: walkK < 1 ? 1 : 0, t, armL: 1.1, armR: 1.1, headYaw: 0.25 * facing, headPitch: t > A.wave ? -0.04 : 0.02, lookX: facing, smile: t > A.say + 0.5 ? 1 : 0 };
      drawPerson(sink, newbie, pose);
      const m = chain(translate(x, Y8, pose.z), rotateY(pose.yaw));
      boxIn(sink, m, 0, 12, 7, 11, 7.5, 7, [0.84, 0.68, 0.48], 0.12);
      boxIn(sink, m, 0, 16.4, 7, 7, 2.4, 5, [0.36, 0.56, 0.4], 0.12);
    }
  }

  function roomGreen(sink: Sink) {
    const y = Y8;
    sink.put("plant", chain(translate(-108, y, -35), scale(1)), [1, 1, 1]);
    sink.put("plant", chain(translate(-132, y, -37), scale(0.7)), [1, 1, 1]);
    box(sink, -120, y + 30, -43.4, 15, 12, 0.5, [0.96, 0.93, 0.86]);
    box(sink, -120, y + 30, -43, 12, 9, 0.4, [0.86, 0.66, 0.34]);
    lamp(sink, -120, y + 45, -24, lit[cellAt(9, 8)!.index]!);
  }

  function roomMeeting(t: number, sink: Sink, kitty: Vec3) {
    const y = Y8;
    box(sink, -12, y + 11.4, -25, 124, 1.4, 17, [0.74, 0.56, 0.38]);
    for (const sx of [-68, 44]) for (const sz of [-31, -19]) box(sink, sx, y + 5.4, sz, 1.4, 10.8, 1.4, [0.3, 0.31, 0.35]);
    box(sink, -66, y + 27, -43.4, 38, 18, 0.5, [0.95, 0.93, 0.88]);
    for (let index = 0; index < 4; index++) box(sink, -78 + index * 6 + 6, y + 30 - index * 2, -43, 10 + (index % 2) * 8, 0.8, 0.3, [0.22, 0.34, 0.6]);
    clock(sink, COPY.stamps.meet, -40, y + 33, -43.2, 0.42);
    for (const x of [-60, -12, 36]) lamp(sink, x, y + 45, -25, 1);
    for (const x of [-60, -36, -12, 12, 36]) chair(sink, x, y, -37, 0, [0.3, 0.36, 0.44]);
    const turned = smooth(M.turn, M.turn + 0.3, t);
    const toCat = smooth(M.land - 0.1, M.land + 0.25, t);
    const nod = t >= M.nod && t < M.nod + 0.9 ? 0.2 * Math.sin(((t - M.nod) / 0.45) * Math.PI) ** 2 : 0;
    meetPeople.forEach(({ who: person, x }, index) => {
      const toChair = clamp((-12 - x) / 40, -1.1, 1.1);
      const toTable = clamp((-12 - x) / 26, -1, 1);
      const idle = 0.1 * Math.sin(t * 0.8 + index * 1.7);
      const yaw = mix(mix(idle + (index === 1 ? 0.5 : 0), toChair, turned), toTable, toCat);
      const speaking = index === 1 && t >= M.ask && t < M.ask + 1.1;
      drawPerson(sink, person, { x, y, z: -37, yaw: 0, sit: 1, t: t + index, headYaw: yaw, headPitch: mix(0, 0.2, toCat) + nod, lookX: yaw * 0.5, armR: speaking ? 0.9 + 0.15 * Math.sin(t * 9) : 0.75, armL: 0.75, smile: toCat > 0.5 ? 1 : 0, blink: Math.sin(t * 1.1 + index * 2) > 0.985 ? 1 : 0 });
      sink.put("cup", chain(translate(x + 7, y + 12.1, -22), scale(0.55)), [0.96, 0.95, 0.92]);
    });
    say(sink, t, T.meetAsk, -8, y + 36, -16, 0.3, M.ask, M.hop + 0.1);
    say(sink, t, T.meetSay, 21, y + 37, -14, 0.31, M.say, M.leave - 0.1);
  }

  function twin(t: number, sink: Sink, y: number, person: Who, done: boolean, pose: Partial<Pose>) {
    desk(sink, 92, y, -24, 26, 20);
    monitor(sink, 86, y + 12, -26, 0.75, 1, done ? "chart" : "blank", t);
    chair(sink, 108, y, -24, -1, [0.3, 0.36, 0.44]);
    drawPerson(sink, person, { x: 108, y, z: -23.5, yaw: -1, sit: 1, t, ...pose });
    lamp(sink, 96, y + 45, -22, 1);
  }

  function roomShaft(t: number, sink: Sink) {
    const passing = (y: number) => {
      /* 猫落到这一层的时刻 */
      const k = ((Y8 - (y + 16)) / (Y8 - Y11)) ** (1 / 1.7);
      return D.start + k * (D.land - D.start);
    };
    const floors: [Who, number, number, number][] = [[shaftA, Y9, 55, 0.9], [shaftB, Y10, 89, -0.9]];
    for (const [person, y, x, yaw] of floors) {
      const at = passing(y);
      const up = smooth(at - 0.5, at - 0.2, t) * (1 - smooth(at - 0.05, at + 0.1, t));
      const down = smooth(at - 0.05, at + 0.12, t);
      chair(sink, x, y, -28, yaw, [0.3, 0.36, 0.44]);
      drawPerson(sink, person, { x, y, z: -28, yaw, sit: 1, t, headYaw: 0, headPitch: -0.55 * up + 0.5 * down, armR: 0.8, armL: 0.8, lookY: up - down, smile: down });
    }
  }

  function roomsTwin(t: number, sink: Sink) {
    const look = smooth(U.look, U.look + 0.3, t);
    const wave = t >= U.wave && t < U.leave + 0.4 ? 1 : 0;
    twin(t, sink, Y11, xiaoman, false, { type: t < U.say + 0.6 ? 0.8 : 0, headYaw: mix(0, 1, look), headPitch: mix(0, 0.5, look), armR: wave * (2.6 + 0.2 * Math.sin(t * 14)), smile: look > 0.5 ? 1 : 0 });
    twin(t, sink, Y12, chenmo, true, { type: t < U.look ? 0.5 : 0, headYaw: mix(0, 1, look), headPitch: mix(0, -0.5, look), armR: wave * (2.6 + 0.2 * Math.sin(t * 13 + 1)), smile: look > 0.5 ? 1 : 0 });
    clock(sink, COPY.stamps.dup, 124, Y11 + 35, -43.2, 0.42);
    say(sink, t, T.dupAsk, 88, Y11 + 37, 1, 0.33, U.ask, U.say + 0.2, 0.2, 0, 0.82);
    say(sink, t, T.dupSay, 48, Y11 + 31, 1, 0.33, U.say, U.leave - 0.1, 0.2, 0, 0.82);
    /* 线从猫那儿顺着地板垂到楼下 */
    const k = smooth(U.say + 0.5, U.look + 0.2, t);
    if (k > 0) {
      const a: Vec3 = [72, Y11 + 0.6, -20];
      const b: Vec3 = [120, Y11 + 0.6, -20];
      const c: Vec3 = [120, Y12 + 13, -20];
      const total = 48 + (b[1] - c[1]);
      const reach = k * total;
      const run = Math.min(reach, 48);
      sink.put("spark", segMatrix(a, [72 + run, a[1], a[2]], 0.55), GOLD, 2.2, 0.35, 2, 0);
      if (reach > 48) sink.put("spark", segMatrix(b, [120, b[1] - (reach - 48), -20], 0.55), GOLD, 2.2, 0.35, 2, 0);
    }
  }

  function roomPink(t: number, sink: Sink, cupX: number, tilt: number) {
    const y = Y11;
    desk(sink, 0, y, -24, 60, 22);
    const working = t >= H.leave + 1.2;
    monitor(sink, -22, y + 12, -26, 0.65, 1, working ? (t > K.dark - 1 ? "done" : "code") : "chart", t);
    box(sink, -14, y + 12.3, -19, 11, 0.7, 4.6, [0.84, 0.84, 0.86]);
    chair(sink, -6, y, -37, -0.5, [0.26, 0.28, 0.34]);
    sink.put("cup", chain(translate(cupX, y + 12, CUP_Z), rotateY(-1.1), rotateZ(-tilt), scale(0.82)), [0.96, 0.94, 0.9]);
    lamp(sink, 0, y + 45, -24, working ? 0.1 : 1);
    clock(sink, t >= K.start ? homeClock(t) : t >= H.ask - 0.4 ? COPY.stamps.hand : t >= U.leave + 0.4 ? COPY.stamps.cup : COPY.stamps.dup, 7, y + 35, -43.2, 0.42);
    const leaving = H.leave;
    if (t < leaving + 1.6) {
      const standing = smooth(H.ask - 0.5, H.ask, t);
      const walkK = clamp((t - leaving) / 1.5);
      const x = mix(-6, -56, smooth(0.1, 1, walkK));
      const z = mix(-37, -22, smooth(0.4, 1, walkK));
      const slide = smooth(C.slide, C.slide + 0.28, t);
      const nodding = t < C.slide ? 0.05 * Math.sin(t * 10) : 0;
      drawPerson(sink, laozhou, {
        x, y, z,
        yaw: walkK > 0 ? -1.4 : -0.5,
        sit: 1 - standing,
        t,
        type: t < C.slide ? 0.7 : 0,
        headPitch: nodding + 0.06,
        headYaw: mix(-0.1, 0.25, slide) + (t > H.say ? 0.6 : 0),
        lookX: mix(-0.9, 1.1, slide) * (1 - smooth(C.ok + 0.2, C.ok + 0.5, t)),
        step: x * 0.6,
        move: walkK > 0 && walkK < 1 ? 1 : 0,
        blink: Math.sin(t * 1.3 + 2) > 0.985 ? 1 : 0,
        smile: t > C.ok + 0.1 ? 1 : 0
      });
    }
    say(sink, t, T.cupSay, 4, y + 31, -12, 0.21, C.say, C.tap1 + 0.35, 0.1, 0, 0.76);
    say(sink, t, T.cupOk, -3.5, y + 33, -30, 0.25, C.ok, C.back + 0.3, 0.1, 0, 0.92);
    say(sink, t, T.handAsk, -26, y + 38, -12, 0.27, H.ask, H.leave, 0.2, 0, 0.82);
    say(sink, t, T.handSay, 34, y + 36, -12, 0.27, H.say, H.leave + 0.6, 0.2, 0, 0.82);
  }

  function web(t: number, sink: Sink, dist: number) {
    if (t < A.wave) return;
    const age = t - A.wave;
    const w = clamp(dist * 0.0011, 0.5, 2.8);
    const calm = 1 - 0.82 * smooth(P.face - 0.5, P.face + 0.7, t);
    for (const run of runs) {
      const k = clamp((age - run.from) / (run.to - run.from));
      if (k < 0.02) continue;
      const born = Math.exp(-Math.max(age - run.to, 0) * 3);
      const pulse = Math.exp(-((((age - run.from * 1.6) % 2.2) + 2.2) % 2.2) * 4);
      sink.put("spark", segMatrix(run.a, mix3(run.a, run.b, k), w), GOLD, (0.9 + pulse * 2.2 + born * 2) * calm, 0.2, 2, 0);
    }
  }

  /** 慢慢合眼。用的是产品图标闭眼那张像素图，卷帘一格一格放下来。 */
  const CLOSED = art("closed");
  function blinds(t: number, sink: Sink) {
    const k = bump(t, P.blink, P.blink + 1.15, 0.5);
    if (k <= 0.001) return;
    for (const cell of CELLS) {
      if (cell.row < 7 || cell.row > 10) continue;
      const want = CLOSED[cell.row]![cell.col]!;
      if (want === MAIN[cell.row]![cell.col]) continue;
      const cover = clamp(k * 4.3 - (cell.row - 7));
      if (cover <= 0) continue;
      const h = CELL * cover;
      box(sink, cell.x + CELL / 2, cell.y + CELL - h / 2, cell.z + 2.2, CELL, h, 1.2, hex(PALETTE[want]!), 0.3);
    }
  }

  /** 气泡上的三个点活过来，像有人在打字。打完，那几间黑屋子也亮了灯。 */
  const WHITE = hex(PALETTE.W!);
  const INK_DOT = hex(PALETTE.k!);
  function dots(t: number, sink: Sink) {
    if (t < P.dots) return;
    const gone = smooth(P.word - 0.22, P.word + 0.02, t);
    if (gone >= 1) return;
    [-144, 0, 144].forEach((x, index) => {
      const phase = (t - P.dots - index * 0.16) / 0.72;
      const up = phase > 0 ? Math.max(Math.sin((phase % 1) * Math.PI * 2), 0) : 0;
      const size = 96 * (1 - gone);
      box(sink, x, 192 + up * 34, 44, size, size, 10, INK_DOT, 0.5);
    });
  }

  const hereLine = line(COPY.here);
  function word(t: number, sink: Sink) {
    if (t < P.word) return;
    const px = 17;
    const ox = -hereLine.width * px / 2 + 22;
    const oy = 50;
    for (const cell of hereLine.cells) {
      const delay = cell.glyph * 0.12;
      const a = pop(clamp((t - P.word - delay) / 0.4));
      if (a <= 0) continue;
      box(sink, ox + cell.x * px + px / 2, oy + cell.y * px + px / 2, 36 + 5, px * a, px * a, 12, [0.2, 0.21, 0.25], 0.42);
    }
  }

  /* 片尾的字钉在画面的固定高度上。at 是从画面中心往上走的比例，px 是字占画面的比例。 */
  function skyText(t: number, sink: Sink, text: string, from: number, to: number, eye: Vec3, target: Vec3, at: number, px: number, glow = 1) {
    if (t < from || t > to) return;
    const a = smooth(from, from + 0.4, t) * (1 - smooth(to - 0.3, to, t));
    if (a <= 0) return;
    const row = line(text);
    const z = 80;
    const dist = eye[2] - z;
    const half = Math.tan(0.25) * dist;
    const size = half * px;
    const y = eye[1] + ((target[1] - eye[1]) * dist) / (eye[2] - target[2]) + half * at;
    for (const cell of row.cells) {
      sink.spark(-(row.width * size) / 2 + cell.x * size + size / 2, y + cell.y * size, z, size * 0.96, 1, 0.98, 0.94, glow * a);
    }
  }

  return {
    meshes,
    at(t: number, sink: Sink, aspect: number) {
      updateLit(t);
      const pulling = t >= P.start;
      const shot = pulling ? pullCam(t) : dayShot(t);
      const here = catAt(t);
      const follow = bump(t, D.start - 0.15, D.land + 0.25, 0.3);
      const eye: Vec3 = [shot.eye[0], mix(shot.eye[1], here.pos[1] + 12, follow), shot.eye[2]];
      const target: Vec3 = [shot.target[0], mix(shot.target[1], here.pos[1] + 6, follow), shot.target[2]];
      const dist = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
      const sky = skyAt(hourAt(t));
      const nightness = sky.lamp;
      const far = smooth(300, 1300, eye[2]);
      const gain = mix(mix(0.06, 0.42, nightness), 0.95, far);
      const clean = smooth(1300, 2300, eye[2]);
      const dotsAlive = t >= P.dots;
      drawShell(sink, lit, gain, clean, (cell) => (dotsAlive && cell.ch === "k" ? WHITE : null));
      crowd(t, sink, dist < 500, clean);
      drawClouds(t, sink, mix3([0.86, 0.86, 0.92], [0.62, 0.54, 0.56], smooth(0.2, 0.7, nightness)));

      const headingNow = heading(t);
      const cupTaps = [C.tap1, C.tap2, C.tap3].reduce((sum, at) => sum + smooth(at, at + 0.14, t), 0);
      const pullBack = smooth(C.back, C.back + 0.5, t);
      const cupX = CUP_X + cupTaps * CUP_STEP - pullBack * 1.6 * CUP_STEP;
      const tilt = smooth(2.5, 3, cupTaps) * (0.1 + 0.05 * Math.sin(t * 13)) * (1 - smooth(0, 0.25, pullBack));

      const hide = smooth(0.15, 0.8, clean);
      if (hide < 1) roomHome(t, sink);
      if (hide <= 0) roomGreen(sink);
      if (t < D.land + 1) roomMeeting(t, sink, here.pos);
      else if (hide <= 0) lamp(sink, -60, Y8 + 45, -25, lit[cellAt(10, 8)!.index]!);
      if (t > D.start - 0.5 && t < D.land + 1) roomShaft(t, sink);
      if (t > D.start - 0.5 && t < C.in + 1) roomsTwin(t, sink);
      if (t > U.leave - 1 && hide < 1) roomPink(t, sink, cupX, tilt);
      if (hide > 0) {
        for (const cell of [cellAt(8, 8)!, cellAt(11, 11)!, cellAt(12, 11)!]) {
          const h = CELL * hide;
          box(sink, cell.x + CELL / 2, cell.y + CELL - h / 2, cell.z + 1.2, CELL, h, 1.2, cell.tint, 0.9);
        }
      }

      /* 猫 */
      const inBed = t < W.start - 0.05;
      const sitting = inBed ? 0 : t >= M.land - 0.05 && t < M.leave - 0.05 ? 1 : t >= D.land && t < U.leave ? 1 : t >= C.in && t < H.leave + 0.4 ? 1 : t >= H.leave + 1.5 ? 1 : 0;
      const wake = inBed ? (t < O.eyes ? 0 : 1) : 1;
      const tapNear = [C.tap1, C.tap2, C.tap3].reduce((best, at) => Math.max(best, bump(t, at - 0.3, at + 0.24, 0.16)), 0) * 0.8;
      const pullPaw = bump(t, C.back - 0.2, C.back + 0.6, 0.25) * 1.05;
      /* 每推一下，猫往前挪一步。 */
      const creep = [C.tap1, C.tap2, C.tap3].reduce((sum, at) => sum + smooth(at + 0.22, at + 0.5, t), 0);
      if (t >= C.in && t < H.leave + 0.5) here.pos = [CUP_CAT[0] + creep * CUP_STEP, CUP_CAT[1], CUP_CAT[2]];
      const lookAtMan = (bump(t, C.say, C.tap1 + 0.4, 0.2) + bump(t, C.tap2 - 0.2, C.tap2 + 0.3, 0.1) + bump(t, C.tap3 - 0.2, C.ok + 0.3, 0.1)) * -0.5;
      let look = 0;
      if (here.move > 0) look = headingNow < 1 ? 0.9 : -0.9;
      if (t >= M.ask && t < M.land) look = 0.2;
      if (t >= D.land && t < U.leave) look = mix(0.7, 0, smooth(U.say + 1.2, U.say + 1.6, t));
      if (t >= C.in) look = lookAtMan;
      if (t > H.ask && t < H.leave + 0.4) look = -0.5;
      if (t >= H.leave + 1.5) look = -1.2;
      const eyesNow = blink(t, [O.eyes + 0.6, W.door + 0.5, M.say + 1.3, U.say + 1.5, C.ok + 0.4, N.say + 0.5, A.say + 0.7]) ?? (wake ? "open" : "closed");
      const falling = t >= D.start && t < D.land;
      const nightCat = t >= K.dark - 0.6 && t < A.wave;
      const rising = smooth(A.wave, A.wave + 0.4, t);
      const pose = nightCat
        ? { x: homeSpot[0], y: homeSpot[1], z: homeSpot[2], heading: Math.PI / 2, look: t > N.say ? -0.2 : 0, loaf: 1, t, eyes: (t < N.ask + 0.8 ? "closed" : blink(t, [N.say + 0.8]) ?? "open") as "closed" | "open" }
        : t >= A.wave
          ? { x: homeSpot[0], y: homeSpot[1], z: homeSpot[2], heading: Math.PI / 2, look: 0, sit: rising, loaf: 1 - rising, t, eyes: "open" as const }
          : { x: here.pos[0], y: here.pos[1], z: here.pos[2], heading: headingNow, look, sit: sitting, loaf: 1 - smooth(W.start - 0.35, W.start + 0.02, t), step: falling ? t * 26 : here.step, move: falling ? 1 : here.move, reach: tapNear + pullPaw, t, eyes: eyesNow, flick: bump(t, M.ask + 0.2, M.ask + 0.6, 0.1) };
      const drawn = hide < 1 ? drawKitty(sink, pose) : { root: scale(1), head: scale(1), tail: [0, 0, 0] as Vec3 };

      /* 黑场里只看得见眼睛 */
      const black = 1 - smooth(O.lamp, O.lamp + 0.1, t);
      if (black > 0 && t >= O.eyes) {
        const open = smooth(O.eyes, O.eyes + 0.2, t);
        for (const side of [-1, 1]) {
          boxIn(sink, drawn.head, side * 4.8, 3.2, 6.4, 4.8, 4.6 * open, 0.6, [0.32, 0.86, 0.42], 2.2);
          boxIn(sink, drawn.head, side * 4.8, 3.2, 6.9, 1.1, 3.8 * open, 0.4, [0.02, 0.04, 0.03]);
        }
      }

      /* 线 */
      const shimmerAt = t * 40;
      for (const seg of threadSegs) {
        if (seg.t > t) break;
        const shine = 1.5 + 1.6 * Math.exp(-((((seg.s - shimmerAt) % 90) + 90) % 90) * 0.1);
        sink.put("spark", seg.m, GOLD, shine, 0.35, 2, 0);
      }

      web(t, sink, eye[2]);
      blinds(t, sink);
      dots(t, sink);
      word(t, sink);

      /* 话 */
      say(sink, t, T.ask, -176, Y8 + 26, 1, 0.21, O.ask, O.lamp + 0.3, mix(0.3, 0.85, black));
      say(sink, t, T.here, -139, Y8 + 26, 1, 0.21, O.say, W.start + 0.25, mix(0.3, 0.85, black));
      say(sink, t, T.ask, -183, Y8 + 34, 1, 0.2, N.ask, N.say + 1.2);
      say(sink, t, T.here, -147, Y8 + 32, 1, 0.2, N.say, N.end - 0.2);
      say(sink, t, T.newAsk, -188, Y8 + 35, 1, 0.2, A.ask, A.say + 0.5, 0.2, 0, 0.84);
      say(sink, t, T.newSay, -146, Y8 + 33, 1, 0.2, A.say, P.start + 0.7, 0.2, 0, 0.84);

      skyText(t, sink, COPY.brain, E.brain, E.line - 0.05, eye, target, 0.62, 0.0155, 1.4);
      skyText(t, sink, COPY.line, E.line, 61, eye, target, 0.62, 0.0155, 1.4);
      skyText(t, sink, `${COPY.brand}  ${COPY.site}`, E.logo, 61, eye, target, 0.43, 0.0085, 1.2);

      /* 灯：离镜头近的屋子才有点光源。 */
      const near = CELLS.filter((cell) => lit[cell.index]! > 0.1).map((cell) => ({ cell, d: Math.hypot(cell.x + 24 - target[0], cell.y + 24 - target[1]) })).sort((a, b) => a.d - b.d).slice(0, 12);
      for (const { cell, d } of near) {
        const fade = 1 - smooth(120, 220, d);
        const power = (0.25 + nightness * 1.1) * fade * lit[cell.index]!;
        if (power > 0.01) sink.light(cell.x + 24, cell.y + 36, cell.z - 18, 26, power * 1.6, power * 1.42, power * 1.12);
      }
      if (t >= H.leave + 0.9 && t < N.ask) sink.light(-20, Y11 + 22, -22, 16, 0.5, 0.62, 0.9);
      if (t > C.in - 0.5 && t < K.start + 1) sink.light(20, Y11 + 30, -2, 34, 0.75, 0.68, 0.58);
      const faceFill = smooth(A.enter - 0.5, A.enter, t) * (1 - smooth(P.start, P.start + 1.2, t));
      if (faceFill > 0.01) sink.light(-180, Y8 + 26, 14, 34, 0.8 * faceFill, 0.7 * faceFill, 0.58 * faceFill);

      const hold = dist;
      const cam: Cam = { eye, target, fov: shot.fov, focus: shot.focus || hold, aperture: shot.aperture, roll: shot.roll, near: pulling ? 2 : 1.5, far: 14000 };
      const dark = 1 - black;
      const env: Env = {
        top: mix3([0, 0, 0], sky.top, dark), mid: mix3([0, 0, 0], sky.mid, dark), low: mix3([0, 0, 0], sky.low, dark), below: mix3([0, 0, 0], sky.below, dark),
        glowDir: normalize([-0.5, 0.12, -0.84]), glowColor: mix3([0, 0, 0], mix3([0.4, 0.3, 0.2], [1.5, 0.9, 0.5], smooth(28, 31, hourAt(t))), dark),
        keyDir: sky.dir, keyColor: mix3([0, 0, 0], sky.key, dark), keySpread: 0.05,
        rimDir: normalize([0.45, 0.3, -0.84]), rimColor: mix3([0, 0, 0], sky.rim, dark),
        domeGain: sky.dome * dark, ambient: mix3([0, 0, 0], sky.amb, dark), stars: sky.stars * dark,
        fog: [mix(0.00004, 0.00012, far), -20, 0.0085], exposure: sky.exp, flash: [0, 0, 0], bloom: 0.09, vignette: 0.32, fade: smooth(0, 0.3, t) * (1 - smooth(59.3, 60, t)),
        shadowCenter: target, shadowRadius: clamp(dist * 1.15, 130, 1500)
      };
      return { cam, env };
    }
  };
}
