import assert from "node:assert/strict";
import test from "node:test";
import { screenPoint } from "./computer.ts";

const shot = { screenWidth: 1512, screenHeight: 982, width: 1280, height: 831 };

test("截图坐标换回屏幕像素，原点在左上角", () => {
  assert.deepEqual(screenPoint(0, 0, shot), { x: 0, y: 0 });
  assert.deepEqual(screenPoint(1280, 831, shot), null);
  const mid = screenPoint(640, 415, shot);
  assert.ok(mid);
  assert.ok(mid.x > 700 && mid.x < 800);
  assert.ok(mid.y > 450 && mid.y < 530);
  assert.equal(screenPoint(-1, 10, shot), null);
  assert.equal(screenPoint(Number.NaN, 10, shot), null);
});
