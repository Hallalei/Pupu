import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FAR_BUBBLES, MOON_SIZE, camera } from "../../cloud/src/client/pupu-camera.ts";
import { MAIN, PALETTE, art, bubbleGrid, headGrid, mesh, VERTEX_FLOATS } from "../../cloud/src/client/pupu-voxels.ts";

const source = readFileSync(new URL("../../../design/icon/pixels.py", import.meta.url), "utf8");

test("3D 模型用的图和图标是同一张", () => {
  const block = source.slice(source.indexOf("MAIN = ["), source.indexOf("# 16×16"));
  assert.deepEqual(MAIN, [...block.matchAll(/"([^"]{24})"/g)].map((match) => match[1]));
});

test("3D 模型的颜色和图标一样", () => {
  for (const [name, color] of Object.entries(PALETTE)) {
    assert.match(source, new RegExp(`"${name}": "${color}"`), name);
  }
});

test("睁眼的图就是图标，其余眼睛只改眼睛那几格", () => {
  assert.equal(art("open"), MAIN);
  for (const eyes of ["half", "closed", "right"] as const) {
    art(eyes).forEach((row, y) => {
      [...row].forEach((cell, x) => {
        const inEye = y >= 7 && y <= 10 && ((x >= 6 && x <= 9) || (x >= 14 && x <= 17));
        if (!inEye) assert.equal(cell, MAIN[y]![x], `${eyes} ${x},${y}`);
      });
    });
  }
});

test("正脸摆在最前面一层", () => {
  const head = headGrid("open");
  assert.equal(head.get(7, 15, 0), "P");
  assert.equal(head.get(8, 15, 0), "h");
  assert.equal(head.get(7, 14, 0), "P");
});

test("网格里每个面都是完整的两个三角形", () => {
  const { vertices, count } = mesh(bubbleGrid());
  assert.ok(count > 0);
  assert.equal(count % 6, 0);
  assert.equal(vertices.length, count * VERTEX_FLOATS);
  assert.ok(vertices.every(Number.isFinite));
});

const ASPECTS = [431 / 588, 598 / 776, 858 / 976, 1];
const CAT_POINTS = [[7, 23, -3], [18, 23, -3], [-3, 17, -9], [2, 3, 5], [22, 3, 5]];

function inFrame(viewProjection: Float32Array, [x, y, z]: number[]) {
  const m = viewProjection;
  const w = m[3]! * x! + m[7]! * y! + m[11]! * z! + m[15]!;
  const sx = (m[0]! * x! + m[4]! * y! + m[8]! * z! + m[12]!) / w;
  const sy = (m[1]! * x! + m[5]! * y! + m[9]! * z! + m[13]!) / w;
  return Math.abs(sx) <= 1 && Math.abs(sy) <= 1;
}

const box = ([x, y, z]: number[], halfWidth: number, halfHeight: number) => [
  [x! - halfWidth, y! - halfHeight, z!],
  [x! + halfWidth, y! - halfHeight, z!],
  [x! - halfWidth, y! + halfHeight, z!],
  [x! + halfWidth, y! + halfHeight, z!]
];

test("整轮镜头摆动里，月亮、远处气泡和猫都不出画", () => {
  for (const aspect of ASPECTS) {
    for (let t = 0; t < 24; t += 0.25) {
      const { viewProjection, moonAt, farAt } = camera(t, aspect);
      const moonRadius = 9.5 * MOON_SIZE;
      const points = [...CAT_POINTS, ...box(moonAt, moonRadius, moonRadius)];
      farAt.forEach((at, index) => points.push(...box(at, 12 * FAR_BUBBLES[index]!.size, 6 * FAR_BUBBLES[index]!.size + 1.2)));
      for (const point of points) assert.ok(inFrame(viewProjection, point), `aspect ${aspect.toFixed(2)} t ${t} ${point}`);
    }
  }
});
