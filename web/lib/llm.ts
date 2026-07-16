import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { DEFAULT_LLM, LlmSettings } from "./types";

/** プロバイダ切替。APIキーは各SDKが環境変数から自動解決する。 */
export function getModel(settings?: Partial<LlmSettings>): LanguageModel {
  const provider = settings?.provider ?? DEFAULT_LLM.provider;
  const model = settings?.model ?? DEFAULT_LLM.model;
  switch (provider) {
    case "openai":
      return openai(model);
    case "google":
      return google(model);
    case "anthropic":
    default:
      return anthropic(model);
  }
}
