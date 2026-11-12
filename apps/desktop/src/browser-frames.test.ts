import assert from "node:assert/strict";
import { test } from "node:test";
import { isRects, paintRects, quadRect, scaleRects } from "./browser-frames.ts";

test("涂掉的矩形按输出宽度缩放，四周多涂几像素，出界的裁掉", () => {
  const width = 10;
  const height = 6;
  const bitmap = Buffer.alloc(width * height * 4, 0xff);
  paintRects(bitmap, width, height, scaleRects([[4, 2, 4, 2]], 20, 10), 1);
  const painted = (x: number, y: number) => bitmap[(y * width + x) * 4] === 0x44;
  assert.equal(painted(1, 0), true);
  assert.equal(painted(4, 2), true);
  assert.equal(painted(5, 0), false);
  assert.equal(painted(0, 3), false);
});

test("quad 换成矩形；页面回的不是矩形列表就不认", () => {
  assert.deepEqual(quadRect([10, 20, 30, 20, 30, 40, 10, 40]), [10, 20, 20, 20]);
  assert.equal(quadRect([1, 2]), null);
  assert.equal(isRects({ width: 1, height: 1, rects: [[1, 2, 3, 4]] }), true);
  assert.equal(isRects({ width: 1, height: 1, rects: [[1, 2, "x", 4]] }), false);
  assert.equal(isRects(null), false);
});
