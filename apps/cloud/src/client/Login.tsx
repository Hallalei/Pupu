import { Button, Input } from "@heroui/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { desktop } from "./desktop";
import { mountPupuArt } from "./pupu-art";

/** 登录没成时，云端跳回首页带着的原因。读一次就从地址栏去掉。 */
function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const message = url.searchParams.get("sign_in_error");
  if (message === null) return null;
  url.searchParams.delete("sign_in_error");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return message;
}

/** Google 自己规定的彩色 G，登录按钮上不能换色。 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="1.2em" height="1.2em" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.96 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function Art() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => mountPupuArt(canvas.current!), []);
  return (
    <div aria-hidden="true" className="login-art hidden flex-1 lg:block">
      <canvas ref={canvas} />
    </div>
  );
}

/** 登录的版式：左边一块 Pupu 的 3D 场景，右边一列居中。窄窗口只留右边。 */
function Shell({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div className="login relative flex h-dvh gap-3">
      <div className="sky" />
      <div className="window-drag" />
      <Art />
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-sm flex-col gap-3 py-6 text-center">
          <h1 className="m-0 text-greeting text-ink-sky">Pupu</h1>
          <p className="m-0 mb-5 text-message text-ink-sky-muted">{lead}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

const PILL = "tap h-12 w-full rounded-full text-body font-semibold";

/**
 * Google 登录按钮：asking 是还没问到开没开，按钮先占着位置转圈，下面的输入框不跳；off 是云端说了没开。
 * 问不到时照样显示：线上一直开着，真没开的话，点了云端会说明。leaving 是已经跳去 Google，
 * 从 Google 按返回回来时页面是从缓存里恢复的，要变回 ready。
 */
type GoogleButton = "asking" | "ready" | "leaving" | "off";

/**
 * 这个浏览器还没有凭据，或者被吊销了。开了 Google 登录时用自己的 Google 账号登录（要在成员名单上）；
 * 也能填配对码（在已经连上的手机或浏览器的设置里生成），手边一台连上的都没有时用访问口令。
 */
export function Login() {
  const app = desktop();
  const [google, setGoogle] = useState<GoogleButton>("asking");
  const [useToken, setUseToken] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(takeSignInError);

  useEffect(() => {
    if (app) return;
    api.googleEnabled().then(
      (enabled) => setGoogle(enabled ? "ready" : "off"),
      () => setGoogle("ready")
    );
  }, [app]);

  useEffect(() => {
    const back = (event: PageTransitionEvent) => {
      if (event.persisted) setGoogle((current) => (current === "leaving" ? "ready" : current));
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);

  async function submit() {
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await api.pair(useToken ? { accessToken: text } : { code: text });
      // 凭据已经在 cookie 里了，重新加载，页面和 WebSocket 都带上它。
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  function toggle() {
    setUseToken(!useToken);
    setValue("");
    setError(null);
  }

  // 电脑 App 的窗口不在网页上配对：凭据由 App 管，配对走 App 自己的窗口。
  if (app) {
    return (
      <Shell lead="这个窗口的授权失效了，重新配对一次就好。">
        <Button className={PILL} onPress={() => void app.repair()}>
          重新配对
        </Button>
      </Shell>
    );
  }

  return (
    <Shell lead="组织大脑，让智能在组织间流动。">
      {google !== "off" && (
        <>
          <Button
            isPending={google === "asking" || google === "leaving"}
            onPress={() => {
              setGoogle("leaving");
              window.location.assign("/api/auth/google/start?client=browser");
            }}
            className={`${PILL} bg-white text-[#1d1d1f]`}
          >
            <GoogleMark />
            通过 Google 继续
          </Button>
          <div className="my-2 flex items-center gap-3 text-footnote text-ink-sky-muted">
            <span className="h-px flex-1 bg-ink-sky/15" />
            或
            <span className="h-px flex-1 bg-ink-sky/15" />
          </div>
        </>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {useToken ? (
          <Input
            key="token"
            aria-label="访问口令"
            placeholder="访问口令"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="h-12 rounded-full bg-ink-sky/8 text-center text-body shadow-none"
          />
        ) : (
          <Input
            key="code"
            aria-label="配对码"
            placeholder="配对码"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value.toUpperCase())}
            className="h-12 rounded-full bg-ink-sky/8 text-center text-body tracking-widest shadow-none placeholder:tracking-normal"
          />
        )}
        <Button type="submit" isPending={busy} isDisabled={!value.trim()} className={PILL}>
          继续
        </Button>
      </form>
      {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      <button type="button" onClick={toggle} className="mt-2 text-footnote text-ink-sky-muted hover:text-ink-sky">
        {useToken ? "用配对码" : "手边没有连上的设备？用访问口令"}
      </button>
    </Shell>
  );
}
