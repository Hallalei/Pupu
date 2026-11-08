import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { dailyLimitFrom, dayOf, USAGE_LIMIT_MESSAGE, UsageStore, withDailyLimit } from "../src/usage.ts";
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

describe("每次调模型前查额度", () => {
  test("额度够：照常调；一轮做到一半用完了：下一次调用就停，不调模型，聊天里说今天的额度用完了", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("第一步做好了"), fauxAssistantMessage("不该走到这里")]);
    let spent = false;
    const provider = withDailyLimit(faux.provider, () => (spent ? USAGE_LIMIT_MESSAGE : null));
    const model = faux.getModel();
    const context = normalizeContext({ messages: [] });

    const first = await provider.streamSimple(model, context).result();
    assert.equal(first.stopReason, "stop");
    spent = true;
    const second = await provider.stream(model, context).result();
    assert.equal(second.stopReason, "error");
    assert.equal(second.errorMessage, USAGE_LIMIT_MESSAGE);
    assert.equal(faux.state.callCount, 1);
  });
});
