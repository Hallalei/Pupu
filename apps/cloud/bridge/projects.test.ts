import assert from "node:assert/strict";
import test from "node:test";
import { progressLine } from "../src/projects.ts";

test("取第一行有字的，去掉 Markdown 记号", () => {
  assert.equal(progressLine("\n\n## 已经拿到桌面上的文件列表\n请问您想怎么整理？"), "已经拿到桌面上的文件列表");
  assert.equal(progressLine("- **登录页**改好了，见 [预览](https://example.com)"), "登录页改好了，见 预览");
  assert.equal(progressLine("1. 跑了 `npm test`，3 个失败"), "跑了 npm test，3 个失败");
  assert.equal(progressLine("> 引用的一句"), "引用的一句");
});

test("跳过代码块和表格", () => {
  assert.equal(progressLine("```bash\nls -la\n```\n列完了，桌面上有 12 个文件。"), "列完了，桌面上有 12 个文件。");
  assert.equal(progressLine("| 文件 | 大小 |\n| --- | --- |\n\n一共两个文件。"), "一共两个文件。");
});

test("下划线和单个星号不当成强调", () => {
  assert.equal(progressLine("改了 src/user_profile_view.ts 和 *.test.ts"), "改了 src/user_profile_view.ts 和 *.test.ts");
});

test("太长截断，没有字是空串", () => {
  const long = "进".repeat(100);
  assert.equal(progressLine(long), `${"进".repeat(80)}…`);
  assert.equal(progressLine(""), "");
  assert.equal(progressLine("```\n只有代码\n```"), "");
});
