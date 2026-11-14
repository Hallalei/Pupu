import { PUPU_CHOICE, providerOf, type KeyChoice, type ModelChoice } from "./settings.ts";

/**
 * 存在这个 Pupu 的 SQLite 里。
 *
 * - `pupu_model`：现在用的，一行。
 * - `pupu_model_own`：最后一次用的自带 key 设置，一行。换成别的来源再换回来，不用重填。
 * - `pupu_model_keys`：每家服务商存过的 key 和当时的地址。只在地址一样时沿用（`savedKey`）。
 */
export class ModelStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS pupu_model (id INTEGER PRIMARY KEY CHECK (id = 1), choice TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS pupu_model_own (id INTEGER PRIMARY KEY CHECK (id = 1), choice TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS pupu_model_keys (provider TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT NOT NULL)"
    );
  }

  get(): ModelChoice {
    const [row] = this.#sql.exec("SELECT choice FROM pupu_model WHERE id = 1").toArray();
    return parseStored(row?.choice) ?? PUPU_CHOICE;
  }

  /** 最后一次用的自带 key 设置。现在用的就是自带 key 时就是它。 */
  lastOwn(): KeyChoice | null {
    const current = this.get();
    if (current.source === "key") return current;
    const [row] = this.#sql.exec("SELECT choice FROM pupu_model_own WHERE id = 1").toArray();
    const stored = parseStored(row?.choice);
    if (stored?.source === "key") return stored;
    return null;
  }

  savedKey(provider: string, baseUrl: string): string {
    const [row] = this.#sql
      .exec("SELECT api_key FROM pupu_model_keys WHERE provider = ? AND base_url = ?", provider, baseUrl)
      .toArray();
    if (row) return String(row.api_key);
    // 改版前只存了一行：那一行的 key 也算这家的。
    const last = this.lastOwn();
    return last && providerOf(last) === provider && last.baseUrl === baseUrl ? last.apiKey : "";
  }

  /** 存过 key 的服务商，给网页显示「key 已存」。 */
  keyProviders(): { readonly provider: string; readonly baseUrl: string }[] {
    const rows = this.#sql.exec("SELECT provider, base_url FROM pupu_model_keys").toArray();
    const list = rows.map((row) => ({ provider: String(row.provider), baseUrl: String(row.base_url) }));
    const last = this.lastOwn();
    if (last && !list.some((each) => each.provider === providerOf(last))) {
      list.push({ provider: providerOf(last), baseUrl: last.baseUrl });
    }
    return list;
  }

  set(choice: ModelChoice): void {
    const text = JSON.stringify(choice);
    this.#sql.exec(
      "INSERT INTO pupu_model (id, choice) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET choice = excluded.choice",
      text
    );
    if (choice.source !== "key") return;
    this.#sql.exec(
      "INSERT INTO pupu_model_own (id, choice) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET choice = excluded.choice",
      text
    );
    this.#sql.exec(
      "INSERT INTO pupu_model_keys (provider, base_url, api_key) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET base_url = excluded.base_url, api_key = excluded.api_key",
      providerOf(choice),
      choice.baseUrl,
      choice.apiKey
    );
  }

  /** 忘掉这家的 key。正在用它就换回我们的模型。 */
  forget(provider: string): void {
    this.#sql.exec("DELETE FROM pupu_model_keys WHERE provider = ?", provider);
    const last = this.lastOwn();
    if (last && providerOf(last) === provider) {
      this.#sql.exec("DELETE FROM pupu_model_own WHERE id = 1");
      const current = this.get();
      if (current.source === "key") {
        this.#sql.exec("UPDATE pupu_model SET choice = ? WHERE id = 1", JSON.stringify(PUPU_CHOICE));
      }
    }
  }
}

function parseStored(raw: unknown): ModelChoice | null {
  if (raw === undefined || raw === null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as ModelChoice;
    return parsed && typeof parsed === "object" && "source" in parsed ? parsed : null;
  } catch {
    return null;
  }
}
