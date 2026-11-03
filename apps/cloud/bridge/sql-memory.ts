import { DatabaseSync } from "node:sqlite";

/** 测试里用 node:sqlite 当 Durable Object 的 SQLite，只实现用得到的那几样。 */
export function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      const statement = db.prepare(query);
      const reads = /^\s*(SELECT|PRAGMA)/i.test(query) || /\bRETURNING\b/i.test(query);
      let rows: Record<string, SqlStorageValue>[] = [];
      let written = 0;
      if (reads) {
        rows = statement.all(...(bindings as never[])) as Record<string, SqlStorageValue>[];
        written = /^\s*(SELECT|PRAGMA)/i.test(query) ? 0 : rows.length;
      } else {
        written = Number(statement.run(...(bindings as never[])).changes);
      }
      return {
        toArray: () => rows,
        one: () => rows[0],
        rowsWritten: written
      };
    }
  } as unknown as SqlStorage;
}
