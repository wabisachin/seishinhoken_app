"use client";

import { useEffect, useState } from "react";
import type { LlmSettings } from "@/lib/types";

type Preset = { provider: LlmSettings["provider"]; model: string; label: string };
type ErrorLog = { id: number; source: string; message: string; detail: string | null; created_at: string };
type UsageTotals = { inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number };
type UsageByModel = UsageTotals & { provider: string; model: string };
type SubjectStock = { subject: string; unserved: number; active: number; total: number };

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [expandedError, setExpandedError] = useState<number | null>(null);
  const [usageTotals, setUsageTotals] = useState<UsageTotals | null>(null);
  const [usageByModel, setUsageByModel] = useState<UsageByModel[]>([]);
  const [usageCallCount, setUsageCallCount] = useState(0);
  const [stock, setStock] = useState<SubjectStock[]>([]);
  const [stockCheckedAt, setStockCheckedAt] = useState<string | null>(null);
  const [stockLoading, setStockLoading] = useState(false);
  const [resetUnservedConfirm, setResetUnservedConfirm] = useState(false);
  const [resetUnservedMsg, setResetUnservedMsg] = useState<string | null>(null);
  const [resetUnservedPasswordInput, setResetUnservedPasswordInput] = useState("");

  useEffect(() => {
    fetch("/api/admin/status")
      .then((r) => r.json())
      .then((d) => setAuthed(!!d.authenticated));
  }, []);

  useEffect(() => {
    if (authed) {
      loadSettings();
      loadErrors();
      loadUsage();
      loadStock();
    }
  }, [authed]);

  // 裏側の生成は継続的に進むため、開いたまま放置しても数字が動いているのが
  // わかるよう、ストック・使用量は自動的に定期更新する
  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => {
      loadStock();
      loadUsage();
    }, 20_000);
    return () => clearInterval(id);
  }, [authed]);

  function loadStock() {
    setStockLoading(true);
    fetch("/api/admin/stock")
      .then((r) => r.json())
      .then((d) => {
        if (d.stock) setStock(d.stock);
        if (d.checkedAt) setStockCheckedAt(d.checkedAt);
      })
      .finally(() => setStockLoading(false));
  }

  function loadErrors() {
    fetch("/api/admin/errors")
      .then((r) => r.json())
      .then((d) => setErrors(d.errors ?? []));
  }

  async function clearErrors() {
    await fetch("/api/admin/errors", { method: "DELETE" });
    setErrors([]);
  }

  function loadUsage() {
    fetch("/api/admin/usage")
      .then((r) => r.json())
      .then((d) => {
        if (d.totals) setUsageTotals(d.totals);
        if (d.byModel) setUsageByModel(d.byModel);
        if (typeof d.callCount === "number") setUsageCallCount(d.callCount);
      });
  }

  async function clearUsage() {
    await fetch("/api/admin/usage", { method: "DELETE" });
    setUsageTotals(null);
    setUsageByModel([]);
    setUsageCallCount(0);
  }

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
    const res = await fetch("/api/admin/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: resetPasswordInput }),
    });
    const d = await res.json();
    setResetMsg(res.ok ? "リセットしました（生成問題・解答履歴を削除）" : `エラー: ${d.error}`);
    if (res.ok) {
      setResetConfirm(false);
      setResetPasswordInput("");
    }
  }

  async function runResetUnserved() {
    setResetUnservedMsg("実行中...");
    const res = await fetch("/api/admin/reset-unserved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: resetUnservedPasswordInput }),
    });
    const d = await res.json();
    setResetUnservedMsg(
      res.ok ? `未出題の問題を${d.deleted}件削除しました。裏側で再生成を始めています。` : `エラー: ${d.error}`,
    );
    if (res.ok) {
      setResetUnservedConfirm(false);
      setResetUnservedPasswordInput("");
      loadStock();
    }
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
            className="min-h-12 w-full rounded-lg border border-slate-300 p-3"
            autoFocus
          />
          {loginError && <p className="text-sm text-red-600">{loginError}</p>}
          <button type="submit" className="min-h-12 w-full rounded-lg bg-slate-800 px-4 py-3 font-medium text-white hover:bg-slate-900">
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
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-700">科目ごとの未出題ストック</h2>
          <button onClick={loadStock} className="text-xs text-slate-400 hover:underline">
            {stockLoading ? "更新中..." : "更新"}
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          「未出題」は本人がまだ一度も解いていない問題の数（目標は常時5問。裏側のCron・出題フックが
          自動で埋めるので通常は操作不要）。「アクティブ計」はこれまで生成された問題の累計で、
          一度出題しても減らないため、練習が進んだ科目ほど未出題より大きくなります。
        </p>
        {stockCheckedAt && (
          <p className="mt-1 text-xs text-slate-400">{new Date(stockCheckedAt).toLocaleString("ja-JP")} 時点</p>
        )}
        {stock.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">まだデータがありません。</p>
        ) : (
          <div className="mt-3 max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-100 text-left">
                <tr>
                  <th className="px-3 py-1.5">科目</th>
                  <th className="px-3 py-1.5 text-right">未出題（本人未回答）</th>
                  <th className="px-3 py-1.5 text-right">アクティブ計（累計）</th>
                  <th className="px-3 py-1.5 text-right">総試行(却下含)</th>
                </tr>
              </thead>
              <tbody>
                {stock.map((s) => (
                  <tr key={s.subject} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">{s.subject}</td>
                    <td className={`px-3 py-1.5 text-right font-medium ${s.unserved < 5 ? "text-amber-600" : "text-slate-700"}`}>
                      {s.unserved}
                    </td>
                    <td className="px-3 py-1.5 text-right">{s.active}</td>
                    <td className="px-3 py-1.5 text-right">{s.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl bg-white p-5 shadow">
        <h2 className="font-bold text-slate-700">問題生成に使うLLM</h2>
        <p className="mt-1 text-sm text-slate-500">ここで選んだモデルだけが問題生成に使われます（利用者側からは変更できません）。</p>
        <div className="mt-3 space-y-2">
          {presets.map((p) => {
            const pkey = `${p.provider}:${p.model}`;
            return (
              <label
                key={pkey}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
                  key === pkey ? "border-slate-500 bg-slate-100" : "border-slate-200"
                }`}
              >
                <input type="radio" checked={key === pkey} onChange={() => saveModel(p)} className="h-4 w-4 shrink-0" />
                <span>{p.label}</span>
                <span className="ml-auto shrink-0 text-xs text-slate-400">{p.model}</span>
              </label>
            );
          })}
        </div>
        {saveMsg && <p className="mt-3 text-sm text-green-600">{saveMsg}</p>}
      </section>

      <section className="rounded-xl bg-white p-5 shadow">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-700">トークン使用量・推定コスト（累積）</h2>
          {usageCallCount > 0 && (
            <button onClick={clearUsage} className="text-xs text-slate-400 hover:underline">
              クリア
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          HyDE検索クエリ生成・問題生成・自己検証、それぞれのLLM呼び出しごとのトークン数から概算しています。
          実際の請求額とは単価表の更新タイミングにより差が出ることがあります。
        </p>
        {!usageTotals || usageCallCount === 0 ? (
          <p className="mt-3 text-sm text-slate-400">まだ記録がありません。</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">推定コスト</p>
                <p className="text-lg font-bold text-slate-800">${usageTotals.costUsd.toFixed(2)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">LLM呼び出し回数</p>
                <p className="text-lg font-bold text-slate-800">{usageCallCount.toLocaleString()}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">入力トークン</p>
                <p className="text-lg font-bold text-slate-800">{usageTotals.inputTokens.toLocaleString()}</p>
                <p className="text-xs text-slate-400">うちキャッシュ {usageTotals.cachedInputTokens.toLocaleString()}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">出力トークン</p>
                <p className="text-lg font-bold text-slate-800">{usageTotals.outputTokens.toLocaleString()}</p>
              </div>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th className="px-3 py-1.5">モデル</th>
                  <th className="px-3 py-1.5 text-right">入力</th>
                  <th className="px-3 py-1.5 text-right">出力</th>
                  <th className="px-3 py-1.5 text-right">推定コスト</th>
                </tr>
              </thead>
              <tbody>
                {usageByModel.map((m) => (
                  <tr key={`${m.provider}:${m.model}`} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">{m.model}</td>
                    <td className="px-3 py-1.5 text-right">{m.inputTokens.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right">{m.outputTokens.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right font-medium">${m.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="rounded-xl bg-white p-5 shadow">
        <h2 className="font-bold text-red-700">リセット</h2>
        <p className="mt-1 text-sm text-slate-500">
          生成済み問題・解答履歴を全て削除します（教科書データ・出題基準・過去問は消えません）。検証用データを消して本番運用を始める時に使います。
        </p>
        {!resetConfirm ? (
          <button
            onClick={() => setResetConfirm(true)}
            className="mt-3 min-h-12 rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700"
          >
            リセットする
          </button>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm font-medium text-red-700">本当に削除しますか？元に戻せません。確認のためパスワードを入力してください。</p>
            <input
              type="password"
              value={resetPasswordInput}
              onChange={(e) => setResetPasswordInput(e.target.value)}
              placeholder="パスワード"
              autoFocus
              className="min-h-12 w-full rounded-lg border border-slate-300 p-3"
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                onClick={runReset}
                disabled={!resetPasswordInput}
                className="min-h-12 rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                削除を実行
              </button>
              <button
                onClick={() => {
                  setResetConfirm(false);
                  setResetPasswordInput("");
                }}
                className="min-h-12 rounded-lg border border-slate-300 px-4 py-3 text-sm text-slate-600"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
        {resetMsg && <p className="mt-3 text-sm text-slate-700">{resetMsg}</p>}
      </section>

      <section className="rounded-xl bg-white p-5 shadow">
        <h2 className="font-bold text-red-700">未出題問題のリセット（モデル/プロンプト変更時）</h2>
        <p className="mt-1 text-sm text-slate-500">
          モデルや生成プロンプト・方針を変えた後、それ以前の設定で作られた「まだ誰にも出題していない」問題は
          今の基準に合わなくなるため削除します。すでに出題済みの問題・解答履歴・成績は一切削除しません。
          削除後は裏側で自動的にゼロから再生成・再ストックが始まります（この操作の完了を待つ必要はありません）。
        </p>
        {!resetUnservedConfirm ? (
          <button
            onClick={() => setResetUnservedConfirm(true)}
            className="mt-3 min-h-12 rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700"
          >
            未出題の問題をリセットする
          </button>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm font-medium text-red-700">
              全科目の未出題問題を削除し、再生成を開始します。確認のためパスワードを入力してください。
            </p>
            <input
              type="password"
              value={resetUnservedPasswordInput}
              onChange={(e) => setResetUnservedPasswordInput(e.target.value)}
              placeholder="パスワード"
              autoFocus
              className="min-h-12 w-full rounded-lg border border-slate-300 p-3"
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                onClick={runResetUnserved}
                disabled={!resetUnservedPasswordInput}
                className="min-h-12 rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                削除して再生成
              </button>
              <button
                onClick={() => {
                  setResetUnservedConfirm(false);
                  setResetUnservedPasswordInput("");
                }}
                className="min-h-12 rounded-lg border border-slate-300 px-4 py-3 text-sm text-slate-600"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
        {resetUnservedMsg && <p className="mt-3 text-sm text-slate-700">{resetUnservedMsg}</p>}
      </section>

      <section className="rounded-xl bg-white p-5 shadow">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-700">最近のエラー（直近50件）</h2>
          {errors.length > 0 && (
            <button onClick={clearErrors} className="text-xs text-slate-400 hover:underline">
              クリア
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          LLMの課金上限・レート制限など、外部サービス連携で起きたエラーをここに記録しています。
        </p>
        {errors.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">エラーはありません。</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {errors.map((e) => (
              <li key={e.id} className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm">
                <button
                  onClick={() => setExpandedError(expandedError === e.id ? null : e.id)}
                  className="flex w-full items-start justify-between gap-2 text-left"
                >
                  <span>
                    <span className="mr-2 rounded bg-red-200 px-1.5 py-0.5 text-xs font-medium text-red-800">{e.source}</span>
                    {e.message}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{new Date(e.created_at).toLocaleString("ja-JP")}</span>
                </button>
                {expandedError === e.id && e.detail && (
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-xs text-slate-600">
                    {e.detail}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
