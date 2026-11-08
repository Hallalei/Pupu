/**
 * 每个 Pupu 每天花了多少模型费用。大家共用一把模型 key，到了上限当天就不再调模型。
 * 按美元算，`usage.cost` 是 pi 按模型单价算好的。第一个 Pupu 不设上限。
 * 记账和检查的位置参考了 cloudflare/vibesdk 的 RateLimitService：调模型时记，发起前查。
 */

import type { Api, Provider } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

export const USAGE_LIMIT_MESSAGE = "今天的额度用完了，明天再来。";

/**
 * 每次调模型前查额度：新的一轮、工具跑完接着调、出错重试、压缩上下文都走这里，一轮做到一半超了也在下一次调用前停下。
 * `refusal` 返回拒绝的话时这次不调，这一轮以一条模型出错结束，聊天里显示这句话。
 */
export function withDailyLimit<T extends Api>(provider: Provider<T>, refusal: () => string | null): Provider<T> {
  const checked = <S>(start: () => S) => async () => {
    const refused = refusal();
    if (refused) throw new Error(refused);
    return start();
  };
  return {
    ...provider,
    stream: (model, context, options) => lazyStream(model, checked(() => provider.stream(model, context, options))),
    streamSimple: (model, context, options) =>
      lazyStream(model, checked(() => provider.streamSimple(model, context, options)))
  };
}

export function dailyLimitFrom(env: { readonly PUPU_DAILY_USD?: string }): number | null {
  const limit = Number(env.PUPU_DAILY_USD ?? 0);
  return limit > 0 ? limit : null;
}

/** 按 UTC 分天，和 DeepSeek 账单无关，只要大家用同一把尺子。 */
export function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class UsageStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS pupu_usage (day TEXT PRIMARY KEY, usd REAL NOT NULL)");
  }

  add(day: string, usd: number): void {
    this.#sql.exec(
      "INSERT INTO pupu_usage (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd",
      day,
      usd
    );
  }

  spent(day: string): number {
    const [row] = this.#sql.exec("SELECT usd FROM pupu_usage WHERE day = ?", day).toArray();
    return Number(row?.usd ?? 0);
  }
}
