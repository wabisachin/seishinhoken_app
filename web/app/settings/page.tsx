"use client";

import { useEffect, useState } from "react";
import { MODEL_PRESETS, LlmSettings } from "@/lib/types";
import { loadLlmSettings, saveLlmSettings } from "@/lib/settings";

export default function SettingsPage() {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSettings(loadLlmSettings());
  }, []);

  if (!settings) return null;

  const key = `${settings.provider}:${settings.model}`;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">設定</h1>
      <div className="rounded-xl bg-white p-5 shadow">
        <h2 className="font-bold text-indigo-700">問題生成に使うLLM</h2>
        <p className="mt-1 text-sm text-slate-500">
          APIキーはサーバーの環境変数（ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY）で設定します。
        </p>
        <div className="mt-3 space-y-2">
          {MODEL_PRESETS.map((p) => {
            const pkey = `${p.provider}:${p.model}`;
            return (
              <label
                key={pkey}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
                  key === pkey ? "border-indigo-500 bg-indigo-50" : "border-slate-200"
                }`}
              >
                <input
                  type="radio"
                  checked={key === pkey}
                  onChange={() => {
                    const next = { provider: p.provider, model: p.model };
                    setSettings(next);
                    saveLlmSettings(next);
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1500);
                  }}
                />
                <span>{p.label}</span>
                <span className="ml-auto text-xs text-slate-400">{p.model}</span>
              </label>
            );
          })}
        </div>
        {saved && <p className="mt-3 text-sm text-green-600">保存しました</p>}
      </div>
    </div>
  );
}
