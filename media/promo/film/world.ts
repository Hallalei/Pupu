/** 世界：东西摆在哪、这一刻长什么样。一切都是时间的纯函数。 */
import { chain, normalize, rotateX, rotateY, rotateZ, scale, translate, type Mat4, type Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";
import { BUBBLE_FRONT } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import { blink, bump, catMeshes, drawCat } from "./cat.ts";
import { COPY } from "./copy.ts";
import { avatar, avatarPupu, chatBubble, cube, cumulus, disc, line, slab } from "./models.ts";
import { add3, bezier, clamp, drift, mix, mix3, mul3, smooth, smoother, sub3, track, type Key } from "./path.ts";
import type { Cam, Env, Sink, World } from "./stage.ts";
import { LINE, loadFont } from "./text.ts";

export const lin = (hex: string): Vec3 => [1, 3, 5].map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255) ** 2.2) as Vec3;

const S = 8;
const CAT_BASE = chain(translate(-12.5 * S, 8, 0), scale(S));
/** 大气泡正面中心。 */
const BRAIN: Vec3 = [-4, 56, 41];
const MOON_AT: Vec3 = [-430, 540, -1500];
const SUN_AT: Vec3 = [440, 110, -2800];

const GOLD: Vec3 = [1, 0.72, 0.34];
const MARK: Vec3 = [1, 0.72, 0.3];
const INK: Vec3 = [0.2, 0.21, 0.25];
const MARK_INK: Vec3 = [0.2, 0.12, 0.06];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

type CloudSpot = { kind: number; x: number; y: number; z: number; size: number; speed: number; yaw: number };

function cloudSea(keepClear: { at: Vec3; radius: number }[]): CloudSpot[] {
  const next = rng(1234);
  const out: CloudSpot[] = [];
  for (let index = 0; index < 340; index++) {
    const z = 1500 - next() ** 0.8 * 4400;
    const x = (next() - 0.5) * (2800 + Math.max(0, -z) * 1.6);
    const far = clamp((800 - z) / 3200);
    const size = 2.2 + far * 8 + next() * 2;
    const y = -96 - next() * 40 - far * 90;
    if (keepClear.some(({ at, radius }) => Math.hypot(x - at[0], z - at[2]) < radius + size * 40)) continue;
    out.push({ kind: index % 6, x, y, z, size, speed: 0.4 + next() * 0.5, yaw: next() * 6.28 });
  }
  return out;
}

type Cell = { x: number; y: number; glyph: number };
type Row = { text: string; mark: boolean; line: ReturnType<typeof line>; top: number };
type Msg = { name: string; w: number; h: number; rows: Row[]; cells: (Cell & { row: number })[]; glyphs: number };

const PAD = 10;

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

/** 气泡弹出来：过冲一点再回来。 */
function pop(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 1 - Math.exp(-6.5 * x) * Math.cos(x * 9.5);
}

const point = (m: Mat4, x: number, y: number, z: number): Vec3 => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
];

export async function buildWorld(): Promise<World> {
  await loadFont();
  const beats = await (await fetch("/media/promo/film/beats.json")).json();
  const R = beats.relay as Record<"start" | "lift" | "enter" | "exit" | "land" | "end", number>;
  const copy = COPY.relay;
  const Q = beats.questions as Record<"first" | "spread" | "title" | "rise" | "breach", number>;
  const V2 = beats.reveal as Record<"dots" | "text" | "leave", number>;
  const F = beats.flow as Record<"start" | "write" | "sun", number>;
  const E = beats.end as Record<"line" | "logo", number>;

  const meshes: World["meshes"] = { ...catMeshes(), cube: { mesh: cube("X") }, spark: { mesh: cube("X"), caster: false } };
  for (let kind = 0; kind < 6; kind++) meshes[`cloud${kind}`] = { mesh: cumulus(kind + 3), caster: false };

  const addMsg = (msg: Msg, tail: "left" | "right" = "left") => {
    meshes[msg.name] = { mesh: chatBubble(msg.w, msg.h, 8, tail) };
    msg.rows.forEach((row, index) => {
      if (row.mark) meshes[`${msg.name}-mark${index}`] = { mesh: slab(row.line.width + 6, LINE + 1) };
    });
    return msg;
  };
  const msgA = addMsg(message("msgA", [{ text: copy.decided }, { text: copy.fact, mark: true }]));
  const msgQ = addMsg(message("msgQ", [{ text: copy.ask }]));
  const msgR = addMsg(message("msgR", [{ text: copy.fact, mark: true }, { text: copy.source }]));
  meshes.sun = { mesh: disc(), caster: false };
  const questions = COPY.questions.map((text, index) => addMsg(message(`question${index}`, [{ text }])));
  const title = addMsg(message("title", COPY.title.map((text) => ({ text }))));
  meshes.avatarLin = { mesh: avatar("A", line("林")) };
  meshes.avatarZhou = { mesh: avatar("Z", line("周")) };
  meshes.avatarPupu = { mesh: avatarPupu() };
  const memory = COPY.memory.map((text, index) => addMsg(message(`memory${index}`, [{ text }])));

  /* 三个气泡在世界里的位置。回复和提问离 Pupu 近，从气泡里拉出来时它们从两边进画。 */
  const V = 0.42;
  const frameA = chain(translate(250, 150, 260), rotateY(-0.5), rotateX(-0.03), scale(V));
  const yawR = 0.2;
  const frameQ = chain(translate(-196, 194, 410), rotateY(yawR), rotateX(-0.03), scale(V));
  const frameR = chain(translate(-190, 166, 414), rotateY(yawR), rotateX(-0.03), scale(V));
  const normalA: Vec3 = normalize([Math.sin(-0.5), 0, Math.cos(-0.5)]);
  const normalR: Vec3 = normalize([Math.sin(yawR), 0, Math.cos(yawR)]);
  const centerA = point(frameA, 0, 0, 0);
  const centerR = point(frameR, 0, 0, 0);

  const sea = cloudSea([
    { at: [0, 0, 20], radius: 170 },
    { at: centerA, radius: 110 },
    { at: centerR, radius: 120 },
    { at: [-100, 0, 240], radius: 120 },
    { at: [30, 0, 470], radius: 130 }
  ]);

  /* 光流：高亮这行的每个体素飞一个分身。到了 Pupu 再原样落进回复里。 */
  const goldA = msgA.cells.filter((cell) => cell.row === 1);
  const goldR = msgR.cells.filter((cell) => cell.row === 0);
  const next = rng(99);
  const flow = goldA.flatMap((cell, index) => {
    const to = goldR[index] ?? goldR[goldR.length - 1]!;
    return [0, 1, 2].map((copyIndex) => ({
      from: point(frameA, cell.x, cell.y, 2),
      to: point(frameR, to.x, to.y, 2),
      index,
      main: copyIndex === 0,
      size: copyIndex === 0 ? 0.42 : 0.2 + next() * 0.14,
      delay: ((cell.x + msgA.w / 2) / msgA.w) * 0.9 + next() * 0.2 + copyIndex * 0.07,
      wobble: next() * 6.28,
      spin: 0.6 + next() * 1.1,
      radius: 3 + next() ** 1.4 * (copyIndex === 0 ? 12 : 26),
      late: next() * 0.3
    }));
  });
  const headA = (p: number) => bezier(centerA, add3(centerA, add3(mul3(normalA, 86), [-30, 76, 0])), add3(BRAIN, [190, -34, 300]), BRAIN, p);
  const headR = (p: number) => bezier(BRAIN, add3(BRAIN, [-70, -30, 190]), add3(centerR, add3(mul3(normalR, 50), [70, -12, 0])), centerR, p);

  const flightIn = R.enter - R.lift - 0.72;
  const flightOut = R.land - R.exit - 0.2;
  const landAt = (p: (typeof flow)[0]) => R.exit - 0.1 + p.delay * 0.45 + flightOut + p.late * 0.5;

  const KEYS: Key[] = [
    { t: R.start - 0.5, eye: add3(centerA, add3(mul3(normalA, 86), [-14, 3, 0])), target: add3(centerA, [-8, 3, 0]), fov: 0.62, focus: 86, aperture: 0.34 },
    { t: R.lift - 0.2, eye: add3(centerA, add3(mul3(normalA, 66), [-8, 0, 0])), target: add3(centerA, [-5, 3, 0]), fov: 0.62, focus: 66, aperture: 0.3 },
    { t: R.lift + 0.8, eye: add3(centerA, add3(mul3(normalA, 74), [2, -5, 0])), target: add3(centerA, [-6, 13, 6]), fov: 0.72, focus: 66, aperture: 0.26, roll: 0.02 },
    { t: R.lift + 1.5, eye: add3(centerA, add3(mul3(normalA, 104), [-6, 8, 18])), target: add3(headA(0.13), [-30, 10, 0]), fov: 0.86, focus: 80, aperture: 0.2, roll: 0.06 },
    { t: R.lift + 2.25, eye: add3(headA(0.12), [26, 44, 58]), target: mix3(headA(0.6), add3(BRAIN, [0, 50, 0]), 0.6), fov: 0.98, focus: 170, aperture: 0.14, roll: 0.09 },
    { t: R.lift + 3.1, eye: add3(headA(0.56), [14, 50, 46]), target: add3(BRAIN, [0, 50, 0]), fov: 1.04, focus: 190, aperture: 0.1, roll: 0.04 },
    { t: R.enter - 0.14, eye: add3(BRAIN, [3, 3, 60]), target: BRAIN, fov: 1.15, focus: 60, aperture: 0.05, roll: 0 },
    { t: R.enter + 0.22, eye: add3(BRAIN, [0, 0, 5]), target: BRAIN, fov: 1.25, focus: 12, aperture: 0.02, roll: 0 }
  ];
  const finalEye = add3(centerR, add3(mul3(normalR, 116), [12, 8, 0]));
  const OUT: Key[] = [
    { t: R.exit - 0.2, eye: add3(BRAIN, [0, 2, 7]), target: BRAIN, fov: 1.25, focus: 20, aperture: 0.02, roll: 0.02 },
    { t: R.exit + 0.75, eye: add3(BRAIN, [-20, 34, 200]), target: add3(BRAIN, [-10, 44, 0]), fov: 1.02, focus: 200, aperture: 0.08, roll: 0.03 },
    { t: R.exit + 1.7, eye: add3(BRAIN, [-110, 96, 470]), target: add3(BRAIN, [-70, 74, 0]), fov: 0.8, focus: 150, aperture: 0.2, roll: 0.015 },
    { t: R.land + 0.55, eye: add3(finalEye, [6, 2, 20]), target: add3(centerR, [24, 8, 0]), fov: 0.74, focus: 134, aperture: 0.42 },
    { t: R.land + 1.6, eye: add3(finalEye, [2, 0, 5]), target: add3(centerR, [22, 8, 0]), fov: 0.72, focus: 120, aperture: 0.46 },
    { t: R.end + 0.6, eye: finalEye, target: add3(centerR, [21, 8, 0]), fov: 0.72, focus: 116, aperture: 0.46 }
  ];

  function drawCells(sink: Sink, m: Mat4, msg: Msg, typed: number, level: number, skipRow = -1) {
    msg.rows.forEach((row, index) => {
      if (row.mark && index !== skipRow) sink.put(`${msg.name}-mark${index}`, chain(m, translate(-msg.w / 2 + PAD + row.line.width / 2, row.top + LINE / 2 - 0.5, 0)), MARK, 0.55 * level, 1, 0, 0);
    });
    for (const cell of msg.cells) {
      if (cell.glyph >= typed || cell.row === skipRow) continue;
      const row = msg.rows[cell.row]!;
      const color = row.mark ? MARK_INK : INK;
      sink.cube(m, cell.x, cell.y, row.mark ? 1.5 : 0.5, 1, color[0], color[1], color[2], 0);
    }
  }

  function drawMsg(sink: Sink, frame: Mat4, msg: Msg, appear: number, typed: number, level = 1) {
    if (appear <= 0) return;
    const m = chain(frame, scale(Math.max(pop(appear), 0.001)));
    sink.put(msg.name, m);
    drawCells(sink, m, msg, typed, level);
  }

  function drawStamp(sink: Sink, frame: Mat4, text: string, amount: number, x: number, y: number) {
    if (amount <= 0) return;
    const row = line(text);
    for (const cell of row.cells) sink.cube(frame, cell.x + x, cell.y + y, 0, 1, 0.8, 0.86, 1, 0.42 * amount, 0.3);
  }

  function dust(sink: Sink, eye: Vec3, t: number, amount: number, color: Vec3) {
    const pick = rng(4242);
    const box = 260;
    for (let index = 0; index < 300; index++) {
      const x = pick() * box;
      const y = pick() * box;
      const z = pick() * box;
      const wrap = (v: number, e: number) => e + ((((v - e) % box) + box * 1.5) % box) - box / 2;
      const bright = pick();
      sink.spark(wrap(x + t * 2, eye[0]), wrap(y + Math.sin(t * 0.3 + index) * 3, eye[1]), wrap(z, eye[2]), 0.14 + bright * 0.24, color[0], color[1], color[2], (0.3 + bright * 0.9) * amount);
    }
  }

  function drawReply(sink: Sink, t: number) {
    const r = (t - (R.land - 0.5)) / 0.5;
    if (r <= 0) return;
    const m = chain(frameR, scale(Math.max(pop(r), 0.001)));
    sink.put(msgR.name, m);
    const level = 1 + bump(t, R.land, R.land + 1.3, 0.3) * 1.2;
    const row = msgR.rows[0]!;
    sink.put(`${msgR.name}-mark0`, chain(m, translate(-msgR.w / 2 + PAD + row.line.width / 2, row.top + LINE / 2 - 0.5, 0)), MARK, 0.55 * level, 1, 0, 0);
    flow.forEach((p) => {
      if (!p.main || t < landAt(p)) return;
      const cell = goldR[p.index];
      if (cell) sink.cube(m, cell.x, cell.y, 1.5, 1, MARK_INK[0], MARK_INK[1], MARK_INK[2], 0);
    });
    const start = row.line.glyphs;
    const typed = Math.floor(clamp((t - R.land - 0.55) / 0.7) * (line(copy.source).glyphs + 1));
    for (const cell of msgR.cells) {
      if (cell.row === 1 && cell.glyph - start < typed) sink.cube(m, cell.x, cell.y, 0.5, 1, INK[0], INK[1], INK[2], 0);
    }
    sink.put("avatarPupu", chain(frameR, translate(-msgR.w / 2 - 19, -msgR.h / 2 + 12, -2), scale(pop(r))));
  }

  function outdoors(t: number, sink: Sink) {
    scenery(t, sink, 0);

    const glance = bump(t, R.lift + 1.5, R.enter + 0.2, 0.4);
    const eyes = blink(t, [R.lift + 0.4, R.enter - 0.06, R.enter + 0.14, R.exit + 1.3]) ?? (glance > 0.5 ? "right" : "open");
    const lit = bump(t, R.enter - 0.3, R.enter + 0.8, 0.2) + bump(t, R.exit - 0.2, R.exit + 0.6, 0.2);
    const thinking = smooth(R.enter - 1.0, R.enter - 0.2, t) * (1 - smooth(R.exit + 0.5, R.exit + 1.4, t));
    drawCat(sink, CAT_BASE, t, { eyes, glance, flick: bump(t, R.enter - 0.1, R.enter + 0.25, 0.08), dots: 1, glow: lit * 0.25, dotGlow: thinking });

    const a = smooth(R.start - 0.3, R.start + 0.35, t);
    const hot = 1 + bump(t, R.lift - 0.4, R.lift + 1.1, 0.3) * 1.3;
    drawMsg(sink, frameA, msgA, a, Math.floor(clamp((t - R.start) / 1.1) * (msgA.glyphs + 1)), hot);
    if (a > 0) {
      sink.put("avatarLin", chain(frameA, translate(-msgA.w / 2 - 19, -msgA.h / 2 + 12, -2), scale(pop(a))));
      drawStamp(sink, frameA, copy.stampMorning, a, -msgA.w / 2 + 2, msgA.h / 2 + 5);
    }

    const q = smooth(R.exit + 0.6, R.exit + 1.2, t);
    drawMsg(sink, frameQ, msgQ, q, 999);
    if (q > 0) {
      sink.put("avatarZhou", chain(frameQ, translate(-msgQ.w / 2 - 19, -msgQ.h / 2 + 12, -2), scale(pop(q))));
      drawStamp(sink, frameQ, copy.stampAfternoon, q, -msgQ.w / 2 + 2, msgQ.h / 2 + 5);
    }
    drawReply(sink, t);
  }

  function along(p: (typeof flow)[0], e: number, center: Vec3, head: (x: number) => Vec3, offset: Vec3, fall: number, turn: number): Vec3 {
    const base = head(e);
    const swirl = Math.sin(e * Math.PI) ** 1.1;
    const a = p.wobble + e * turn * p.spin;
    const r = p.radius * swirl;
    return add3(add3(base, mul3(sub3(offset, center), fall)), [Math.cos(a) * r, Math.sin(a * 1.2) * r, Math.sin(a) * r]);
  }

  function streamIn(sink: Sink, t: number) {
    let lit = 0;
    for (const p of flow) {
      const k = (t - R.lift - p.delay) / (flightIn + p.late);
      if (k <= 0 || k >= 1) continue;
      const e = k ** 1.7;
      const fall = (1 - e) ** 3;
      const c = along(p, e, centerA, headA, p.from, fall, 7);
      const size = p.size * mix(1, 1.5, Math.sin(k * Math.PI)) * (1 - smooth(0.92, 1, k) * 0.7);
      sink.spark(c[0], c[1], c[2], size, GOLD[0], GOLD[1], GOLD[2], 4.6);
      if (!p.main) continue;
      for (let tail = 1; tail <= 3; tail++) {
        const b = along(p, Math.max(e - tail * 0.011, 0), centerA, headA, p.from, fall, 7);
        sink.spark(b[0], b[1], b[2], size * (0.62 - tail * 0.14), GOLD[0], GOLD[1], GOLD[2], 3 - tail * 0.7);
      }
      if (lit < 4 && p.index % 53 === 0) {
        sink.light(c[0], c[1], c[2], 34, 0.42, 0.26, 0.1);
        lit += 1;
      }
    }
  }

  function streamOut(sink: Sink, t: number) {
    let lit = 0;
    for (const p of flow) {
      const start = R.exit - 0.1 + p.delay * 0.45;
      const k = (t - start) / (flightOut + p.late * 0.5);
      if (k <= 0 || k >= 1) continue;
      const e = k ** 1.2;
      const fall = e ** 3;
      const c = along(p, e, centerR, headR, p.to, fall, -6);
      const size = p.size * mix(1, 1.5, Math.sin(k * Math.PI));
      sink.spark(c[0], c[1], c[2], size, GOLD[0], GOLD[1], GOLD[2], 4.6);
      if (!p.main) continue;
      for (let tail = 1; tail <= 2; tail++) {
        const b = along(p, Math.max(e - tail * 0.011, 0), centerR, headR, p.to, fall, -6);
        sink.spark(b[0], b[1], b[2], size * (0.62 - tail * 0.2), GOLD[0], GOLD[1], GOLD[2], 3 - tail);
      }
      if (lit < 4 && p.index % 53 === 0) {
        sink.light(c[0], c[1], c[2], 34, 0.42, 0.26, 0.1);
        lit += 1;
      }
    }
  }

  /* Pupu 里面：大家说过的事都在，时间从上午走到下午。 */
  const INNER: Vec3 = [0, 6000, 0];
  const TRAVEL = 310;
  const innerNext = rng(77);
  const memories = Array.from({ length: 16 }, (_, index) => {
    const a = (index * 2.399963) % 6.283;
    return { msg: memory[index % memory.length]!, a, r: 40 + innerNext() * 34, z: -46 - index * 24, roll: (innerNext() - 0.5) * 0.3, yaw: -Math.cos(a) * 0.5, size: 0.3 + innerNext() * 0.1 };
  });
  const threads = Array.from({ length: 1500 }, () => ({ a: innerNext() * 6.28, r: 20 + innerNext() ** 0.7 * 190, z: innerNext(), speed: 0.5 + innerNext(), size: 0.1 + innerNext() ** 3 * 0.42 }));

  function inside(t: number, sink: Sink): Cam {
    const k = (t - R.enter) / (R.exit - R.enter);
    const eye: Vec3 = [INNER[0], INNER[1], INNER[2] - mix(0, TRAVEL, k)];
    for (const m of memories) {
      const at: Vec3 = [INNER[0] + Math.cos(m.a) * m.r, INNER[1] + Math.sin(m.a) * m.r * 0.66, INNER[2] + m.z];
      const frame = chain(translate(...at), rotateY(m.yaw), rotateZ(m.roll), scale(m.size));
      sink.put(m.msg.name, frame, [1, 0.97, 0.9], 0.12, 1, 0, 0);
      for (const cell of m.msg.cells) sink.cube(frame, cell.x, cell.y, 0.5, 1, INK[0], INK[1], INK[2], 0, 1);
    }
    for (const p of threads) {
      const z = ((p.z + t * 0.3 * p.speed) % 1) * 760;
      const a = p.a + z * 0.008 + t * 0.2;
      sink.spark(INNER[0] + Math.cos(a) * p.r, INNER[1] + Math.sin(a) * p.r * 0.72, eye[2] + 80 - z, p.size, GOLD[0], GOLD[1], GOLD[2], 3 + p.speed * 3);
    }
    sink.light(eye[0], eye[1] + 6, eye[2] - 30, 90, 0.8, 0.66, 0.42);
    sink.light(eye[0], eye[1] - 8, eye[2] - 120, 120, 0.9, 0.6, 0.3);

    // 时间：上午变下午，字的体素直接挪过去。
    const from = line(copy.stampMorning);
    const to = line(copy.stampAfternoon);
    const morph = smoother(0.36, 0.66, k);
    const size = 2.1;
    const stampZ = INNER[2] - TRAVEL - 34;
    const count = Math.max(from.cells.length, to.cells.length);
    for (let index = 0; index < count; index++) {
      const a = from.cells[Math.floor((index / count) * from.cells.length)]!;
      const b = to.cells[Math.floor((index / count) * to.cells.length)]!;
      const scatter = Math.sin(morph * Math.PI);
      const x = mix((a.x - from.width / 2) * size, (b.x - to.width / 2) * size, morph) + Math.sin(index * 12.9) * 30 * scatter;
      const y = mix(a.y - 6, b.y - 6, morph) * size + Math.cos(index * 7.3) * 22 * scatter;
      sink.cube(null, INNER[0] + x, INNER[1] + y, stampZ + Math.sin(index * 3.1) * 34 * scatter, size, 1, 0.8, 0.5, 2, 0);
    }
    return { eye, target: [INNER[0], INNER[1], eye[2] - 100], fov: 1.05, focus: 120, aperture: 0.05, roll: k * 0.16 - 0.08, near: 1, far: 2000 };
  }

  /* 第一幕：云层下面，很多人在问。 */
  const FIELD: Vec3 = [30, -520, 240];
  const fieldNext = rng(21);
  const crowd = Array.from({ length: 84 }, (_, index) => {
    const spread = 1 + index / 26;
    const x = (fieldNext() - 0.5) * 300 * spread;
    const y = (fieldNext() - 0.5) * 150 * spread;
    const z = 60 - fieldNext() * 560 * spread;
    const near = Math.hypot(x, y * 1.4);
    return { msg: questions[index % 3 === 0 ? 0 : 1 + (index % 4)]!, at: add3(FIELD, [near < 60 ? x + Math.sign(x || 1) * 70 : x, y, z]), yaw: (fieldNext() - 0.5) * 0.7, tilt: (fieldNext() - 0.5) * 0.2, size: 0.34 + fieldNext() * 0.2, phase: fieldNext() * 6.28, born: Q.spread + (index / 84) ** 0.8 * (Q.title - Q.spread + 1.2) };
  });

  function field(t: number, sink: Sink) {
    const hero = chain(translate(...FIELD), rotateY(Math.sin(t * 0.3) * 0.05), rotateX(-0.04), scale(0.5));
    drawMsgCold(sink, hero, questions[0]!, t - Q.first, 1 - smooth(Q.title - 0.4, Q.title + 0.2, t));
    for (const c of crowd) {
      const age = t - c.born;
      if (age <= 0) continue;
      const bob = Math.sin(t * 0.5 + c.phase) * 3;
      const frame = chain(translate(c.at[0], c.at[1] + bob, c.at[2]), rotateY(c.yaw + Math.sin(t * 0.2 + c.phase) * 0.06), rotateZ(c.tilt), scale(c.size));
      drawMsgCold(sink, frame, c.msg, age, 1);
    }
    const shown = t - Q.title;
    if (shown > 0) {
      const frame = chain(translate(FIELD[0], FIELD[1] + 2, FIELD[2] + 42), rotateX(-0.03), scale(1.16));
      const m = chain(frame, scale(Math.max(pop(shown * 1.8), 0.001)));
      sink.put(title.name, m, [1, 1, 1], 0.05, 1, 0, 1);
      for (const cell of title.cells) sink.cube(m, cell.x, cell.y, 0.5, 1, INK[0], INK[1], INK[2], 0, 1);
    }
    sink.light(FIELD[0], FIELD[1] + 10, FIELD[2] + 70, 120, 0.3, 0.36, 0.5);
    sink.light(FIELD[0] + 140, FIELD[1] + 40, FIELD[2] - 200, 200, 0.16, 0.2, 0.34);
    sink.light(FIELD[0] - 160, FIELD[1] - 30, FIELD[2] - 320, 220, 0.14, 0.18, 0.32);
  }

  function drawMsgCold(sink: Sink, frame: Mat4, msg: Msg, age: number, level: number) {
    if (age <= 0 || level <= 0) return;
    const m = chain(frame, scale(Math.max(pop(age * 2.2), 0.001) * (0.2 + 0.8 * level)));
    sink.put(msg.name, m, [0.78, 0.84, 1], 0.03, 1, 0, 1);
    for (const cell of msg.cells) sink.cube(m, cell.x, cell.y, 0.5, 1, INK[0], INK[1], INK[2], 0, 1);
  }

  const PRO: Key[] = [
    { t: -1, eye: add3(FIELD, [0, 1, 62]), target: FIELD, fov: 0.6, focus: 62, aperture: 0.22 },
    { t: 2.2, eye: add3(FIELD, [0, 2, 74]), target: FIELD, fov: 0.6, focus: 74, aperture: 0.22 },
    { t: 6.2, eye: add3(FIELD, [24, 12, 190]), target: add3(FIELD, [0, 0, -50]), fov: 0.74, focus: 200, aperture: 0.6 },
    { t: 9.7, eye: add3(FIELD, [10, 8, 262]), target: add3(FIELD, [0, 2, 0]), fov: 0.76, focus: 220, aperture: 0.5 },
    { t: Q.rise, eye: add3(FIELD, [0, 3, 232]), target: add3(FIELD, [0, 3, 42]), fov: 0.74, focus: 190, aperture: 0.3 },
    { t: Q.rise + 1.3, eye: [30, -400, 470], target: [30, -40, 420], fov: 0.95, focus: 300, aperture: 0.1, roll: 0.05 },
    { t: Q.rise + 2.5, eye: [32, -150, 472], target: [34, 200, 400], fov: 1.1, focus: 300, aperture: 0.08, roll: -0.04 },
    { t: Q.breach, eye: [32, 6, 470], target: [8, 110, 60], fov: 0.96, focus: 450, aperture: 0.08 },
    { t: V2.dots, eye: [26, 26, 452], target: [0, 112, 0], fov: 0.82, focus: 440, aperture: 0.2 },
    { t: V2.text, eye: [14, 44, 380], target: [-3, 94, 0], fov: 0.68, focus: 372, aperture: 0.26 },
    { t: V2.leave, eye: [4, 52, 322], target: [-3, 84, 0], fov: 0.62, focus: 300, aperture: 0.26 },
    { t: V2.leave + 0.42, eye: add3(centerA, add3(mul3(normalA, 110), [-40, 8, 20])), target: add3(centerA, [-30, 6, 0]), fov: 0.66, focus: 100, aperture: 0.3 },
    { t: R.start - 0.1, eye: add3(centerA, add3(mul3(normalA, 86), [-14, 3, 0])), target: add3(centerA, [-8, 3, 0]), fov: 0.62, focus: 86, aperture: 0.34 }
  ];

  function speak(sink: Sink, root: Mat4, text: string, born: number, t: number, rowY: number, size: number, color: Vec3 = INK) {
    const row = line(text);
    const x0 = 12.5 - (row.width * size) / 2;
    for (const cell of row.cells) {
      const age = (t - born - cell.glyph * 0.045) * 5;
      if (age <= 0) continue;
      const s = size * pop(age);
      sink.cube(root, x0 + (cell.x + 0.5) * size, rowY + (cell.y + 0.5) * size, BUBBLE_FRONT + s * 0.5, s, color[0], color[1], color[2], 0, 1);
    }
  }

  /* 第四幕：所有人都连上了。 */
  const nodeNext = rng(314);
  const nodes = Array.from({ length: 46 }, (_, index) => {
    const a = (index / 46) * Math.PI * 2 + nodeNext() * 0.4;
    const r = 230 + nodeNext() ** 0.7 * 900;
    return { msg: memory[index % memory.length]!, at: [Math.cos(a) * r, 120 + nodeNext() * 180, Math.sin(a) * r * 0.75 + 60] as Vec3, yaw: (nodeNext() - 0.5) * 0.6, size: 0.42 + nodeNext() * 0.26, born: F.start + 0.1 + (index / 46) * 2.6, phase: nodeNext() };
  });
  const links: [number, number][] = nodes.map((_, index) => [index, (index + 3 + (index % 5) * 2) % nodes.length]);
  const flowLine = line(COPY.flow);
  const SKY_AT: Vec3 = [0, 410, -60];
  const WRITE_SIZE = 4.4;
  const writeNext = rng(555);
  const writing = flowLine.cells.map((cell) => ({ x: (cell.x - flowLine.width / 2) * WRITE_SIZE, y: (cell.y - LINE / 2) * WRITE_SIZE, delay: (cell.x / flowLine.width) * 1.5 + writeNext() * 0.5, wobble: writeNext() * 6.28, arc: 60 + writeNext() * 160, side: (writeNext() - 0.5) * 240 }));

  function network(t: number, sink: Sink, level: number) {
    for (const n of nodes) {
      const age = t - n.born;
      if (age <= 0) continue;
      const frame = chain(translate(n.at[0], n.at[1] + Math.sin(t * 0.5 + n.phase * 6) * 4, n.at[2]), rotateY(n.yaw), scale(n.size));
      const m = chain(frame, scale(Math.max(pop(age * 2), 0.001)));
      sink.put(n.msg.name, m, [1, 0.97, 0.9], 0.08 * level, 1, 0, 1);
      for (const cell of n.msg.cells) sink.cube(m, cell.x, cell.y, 0.5, 1, INK[0], INK[1], INK[2], 0, 1);
    }
    const arc = (from: Vec3, to: Vec3, seed: number, count: number, speed: number, age: number) => {
      const lift = 50 + Math.hypot(to[0] - from[0], to[2] - from[2]) * 0.24;
      const mid: Vec3 = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + lift, (from[2] + to[2]) / 2];
      for (let index = 0; index < count; index++) {
        const k = (t * speed + seed + index / count) % 1;
        const q = 1 - k;
        const x = q * q * from[0] + 2 * q * k * mid[0] + k * k * to[0];
        const y = q * q * from[1] + 2 * q * k * mid[1] + k * k * to[1];
        const z = q * q * from[2] + 2 * q * k * mid[2] + k * k * to[2];
        sink.spark(x, y, z, 1.1 * Math.sin(k * Math.PI) ** 0.5 * smooth(0, 1, age), GOLD[0], GOLD[1], GOLD[2], 4.5);
      }
    };
    nodes.forEach((n, index) => {
      const age = t - n.born;
      if (age > 0) arc(BRAIN, n.at, n.phase, 16, 0.3, age);
    });
    for (const [a, b] of links) {
      const age = t - Math.max(nodes[a]!.born, nodes[b]!.born) - 0.6;
      if (age > 0) arc(nodes[a]!.at, nodes[b]!.at, nodes[a]!.phase * 0.7, 10, 0.24, age);
    }
  }

  function skyWriting(t: number, sink: Sink) {
    const going = smooth(F.sun - 0.9, F.sun + 0.1, t);
    for (const p of writing) {
      const k = (t - F.write - p.delay) / 1.5;
      if (k <= 0) continue;
      const e = 1 - (1 - Math.min(k, 1)) ** 2.4;
      const target: Vec3 = [SKY_AT[0] + p.x, SKY_AT[1] + p.y, SKY_AT[2]];
      const from: Vec3 = BRAIN;
      const q = 1 - e;
      const mid: Vec3 = [(from[0] + target[0]) / 2 + p.side, target[1] + p.arc * 0.2, (from[2] + target[2]) / 2 + 120];
      const c: Vec3 = [q * q * from[0] + 2 * q * e * mid[0] + e * e * target[0], q * q * from[1] + 2 * q * e * mid[1] + e * e * target[1], q * q * from[2] + 2 * q * e * mid[2] + e * e * target[2]];
      const blow = going ** 2;
      sink.spark(c[0] + Math.sin(p.wobble) * blow * 90, c[1] + blow * 200, c[2] - blow * 240, WRITE_SIZE * (k >= 1 ? 1 : 0.5 + e * 0.5) * (1 - going * 0.7), 1, 0.8, 0.5, 2.6);
    }
  }

  const FIN: Key[] = [
    { t: R.end - 0.4, eye: finalEye, target: add3(centerR, [21, 8, 0]), fov: 0.72, focus: 116, aperture: 0.46 },
    { t: F.start + 1.0, eye: add3(finalEye, [24, 40, 110]), target: add3(centerR, [90, 30, -120]), fov: 0.82, focus: 300, aperture: 0.4 },
    { t: F.start + 3.2, eye: [-70, 300, 1040], target: [0, 240, 0], fov: 0.86, focus: 1000, aperture: 0.6 },
    { t: F.write + 2.6, eye: [-20, 330, 900], target: [0, 320, -40], fov: 0.84, focus: 900, aperture: 0.4 },
    { t: F.sun - 0.5, eye: [10, 270, 760], target: [0, 280, 0], fov: 0.84, focus: 760, aperture: 0.3 },
    { t: E.line - 0.2, eye: [18, 46, 372], target: [-3, 98, 0], fov: 0.72, focus: 372, aperture: 0.22 },
    { t: E.logo, eye: [10, 56, 332], target: [-3, 96, 0], fov: 0.68, focus: 330, aperture: 0.24 },
    { t: 55, eye: [6, 60, 300], target: [-3, 96, 0], fov: 0.66, focus: 298, aperture: 0.24 }
  ];

  function scenery(t: number, sink: Sink, dawn: number) {
    const tint = mix3([0.9, 0.94, 1], [0.6, 0.5, 0.5], dawn);
    for (const c of sea) sink.put(`cloud${c.kind}`, chain(translate(c.x + t * c.speed, c.y, c.z), rotateY(c.yaw), scale(c.size)), tint, 0, 1, 1, 0);
    const moonLeft = 1 - smooth(0.2, 0.75, dawn);
    if (moonLeft > 0.01) sink.put("moon", chain(translate(...MOON_AT), rotateY(0.28), scale(21)), [0.92, 0.9, 0.82], 0.92 * moonLeft, 0, 2, 0);
    if (dawn > 0.05) {
      const rise = smooth(0.15, 1, dawn);
      const sunAt: Vec3 = [SUN_AT[0], mix(-240, SUN_AT[1], rise) + smooth(F.sun, 54, t) * 260, SUN_AT[2]];
      sink.put("sun", chain(translate(...sunAt), scale(24)), [1, 0.86, 0.6], 3.2, 0, 2, 0);
    }
  }

  function nightEnv(eye: Vec3, dawn = 0, under = 0, t = 0): Env {
    const sun = normalize(sub3([SUN_AT[0], mix(-240, SUN_AT[1], smooth(0.15, 1, dawn)) + smooth(F.sun, 54, t) * 260, SUN_AT[2]], eye));
    const moon = normalize(sub3(MOON_AT, eye));
    const k = smooth(0.2, 0.8, dawn);
    const env: Env = {
      top: mix3(lin("#0a1220"), lin("#34557f"), dawn),
      mid: mix3(lin("#142442"), lin("#6f8fb3"), dawn),
      low: mix3(lin("#2c4468"), lin("#e8b48e"), dawn),
      below: mix3(lin("#1c2c48"), lin("#8d7f90"), dawn),
      glowDir: normalize(mix3(moon, sun, k)),
      glowColor: mix3([0.42, 0.5, 0.66], [1.5, 0.82, 0.4], k),
      keyDir: normalize(mix3([-0.5, 0.62, 0.6], [0.3, 0.42, 0.86], k)),
      keyColor: mix3([0.5, 0.52, 0.62], [1.0, 0.8, 0.6], dawn),
      keySpread: 0.06,
      rimDir: normalize(mix3([-0.3, 0.4, -0.86], sun, k)),
      rimColor: mix3([0.22, 0.28, 0.42], [1.2, 0.8, 0.46], k),
      domeGain: mix(3, 0.9, dawn),
      ambient: mix3([0.016, 0.018, 0.028], [0.05, 0.05, 0.06], dawn),
      stars: 1 - smooth(0.1, 0.6, dawn),
      fog: [mix(0.0009, 0.00022, dawn), -20, 0.0085],
      exposure: mix(1, 0.86, dawn),
      flash: [0, 0, 0],
      bloom: mix(0.1, 0.09, dawn),
      vignette: mix(0.6, 0.35, dawn),
      fade: 1,
      shadowCenter: [0, 110, 40],
      shadowRadius: 320
    };
    if (under > 0) {
      env.top = mix3(env.top, lin("#05080f"), under);
      env.mid = mix3(env.mid, lin("#070c16"), under);
      env.low = mix3(env.low, lin("#0a1120"), under);
      env.below = mix3(env.below, lin("#04070d"), under);
      env.glowColor = mul3(env.glowColor, 1 - under);
      env.stars *= 1 - under;
      env.keyColor = mix3(env.keyColor, [0.16, 0.2, 0.3], under);
      env.keyDir = normalize(mix3(env.keyDir, [-0.2, 0.3, 0.9], under));
      env.rimColor = mul3(env.rimColor, 1 - under * 0.7);
      env.domeGain *= 1 - under * 0.6;
      env.ambient = mix3(env.ambient, [0.012, 0.016, 0.03], under);
      env.fog = [mix(env.fog[0], 0.0016, under), -520, 0.0001 + (1 - under) * 0.0084];
      env.bloom = 0.09;
    }
    return env;
  }

  function prologue(t: number, sink: Sink): { cam: Cam; env: Env } {
    const shot = track(PRO, t);
    const sway = drift(t, 0.4);
    const eye = add3(shot.eye, mul3(sway, 0.8));
    const cam: Cam = { eye, target: add3(shot.target, mul3(sway, 0.3)), fov: shot.fov, focus: shot.focus, aperture: shot.aperture, roll: shot.roll, near: 1, far: 7000 };
    const under = 1 - smooth(-260, -40, eye[1]);
    scenery(t, sink, 0);
    if (t < Q.rise + 2) field(t, sink);
    if (t > Q.breach - 2.5) {
      const dots = 1 - smooth(V2.text - 0.25, V2.text + 0.05, t);
      const eyes = blink(t, [Q.breach + 1.4, V2.text - 0.6, V2.text - 0.2]) ?? "open";
      const root = drawCat(sink, CAT_BASE, t, { eyes, glance: 0, flick: bump(t, V2.dots + 0.2, V2.dots + 0.5, 0.08), dots, glow: 0 });
      speak(sink, root, COPY.brain, V2.text, t, 4.5, 0.15);
    }
    dust(sink, eye, t, 0.8, [0.72, 0.82, 1]);
    const env = nightEnv(eye, 0, under, t);
    if (t < Q.rise + 1) {
      env.shadowCenter = FIELD;
      env.shadowRadius = 300;
    }
    env.fade = smooth(0.1, 0.9, t);
    sink.light(-4, 110, 170, 190, 0.5, 0.4, 0.26);
    return { cam, env };
  }

  function finale(t: number, sink: Sink): { cam: Cam; env: Env } {
    const shot = track(FIN, t);
    const sway = drift(t, 2.2);
    const eye = add3(shot.eye, mul3(sway, 0.8));
    const cam: Cam = { eye, target: add3(shot.target, mul3(sway, 0.3)), fov: shot.fov, focus: shot.focus, aperture: shot.aperture, roll: shot.roll, near: 1, far: 7000 };
    const dawn = smoother(F.start + 0.8, F.sun + 0.6, t);
    scenery(t, sink, dawn);
    const lineAt = E.line;
    const clearing = smooth(lineAt - 0.8, lineAt - 0.3, t);
    const eyes = blink(t, [F.write + 0.6, F.sun + 1, E.logo - 0.4, E.logo + 1.3, E.logo + 1.7]) ?? "open";
    const root = drawCat(sink, CAT_BASE, t, { eyes, glance: 0, flick: bump(t, E.logo + 0.6, E.logo + 0.9, 0.08), dots: 1 - clearing, glow: 0 });
    if (t < E.logo - 0.3) speak(sink, root, COPY.line, lineAt, t, 4.5, 0.15);
    else {
      speak(sink, root, COPY.brand[0]!, E.logo, t, 5.8, 0.17);
      speak(sink, root, COPY.brand[1]!, E.logo + 0.35, t, 3.8, 0.13, [0.34, 0.35, 0.4]);
    }

    const leaving = 1 - smooth(F.start + 2.6, F.start + 3.4, t);
    if (leaving > 0.01) {
      drawMsg(sink, frameA, msgA, 1, 999);
      sink.put("avatarLin", chain(frameA, translate(-msgA.w / 2 - 19, -msgA.h / 2 + 12, -2)));
      drawMsg(sink, frameQ, msgQ, 1, 999);
      sink.put("avatarZhou", chain(frameQ, translate(-msgQ.w / 2 - 19, -msgQ.h / 2 + 12, -2)));
      drawReply(sink, t);
    }
    const fading = 1 - smooth(F.sun - 0.4, F.sun + 0.8, t);
    if (fading > 0.01) {
      network(t, sink, fading);
      skyWriting(t, sink);
    }
    dust(sink, eye, t, 0.8 * (1 - dawn * 0.5), mix3([0.72, 0.82, 1], [1, 0.86, 0.66], dawn));
    const env = nightEnv(eye, dawn, 0, t);
    env.shadowCenter = mix3([-120, 130, 280], [0, 100, 40], smooth(F.start, F.start + 3, t));
    env.shadowRadius = mix(300, 340, smooth(F.start, F.start + 3, t));
    const flash = bump(t, F.sun - 0.45, F.sun + 0.5, 0.35);
    env.flash = mul3([1, 0.78, 0.5], flash * 1.6);
    env.fade = 1 - smooth(52.7, 53.8, t);
    sink.light(-4, 120, 180, 220, mix(0.5, 0.3, dawn), mix(0.4, 0.26, dawn), mix(0.26, 0.16, dawn));
    return { cam, env };
  }

  function at(t: number, sink: Sink): { cam: Cam; env: Env } {
    if (t < R.start - 0.1) return prologue(t, sink);
    if (t >= R.end - 0.4) return finale(t, sink);
    const indoors = t >= R.enter + 0.08 && t < R.exit - 0.02;
    if (indoors) {
      const cam = inside(t, sink);
      const k = (t - R.enter) / (R.exit - R.enter);
      const env = nightEnv(cam.eye);
      env.top = lin("#0e0c1c");
      env.mid = lin("#151026");
      env.low = lin("#1f1529");
      env.below = lin("#0c0a16");
      env.glowDir = [0, 0, -1];
      env.glowColor = [0.5, 0.3, 0.13];
      env.stars = 0;
      env.fog = [0.0026, 6000, 0.00001];
      env.domeGain = 1.2;
      env.ambient = [0.05, 0.042, 0.04];
      env.keyDir = normalize([0.2, 0.5, 0.8]);
      env.keyColor = [0.42, 0.36, 0.28];
      env.shadowCenter = cam.eye;
      env.shadowRadius = 200;
      env.bloom = 0.1;
      const flash = bump(k, -0.1, 0.14, 0.12) + bump(k, 0.88, 1.1, 0.12);
      env.flash = mul3([1, 0.8, 0.5], flash * 2.6);
      return { cam, env };
    }

    outdoors(t, sink);
    const before = t < R.exit;
    const shot = track(before ? KEYS : OUT, t);
    const sway = drift(t, 1.3);
    const eye = add3(shot.eye, mul3(sway, 0.8));
    const cam: Cam = { eye, target: add3(shot.target, mul3(sway, 0.3)), fov: shot.fov, focus: shot.focus, aperture: shot.aperture, roll: shot.roll, near: 1, far: 7000 };
    if (before) streamIn(sink, t);
    else streamOut(sink, t);
    dust(sink, eye, t, 1, [0.72, 0.82, 1]);

    const env = nightEnv(eye);
    env.shadowCenter = t < R.exit ? mix3([230, 130, 230], [0, 100, 60], smooth(R.lift + 1, R.lift + 2.6, t)) : mix3([0, 100, 60], [-200, 150, 340], smooth(R.exit + 1, R.land, t));
    env.shadowRadius = 300;
    const flash = bump(t, R.enter - 0.2, R.enter + 0.28, 0.22) + bump(t, R.exit - 0.2, R.exit + 0.3, 0.22);
    env.flash = mul3([1, 0.8, 0.5], flash * 2.6);
    sink.light(-4, 110, 170, 190, 0.5, 0.4, 0.26);
    sink.light(centerA[0] - 10, centerA[1] + 4, centerA[2] + 22, 34, 0.5, 0.38, 0.22);
    sink.light(centerR[0] + 6, centerR[1] + 14, centerR[2] + 30, 44, 0.55, 0.42, 0.24);
    return { cam, env };
  }

  return { meshes, at };
}
