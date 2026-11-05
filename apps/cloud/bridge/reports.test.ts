import assert from "node:assert/strict";
import test from "node:test";
import { asksUser, failureSummary, reportCards, reportQuote, type ReportRow } from "../src/reports.ts";

function row(input: Partial<ReportRow> & Pick<ReportRow, "id" | "projectId">): ReportRow {
  return {
    session: "1",
    task: "整理桌面",
    state: "done",
    summary: `结果 ${input.id}`,
    owner: null,
    createdAt: 0,
    reportedAt: 100,
    seenAt: null,
    ...input
  };
}

const names = new Map([
  ["a", "桌面整理"],
  ["b", "周报"]
]);
const nameOf = (id: string) => names.get(id);

test("同一个项目没看过的合成一张，只留最新的，标还有几条", () => {
  const cards = reportCards(
    [
      row({ id: "1", projectId: "a", reportedAt: 100 }),
      row({ id: "2", projectId: "a", reportedAt: 300, state: "asking" }),
      row({ id: "3", projectId: "b", reportedAt: 200, state: "failed" })
    ],
    nameOf
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.projectName, card.status, card.more, card.at]),
    [
      ["3", "周报", "failed", 0, 200],
      ["2", "桌面整理", "blocked", 1, 300]
    ]
  );
});

test("看过的一条一张，放在自己的时间；还在做的和没了的项目不显示", () => {
  const cards = reportCards(
    [
      row({ id: "1", projectId: "a", reportedAt: 100, seenAt: 150 }),
      row({ id: "2", projectId: "a", reportedAt: 200, seenAt: 250 }),
      row({ id: "3", projectId: "a", reportedAt: 300 }),
      row({ id: "4", projectId: "a", state: "running", reportedAt: null }),
      row({ id: "5", projectId: "gone", reportedAt: 400 })
    ],
    nameOf
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.seen, card.more]),
    [
      ["1", true, 0],
      ["2", true, 0],
      ["3", false, 0]
    ]
  );
});

test("没写结果时用转过去的事", () => {
  const [card] = reportCards([row({ id: "1", projectId: "a", summary: "" })], nameOf);
  assert.equal(card?.summary, "整理桌面");
});

test("最后一句是问句才算要你定，代码块里的不算", () => {
  assert.equal(asksUser("文件列好了。\n\n要按日期还是按类型归档？"), true);
  assert.equal(asksUser("要不要我顺手删掉临时文件?"), true);
  assert.equal(asksUser("**先删哪个？**"), true);
  assert.equal(asksUser("你问的「为什么慢？」查到了：磁盘满了。"), false);
  assert.equal(asksUser("跑完了：\n```\necho ok?\n```"), false);
  assert.equal(asksUser(""), false);
});

test("引用回复报告卡时带上项目名和状态", () => {
  assert.equal(
    reportQuote({ projectName: "周报", status: "blocked", summary: "等你批准：推送到远端" }),
    "项目「周报」的报告 · 卡住了要你定：等你批准：推送到远端"
  );
});

test("出错的报告说人话", () => {
  assert.equal(
    failureSummary('400: {"error":{"message":"假模型：这次故意出错","type":"invalid_request_error"}}'),
    "模型出错，这件事没做完：假模型：这次故意出错"
  );
  assert.equal(failureSummary("429 Too Many Requests"), "模型那边限流了，这件事没做完。");
  assert.equal(failureSummary("503: busy"), "模型那边太忙，这件事没做完。");
  assert.equal(failureSummary(""), "模型出错，这件事没做完。");
});
