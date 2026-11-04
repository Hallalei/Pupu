# pstack

来源：https://github.com/backnotprop/pstack，提交 ecec42a，版本 0.15.36，MIT 许可（见 `LICENSE`）。

这里的 `<pstack>` 是 `.claude/`。`skills/`、`agents/`、`docs/`、`README.md` 和 `LICENSE` 来自上游，本地只改了下面列出的地方。同步上游时重新应用这些改动。

按项目安装，所以和 `docs/harness/claude-code.md` 有两处不同：

- 命令不带前缀：用 `/poteto-mode`，不用 `/pstack:poteto-mode`。
- 子代理不带前缀：用 `poteto-agent`、`comment-sicko`。

用户级已有同名的 `tdd` 和 `teach`，直接输入时走用户级版本。要用 pstack 版本，读 `.claude/skills/tdd/SKILL.md` 或 `.claude/skills/teach/SKILL.md`。

## 本地改动

- 删了 `skills/make-bot-ui`，并去掉 `skills/poteto-help/SKILL.md` 里指向它的一行。`README.md` 和 `docs/guide/09-make-it-yours.md` 还提到它，不用管。
- `skills/poteto-mode/SKILL.md` 的 Harness 加了一条：`control-ui`、`control-cli` 指 `verify-pupu`。
- 没有复制 `automations/`，它依赖 Cursor Automations。

`skills/verify-pupu` 不是上游的，是这个项目用 `/create-verification-skill` 生成的。
