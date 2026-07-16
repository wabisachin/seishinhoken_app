"use client";

import { useEffect, useState } from "react";
import type { LlmSettings } from "@/lib/types";

type Preset = { provider: LlmSettings["provider"]; model: string; label: string };

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/status")
      .then((r) => r.json())
      .then((d) => setAuthed(!!d.authenticated));
  }, []);

  useEffect(() => {
    if (authed) loadSettings();
  }, [authed]);

  function loadSettings() {
    fetch("/api/admin/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.settings) setSettings(d.settings);
        if (d.presets) setPresets(d.presets);
      });
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const d = await res.json();
      setLoginError(d.error ?? "ログインに失敗しました");
      return;
    }
    setAuthed(true);
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setAuthed(false);
  }

  async function saveModel(p: Preset) {
    setSaveMsg(null);
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: p.provider, model: p.model }),
    });
    if (res.ok) {
      setSettings({ provider: p.provider, model: p.model });
      setSaveMsg("保存しました");
      setTimeout(() => setSaveMsg(null), 1500);
    } else {
      const d = await res.json();
      setSaveMsg(`エラー: ${d.error}`);
    }
  }

  async function runReset() {
    setResetMsg("実行中...");
    const res = await fetch("/api/admin/reset", { method: "POST" });
    const d = await res.json();
    setResetMsg(res.ok ? "リセットしました（生成問題・解答履歴を削除）" : `エラー: ${d.error}`);
    setResetConfirm(false);
  }

  if (authed === null) return <div className="p-6 text-sm text-slate-500">確認中...</div>;

  if (!authed) {
    return (
      <div className="mx-auto mt-24 max-w-sm space-y-4 px-4">
        <h1 className="text-lg font-bold text-slate-800">管理者ログイン</h1>
        <form onSubmit={login} className="space-y-3 rounded-xl bg-white p-5 shadow">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="パスワード"
            className="w-full rounded border border-slate-300 p-2"
            autoFocus
          />
          {loginError && <p className="text-sm text-red-600">{loginError}</p>}
          <button type="submit" className="w-full rounded bg-slate-800 px-4 py-2 text-white hover:bg-slate-900">
            ログイン
          </button>
        </form>
      </div>
    );
  }

  const key = settings ? `${settings.provider}:${settings.model}` : "";

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">管理者設定</h1>
        <button onClick={logout} className="text-sm text-slate-500 hover:underline">
          ログアウト
        </button>
      </div>

      <section className="rounded-xl bg-white p-5 shadow">
        <h2 className="font-bold text-slate-700">問題生成に使うLLM</h2>
        <p className="mt-1 text-sm text-slate-500">ここで選んだモデルだけが問題生成に使われます（利用者側からは変更できません）。</p>
        <div className="mt-3 space-y-2">
          {presets.map((p) => {
            const pkey = `${p.provider}:${p.model}`;
            return (
              <label
                key={pkey}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
                  key === pkey ? "border-slate-500 bg-slate-100" : "border-slate-200"
                }`}
              >
                <input type="radio" checked={key === pkey} onChange={() => saveModel(p)} />
                <span>{p.label}</span>
                <span className="ml-auto text-xs text-slate-400">{p.model}</span>
              </label>
            );
          })}
        </div>
        {saveMsg && <p className="mt-3 text-sm text-green-600">{saveMsg}</p>}
      </section>

      <section className="rounded-xl bg-white p-5 shadow">
        <h2 className="font-bold text-red-700">リセット</h2>
        <p className="mt-1 text-sm text-slate-500">
          生成済み問題・解答履歴を全て削除します（教科書データ・出題基準・過去問は消えません）。検証用データを消して本番運用を始める時に使います。
        </p>
        {!resetConfirm ? (
          <button
            onClick={() => setResetConfirm(true)}
            className="mt-3 rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
          >
            リセットする
          </button>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm font-medium text-red-700">本当に削除しますか？元に戻せません。</p>
            <div className="flex gap-2">
              <button onClick={runReset} className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700">
                削除を実行
              </button>
              <button
                onClick={() => setResetConfirm(false)}
                className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
        {resetMsg && <p className="mt-3 text-sm text-slate-700">{resetMsg}</p>}
      </section>
    </div>
  );
}
