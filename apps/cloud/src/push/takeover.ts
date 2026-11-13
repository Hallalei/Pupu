import type { PushSender } from "./approvals.ts";
import type { PushTokenRow } from "./store.ts";

/** 接手的提醒在 APNs 那里最多等十分钟：过了人多半已经看到电脑了，或者事情已经换了。 */
const TAKEOVER_TTL_S = 10 * 60;

/** 推给手机的那条：没有按钮，点开就是 Pupu。手机上没有 approvalId 的通知按普通通知处理。 */
export function takeoverAlert(computerName: string): object {
  return {
    aps: {
      alert: { title: "请在电脑上的 Pupu 里接手", body: `「${computerName}」上的 Pupu 浏览器要你登录或者确认一下。` },
      sound: "default",
      "interruption-level": "time-sensitive",
      "thread-id": "browser"
    }
  };
}

/**
 * browser_show 做成了：给这台电脑主人的手机推一条「请在电脑上的 Pupu 里接手」。一次调用推一次，collapse id 用调用 id。
 * 审批推送要对账（ApprovalPusher），这条不用：推出去就完了，没推到也不重试。
 */
export async function pushTakeover(input: {
  readonly apns: PushSender | null;
  readonly tokens: readonly PushTokenRow[];
  readonly to: (deviceId: string) => boolean;
  readonly requestId: string;
  readonly computerName: string;
  readonly now: number;
  readonly remove: (token: string) => void;
  readonly log: (message: string) => void;
}): Promise<number> {
  if (!input.apns) return 0;
  const apns = input.apns;
  const targets = input.tokens.filter((token) => input.to(token.deviceId));
  await Promise.all(
    targets.map(async (token) => {
      const result = await apns.send({
        token: token.token,
        env: token.env,
        type: "alert",
        priority: 10,
        collapseId: `takeover-${input.requestId}`.slice(0, 64),
        expiration: Math.floor(input.now / 1000) + TAKEOVER_TTL_S,
        payload: takeoverAlert(input.computerName)
      });
      if (result.gone) {
        input.remove(token.token);
        input.log(`APNs 说这个 token 用不了了（${result.status} ${result.reason}），已删掉`);
      } else if (result.status !== 200) {
        input.log(`APNs 没收这条推送：${result.status} ${result.reason ?? ""}`);
      }
    })
  );
  return targets.length;
}
