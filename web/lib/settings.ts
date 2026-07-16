import { DEFAULT_LLM, LlmSettings } from "./types";

/** クライアント側: localStorageからLLM設定を読む */
export function loadLlmSettings(): LlmSettings {
  if (typeof window === "undefined") return DEFAULT_LLM;
  try {
    const raw = localStorage.getItem("llm_settings");
    return raw ? { ...DEFAULT_LLM, ...JSON.parse(raw) } : DEFAULT_LLM;
  } catch {
    return DEFAULT_LLM;
  }
}

export function saveLlmSettings(settings: LlmSettings) {
  localStorage.setItem("llm_settings", JSON.stringify(settings));
}
