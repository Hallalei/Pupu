import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerAction, UpFrame } from "../src/bridge/protocol.ts";
import type { ActionHost } from "./actions.ts";
import { grantee, performComputer, refuseWhileUserActive, toolCall, type Driver, type DriverResult, USER_QUIET_MS } from "./computer.ts";

const on = { pid: 7, windowId: 9 };
const computer = (action: Omit<ComputerAction, "kind">): ComputerAction => ({ kind: "computer", ...action });
const result = (over: Partial<DriverResult> = {}): DriverResult => ({ text: "", images: [], isError: false, ...over });

/** 记下每次调用，按工具名回话。 */
function fake(replies: Record<string, DriverResult> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const driver: Driver = {
    async callTool(name, json) {
      calls.push({ name, args: JSON.parse(json) as Record<string, unknown> });
      return replies[name] ?? result();
    }
  };
  return { calls, driver };
}

function host() {
  const frames: UpFrame[] = [];
  return { frames, host: { send: (frame: UpFrame) => frames.push(frame) } as unknown as ActionHost };
}

const granted = result({ structuredJson: JSON.stringify({ accessibility: true, screen_recording: true }) });

test("点控件走编号，点画布走窗口坐标", () => {
  assert.deepEqual(toolCall(computer({ op: "click", ...on, element: "s1:3" })), {
    name: "click",
    args: { pid: 7, window_id: 9, element_token: "s1:3" }
  });
  assert.deepEqual(toolCall(computer({ op: "click", ...on, x: 10, y: 20, button: "middle" })), {
    name: "click",
    args: { pid: 7, window_id: 9, x: 10, y: 20, button: "middle" }
  });
});

test("双击和右键是驱动里单独的工具", () => {
  assert.equal(toolCall(computer({ op: "click", ...on, x: 1, y: 2, count: 2 })).name, "double_click");
  assert.equal(toolCall(computer({ op: "click", ...on, element: "s1:3", button: "right" })).name, "right_click");
});

test("组合键走 hotkey，单键走 press_key，常见别名换成驱动的键名", () => {
  assert.deepEqual(toolCall(computer({ op: "key", ...on, key: "cmd+shift+s" })), {
    name: "hotkey",
    args: { pid: 7, window_id: 9, keys: ["cmd", "shift", "s"] }
  });
  assert.deepEqual(toolCall(computer({ op: "key", ...on, key: "Enter" })), {
    name: "press_key",
    args: { pid: 7, window_id: 9, key: "return" }
  });
});

test("打开应用认 bundle id 和名字", () => {
  assert.deepEqual(toolCall(computer({ op: "open", app: "com.apple.Notes" })).args, { bundle_id: "com.apple.Notes" });
  assert.deepEqual(toolCall(computer({ op: "open", app: "备忘录", path: "/tmp/a.txt" })).args, { name: "备忘录", urls: ["/tmp/a.txt"] });
});

test("默认不带投递方式，也就是后台；要切到前面得明说", () => {
  assert.equal(toolCall(computer({ op: "type", ...on, text: "hi" })).args.delivery_mode, undefined);
  assert.equal(toolCall(computer({ op: "type", ...on, text: "hi", foreground: true })).args.delivery_mode, "foreground");
});

test("看窗口要 JPEG 和控件，一起发回去", async () => {
  const { calls, driver } = fake({
    get_window_state: result({
      text: "- [1] AXButton \"发送\"",
      images: [{ mimeType: "image/jpeg", dataBase64: "abc" }],
      structuredJson: JSON.stringify({ screenshot_width: 640, screenshot_height: 480 })
    })
  });
  const { frames, host: sink } = host();
  await performComputer("r1", computer({ op: "look", ...on }), sink, driver);
  assert.equal(calls[0]?.args.screenshot_format, "jpeg");
  const frame = frames[0];
  assert.equal(frame?.type, "picture");
  assert.ok(frame?.type === "picture" && frame.summary?.includes("AXButton"));
  assert.ok(frame?.type === "picture" && frame.width === 640 && frame.data === "abc");
});

test("不填 pid 就看当前桌面空间最前面的普通窗口", async () => {
  const { calls, driver } = fake({
    list_windows: result({
      structuredJson: JSON.stringify({
        windows: [
          { pid: 1, window_id: 11, layer: 0, z_index: 2 },
          { pid: 2, window_id: 22, layer: 0, z_index: 5 },
          { pid: 3, window_id: 33, layer: 25, z_index: 9 }
        ]
      })
    }),
    check_permissions: granted
  });
  await performComputer("r1", computer({ op: "look" }), host().host, driver);
  assert.deepEqual(calls[0], { name: "list_windows", args: { on_screen_only: true } });
  assert.equal(calls[1]?.args.pid, 2);
  assert.equal(calls[1]?.args.window_id, 22);
});

test("只给 pid 就看这个进程最大的可见窗口，不跑到别的应用去", async () => {
  const { calls, driver } = fake({
    list_windows: result({
      structuredJson: JSON.stringify({
        windows: [
          { pid: 5, window_id: 1, layer: 0, is_on_screen: false, bounds: { width: 900, height: 900 } },
          { pid: 5, window_id: 2, layer: 0, is_on_screen: true, bounds: { width: 40, height: 40 } },
          { pid: 5, window_id: 3, layer: 0, is_on_screen: true, bounds: { width: 300, height: 200 } }
        ]
      })
    }),
    check_permissions: granted
  });
  await performComputer("r1", computer({ op: "look", pid: 5 }), host().host, driver);
  assert.deepEqual(calls[0], { name: "list_windows", args: { pid: 5 } });
  assert.equal(calls[1]?.args.window_id, 3);
});

test("窗口列表去掉系统噪音，前面的排在前面，标出别的桌面空间", async () => {
  const bounds = { width: 500, height: 400 };
  const { driver } = fake({
    list_windows: result({
      structuredJson: JSON.stringify({
        windows: [
          { pid: 1, window_id: 1, app_name: "WindowManager", title: "", layer: 0, z_index: 9, is_on_screen: false, bounds },
          { pid: 2, window_id: 2, app_name: "飞书", title: "消息", layer: 0, z_index: 1, is_on_screen: false, on_current_space: false, bounds },
          { pid: 3, window_id: 3, app_name: "备忘录", title: "", layer: 0, z_index: 5, is_on_screen: true, on_current_space: true, bounds },
          { pid: 4, window_id: 4, app_name: "小条", title: "", layer: 0, z_index: 7, is_on_screen: true, bounds: { width: 20, height: 20 } }
        ]
      })
    })
  });
  const { frames, host: sink } = host();
  await performComputer("r1", computer({ op: "windows" }), sink, driver);
  const frame = frames[0];
  assert.ok(frame?.type === "data");
  assert.deepEqual(frame.text?.split("\n"), [
    "- 备忘录：没有标题，pid 3，window_id 3",
    "- 飞书：消息，pid 2，window_id 2，在别的桌面空间或者最小化了"
  ]);
});

test("系统的授权和密码窗口只留给用户，看得到但点不了", async () => {
  const { calls, driver } = fake({
    list_windows: result({ structuredJson: JSON.stringify({ windows: [{ pid: 1835, window_id: 1, app_name: "universalAccessAuthWarn" }] }) })
  });
  await assert.rejects(
    performComputer("r1", computer({ op: "click", pid: 1835, windowId: 1, element: "s1:1" }), host().host, driver),
    /只能用户自己处理/
  );
  assert.equal(calls.some((call) => call.name === "click"), false);
});

test("没有屏幕录制权限时控件照常给，并说明去哪开", async () => {
  const { driver } = fake({
    get_window_state: result({ text: "- [1] AXButton" }),
    check_permissions: result({ structuredJson: JSON.stringify({ accessibility: true, screen_recording: false }) })
  });
  const { frames, host: sink } = host();
  await performComputer("r1", computer({ op: "look", ...on }), sink, driver);
  const frame = frames[0];
  assert.ok(frame?.type === "data" && frame.text?.includes("AXButton") && frame.text.includes("屏幕录制"));
});

test("做完一步马上再看一眼同一个窗口，模型拿到新编号", async () => {
  const { calls, driver } = fake({ click: result({ text: "已点" }), check_permissions: granted });
  const { frames, host: sink } = host();
  await performComputer("r1", computer({ op: "click", ...on, element: "s1:3" }), sink, driver);
  assert.deepEqual(calls.map((call) => call.name).slice(0, 3), ["list_windows", "click", "get_window_state"]);
  const frame = frames[0];
  assert.ok(frame?.type === "data" && frame.text?.startsWith("已点"));
});

test("驱动拒绝时不再看窗口，把原因交给模型", async () => {
  const { calls, driver } = fake({
    type_text: result({ text: "window_not_key", structuredJson: JSON.stringify({ effect: "refused" }) }),
    check_permissions: granted
  });
  await assert.rejects(performComputer("r1", computer({ op: "type", ...on, text: "x" }), host().host, driver), /window_not_key/);
  assert.equal(calls.some((call) => call.name === "get_window_state"), false);
});

test("没有辅助功能权限时说清楚去哪开、开给谁", async () => {
  const { driver } = fake({
    click: result({ isError: true, text: "AX denied" }),
    check_permissions: result({ structuredJson: JSON.stringify({ accessibility: false, screen_recording: true }) })
  });
  await assert.rejects(performComputer("r1", computer({ op: "click", ...on, x: 1, y: 2 }), host().host, driver), /辅助功能/);
});

test("权限记在外层应用名下，不是里面的 Helper", () => {
  assert.equal(grantee("/Applications/Pupu.app/Contents/Frameworks/Pupu Helper.app/Contents/MacOS/Pupu Helper"), "Pupu");
  assert.equal(grantee("/opt/homebrew/bin/node"), "node");
});

test("用户刚碰过键盘鼠标就不切到前面", async () => {
  await assert.rejects(refuseWhileUserActive(async () => 200, () => 1_000_000), /正在用这台电脑/);
  await refuseWhileUserActive(async () => USER_QUIET_MS + 1);
});
