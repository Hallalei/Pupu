/**
 * open-connector（github.com/oomol-lab/open-connector）的 HTTP 客户端。它单独部署成一个 Worker，
 * 管 OAuth、存凭据、跑各家的动作；Pupu 用管理员 token 调它的 /v1 接口，凭据不出那边。
 * 接口和返回格式见它的 docs/runtime-api.md、docs/programmatic-connections.md。
 */

export type ConnectorConfig = {
  /** 部署好的 open-connector 地址，比如 https://open-connector.xxx.workers.dev */
  readonly url: string;
  /** 它的 OOMOL_CONNECT_ADMIN_TOKEN：发起授权、查连接要管理员，跑动作也认它。 */
  readonly token: string;
};

/** 读、写、删。写和删要先问账号主人，见 tools.ts。 */
export type OperationType = "read" | "write" | "destructive";

export type ActionInfo = {
  readonly id: string;
  readonly service: string;
  readonly name: string;
  readonly description: string;
  readonly operationType: OperationType;
  /** 入参的 JSON Schema。 */
  readonly inputSchema: unknown;
};

export type RequestStatus = {
  readonly status: "initiated" | "connected" | "failed" | "expired";
  readonly appId: string | null;
  readonly errorMessage: string | null;
};

export type Connection = {
  readonly id: string;
  readonly service: string;
  readonly alias: string;
  readonly account: string | null;
};

export class ConnectorError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type Envelope = { success?: boolean; message?: string; errorCode?: string; data?: unknown };

function operationOf(value: unknown): OperationType {
  // 没写清楚的按会改东西算，宁可多问一次。
  return value === "read" ? "read" : value === "destructive" ? "destructive" : "write";
}

function actionOf(value: unknown): ActionInfo {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? raw.actionId ?? ""),
    service: String(raw.service ?? ""),
    name: String(raw.name ?? raw.id ?? ""),
    description: String(raw.description ?? ""),
    operationType: operationOf(raw.operationType),
    inputSchema: raw.inputSchema ?? null
  };
}

export class ConnectorClient {
  readonly #config: ConnectorConfig;
  readonly #fetch: typeof fetch;

  // Workers 里的 fetch 要按全局函数调，存成字段再 this.#fetch(...) 会报 Illegal invocation，所以包一层。
  constructor(config: ConnectorConfig, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#config = { ...config, url: config.url.replace(/\/+$/, "") };
    this.#fetch = fetcher;
  }

  async #call(
    path: string,
    init: { method?: string; body?: unknown; alias?: string; idempotencyKey?: string } = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#config.token}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.alias) headers["x-oo-connector-alias"] = init.alias;
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
    const response = await this.#fetch(`${this.#config.url}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
    });
    const envelope = (await response.json().catch(() => ({}))) as Envelope;
    if (!response.ok || envelope.success === false) {
      throw new ConnectorError(
        envelope.errorCode ?? `http_${response.status}`,
        envelope.message ?? `open-connector 返回 ${response.status}`,
        response.status
      );
    }
    return envelope.data;
  }

  /** 发起授权。`returnUri` 只能是 http(s)，授权完 open-connector 跳回这里，带上 status。 */
  async start(service: string, returnUri: string): Promise<{ authorizationUrl: string; requestId: string }> {
    const data = (await this.#call(`/v1/connections/${encodeURIComponent(service)}/connect`, {
      method: "POST",
      body: { returnUri }
    })) as Record<string, unknown>;
    return { authorizationUrl: String(data.authorizationUrl), requestId: String(data.connectionRequestId) };
  }

  async request(requestId: string): Promise<RequestStatus> {
    const data = (await this.#call(`/v1/connection-requests/${encodeURIComponent(requestId)}`)) as Record<
      string,
      unknown
    >;
    const status = data.status;
    return {
      status: status === "connected" || status === "failed" || status === "expired" ? status : "initiated",
      appId: typeof data.appId === "string" ? data.appId : null,
      errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : null
    };
  }

  async connection(appId: string): Promise<Connection> {
    const data = (await this.#call(`/v1/connections/by-id/${encodeURIComponent(appId)}`)) as Record<string, unknown>;
    const account = data.accountLabel ?? data.displayName ?? data.providerAccountId;
    return {
      id: String(data.id ?? appId),
      service: String(data.service ?? ""),
      alias: String(data.alias ?? "default"),
      account: typeof account === "string" && account ? account : null
    };
  }

  /** 断开并在服务那边撤销授权。 */
  async disconnect(service: string, alias: string): Promise<void> {
    await this.#call(`/api/connections/${encodeURIComponent(service)}`, {
      method: "DELETE",
      body: { connectionName: alias, revoke: true }
    });
  }

  async search(query: string, service?: string, limit = 8): Promise<ActionInfo[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (service) params.set("service", service);
    const data = await this.#call(`/v1/actions/search?${params}`);
    const list = Array.isArray(data) ? data : ((data as { results?: unknown[] })?.results ?? []);
    return list.map((item) => actionOf((item as { action?: unknown }).action ?? item));
  }

  async action(actionId: string): Promise<ActionInfo> {
    return actionOf(await this.#call(`/v1/actions/${encodeURIComponent(actionId)}`));
  }

  /**
   * 跑一个动作。`idempotencyKey` 用工具调用的 id：DO 被回收后 pi 重跑这次调用，
   * open-connector 24 小时内按它回放上次的结果，不会再发一封信。
   */
  async run(actionId: string, input: unknown, alias: string, idempotencyKey: string): Promise<unknown> {
    return this.#call(`/v1/actions/${encodeURIComponent(actionId)}`, {
      method: "POST",
      body: { input },
      alias,
      idempotencyKey
    });
  }
}

/** 两个都设了才开连接器。 */
export function connectorConfigFrom(env: {
  readonly CONNECTOR_URL?: string;
  readonly CONNECTOR_TOKEN?: string;
}): ConnectorConfig | null {
  const url = env.CONNECTOR_URL?.trim();
  const token = env.CONNECTOR_TOKEN?.trim();
  return url && token ? { url, token } : null;
}
