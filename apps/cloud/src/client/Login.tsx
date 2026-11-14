import { Spinner } from "@heroui/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { desktop } from "./desktop";
import { mountPupuArt } from "./pupu-art";
import { PILL_ACTION } from "./settings-ui";

/** 登录没成时，云端跳回首页带着的原因。读一次就从地址栏去掉。 */
function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const message = url.searchParams.get("sign_in_error");
  if (message === null) return null;
  url.searchParams.delete("sign_in_error");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return message;
}

/** Google 自己规定的四色 G，登录按钮上不能换色。 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" className="shrink-0">
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

/**
 * 登录的版式（规范 SignIn）：天空上只写 Pupu 和那句话，按钮、输入框、出错的字都在一张实色卡片上。
 * 手机浏览器卡片贴着屏幕底；电脑上是一列里的一张浮卡；窗口宽 1024 以上左边多一块 3D 场景。样子在 styles.css 的 .login 里。
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="login">
      <div className="sky" />
      <div className="window-drag" />
      <Art />
      <main className="login-column">
        <div className="login-hero">
          <h1 className="m-0 text-greeting text-ink-sky">Pupu</h1>
          <p className="m-0 mt-2 text-message text-ink-sky">组织大脑，让智能在组织间流动。</p>
        </div>
        {children}
      </main>
    </div>
  );
}

const BUTTON = `${PILL_ACTION} w-full`;

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
    if (!text || busy) return;
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

  // 电脑 App 的窗口不在网页上配对：凭据由 App 管，配对走 App 自己的窗口。卡片里只有一句话和「重新配对」。
  if (app) {
    return (
      <Shell>
        <div className="login-card">
          <p className="m-0 text-body text-ink">这个窗口的授权失效了，重新配对一次就好。</p>
          <button type="button" onClick={() => void app.repair()} className={BUTTON}>
            重新配对
          </button>
        </div>
      </Shell>
    );
  }

  const googleWaiting = google === "asking" || google === "leaving";
  return (
    <Shell>
      <form
        aria-label="连接 Pupu"
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {google !== "off" && (
          <>
            <button
              type="button"
              aria-busy={googleWaiting || undefined}
              onClick={() => {
                if (googleWaiting) return;
                setGoogle("leaving");
                window.location.assign("/api/auth/google/start?client=browser");
              }}
              className="login-google tap"
            >
              {googleWaiting ? <Spinner size="sm" color="current" aria-label="正在打开 Google" className="size-4.5" /> : <GoogleMark />}
              用 Google 登录
            </button>
            <div className="login-or text-footnote">或</div>
          </>
        )}
        {useToken ? (
          <input
            key="token"
            aria-label="访问口令"
            placeholder="访问口令"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="field w-full text-center"
          />
        ) : (
          <input
            key="code"
            aria-label="配对码"
            placeholder="配对码"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value.toUpperCase())}
            className={`field w-full text-center ${value ? "font-mono tracking-[0.1em]" : ""}`}
          />
        )}
        <button type="submit" disabled={!value.trim()} aria-disabled={busy || undefined} className={`${BUTTON} ${busy ? "pointer-events-none" : ""}`}>
          {busy && <Spinner size="sm" color="current" aria-label="正在连接" className="size-3.5" />}
          继续
        </button>
        {error && (
          <p role="alert" className="m-0 text-subheadline text-danger-ink">
            {error}
          </p>
        )}
        <p className="login-more text-subheadline text-ink-muted">
          {!useToken && "手边没有连上的设备？"}
          <button type="button" onClick={toggle} className="text-ink underline underline-offset-3">
            {useToken ? "用配对码" : "用访问口令"}
          </button>
        </p>
      </form>
    </Shell>
  );
}
