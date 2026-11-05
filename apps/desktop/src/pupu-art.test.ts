import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
