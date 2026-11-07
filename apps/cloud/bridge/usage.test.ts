import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { dailyLimitFrom, dayOf, UsageStore } from "../src/usage.ts";
import { sqlStorage } from "./sql-memory.ts";

describe("每日费用", () => {
  test("同一天累加，第二天从零开始", () => {
    const store = new UsageStore(sqlStorage());
    store.add("2026-11-07", 0.2);
    store.add("2026-11-07", 0.3);
    assert.equal(store.spent("2026-11-07"), 0.5);
    assert.equal(store.spent("2026-11-08"), 0);
  });

  test("按 UTC 分天", () => {
    assert.equal(dayOf(Date.UTC(2026, 10, 7, 23, 59)), "2026-11-07");
    assert.equal(dayOf(Date.UTC(2026, 10, 8, 0, 0)), "2026-11-08");
  });

  test("没配或者填 0 是不限", () => {
    assert.equal(dailyLimitFrom({}), null);
    assert.equal(dailyLimitFrom({ PUPU_DAILY_USD: "0" }), null);
    assert.equal(dailyLimitFrom({ PUPU_DAILY_USD: "0.5" }), 0.5);
  });
});
