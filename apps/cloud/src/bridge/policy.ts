import type { Action } from "./protocol.ts";

/**
 * 电脑上一个动作的风险，以及要不要先问人。云端按它决定请示，本机桥按它再判一次。
 *
 * 规则是启发式的，宁可多问一次：`python -c`、`node -e` 这类什么都能做的解释器不拦，
 * 靠分级和本机开关兜底。部分规则（命令包装器、凭据路径、chmod 放权、数据流向）参考
 * Cindy 的 packages/maker-core/src/agents/shared/auto-review.ts 和
 * sensitive-credential-paths.ts（Apache-2.0，Copyright 2026 XD Inc.）。
 */

export type Risk =
  | { readonly level: "low" }
  | { readonly level: "high"; readonly reason: string };

/**
 * 每台电脑一个分级。
 * - ask_risky：高风险的才问，屏幕按电脑批一次（默认）；
 * - ask_all：跑命令、写文件、写输入、点屏幕，每一步都问；
 * - trust：都放行。
 */
export type ComputerPolicy = "ask_risky" | "ask_all" | "trust";

export const DEFAULT_POLICY: ComputerPolicy = "ask_risky";

export function isComputerPolicy(value: unknown): value is ComputerPolicy {
  return value === "ask_risky" || value === "ask_all" || value === "trust";
}

/** 批准一次屏幕授权后，这么久没有屏幕操作就失效。 */
export const SCREEN_GRANT_IDLE_MS = 15 * 60_000;

const LOW: Risk = { level: "low" };

function high(reason: string): Risk {
  return { level: "high", reason };
}

// ---- 命令 ----

type Frame = "top" | "paren" | "tick" | "single" | "double";

/**
 * 把命令切成段，每段是去掉引号之后的一串词。认 `; & | 换行 ( ) { }`、`$(`、反引号；
 * 双引号里的 `$(` 和反引号照样切出来，因为 shell 会执行它们。`${VAR}` 留在词里。
 */
export function splitCommand(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const stack: Frame[] = ["top"];

  const endWord = () => {
    if (!inWord) return;
    words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  /** `${...}` 原样留在词里，返回它最后一个字符的位置。 */
  const takeBraced = (start: number): number => {
    const close = command.indexOf("}", start);
    const end = close === -1 ? command.length - 1 : close;
    word += command.slice(start, end + 1);
    inWord = true;
    return end;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    const frame = stack[stack.length - 1]!;

    if (frame === "single") {
      if (char === "'") stack.pop();
      else word += char;
      continue;
    }

    if (frame === "double") {
      if (char === "\\" && next !== undefined) {
        word += next;
        index += 1;
      } else if (char === '"') {
        stack.pop();
      } else if (char === "`") {
        endSegment();
        stack.push("tick");
      } else if (char === "$" && next === "(") {
        endSegment();
        stack.push("paren");
        index += 1;
      } else if (char === "$" && next === "{") {
        index = takeBraced(index);
      } else {
        word += char;
      }
      continue;
    }

    // 命令位置：top、paren、tick。
    if (char === "\\") {
      if (next !== undefined && next !== "\n") {
        word += next;
        inWord = true;
      }
      index += 1;
    } else if (char === "'") {
      stack.push("single");
      inWord = true;
    } else if (char === '"') {
      stack.push("double");
      inWord = true;
    } else if (char === "`") {
      endSegment();
      if (frame === "tick") stack.pop();
      else stack.push("tick");
    } else if (char === "$" && next === "(") {
      endSegment();
      stack.push("paren");
      index += 1;
    } else if (char === "$" && next === "{") {
      index = takeBraced(index);
    } else if (char === "(") {
      endSegment();
      stack.push("paren");
    } else if (char === ")") {
      endSegment();
      if (frame === "paren") stack.pop();
    } else if (";&|\n{}".includes(char)) {
      endSegment();
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
    } else if (char === "#" && !inWord) {
      const end = command.indexOf("\n", index);
      index = end === -1 ? command.length : end - 1;
    } else {
      word += char;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

/** 整条命令扫一遍的规则：管道把下载的脚本交给 shell、凭据路径、密钥变量。 */
const WHOLE_COMMAND_RULES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:curl|wget)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/, "下载脚本直接执行"],
  // `| python3 -m json.tool` 只是排版，不算；裸的 `| python3` 才是执行下载的脚本。
  [/\b(?:curl|wget)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby)\s*-?\s*(?:$|[;&|)])/, "下载脚本直接执行"],
  [/\b(?:sh|bash|zsh|source|\.)\s+(?:-\S+\s+)*["']?(?:<\(|\$\()\s*(?:curl|wget)\b/, "下载脚本直接执行"],
  [/:\s*\(\s*\)\s*\{.*\|.*&.*\}/, "fork 炸弹"],
  [/(?:^|[\\/\s'"~=])\.(?:ssh|aws|gnupg|kube|docker|pupu)(?=[\\/\s'"]|$)/i, "碰凭据目录"],
  [/(?:^|[\\/\s'"~=])\.(?:netrc|npmrc|pgpass|pypirc|git-credentials)(?=[\s'"]|$)/i, "碰登录凭据"],
  [/\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/, "碰 SSH 私钥"],
  [/[\\/]\.config[\\/](?:gh|hub|glab|op|gcloud)(?=[\\/\s'"]|$)/i, "碰命令行工具的登录凭据"],
  [/\bKeychains\b/, "碰钥匙串"],
  [/(?:^|[\\/\s'"=])\.env(?:\.(?!(?:example|sample|template|dist)\b)[\w-]+)?(?=[\s'";|&)]|$)/, "碰 .env，里面通常是密钥"],
  [/\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?[A-Z0-9_]*\}?/, "读取密钥变量"]
];

/** 会执行后面命令的包装器。跳过它和它的选项，按后面的命令判。sudo 不在这里，它本身就危险。 */
const WRAPPERS = new Set([
  "env",
  "nohup",
  "nice",
  "time",
  "timeout",
  "gtimeout",
  "command",
  "builtin",
  "exec",
  "stdbuf",
  "caffeinate",
  "arch",
  "watch",
  "unbuffer"
]);

/** 包装器里带一个参数的选项。 */
const WRAPPER_OPTIONS_WITH_VALUE: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  gtimeout: ["-s", "--signal", "-k", "--kill-after"],
  stdbuf: ["-i", "-o", "-e"],
  caffeinate: ["-t", "-w"],
  watch: ["-n", "--interval", "-d"]
};

/** 只看命令名就算高风险的。 */
const ALWAYS_HIGH: Readonly<Record<string, string>> = {
  sudo: "提权",
  doas: "提权",
  su: "提权",
  runuser: "提权",
  chroot: "提权",
  rm: "删除文件",
  rmdir: "删除目录",
  unlink: "删除文件",
  shred: "删除文件",
  srm: "删除文件",
  truncate: "清空文件",
  kill: "结束进程",
  killall: "结束进程",
  pkill: "结束进程",
  shutdown: "关机或重启",
  reboot: "关机或重启",
  halt: "关机或重启",
  poweroff: "关机或重启",
  osascript: "AppleScript 能操作别的应用、发消息",
  security: "碰钥匙串",
  dd: "直接写磁盘",
  fdisk: "改磁盘分区",
  csrutil: "改系统安全设置",
  spctl: "改系统安全设置",
  nvram: "改系统设置",
  dscl: "改系统账户",
  sysadminctl: "改系统账户",
  passwd: "改密码",
  twine: "发布包"
};

/** 会写目标路径的命令：参数里出现系统目录就算高风险。 */
const PATH_WRITERS = new Set(["cp", "mv", "ln", "install", "tee", "touch", "mkdir", "ditto", "rsync", "chmod", "chown", "chgrp"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

const MAX_DEPTH = 6;

/** 判一条命令。home 是这台电脑的主目录，用来认出改主目录配置的重定向。 */
export function classifyCommand(command: string, home?: string): Risk {
  return classifyText(command, home, 0);
}

function classifyText(command: string, home: string | undefined, depth: number): Risk {
  if (depth > MAX_DEPTH) return high("命令嵌套太深，看不清");
  for (const [pattern, reason] of WHOLE_COMMAND_RULES) {
    if (pattern.test(command)) return high(reason);
  }
  for (const segment of splitCommand(command)) {
    const risk = classifySegment(segment, home, depth);
    if (risk.level === "high") return risk;
  }
  return LOW;
}

function classifySegment(input: readonly string[], home: string | undefined, depth: number): Risk {
  if (depth > MAX_DEPTH) return high("命令嵌套太深，看不清");
  const redirect = redirectRisk(input, home);
  if (redirect.level === "high") return redirect;

  let words = input.slice();
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  if (words.length === 0) return LOW;
  const head = commandName(words[0]!);
  const args = words.slice(1);

  if (WRAPPERS.has(head)) {
    const rest = skipOptions(args, WRAPPER_OPTIONS_WITH_VALUE[head] ?? []);
    // timeout 后面先是时长，再是命令。
    const inner = head === "timeout" || head === "gtimeout" ? rest.slice(1) : rest;
    if (inner.length === 0) {
      return head === "env" ? high("会输出全部环境变量，里面可能有密钥") : LOW;
    }
    return classifySegment(inner, home, depth + 1);
  }
  if (head === "printenv") return high("会输出环境变量，里面可能有密钥");

  if (SHELLS.has(head)) {
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag === -1) return LOW;
    const script = args[flag + 1];
    return script === undefined ? LOW : classifyText(script, home, depth + 1);
  }
  if (head === "eval") return classifyText(args.join(" "), home, depth + 1);
  if (head === "xargs") {
    const rest = skipOptions(args, ["-I", "-J", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-R", "-S"]);
    return rest.length === 0 ? LOW : classifySegment(rest, home, depth + 1);
  }
  if (head === "ssh") {
    const rest = skipOptions(args, ["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
    const remote = rest.slice(1);
    return remote.length === 0 ? LOW : classifyText(remote.join(" "), home, depth + 1);
  }
  if (head === "npx" || head === "pnpx" || head === "bunx") {
    const call = args.indexOf("-c");
    if (call !== -1 && args[call + 1] !== undefined) return classifyText(args[call + 1]!, home, depth + 1);
    const rest = skipOptions(args, ["-p", "--package"]);
    return rest.length === 0 ? LOW : classifySegment(rest, home, depth + 1);
  }

  const always = ALWAYS_HIGH[head];
  if (always) return high(always);
  if (head.startsWith("mkfs") || head.startsWith("newfs")) return high("格式化磁盘");

  const specific = commandRisk(head, args, home, depth);
  if (specific.level === "high") return specific;

  const writes = PATH_WRITERS.has(head) || (head === "sed" && args.some((arg) => arg.startsWith("-i") || arg === "--in-place"));
  if (writes) {
    if (args.some((arg) => isSystemPath(arg))) return high("改系统目录");
    for (const arg of args) {
      const relative = arg.startsWith("-") ? null : homeRelative(arg, home);
      const reason = relative === null ? null : sensitiveWriteReason(relative);
      if (reason) return high(reason);
    }
  }
  return LOW;
}

function commandRisk(head: string, args: readonly string[], home: string | undefined, depth: number): Risk {
  switch (head) {
    case "find": {
      if (args.includes("-delete")) return high("find -delete 批量删除");
      for (const flag of ["-exec", "-execdir", "-ok", "-okdir"]) {
        const at = args.indexOf(flag);
        if (at === -1) continue;
        const rest = args.slice(at + 1);
        const end = rest.findIndex((arg) => arg === ";" || arg === "+");
        const inner = classifySegment(end === -1 ? rest : rest.slice(0, end), home, depth + 1);
        if (inner.level === "high") return inner;
      }
      return LOW;
    }
    case "git":
      return gitRisk(args);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packageRisk(head, args, home, depth);
    case "wrangler": {
      const words = new Set(args);
      if (["deploy", "publish", "delete", "secret", "rollback"].some((word) => words.has(word))) {
        return high("部署或改线上 Worker");
      }
      if (words.has("execute") && words.has("--remote")) return high("改线上数据库");
      if (words.has("put") && !words.has("--local")) return high("改线上存储");
      return LOW;
    }
    case "vercel": {
      const sub = firstPlain(args);
      const safe = ["dev", "login", "logout", "logs", "ls", "list", "inspect", "whoami", "pull", "link", "help", "build", "init", "switch"];
      if (args.includes("--version") || args.includes("--help") || args.includes("-h")) return LOW;
      return sub !== undefined && safe.includes(sub) ? LOW : high("部署（vercel）");
    }
    case "netlify":
    case "firebase":
    case "fly":
    case "flyctl":
      return args.some((arg) => /deploy|destroy|delete|disable/.test(arg) || arg === "secrets")
        ? high("部署或删除线上服务")
        : LOW;
    case "gh":
      return ghRisk(args);
    case "kubectl":
    case "oc":
      return ["apply", "delete", "replace", "patch", "scale", "drain", "cordon", "edit", "create", "set", "label", "annotate", "taint", "rollout"].includes(firstPlain(args) ?? "")
        ? high("改集群")
        : LOW;
    case "helm":
      return ["install", "upgrade", "uninstall", "delete", "rollback"].includes(firstPlain(args) ?? "")
        ? high("改集群")
        : LOW;
    case "terraform":
    case "tofu":
      return ["apply", "destroy", "import", "taint", "untaint"].includes(firstPlain(args) ?? "") ||
        (firstPlain(args) === "state" && args.some((arg) => arg === "rm" || arg === "mv" || arg === "push"))
        ? high("改云资源")
        : LOW;
    case "pulumi":
      return ["up", "update", "destroy", "import"].includes(firstPlain(args) ?? "") ? high("改云资源") : LOW;
    case "docker":
    case "podman": {
      const sub = firstPlain(args);
      if (sub === "push") return high("推送镜像");
      if (sub === "rm" || sub === "rmi" || sub === "kill" || args.includes("prune")) return high("删除容器或镜像");
      if ((sub === "volume" || sub === "network" || sub === "image" || sub === "container") && args.includes("rm")) {
        return high("删除容器或镜像");
      }
      if (sub === "compose" && args.includes("down") && (args.includes("-v") || args.includes("--volumes"))) {
        return high("删除数据卷");
      }
      return LOW;
    }
    case "cargo":
      return ["publish", "yank", "owner"].includes(firstPlain(args) ?? "") ? high("发布包") : LOW;
    case "gem":
      return ["push", "yank"].includes(firstPlain(args) ?? "") ? high("发布包") : LOW;
    case "pod":
      return args[0] === "trunk" && (args.includes("push") || args.includes("delete")) ? high("发布包") : LOW;
    case "poetry":
    case "uv":
    case "hatch":
    case "flit":
      return firstPlain(args) === "publish" ? high("发布包") : LOW;
    case "aws":
      return args.some((arg) => /^(?:delete|terminate|remove)-/.test(arg) || arg === "rm" || arg === "rb" || arg === "--delete")
        ? high("删除云资源")
        : LOW;
    case "gcloud":
    case "az":
      return args.includes("delete") ? high("删除云资源") : LOW;
    case "rsync":
      return args.some((arg) => arg.startsWith("--delete") || arg === "--remove-source-files")
        ? high("同步时删除文件")
        : LOW;
    case "tmutil":
      return ["delete", "deletelocalsnapshots", "disable"].includes(firstPlain(args) ?? "") ? high("删除备份") : LOW;
    case "chmod": {
      if (args.some((arg) => arg === "-R" || arg === "--recursive" || /^-[A-Za-z]*R/.test(arg))) return high("批量改权限");
      if (args.some((arg) => /^[0-7]*7{2,3}$/.test(arg) || /^[ugoa]*[oa][ugoa]*[-+=][rwxXst]*w/.test(arg))) {
        return high("放开文件权限");
      }
      return LOW;
    }
    case "chown":
    case "chgrp":
      return args.some((arg) => arg === "-R" || /^-[A-Za-z]*R/.test(arg)) ? high("批量改文件所有者") : LOW;
    case "crontab":
      return args.length > 0 && args.every((arg) => arg === "-l" || arg.startsWith("-u")) ? LOW : high("改定时任务");
    case "launchctl":
      return ["list", "print", "print-disabled", "blame", "help", "version", "procinfo"].includes(args[0] ?? "")
        ? LOW
        : high("改开机启动项");
    case "defaults":
      return ["write", "delete", "import", "rename"].includes(firstPlain(args) ?? "") ? high("改系统或应用设置") : LOW;
    case "diskutil": {
      const sub = firstPlain(args);
      if (sub === "list" || sub === "info" || sub === "activity") return LOW;
      if (sub === "apfs" && (args.includes("list") || args.includes("info"))) return LOW;
      return high("改磁盘");
    }
    case "pmset":
      return args.length > 0 && args.every((arg) => arg.startsWith("-g") || !arg.startsWith("-")) && args[0]!.startsWith("-g")
        ? LOW
        : high("改电源设置");
    case "networksetup":
      return args.some((arg) => /^-(?:set|remove|delete|add|create|disconnect)/.test(arg)) ? high("改网络设置") : LOW;
    case "scutil":
      return args.includes("--set") ? high("改系统设置") : LOW;
    case "systemsetup":
      return args.length > 0 && args.every((arg) => !arg.startsWith("-") || arg.startsWith("-get")) ? LOW : high("改系统设置");
    default:
      return LOW;
  }
}

function gitRisk(args: readonly string[]): Risk {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    const option = args[index]!;
    index += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(option) ? 2 : 1;
  }
  const sub = args[index];
  const rest = args.slice(index + 1);
  switch (sub) {
    case "push":
      return high("推送代码");
    case "reset":
      return rest.includes("--hard") || rest.includes("--merge") || rest.includes("--keep")
        ? high("丢掉本地改动（git reset --hard）")
        : LOW;
    case "clean":
      return rest.some((arg) => arg === "--force" || /^-[A-Za-z]*f/.test(arg)) ? high("删除没跟踪的文件（git clean）") : LOW;
    case "branch":
      return rest.includes("-D") || (rest.includes("--delete") && (rest.includes("--force") || rest.includes("-f")))
        ? high("强制删分支")
        : LOW;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? high("丢掉暂存的改动") : LOW;
    case "checkout":
      return rest.includes("--") || rest.includes(".") || rest.includes("-f") || rest.includes("--force")
        ? high("丢掉本地改动（git checkout）")
        : LOW;
    case "restore":
      return rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W")
        ? LOW
        : high("丢掉本地改动（git restore）");
    case "filter-branch":
    case "filter-repo":
      return high("改写提交历史");
    default:
      return LOW;
  }
}

const RELEASE_SCRIPT = /deploy|publish|release/i;

function packageRisk(head: string, args: readonly string[], home: string | undefined, depth: number): Risk {
  const withValue = ["--prefix", "-C", "--dir", "--cwd", "--filter", "-F", "--workspace"];
  if (head === "npm") withValue.push("-w");
  const rest = skipOptions(args, withValue);
  const sub = rest[0];
  if (sub === undefined) return LOW;
  if (["publish", "unpublish", "deprecate"].includes(sub)) return high("发布包");
  if (sub === "run" || sub === "run-script") {
    const script = firstPlain(rest.slice(1));
    return script !== undefined && RELEASE_SCRIPT.test(script) ? high(`跑 ${script} 脚本（部署或发布）`) : LOW;
  }
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    const inner = skipOptions(rest.slice(1), ["-p", "--package", "-c"]);
    return inner.length === 0 ? LOW : classifySegment(inner, home, depth + 1);
  }
  // yarn、pnpm、bun 直接跟脚本名。
  if (head !== "npm" && RELEASE_SCRIPT.test(sub)) return high(`跑 ${sub} 脚本（部署或发布）`);
  return LOW;
}

function ghRisk(args: readonly string[]): Risk {
  const [sub, act] = args;
  const has = (...words: string[]) => act !== undefined && words.includes(act);
  switch (sub) {
    case "release":
      return has("create", "delete", "upload", "edit", "delete-asset") ? high("发 Release") : LOW;
    case "pr":
      return has("merge", "close", "create", "comment", "review", "edit", "ready", "reopen") ? high("改 PR") : LOW;
    case "issue":
      return has("create", "close", "delete", "comment", "edit", "transfer", "lock", "reopen") ? high("改 Issue") : LOW;
    case "repo":
      return has("delete", "archive", "rename", "edit", "create", "unarchive") ? high("改仓库") : LOW;
    case "secret":
    case "variable":
      return has("set", "delete", "remove") ? high("改仓库密钥") : LOW;
    case "workflow":
      return has("run", "enable", "disable") ? high("跑或改 CI") : LOW;
    case "run":
      return has("rerun", "cancel", "delete") ? high("改 CI 运行") : LOW;
    case "gist":
      return has("create", "delete", "edit") ? high("发 Gist") : LOW;
    case "ssh-key":
    case "gpg-key":
      return has("add", "delete") ? high("改账号密钥") : LOW;
    case "auth":
      return act === "token" || args.includes("--show-token") ? high("读 GitHub 令牌") : LOW;
    case "api": {
      const method = valueAfter(args, ["-X", "--method"]);
      if (method !== undefined && method.toUpperCase() !== "GET") return high("调用 GitHub 接口改东西");
      if (args.some((arg) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(arg))) {
        return high("调用 GitHub 接口改东西");
      }
      return LOW;
    }
    default:
      return LOW;
  }
}

/** 重定向写到系统目录，或者写主目录里的配置和凭据。 */
function redirectRisk(words: readonly string[], home: string | undefined): Risk {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const match = /^(?:\d*|&)>>?\|?(.*)$/.exec(word);
    if (!match) continue;
    const target = match[1] ? match[1] : words[index + 1];
    if (!target || target.startsWith("&")) continue;
    if (isSystemPath(target)) return high("写系统目录");
    const relative = homeRelative(target, home);
    if (relative !== null) {
      const reason = sensitiveWriteReason(relative);
      if (reason) return high(reason);
    }
  }
  return LOW;
}

function commandName(word: string): string {
  const base = word.slice(word.lastIndexOf("/") + 1);
  // macOS 默认的文件系统不分大小写，`RM` 也是 rm。
  return base.toLowerCase();
}

/** 跳过开头的选项；withValue 里的选项连同它后面的值一起跳过。 */
function skipOptions(args: readonly string[], withValue: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    index += withValue.includes(arg) ? 2 : 1;
  }
  return args.slice(index);
}

function firstPlain(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function valueAfter(args: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (names.includes(arg)) return args[index + 1];
    for (const name of names) {
      if (name.startsWith("--") && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      if (!name.startsWith("--") && arg.startsWith(name) && arg.length > name.length) return arg.slice(name.length);
    }
  }
  return undefined;
}

// ---- 路径 ----

const SAFE_DEVICES = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+|random|urandom)$/;

/** 系统目录。/usr/local 和 /opt 是 Homebrew 这类的地盘，不算。 */
export function isSystemPath(raw: string): boolean {
  if (!raw.startsWith("/")) return false;
  const path = normalize(raw);
  if (path === null) return false;
  if (path.startsWith("/dev/")) return !SAFE_DEVICES.test(path);
  if (/^\/usr\/local(?:\/|$)/.test(path)) return false;
  return /^\/(?:etc|private\/etc|usr|bin|sbin|System|Library|private\/var\/db|var\/db|var\/root|boot|root)(?:\/|$)/i.test(path);
}

/** 把路径换成相对主目录的样子，比如 `.ssh/id_rsa`。在主目录外面的返回 null。 */
export function homeRelative(raw: string, home?: string): string | null {
  let path = raw.trim();
  if (path === "~" || path === "$HOME" || path === "${HOME}") return "";
  for (const prefix of ["~/", "$HOME/", "${HOME}/"]) {
    if (path.startsWith(prefix)) {
      path = path.slice(prefix.length);
      return normalizeRelative(path);
    }
  }
  if (path.startsWith("/")) {
    if (!home) return null;
    const root = home.replace(/\/+$/, "");
    if (path === root) return "";
    if (!path.startsWith(`${root}/`)) return null;
    return normalizeRelative(path.slice(root.length + 1));
  }
  if (path.startsWith("~")) return null;
  return normalizeRelative(path);
}

function normalize(path: string): string | null {
  const relative = normalizeRelative(path.replace(/^\/+/, ""));
  return relative === null ? null : `/${relative}`;
}

function normalizeRelative(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

const SENSITIVE_DIRS: readonly (readonly [string, string])[] = [
  [".ssh", "改 SSH 配置或密钥"],
  [".aws", "改 AWS 凭据"],
  [".gnupg", "改 GPG 密钥"],
  [".config/gh", "改 GitHub 登录"],
  [".kube", "改集群凭据"],
  [".docker", "改 Docker 凭据"],
  ["Library/LaunchAgents", "改开机启动项"],
  ["Library/Keychains", "改钥匙串"],
  [".pupu", "改 Pupu 桥的凭据和开关"]
];

function inside(relative: string, dir: string): boolean {
  return relative === dir || relative.startsWith(`${dir}/`);
}

/** 写这个路径要不要先问。参数是相对主目录的路径。 */
export function sensitiveWriteReason(relative: string): string | null {
  if (relative === "") return null;
  for (const [dir, reason] of SENSITIVE_DIRS) {
    if (inside(relative, dir)) return reason;
  }
  if (!relative.includes("/") && relative.startsWith(".")) return "改主目录里的配置文件";
  return null;
}

/** 读这个路径要不要先问。参数是相对主目录的路径。 */
export function sensitiveReadReason(relative: string): string | null {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  if (inside(relative, ".ssh")) {
    if (name.endsWith(".pub") || name === "known_hosts" || name === "config" || name === "authorized_keys" || relative === ".ssh") {
      return null;
    }
    return "读 SSH 私钥";
  }
  if (inside(relative, ".aws")) return name === "config" || relative === ".aws" ? null : "读 AWS 凭据";
  if (inside(relative, ".gnupg") && relative !== ".gnupg") return "读 GPG 密钥";
  if (inside(relative, "Library/Keychains")) return "读钥匙串";
  if (inside(relative, ".pupu") && relative !== ".pupu") return "读 Pupu 桥的凭据";
  if (relative === ".config/gh/hosts.yml" || relative === ".docker/config.json" || relative === ".kube/config") {
    return "读命令行工具的登录凭据";
  }
  if ([".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pgpass"].includes(name)) return "读登录凭据";
  if (/^\.env(?:\.[\w-]+)?$/.test(name) && !/^\.env\.(?:example|sample|template|dist)$/.test(name)) {
    return "读 .env，里面通常是密钥";
  }
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name)) return "读私钥";
  return null;
}

// ---- 动作 ----

/** 判一个要在电脑上做的动作。 */
export function classifyAction(action: Action, home?: string): Risk {
  switch (action.kind) {
    case "run":
      return classifyCommand(action.command, home);
    case "write": {
      const relative = homeRelative(action.path, home);
      const reason = relative === null ? null : sensitiveWriteReason(relative);
      return reason ? high(reason) : LOW;
    }
    case "read": {
      const relative = homeRelative(action.path, home);
      const reason = relative === null ? null : sensitiveReadReason(relative);
      return reason ? high(reason) : LOW;
    }
    case "computer":
      return isScreenInput(action) && action.sensitive === true ? high("这一步会发消息、付款、提交或删除") : LOW;
    default:
      return LOW;
  }
}

/** 点、拖、滚动、打字、按键。截图和查权限不算。 */
export function isScreenInput(action: Action): boolean {
  return action.kind === "computer" && action.op !== "screenshot" && action.op !== "permissions";
}

/** 截图或者屏幕输入，都要有屏幕授权。 */
export function usesScreen(action: Action): boolean {
  return action.kind === "computer" && action.op !== "permissions";
}

/**
 * 按分级决定这个动作要不要先问。
 * - none：直接做；
 * - screen：要先批屏幕授权，批了之后这台电脑一段时间内不再问；
 * - step：这一步单独问。屏幕输入的这一步批了，也同时开了屏幕授权。
 */
export function needFor(
  policy: ComputerPolicy,
  action: Action,
  options: { readonly home?: string; readonly screenGranted: boolean }
): { readonly need: "none" | "screen" | "step"; readonly risk: Risk } {
  const risk = classifyAction(action, options.home);
  if (policy === "trust") return { need: "none", risk };
  if (action.kind === "computer") {
    if (action.op === "permissions") return { need: "none", risk };
    if (action.op !== "screenshot" && (policy === "ask_all" || risk.level === "high")) return { need: "step", risk };
    return { need: options.screenGranted ? "none" : "screen", risk };
  }
  if (risk.level === "high") return { need: "step", risk };
  if (policy === "ask_all" && (action.kind === "run" || action.kind === "write" || action.kind === "stdin")) {
    return { need: "step", risk };
  }
  return { need: "none", risk };
}

/** 审批卡片上的标题和详情。 */
export function describeAction(action: Action): { readonly title: string; readonly detail: string } {
  switch (action.kind) {
    case "run":
      return { title: "跑命令", detail: clip(action.command, 2000) };
    case "stdin":
      return { title: "往正在跑的命令里输入", detail: clip(action.data, 1000) };
    case "write":
      return { title: "写文件", detail: `${action.path}（${action.content.length} 个字）` };
    case "read":
      return { title: "读文件", detail: action.path };
    case "list":
      return { title: "列目录", detail: action.path || "主目录" };
    case "computer":
      switch (action.op) {
        case "click":
          return { title: action.count === 2 ? "双击屏幕" : "点击屏幕", detail: `截图上的 (${action.x}, ${action.y})` };
        case "move":
          return { title: "移动鼠标", detail: `截图上的 (${action.x}, ${action.y})` };
        case "drag":
          return { title: "拖动", detail: `从 (${action.x}, ${action.y}) 到 (${action.x2}, ${action.y2})` };
        case "scroll":
          return { title: "滚动", detail: `在 (${action.x}, ${action.y}) 滚动 ${action.delta}` };
        case "type":
          return { title: "输入文字", detail: clip(action.text ?? "", 1000) };
        case "key":
          return { title: "按键", detail: action.key ?? "" };
        default:
          return { title: "操作屏幕", detail: "看这台电脑的屏幕，用鼠标和键盘操作它。" };
      }
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
