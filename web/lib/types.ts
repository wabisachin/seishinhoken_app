export type Mode = "subject" | "mock" | "review" | "garden";

export type Citation = {
  chunk_id: number;
  book: string;
  page_start: number;
  page_end: number;
  excerpt: string;
  // このチャンクが根拠になっている選択肢番号（1始まり）。旧データには無いためoptional。
  supports?: number[];
  // 選択肢番号ごとの、excerpt内の該当箇所の一字一句引用（表示側で太字強調するために使う）。
  // quoteが実際のexcerptに存在しない場合は強調せずそのまま表示する
  quotes?: { option: number; quote: string }[];
};

export type Question = {
  id: number;
  subject: string;
  taxonomy_id: number | null;
  question_type: "single" | "multi";
  stem: string;
  case_text: string | null;
  options: string[];
  correct: number[]; // 1始まり
  explanations: string[];
  key_points: string | null;
  citations: Citation[] | null;
};

export type LlmSettings = {
  provider: "anthropic" | "openai" | "google";
  model: string;
};

export const DEFAULT_LLM: LlmSettings = {
  provider: "openai",
  model: "gpt-5.6-luna",
};

export const MODEL_PRESETS: { provider: LlmSettings["provider"]; model: string; label: string }[] = [
  { provider: "anthropic", model: "claude-opus-4-8", label: "Claude Opus 4.8（最高品質・推奨）" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6（バランス）" },
  { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5（低コスト）" },
  { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna（推奨・現行より低コスト）" },
  { provider: "openai", model: "gpt-5.4-nano", label: "GPT-5.4 nano（スピード最優先）" },
  { provider: "openai", model: "gpt-4.1-nano", label: "GPT-4.1 nano（低レイテンシ）" },
  { provider: "openai", model: "gpt-4o", label: "GPT-4o" },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini" },
  { provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];
