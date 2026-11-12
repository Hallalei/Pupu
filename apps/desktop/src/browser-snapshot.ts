/**
 * 把 CDP 的无障碍树（Accessibility.getFullAXTree）压成给模型看的快照：
 * 标题一行一个，正文按块合并，可操作的控件写成 `[编号] 角色 "名字"`，编号就是 backendDOMNodeId，点和输入都按它找。
 *
 * 角色表和「焦点包装层只有带名字才算控件」的规则取自 browser-use 的 browser_use/ax.py（MIT，Copyright (c) 2024 Gregor Zunic）；
 * 去空文本、不重复打印控件自己的文字，取自 ego-lite 的 docs/native-snapshot-ref-requirement.md（MIT）。
 */

import { SENSITIVE_NAME } from "./browser-frames.ts";

type AXValue = { readonly value?: unknown };

export type AXNode = {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly properties?: readonly { readonly name: string; readonly value: AXValue }[];
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
};

const CONTROLS = new Set(
  "button link textbox searchbox combobox listbox option checkbox radio switch slider spinbutton tab menuitem menuitemcheckbox menuitemradio treeitem".split(
    " "
  )
);
/** 这些里面的文字合成一行，跨过它们的不合。 */
const BLOCKS = new Set(["paragraph", "listitem", "row", "LabelText", "cell", "gridcell"]);
/** 快照最长这么多字，超了在末尾说一声。 */
export const SNAPSHOT_MAX_CHARS = 16_000;

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\s﻿]+/g, " ").trim();
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((item) => item.name === name)?.value.value;
}

function isField(role: string): boolean {
  return role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "combobox" || role === "generic";
}

function fold(value: string): string {
  return value.toLowerCase();
}

/** 敏感输入框（密码、验证码、卡号）填了什么不给模型看，只说填过了：画面上涂掉了，文字里也不能漏。 */
export const HIDDEN_VALUE = "（已填，不显示）";

/**
 * @param hidden 页面上认出来的敏感输入框（backendDOMNodeId）。取不到时按无障碍名字再认一遍，宁可多藏。
 */
export function renderSnapshot(nodes: readonly AXNode[], query?: string, hidden: ReadonlySet<number> = new Set()): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  const lines: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const line = buffer.join(" ").trim();
    buffer = [];
    if (line && lines.at(-1) !== line) lines.push(line);
  };

  const walk = (node: AXNode | undefined, inside: string) => {
    if (!node) return;
    const kids = node.childIds ?? [];
    const each = (within: string) => {
      for (const id of kids) walk(byId.get(id), within);
    };
    if (node.ignored) {
      each(inside);
      return;
    }
    const role = text(node.role?.value);
    const name = text(node.name?.value);
    if (role === "StaticText" || role === "InlineTextBox") {
      if (role === "StaticText" && name && !inside.includes(fold(name)) && buffer.at(-1) !== name) buffer.push(name);
      return;
    }
    if (role === "heading" && name) {
      flush();
      lines.push(`## ${name}`);
      each(fold(name));
      return;
    }
    const ref = node.backendDOMNodeId;
    const raw = text(node.value?.value);
    const secret = raw !== "" && ((ref !== undefined && hidden.has(ref)) || (isField(role) && SENSITIVE_NAME.test(name)));
    const value = secret ? HIDDEN_VALUE : raw;
    const focusable = prop(node, "focusable") === true && role !== "RootWebArea" && (name || value || prop(node, "editable"));
    if (ref && (CONTROLS.has(role) || focusable)) {
      flush();
      // 控件前面那行要是它自己的标签，就不重复了。
      if (name && lines.at(-1)?.toLowerCase() === name.toLowerCase()) lines.pop();
      lines.push(describe(node, ref, role, name, value));
      // 敏感框里面的文字（输入框的值有时挂在子节点上）一个字也不往下走。
      if (!secret) each(`${inside} ${fold(name)} ${fold(value)}`);
      flush();
      return;
    }
    if (BLOCKS.has(role)) {
      flush();
      each(inside);
      flush();
      return;
    }
    each(inside);
  };

  for (const root of roots) walk(root, "");
  flush();

  let picked = lines;
  if (query?.trim()) {
    const needle = fold(query.trim());
    picked = lines.filter((line) => fold(line).includes(needle));
    if (picked.length === 0) return `没有找到包含「${query.trim()}」的内容。`;
  }
  const output = picked.join("\n");
  return output.length > SNAPSHOT_MAX_CHARS
    ? `${output.slice(0, SNAPSHOT_MAX_CHARS)}\n…（快照太长截断了，用 query 只看一部分，或用 read 读全文）`
    : output;
}

function describe(node: AXNode, ref: number, role: string, name: string, value: string): string {
  const editable = role === "generic" && prop(node, "editable");
  const shown = editable ? "textbox" : role || "control";
  const states = [
    prop(node, "checked") === "true" || prop(node, "checked") === true ? "checked" : "",
    prop(node, "checked") === "false" || prop(node, "checked") === false ? "unchecked" : "",
    prop(node, "expanded") === true ? "expanded" : prop(node, "expanded") === false ? "collapsed" : "",
    prop(node, "selected") === true ? "selected" : "",
    prop(node, "disabled") === true ? "disabled" : "",
    prop(node, "focused") === true ? "focused" : ""
  ].filter(Boolean);
  return [
    `[${ref}] ${shown}`,
    name ? ` "${name.length > 80 ? `${name.slice(0, 80)}…` : name}"` : "",
    value && value !== name ? ` = "${value.length > 80 ? `${value.slice(0, 80)}…` : value}"` : "",
    states.length ? ` (${states.join(", ")})` : ""
  ].join("");
}
