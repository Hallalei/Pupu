/**
 * 每家模板对应的 pi-ai 模型目录（见 catalog.ts）。只有云端引用：带着整份模型资料，别让桥引到。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";
import { MINIMAX_CN_MODELS } from "@earendil-works/pi-ai/providers/minimax-cn.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { NVIDIA_MODELS } from "@earendil-works/pi-ai/providers/nvidia.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import { TOGETHER_MODELS } from "@earendil-works/pi-ai/providers/together.models";
import { VERCEL_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models";
import { XIAOMI_MODELS } from "@earendil-works/pi-ai/providers/xiaomi.models";
import { ZAI_CODING_CN_MODELS } from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { isOwnApi, type Template } from "./catalog.ts";

const CATALOGS: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = {
  "deepseek": DEEPSEEK_MODELS,
  "moonshotai-cn": MOONSHOTAI_CN_MODELS,
  "kimi-coding": KIMI_CODING_MODELS,
  "zai-coding-cn": ZAI_CODING_CN_MODELS,
  "qwen-token-plan-cn": QWEN_TOKEN_PLAN_CN_MODELS,
  "minimax-cn": MINIMAX_CN_MODELS,
  "xiaomi": XIAOMI_MODELS,
  "xiaomi-token-plan-cn": XIAOMI_TOKEN_PLAN_CN_MODELS,
  "openai": OPENAI_MODELS,
  "anthropic": ANTHROPIC_MODELS,
  "google": GOOGLE_MODELS,
  "xai": XAI_MODELS,
  "openrouter": OPENROUTER_MODELS,
  "moonshotai": MOONSHOTAI_MODELS,
  "zai": ZAI_MODELS,
  "minimax": MINIMAX_MODELS,
  "mistral": MISTRAL_MODELS,
  "groq": GROQ_MODELS,
  "together": TOGETHER_MODELS,
  "fireworks": FIREWORKS_MODELS,
  "cerebras": CEREBRAS_MODELS,
  "nvidia": NVIDIA_MODELS,
  "huggingface": HUGGINGFACE_MODELS,
  "vercel-ai-gateway": VERCEL_AI_GATEWAY_MODELS,
};

/** 目录里的聊天模型。没有目录的模板是空的。 */
export function catalogModels(template: Template): Model<Api>[] {
  const catalog = CATALOGS[template.id];
  if (!catalog) return [];
  return Object.values(catalog).filter((model) => isOwnApi(model.api));
}

export function catalogModel(template: Template, id: string): Model<Api> | undefined {
  return catalogModels(template).find((model) => model.id === id);
}
