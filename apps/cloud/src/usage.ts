/**
 * 每个 Pupu 每天花了多少模型费用。大家共用一把模型 key，到了上限当天就不再接新消息。
 * 按美元算，`usage.cost` 是 pi 按模型单价算好的。第一个 Pupu 不设上限。
 * 记账和检查的位置参考了 cloudflare/vibesdk 的 RateLimitService：调模型时记，发起前查。
 */
export const USAGE_LIMIT_MESSAGE = "今天的额度用完了，明天再来。";

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
