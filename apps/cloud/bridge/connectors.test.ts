import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ApprovalRow } from "../src/bridge/approvals.ts";
import { ApprovalStore } from "../src/bridge/approvals.ts";
import { ComputerGate } from "../src/bridge/gate.ts";
import { ConnectorClient, ConnectorError, connectorConfigFrom } from "../src/connectors/client.ts";
import { ATTEMPT_TTL_MS, ConnectorStore, type ConnectorRow } from "../src/connectors/store.ts";
import {
  connectorIdOf,
  connectorSubject,
  pickAccount,
  planConnectorCall,
  type ConnectorAsk,
  type ConnectorDeps
} from "../src/connectors/tools.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

function account(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: "app-1",
    service: "gmail",
    alias: "alias-1",
    account: "mom@example.com",
    memberId: "m1",
    createdAt: NOW,
    ...overrides
  };
}

/** 假的 open-connector：按路径回 envelope，记下收到的请求。 */
function fakeConnector(routes: Record<string, (init: RequestInit) => { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const key = `${init.method ?? "GET"} ${path}`;
    const route = routes[key];
    if (!route) return Response.json({ success: false, errorCode: "unknown", message: key }, { status: 404 });
    const { status = 200, body } = route(init);
    return Response.json(body, { status });
  }) as typeof fetch;
  return { client: new ConnectorClient({ url: "https://oc.example/", token: "admin" }, fetcher), calls };
}

describe("连接器的记录", () => {
  test("存、按 id 查、重连覆盖别名和账号名但不换主人", () => {
    const store = new ConnectorStore(sqlStorage());
    store.save(account());
    store.save(account({ alias: "alias-2", account: "new@example.com", memberId: "someone-else" }));
    const row = store.byId("app-1");
    assert.equal(row?.alias, "alias-2");
    assert.equal(row?.account, "new@example.com");
    assert.equal(row?.memberId, "m1");
    assert.equal(store.list().length, 1);
    assert.equal(store.remove("app-1"), true);
    assert.equal(store.remove("app-1"), false);
  });

  test("还没有创建者时连的账号，创建者第一次登录后归他", () => {
    const store = new ConnectorStore(sqlStorage());
    store.save(account({ memberId: null }));
    store.claimUnowned("creator");
    assert.equal(store.byId("app-1")?.memberId, "creator");
  });

  test("一次授权只认一次，过期的不认", () => {
    const store = new ConnectorStore(sqlStorage());
    const attempt = { id: "t1", requestId: "r1", service: "gmail", memberId: "m1", client: "phone" as const, createdAt: NOW };
    store.addAttempt(attempt);
    assert.deepEqual(store.takeAttempt("t1", NOW + 1000), attempt);
    assert.equal(store.takeAttempt("t1", NOW + 1000), undefined);
    store.addAttempt({ ...attempt, id: "t2" });
    assert.equal(store.takeAttempt("t2", NOW + ATTEMPT_TTL_MS + 1), undefined);
  });
});

describe("用哪个账号", () => {
  test("这个服务只连了一个就用它", () => {
    const picked = pickAccount([account()], "gmail", undefined);
    assert.equal(picked.ok && picked.row.id, "app-1");
  });

  test("没连上的服务照实说，让用户去「我 → 账户」", () => {
    const picked = pickAccount([account()], "github", undefined);
    assert.equal(picked.ok, false);
    assert.match(!picked.ok ? picked.reason : "", /还没有连上 GitHub/);
  });

  test("连了几个又没说用哪个，先问；按邮箱或 id 都能选", () => {
    const rows = [account(), account({ id: "app-2", alias: "alias-2", account: "dad@example.com", memberId: "m2" })];
    assert.equal(pickAccount(rows, "gmail", undefined).ok, false);
    const byEmail = pickAccount(rows, "gmail", "Dad@Example.com");
    assert.equal(byEmail.ok && byEmail.row.id, "app-2");
    const byId = pickAccount(rows, "gmail", "app-1");
    assert.equal(byId.ok && byId.row.id, "app-1");
  });
});

describe("open-connector 客户端", () => {
  test("两个都设了才开", () => {
    assert.equal(connectorConfigFrom({ CONNECTOR_URL: "https://oc.example" }), null);
    assert.deepEqual(connectorConfigFrom({ CONNECTOR_URL: " https://oc.example ", CONNECTOR_TOKEN: "t" }), {
      url: "https://oc.example",
      token: "t"
    });
  });

  test("发起授权带上管理员 token 和跳回地址", async () => {
    const { client, calls } = fakeConnector({
      "POST /v1/connections/gmail/connect": () => ({
        body: { success: true, data: { authorizationUrl: "https://accounts.google.com/x", connectionRequestId: "r1" } }
      })
    });
    const started = await client.start("gmail", "https://pupu.example/api/connectors/done?attempt=t1");
    assert.deepEqual(started, { authorizationUrl: "https://accounts.google.com/x", requestId: "r1" });
    assert.equal(calls[0]?.url, "https://oc.example/v1/connections/gmail/connect");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer admin");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      returnUri: "https://pupu.example/api/connectors/done?attempt=t1"
    });
  });

  test("跑动作带上账号别名和幂等键", async () => {
    const { client, calls } = fakeConnector({
      "POST /v1/actions/gmail.send_email": () => ({ body: { success: true, data: { id: "msg" } } })
    });
    assert.deepEqual(await client.run("gmail.send_email", { to: "a@b.c" }, "alias-1", "pupu:call-1"), { id: "msg" });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["x-oo-connector-alias"], "alias-1");
    assert.equal(headers["Idempotency-Key"], "pupu:call-1");
  });

  test("失败时带上 open-connector 的错误码", async () => {
    const { client } = fakeConnector({
      "GET /v1/connection-requests/r1": () => ({
        status: 404,
        body: { success: false, errorCode: "connection_request_not_found", message: "Connection request not found." }
      })
    });
    await assert.rejects(client.request("r1"), (error) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "connection_request_not_found");
      assert.equal(error.status, 404);
      return true;
    });
  });

  test("没写清楚读写的动作按写算", async () => {
    const { client } = fakeConnector({
      "GET /v1/actions/x.y": () => ({ body: { success: true, data: { id: "x.y", service: "x" } } })
    });
    assert.equal((await client.action("x.y")).operationType, "write");
  });
});

describe("写操作先问账号主人", () => {
  function deps(operationType: string, rows: ConnectorRow[] = [account()]): ConnectorDeps {
    const { client } = fakeConnector({
      "GET /v1/actions/gmail.send_email": () => ({
        body: {
          success: true,
          data: { id: "gmail.send_email", service: "gmail", name: "Send email", description: "发一封信", operationType }
        }
      })
    });
    return {
      client: () => client,
      accounts: () => rows,
      emailOf: () => "mom@example.com",
      threadOf: (session) =>
        session === "7" ? { kind: "private", session, memberId: "m1" }
        : session === "8" ? { kind: "private", session, memberId: "m2" }
        : session === "1" ? { kind: "main", session }
        : undefined
    };
  }

  const call = {
    name: "connector_run",
    arguments: { action_id: "gmail.send_email", input: { to: "a@b.c" } },
    session: "1"
  };

  test("读的动作在账号主人的私聊里不问，直接跑", async () => {
    assert.equal(await planConnectorCall({ ...call, session: "7" }, deps("read")), undefined);
  });

  test("读的动作在主会话、别人的私聊、项目里都拦下，告诉模型让用户去私聊", async () => {
    for (const session of ["1", "8", "9", null]) {
      const refused = await planConnectorCall({ ...call, session }, deps("read"));
      assert.ok(refused && "block" in refused, `会话 ${session} 该拦下`);
      assert.match(refused.block, /私聊/);
    }
  });

  test("门上拦下读的动作：工具不跑，也不用人批", async () => {
    const gate = new ComputerGate({
      computers: () => [],
      directory: { list: () => [], setPolicy: () => false, setScreenUntil: () => {} },
      approvals: new ApprovalStore(sqlStorage()),
      now: () => NOW,
      onChange: () => {},
      plan: (planned) => planConnectorCall(planned, deps("read"))
    });
    const blocked = await gate.beforeTool({ id: "call-read", ...call });
    assert.match(blocked?.block ?? "", /私聊/);
    assert.deepEqual(gate.pending(), []);
    assert.equal(await gate.beforeTool({ id: "call-read-2", ...call, session: "7" }), undefined);
  });

  test("还没有创建者时账号没有主人，主会话能读", async () => {
    const rows = [account({ memberId: null })];
    assert.equal(await planConnectorCall(call, deps("read", rows)), undefined);
  });

  test("写的动作问连这个账号的人，删的动作标高风险", async () => {
    const write = (await planConnectorCall(call, deps("write"))) as ConnectorAsk;
    assert.equal(write?.subjectId, connectorSubject("app-1"));
    assert.equal(write?.ownerId, "m1");
    assert.match(write?.title ?? "", /Gmail（mom@example.com）：Send email/);
    assert.match(write?.detail ?? "", /a@b\.c/);
    assert.equal(write?.reason, null);
    assert.ok(((await planConnectorCall(call, deps("destructive"))) as ConnectorAsk).reason);
  });

  test("别的工具、没开连接器、选不出账号都不拦", async () => {
    assert.equal(await planConnectorCall({ name: "run_command", arguments: {}, session: "1" }, deps("write")), undefined);
    assert.equal(await planConnectorCall(call, { ...deps("write"), client: () => null }), undefined);
    assert.equal(await planConnectorCall(call, deps("write", [])), undefined);
  });

  test("审批表里记成 connector:<id>，和电脑分开", () => {
    assert.equal(connectorIdOf(connectorSubject("app-1")), "app-1");
    assert.equal(connectorIdOf("c1"), null);
  });

  test("门里等批：允许了放行，卡片上写账号", async () => {
    let now = NOW;
    const approvals = new ApprovalStore(sqlStorage());
    const changed: string[][] = [];
    const gate = new ComputerGate({
      computers: () => [],
      directory: { list: () => [], setPolicy: () => false, setScreenUntil: () => {} },
      approvals,
      now: () => now,
      onChange: (ids) => changed.push([...ids]),
      plan: (planned) => planConnectorCall(planned, deps("write")),
      subjectName: (id) => (connectorIdOf(id) ? "Gmail（mom@example.com）" : undefined)
    });
    const waiting = gate.beforeTool({ id: "call-1", ...call });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [view] = gate.pending();
    assert.equal(view?.computerId, "connector:app-1");
    assert.equal(view?.computerName, "Gmail（mom@example.com）");
    assert.deepEqual(changed[0], ["connector:app-1"]);
    assert.equal(gate.decide(view!.id, "allow"), "ok");
    assert.equal(await waiting, undefined);
    // 重跑同一次调用：按调用 id 查到已经批过的那条，不再问。
    now += 1000;
    assert.equal(await gate.beforeTool({ id: "call-1", ...call }), undefined);
    assert.equal(approvals.pending(now).length, 0);
    assert.equal((approvals.byCall("call-1") as ApprovalRow).status, "allowed");
  });

  test("门里等批：拒绝了不做，告诉模型别绕过去", async () => {
    const approvals = new ApprovalStore(sqlStorage());
    const gate = new ComputerGate({
      computers: () => [],
      directory: { list: () => [], setPolicy: () => false, setScreenUntil: () => {} },
      approvals,
      now: () => NOW,
      onChange: () => {},
      plan: (planned) => planConnectorCall(planned, deps("write"))
    });
    const waiting = gate.beforeTool({ id: "call-2", ...call });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.decide(gate.pending()[0]!.id, "deny");
    const result = await waiting;
    assert.match(result?.block ?? "", /拒绝/);
  });
});
