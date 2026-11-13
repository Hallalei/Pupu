/** 页面入口：要任务，一帧一帧算，把像素交回去。 */
import { createStage, type Job } from "./stage.ts";

const say = (url: string, body: string) => fetch(url, { method: "POST", body });

async function run() {
  const job: Job = await (await fetch("/job")).json();
  const started = performance.now();
  const { buildWorld } = await import(job.world === "day" ? "../day/world.ts" : "./world.ts");
  const world = await buildWorld();
  const stage = createStage(document.getElementById("film") as HTMLCanvasElement, job, world);
  await say("/log", `${stage.renderer}，世界建好了，用了 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
  let sending: Promise<unknown> = Promise.resolve();
  for (let index = 0; index < job.times.length; index++) {
    const pixels = stage.frame(job.times[index]!);
    await sending;
    sending = fetch(`/frame/${index}`, { method: "POST", body: pixels });
  }
  await sending;
  await say("/done", "");
}

run().catch((error) => say("/fail", String(error?.stack ?? error)));
window.addEventListener("error", (event) => say("/fail", String(event.message)));
