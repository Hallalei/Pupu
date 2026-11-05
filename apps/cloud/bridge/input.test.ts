import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { InputHelper, usePrebuiltInput } from "./input.ts";

/** 等文件出现并满足条件。助手是子进程，机器忙的时候起得慢。 */
async function contents(file: string, ready: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null && ready(text)) return text;
    if (Date.now() > deadline) throw new Error(`等不到 ${file}：${text}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("正式包的输入助手", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pupu-input-"));
  after(() => rm(directory, { recursive: true, force: true }));

  it("用包里的程序，不在本机编", async () => {
    const received = path.join(directory, "received");
    const bin = path.join(directory, "pupu-input");
    await writeFile(bin, `#!/bin/sh\nprintf '{"type":"permissions","accessibility":true}\\n'\ncat > ${JSON.stringify(received)}\n`);
    await chmod(bin, 0o755);
    usePrebuiltInput(bin);

    const failures: string[] = [];
    const input = new InputHelper((message) => failures.push(message));
    input.send({ t: "move", x: 0.5, y: 0.5 });
    await contents(received, () => true);
    input.stop();
    const text = await contents(received, (it) => it.includes("release"));

    assert.deepEqual(failures, []);
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as unknown);
    assert.deepEqual(lines, [{ t: "move", x: 0.5, y: 0.5 }, { t: "release" }]);
  });
});
