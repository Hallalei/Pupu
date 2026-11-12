import { PUPU_CHOICE, type ModelChoice } from "./settings.ts";

/** 存在这个 Pupu 的 SQLite 里，一行。 */
export class ModelStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS pupu_model (id INTEGER PRIMARY KEY CHECK (id = 1), choice TEXT NOT NULL)");
  }

  get(): ModelChoice {
    const [row] = this.#sql.exec("SELECT choice FROM pupu_model WHERE id = 1").toArray();
    if (!row) return PUPU_CHOICE;
    try {
      const parsed = JSON.parse(String(row.choice)) as ModelChoice;
      return parsed && typeof parsed === "object" && "source" in parsed ? parsed : PUPU_CHOICE;
    } catch {
      return PUPU_CHOICE;
    }
  }

  set(choice: ModelChoice): void {
    this.#sql.exec(
      "INSERT INTO pupu_model (id, choice) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET choice = excluded.choice",
      JSON.stringify(choice)
    );
  }
}
