import { Button, Input } from "@heroui/react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { desktop } from "./desktop";

/** 登录没成时，云端跳回首页带着的原因。读一次就从地址栏去掉。 */
function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const message = url.searchParams.get("sign_in_error");
  if (message === null) return null;
  url.searchParams.delete("sign_in_error");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return message;
}

/**
 * 这个浏览器还没有凭据，或者被吊销了。开了 Google 登录时用自己的 Google 账号登录（要在成员名单上）；
 * 也能填配对码（在已经连上的手机或浏览器的设置里生成），手边一台连上的都没有时用访问口令。
 */
export function Login() {
  const app = desktop();
  const [google, setGoogle] = useState(false);
  const [manual, setManual] = useState(false);
  const [useToken, setUseToken] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(takeSignInError);

  useEffect(() => {
    if (app) return;
    api.googleEnabled().then(setGoogle, () => setGoogle(false));
  }, [app]);

  async function submit() {
    const text = value.trim();
    if (!text) {
      setError(useToken ? "先填访问口令" : "先填配对码");
      return;
    }
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
      <div className="flex h-dvh flex-col items-center justify-center px-4">
        <div className="sky" />
        <div className="strong bubble relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-panel p-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold">这个窗口没连上 Pupu</h1>
            <p className="text-[15px] leading-6 text-muted">它的授权失效了，多半是在别的设备上吊销了。重新配对一次就好。</p>
          </div>
          <Button className="w-full" onPress={() => void app.repair()}>
            重新配对
          </Button>
        </div>
      </div>
    );
  }

  if (google && !manual) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center px-4">
        <div className="sky" />
        <div className="strong bubble relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-panel p-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold">连上 Pupu</h1>
            <p className="text-[15px] leading-6 text-muted">用你的 Google 账号登录，这个浏览器就连上了。</p>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button
            className="w-full"
            isPending={busy}
            onPress={() => {
              setBusy(true);
              window.location.assign("/api/auth/google/start?client=browser");
            }}
          >
            用 Google 登录
          </Button>
          <button
            type="button"
            onClick={() => {
              setManual(true);
              setError(null);
            }}
            className="text-sm text-muted"
          >
            用配对码或访问口令
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center px-4">
      <div className="sky" />
      <form
        className="strong bubble relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-panel p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold">连上 Pupu</h1>
          <p className="text-[15px] leading-6 text-muted">
            {useToken
              ? "访问口令只用这一次，换成这个浏览器自己的凭据，之后不用再填。"
              : "在已经连上的手机或浏览器上打开设置，点「生成配对码」，把码填在这里。"}
          </p>
        </div>
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
          />
        ) : (
          <Input
            key="code"
            aria-label="配对码"
            placeholder="比如 7K3M-Q9TX"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className="text-center font-mono text-lg tracking-widest"
            value={value}
            onChange={(event) => setValue(event.target.value.toUpperCase())}
          />
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" isPending={busy} className="w-full">
          连上
        </Button>
        <button type="button" onClick={toggle} className="text-sm text-muted">
          {useToken ? "用配对码" : "手边没有连上的设备？用访问口令"}
        </button>
        {google && (
          <button
            type="button"
            onClick={() => {
              setManual(false);
              setError(null);
            }}
            className="text-sm text-muted"
          >
            用 Google 登录
          </button>
        )}
      </form>
    </div>
  );
}
