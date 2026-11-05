/** 官网所有的动效和表单。页面不靠它也读得完：没有 JS 时内容全部直接显示。 */

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 元素进入视口时调一次 enter，离开时调 leave。 */
function watch(el: Element, enter: () => void, leave?: () => void, threshold = 0.25): void {
  new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) enter();
        else leave?.();
      }
    },
    { threshold }
  ).observe(el);
}

function setupReveal(): void {
  for (const el of document.querySelectorAll(".reveal")) {
    if (calm) el.classList.add("is-in");
    else watch(el, () => el.classList.add("is-in"), undefined, 0.2);
  }
}

/** 顶栏的字在深色天空上是白的，滚到浅色天空换成墨色。 */
function setupHeaderTone(): void {
  const header = document.querySelector<HTMLElement>(".top");
  const mark = document.getElementById("tone-switch");
  if (!header) return;
  if (!mark) {
    header.dataset.tone = "sky";
    return;
  }
  const update = () => {
    header.dataset.tone = mark.getBoundingClientRect().top < 48 ? "ink" : "sky";
  };
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}

/** 把一段话从第一个人的气泡送到 Pupu 的回复里。这就是「流动」。 */
async function flow(scene: HTMLElement): Promise<void> {
  const from = scene.querySelector<HTMLElement>("[data-flow-from]");
  const to = scene.querySelector<HTMLElement>("[data-flow-to]");
  if (!from || !to) return;

  const box = scene.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const chip = document.createElement("span");
  chip.className = "flow-chip";
  chip.textContent = from.textContent;
  chip.setAttribute("aria-hidden", "true");
  chip.style.left = `${a.left - box.left}px`;
  chip.style.top = `${a.top - box.top}px`;
  scene.append(chip);

  const dx = b.left - a.left;
  const dy = b.top - a.top;
  from.classList.add("is-lit");
  await chip.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 0 },
      { transform: `translate(${dx * 0.4 + 28}px, ${dy * 0.4}px) scale(1.06)`, opacity: 1, offset: 0.2 },
      { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }
    ],
    { duration: 1100, easing: "cubic-bezier(.45,.05,.2,1)", fill: "forwards" }
  ).finished;
  to.classList.add("is-lit");
  chip.remove();
}

/** 按 data-step 的顺序把演示放一遍。所有步骤一直占着位置，面板不会跳。 */
function setupScene(scene: HTMLElement): void {
  const steps = [...scene.querySelectorAll<HTMLElement>("[data-step]")];
  const loop = scene.hasAttribute("data-loop");
  if (calm || steps.length === 0) return;

  const reset = () => {
    for (const step of steps) step.classList.add("is-waiting");
    for (const mark of scene.querySelectorAll("mark")) mark.classList.remove("is-lit");
  };

  let visible = false;
  let running = false;

  const play = async () => {
    if (running) return;
    running = true;
    do {
      reset();
      for (const step of steps) {
        await sleep(Number(step.dataset.wait ?? 600));
        if (step.hasAttribute("data-typing")) {
          step.classList.remove("is-waiting");
          step.classList.add("is-typing");
          await sleep(900);
          step.classList.remove("is-typing");
        }
        step.classList.remove("is-waiting");
        if (step.hasAttribute("data-flow")) await flow(scene);
      }
      if (!loop) break;
      await sleep(6000);
      while (!visible) await sleep(400);
    } while (loop);
    running = false;
  };

  reset();
  let played = false;
  watch(
    scene,
    () => {
      visible = true;
      if (!played || loop) {
        played = true;
        void play();
      }
    },
    () => {
      visible = false;
    }
  );
}

function setupApprove(root: HTMLElement): void {
  const island = root.querySelector<HTMLElement>("[data-island]");
  const badge = root.querySelector<HTMLElement>("[data-badge]");
  const actions = root.querySelector<HTMLElement>("[data-actions]");
  const resultRow = root.querySelector<HTMLElement>(".approve__result");
  const result = root.querySelector<HTMLElement>("[data-result]");
  if (!island || !badge || !actions || !resultRow || !result) return;

  const decide = (yes: boolean) => {
    root.dataset.state = yes ? "yes" : "no";
    island.textContent = yes ? "正在发布" : "已拒绝";
    badge.hidden = true;
    actions.hidden = true;
    resultRow.hidden = false;
    result.textContent = yes ? "已允许。发布好了我在项目里说。" : "已拒绝。这件事 Pupu 不做了。";
  };

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-decide]")) {
    button.addEventListener("click", () => decide(button.dataset.decide === "yes"));
  }
  root.querySelector("[data-again]")?.addEventListener("click", () => {
    delete root.dataset.state;
    island.textContent = "等你批准";
    badge.hidden = false;
    actions.hidden = false;
    resultRow.hidden = true;
  });
}

function setupWaitlist(root: HTMLElement): void {
  const form = root.querySelector("form");
  const reply = root.querySelector<HTMLElement>(".waitlist__reply");
  const text = root.querySelector<HTMLElement>("[data-reply]");
  const button = root.querySelector("button");
  if (!form || !reply || !text || !button) return;

  const say = (message: string) => {
    text.textContent = message;
    reply.hidden = false;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    button.disabled = true;
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, website: data.get("website") })
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        say(body.error ?? "没发出去，再试一次。");
        button.disabled = false;
        return;
      }
      form.hidden = true;
      say(`收到了。开放名额时，我发信到 ${email}。`);
    } catch {
      say("没发出去：网络断了。连上之后再试一次。");
      button.disabled = false;
    }
  });
}

setupReveal();
setupHeaderTone();
document.querySelectorAll<HTMLElement>("[data-scene]").forEach(setupScene);
document.querySelectorAll<HTMLElement>("[data-approve]").forEach(setupApprove);
document.querySelectorAll<HTMLElement>("[data-waitlist]").forEach(setupWaitlist);
