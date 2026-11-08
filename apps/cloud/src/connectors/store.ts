/**
 * 连接器：成员把自己的 Gmail、日历、GitHub 这类账号连给 Pupu。
 * 凭据和 OAuth 都在 open-connector 那边（见 client.ts），这里只记「谁连了哪个账号」，
 * 跟电脑一样挂在成员名下（需求说明 4.8）。做法参考 Nango 的 end user：网关只管凭据，
 * 连接属于谁由接入方自己记。
 */

import { connectorMessage, type ConnectorClient } from "./client.ts";

/** 设置里能连的服务。id 是 open-connector 的 provider id。 */
export type ConnectorService = {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
};

/** 第一批只接这几个，见需求说明 4.8。 */
export const CONNECTOR_SERVICES: readonly ConnectorService[] = [
  { id: "gmail", name: "Gmail", detail: "读邮件、找邮件、写草稿和发信" },
  { id: "googlecalendar", name: "Google 日历", detail: "看日程、找空档、建会议" },
  { id: "googledrive", name: "Google 云端硬盘", detail: "找文件、读文档" },
  { id: "github", name: "GitHub", detail: "仓库、issue 和 PR" }
];

export function serviceOf(id: string): ConnectorService | undefined {
  return CONNECTOR_SERVICES.find((service) => service.id === id);
}

/** 连好的一个账号。`id` 是 open-connector 的 appId，`alias` 是执行动作时选它用的名字。 */
export type ConnectorRow = {
  readonly id: string;
  readonly service: string;
  readonly alias: string;
  /** 账号是谁，比如邮箱或 GitHub 用户名。open-connector 没给就是 null。 */
  readonly account: string | null;
  /** 谁连的。没开 Google 登录、还没有创建者时是 null。 */
  readonly memberId: string | null;
  readonly createdAt: number;
};

/** 一次「去授权」：等 open-connector 跳回来时，按它找到是谁、连的什么。 */
export type ConnectorAttempt = {
  readonly id: string;
  readonly requestId: string;
  readonly service: string;
  readonly memberId: string | null;
  /** 从哪儿发起的：手机跳回 App，浏览器和电脑 App 显示一页「连好了」。 */
  readonly client: "phone" | "browser";
  readonly createdAt: number;
};

/** 给网页和 App 看的账号。 */
export type ConnectorView = {
  readonly id: string;
  readonly service: string;
  readonly name: string;
  readonly account: string | null;
  readonly memberId: string | null;
  readonly ownerEmail: string | null;
  /** 发这次请求的人能不能断开它：自己的，或者创建者。 */
  readonly removable: boolean;
  readonly createdAt: number;
};

/** 授权页 10 分钟就过期（open-connector 的 expiresAt），多留一点再删。 */
export const ATTEMPT_TTL_MS = 15 * 60_000;

type Row = Record<string, SqlStorageValue>;

function toRow(row: Row): ConnectorRow {
  return {
    id: String(row.id),
    service: String(row.service),
    alias: String(row.alias),
    account: row.account === null ? null : String(row.account),
    memberId: row.member_id === null ? null : String(row.member_id),
    createdAt: Number(row.created_at)
  };
}

function toAttempt(row: Row): ConnectorAttempt {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    service: String(row.service),
    memberId: row.member_id === null ? null : String(row.member_id),
    client: row.client === "phone" ? "phone" : "browser",
    createdAt: Number(row.created_at)
  };
}

export class ConnectorStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_connectors (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        alias TEXT NOT NULL,
        account TEXT,
        member_id TEXT,
        created_at INTEGER NOT NULL
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_connector_attempts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        service TEXT NOT NULL,
        member_id TEXT,
        client TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 先连的在前。 */
  list(): ConnectorRow[] {
    return this.#db().exec("SELECT * FROM pupu_connectors ORDER BY created_at").toArray().map(toRow);
  }

  byId(id: string): ConnectorRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_connectors WHERE id = ?", id).toArray();
    return row ? toRow(row) : undefined;
  }

  /** 重新授权同一个账号时 appId 不变，覆盖原来那行。 */
  save(row: ConnectorRow): void {
    this.#db().exec(
      `INSERT INTO pupu_connectors (id, service, alias, account, member_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET alias = excluded.alias, account = excluded.account`,
      row.id,
      row.service,
      row.alias,
      row.account,
      row.memberId,
      row.createdAt
    );
  }

  remove(id: string): boolean {
    return this.#db().exec("DELETE FROM pupu_connectors WHERE id = ? RETURNING id", id).toArray().length > 0;
  }

  /** 还没有创建者时连的账号和还在授权的，创建者第一次登录后归他，和设备、电脑一样。 */
  claimUnowned(memberId: string): void {
    this.#db().exec("UPDATE pupu_connectors SET member_id = ? WHERE member_id IS NULL", memberId);
    this.#db().exec("UPDATE pupu_connector_attempts SET member_id = ? WHERE member_id IS NULL", memberId);
  }

  addAttempt(attempt: ConnectorAttempt): void {
    this.#db().exec(
      "INSERT INTO pupu_connector_attempts (id, request_id, service, member_id, client, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      attempt.id,
      attempt.requestId,
      attempt.service,
      attempt.memberId,
      attempt.client,
      attempt.createdAt
    );
  }

  /** 还在等的一次授权，过期的不认。顺手删掉过期的。 */
  attempt(id: string, now: number): ConnectorAttempt | undefined {
    const db = this.#db();
    db.exec("DELETE FROM pupu_connector_attempts WHERE created_at < ?", now - ATTEMPT_TTL_MS);
    const [row] = db.exec("SELECT * FROM pupu_connector_attempts WHERE id = ?", id).toArray();
    return row ? toAttempt(row) : undefined;
  }

  dropAttempt(id: string): void {
    this.#db().exec("DELETE FROM pupu_connector_attempts WHERE id = ?", id);
  }
}

/** 授权页跳回来之后告诉用户的。`client` 决定是跳回 App 还是显示一页。 */
export type AttemptResult = {
  readonly client: "phone" | "browser";
  readonly ok: boolean;
  readonly service: string;
  readonly message: string;
};

/**
 * 授权页跳回来：问 open-connector 这次连上没有，连上了记下是谁的哪个账号。
 * 授权记录只在有了结果时才删：连上了、失败了、过期了。还在授权中，或者没问到，留着，刷新这一页再问一次。
 * 连上了但发起的人已经不在名单上（`memberIn` 说不在），在 open-connector 撤销掉，不留没人管的凭据。
 * 没有这次授权（用过、过期、乱填的）是 undefined。
 */
export async function finishAttempt(
  attemptId: string,
  deps: {
    readonly store: ConnectorStore;
    /** 这个 Pupu 没开连接器是 null。 */
    readonly client: Pick<ConnectorClient, "request" | "connection" | "disconnect"> | null;
    readonly memberIn: (memberId: string) => boolean;
  },
  now: number
): Promise<AttemptResult | undefined> {
  const { store, client } = deps;
  const attempt = store.attempt(attemptId, now);
  if (!attempt) return undefined;
  const name = serviceOf(attempt.service)?.name ?? attempt.service;
  const done = (ok: boolean, message: string) => ({ client: attempt.client, ok, service: attempt.service, message });
  if (!client) {
    store.dropAttempt(attempt.id);
    return done(false, "这个 Pupu 的连接器已经关了");
  }
  try {
    const request = await client.request(attempt.requestId);
    if (request.status === "initiated") return done(false, `${name} 那边还没授权完，授权完再刷新这一页`);
    if (request.status !== "connected" || !request.appId) {
      store.dropAttempt(attempt.id);
      return done(false, request.status === "expired" ? "授权超时了，再连一次" : (request.errorMessage ?? `没连上 ${name}`));
    }
    const connection = await client.connection(request.appId);
    if (attempt.memberId !== null && !deps.memberIn(attempt.memberId)) {
      await client.disconnect(attempt.service, connection.alias);
      store.dropAttempt(attempt.id);
      return done(false, "你已经不在这个 Pupu 的成员名单上了，账号没有连上");
    }
    const known = store.byId(connection.id);
    store.save({
      id: connection.id,
      service: attempt.service,
      alias: connection.alias,
      account: connection.account,
      memberId: known?.memberId ?? attempt.memberId,
      createdAt: known?.createdAt ?? now
    });
    store.dropAttempt(attempt.id);
    return done(true, connection.account ? `${name}（${connection.account}）连好了` : `${name} 连好了`);
  } catch (error) {
    return done(false, connectorMessage(error));
  }
}
