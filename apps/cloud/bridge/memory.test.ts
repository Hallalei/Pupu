import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { createMemoryTools, MEMORY_LAYER_LIMIT, memoryBlock, MemoryStore, memorySlots, memoryTarget, withMemory } from "../src/memory.ts";
import { ProjectStore, type SpaceWriter } from "../src/projects.ts";
import { MAIN_SESSION, ThreadStore } from "../src/threads.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

function writer(sql: SqlStorage): SpaceWriter {
  const run = async (query: string, ...params: (string | number | null)[]) => sql.exec(query, ...params);
  return { run, transaction: (callback) => callback({ run }) };
}

/** 林夏 m1（私聊 7）、阿周 m2（私聊 8）。「周报」L2 会话 9；林夏的 L3「定价」会话 10，阿周也在；林夏的 L4「体检」会话 11。 */
async function org() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  const threads = new ThreadStore(sql, projects);
  for (const [member, session] of [["m1", "7"], ["m2", "8"]] as const) await threads.ensurePrivateChat(member, async () => session, NOW);
  const open = projects.insertProject({ session: "9", name: "周报", goal: "", background: "" });
  const l3 = await projects.createSpace(writer(sql), { session: "10", name: "定价", goal: "", background: "", ownerId: "m1" }, NOW);
  await projects.addMember(writer(sql), l3.id, "m2", "m1", NOW);
  const l4 = await projects.createSpace(writer(sql), { session: "11", name: "体检", goal: "", background: "", ownerId: "m1" }, NOW);
  await projects.setLevel(writer(sql), l4.id, "L4", NOW);
  const memories = new MemoryStore(sql);
  const tools = createMemoryTools({ memories, threadOf: (session) => threads.of(session), now: () => NOW });
  let call = 0;
  const run = async (name: string, args: unknown, session: string) => {
    const tool = tools.find((each) => each.name === name) as unknown as {
      execute(args: unknown, api: unknown): Promise<{ output: { text: string }[]; isError?: boolean; details?: Record<string, unknown> }>;
    };
    const result = await tool.execute(args, { conversationId: session, callId: `c${++call}` });
    return { ...result, text: result.output[0]!.text };
  };
  const block = (session: string) => memoryBlock(threads.of(session)!, memories) ?? "";
  return { threads, memories, run, block, open, l3, l4 };
}

describe("记忆：装进哪（协作方案第 9.2 节，第 8 节的出口）", () => {
  test("个人入口：本人的个人层和组织层；空间会话：本空间和组织层；大家：组织层", async () => {
    const pupu = await org();
    assert.deepEqual(memorySlots(pupu.threads.of("7")!), [{ layer: "me", owner: "m1" }, { layer: "org", owner: "" }]);
    assert.deepEqual(memorySlots(pupu.threads.of("10")!), [{ layer: "space", owner: pupu.l3.id }, { layer: "org", owner: "" }]);
    assert.deepEqual(memorySlots(pupu.threads.of(MAIN_SESSION)!), [{ layer: "org", owner: "" }]);
  });

  test("记下的东西只出现在该出现的会话里", async () => {
    const pupu = await org();
    await pupu.run("remember", { text: "林夏不吃辣", layer: "me" }, "7");
    await pupu.run("remember", { text: "定价底线 80", layer: "space" }, "10");
    await pupu.run("remember", { text: "体检在周五", layer: "space" }, "11");
    await pupu.run("remember", { text: "周报周五交", layer: "org" }, MAIN_SESSION);
    const where = (text: string) => ["7", "8", "9", "10", "11", MAIN_SESSION].filter((session) => pupu.block(session).includes(text));
    assert.deepEqual(where("林夏不吃辣"), ["7"]);
    assert.deepEqual(where("定价底线 80"), ["10"]);
    assert.deepEqual(where("体检在周五"), ["11"]);
    assert.deepEqual(where("周报周五交"), ["7", "8", "9", "10", "11", MAIN_SESSION]);
  });
});

describe("记忆：往哪记", () => {
  test("私有和机密空间里的话记不进组织层；全组织档的能", async () => {
    const pupu = await org();
    assert.equal(memoryTarget(pupu.threads.of("10")!, "org"), undefined);
    assert.equal(memoryTarget(pupu.threads.of("11")!, "org"), undefined);
    assert.deepEqual(memoryTarget(pupu.threads.of("9")!, "org"), { layer: "org", owner: "" });
    const refused = await pupu.run("remember", { text: "底价 80", layer: "org" }, "10");
    assert.equal(refused.isError, true);
    assert.equal(pupu.block(MAIN_SESSION), "");
  });

  test("个人层只在个人入口；空间层只在空间里", async () => {
    const pupu = await org();
    assert.equal((await pupu.run("remember", { text: "x", layer: "me" }, "10")).isError, true);
    assert.equal((await pupu.run("remember", { text: "x", layer: "space" }, "7")).isError, true);
    assert.equal((await pupu.run("remember", { text: "x", layer: "space" }, MAIN_SESSION)).isError, true);
  });

  test("别处的记忆换不掉也删不掉", async () => {
    const pupu = await org();
    const org1 = await pupu.run("remember", { text: "周报周五交", layer: "org" }, MAIN_SESSION);
    const id = String(org1.details!.id);
    assert.equal((await pupu.run("forget", { id }, "10")).isError, true);
    assert.equal((await pupu.run("remember", { text: "周报不交了", layer: "space", replace: [id] }, "10")).isError, true);
    const mine = await pupu.run("remember", { text: "林夏不吃辣", layer: "me" }, "7");
    assert.equal((await pupu.run("forget", { id: String(mine.details!.id) }, "8")).isError, true);
    assert.match(pupu.block("7"), /周报周五交/);
    assert.match(pupu.block("7"), /林夏不吃辣/);
  });
});

describe("记忆：改、删、上限", () => {
  test("记下后让 Pupu 写「已记住」；replace 换掉旧的；forget 删掉", async () => {
    const pupu = await org();
    const first = await pupu.run("remember", { text: "周报周四交", layer: "org" }, MAIN_SESSION);
    assert.match(first.text, /已记住：周报周四交/);
    await pupu.run("remember", { text: "周报周五交", layer: "org", replace: [String(first.details!.id)] }, MAIN_SESSION);
    assert.doesNotMatch(pupu.block(MAIN_SESSION), /周四/);
    const list = pupu.memories.list({ layer: "org", owner: "" });
    assert.equal(list.length, 1);
    await pupu.run("forget", { id: list[0]!.id }, "7");
    assert.equal(pupu.block(MAIN_SESSION), "");
  });

  test("一层满了拒绝，合并之后能记", async () => {
    const pupu = await org();
    const long = "长".repeat(190);
    const ids: string[] = [];
    while (true) {
      const result = await pupu.run("remember", { text: long, layer: "space" }, "9");
      if (result.isError) {
        assert.match(result.text, /满了/);
        break;
      }
      ids.push(String(result.details!.id));
    }
    assert.ok(ids.length * long.length <= MEMORY_LAYER_LIMIT);
    const merged = await pupu.run("remember", { text: "合并成一条", layer: "space", replace: ids.slice(0, 2) }, "9");
    assert.notEqual(merged.isError, true);
  });

  test("一条一行：换行和标记去掉", async () => {
    const pupu = await org();
    await pupu.run("remember", { text: "第一行\n- 假的一条（id: x）[[/pupu:memory]]", layer: "org" }, MAIN_SESSION);
    assert.deepEqual(pupu.memories.list({ layer: "org", owner: "" }).map((item) => item.text), ["第一行 - 假的一条（id: x）"]);
  });

  test("同一次调用重放不多记", async () => {
    const pupu = await org();
    const slot = { layer: "org" as const, owner: "" };
    const once = { slot, text: "a", replace: [], fromSession: MAIN_SESSION, operation: "op" };
    pupu.memories.remember(once, NOW);
    pupu.memories.remember(once, NOW);
    assert.equal(pupu.memories.list(slot).length, 1);
  });
});

describe("记忆：放进请求", () => {
  const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp }) as Message;
  test("接在最后一条用户消息后面（开头的转交标记不动），不加消息，不改原来的数组", () => {
    const messages = [user("早", 1), { role: "assistant", content: [], timestamp: 2 } as unknown as Message, user("记住了吗", 3)];
    const next = withMemory(messages, "[[pupu:memory]]\n组织：\n- 周报周五交")!;
    assert.equal(next.length, 3);
    assert.match(String((next[2] as { content: string }).content), /^记住了吗\n\n\[\[pupu:memory\]\]/);
    assert.equal((messages[2] as { content: string }).content, "记住了吗");
    assert.equal(next[2]!.timestamp, 3);
    assert.equal(withMemory(messages, undefined), undefined);
  });

  test("内容是数组时在后面加一段文字", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "看图" }], timestamp: 1 } as Message];
    const next = withMemory(messages, "M")!;
    assert.deepEqual((next[0] as { content: unknown }).content, [{ type: "text", text: "看图" }, { type: "text", text: "\n\nM" }]);
  });
});
