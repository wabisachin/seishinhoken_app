import { supabase } from "./supabase";
import { generateOneQuestion } from "./generation";
import type { LlmSettings } from "./types";

const MAX_CONSECUTIVE_FAILURES = 5;
const TICK_DELAY_MS = 500;
const STALE_HEARTBEAT_MS = 2 * 60 * 1000; // このぶん心拍が無ければクラッシュしたとみなし再クレーム可能にする

// このNodeプロセス内で現在ループ中の科目（同一プロセス内の二重起動を防ぐ）。
// ジョブ行のstatus='running'によるクレームは複数インスタンス/デプロイ間の調整用。
const localLoops = new Set<string>();

export type JobStatus = {
  subject: string;
  status: "idle" | "running" | "stalled";
  target_pool: number;
  consecutive_failures: number;
  last_error: string | null;
  pool_count: number;
};

async function activePoolCount(subject: string): Promise<number> {
  const { count } = await supabase()
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("subject", subject)
    .eq("status", "active");
  return count ?? 0;
}

export async function getJobStatus(subject: string): Promise<JobStatus> {
  const sb = supabase();
  const { data: job } = await sb.from("generation_jobs").select("*").eq("subject", subject).maybeSingle();
  const pool_count = await activePoolCount(subject);
  return {
    subject,
    status: (job?.status as JobStatus["status"]) ?? "idle",
    target_pool: job?.target_pool ?? 5,
    consecutive_failures: job?.consecutive_failures ?? 0,
    last_error: job?.last_error ?? null,
    pool_count,
  };
}

/** ジョブ行をクレームする。他プロセスが実行中(心拍が新しい)ならfalseを返す */
async function claim(subject: string, targetPool: number): Promise<boolean> {
  const sb = supabase();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_HEARTBEAT_MS).toISOString();

  const { data: existing } = await sb.from("generation_jobs").select("*").eq("subject", subject).maybeSingle();

  if (!existing) {
    const { error } = await sb.from("generation_jobs").insert({
      subject,
      status: "running",
      target_pool: targetPool,
      consecutive_failures: 0,
      last_error: null,
      heartbeat_at: now.toISOString(),
    });
    return !error;
  }

  const isFresh = existing.heartbeat_at && existing.heartbeat_at > staleBefore;
  if (existing.status === "running" && isFresh) return false; // 他で実行中

  const { error } = await sb
    .from("generation_jobs")
    .update({
      status: "running",
      target_pool: targetPool,
      consecutive_failures: 0,
      last_error: null,
      heartbeat_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("subject", subject);
  return !error;
}

async function heartbeat(subject: string, patch: Record<string, unknown>) {
  await supabase()
    .from("generation_jobs")
    .update({ ...patch, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("subject", subject);
}

async function runLoop(subject: string, targetPool: number, llm?: Partial<LlmSettings>) {
  let consecutiveThrows = 0;
  let attempts = 0;
  let rejectedCount = 0;
  // rejected（却下）はthrowしないため、却下だけが続いても止まるよう総試行回数にも上限を設ける。
  // これが無いと「却下ばかり出る科目」でジョブが永遠に終わらずAPIを呼び続けてしまう。
  const maxAttempts = Math.max(6, targetPool * 2);
  try {
    while (consecutiveThrows < MAX_CONSECUTIVE_FAILURES && attempts < maxAttempts) {
      const pool = await activePoolCount(subject);
      if (pool >= targetPool) break;
      attempts++;
      try {
        const result = await generateOneQuestion(subject, llm);
        consecutiveThrows = 0;
        if (result.status !== "active") rejectedCount++;
        await heartbeat(subject, { consecutive_failures: 0, last_error: null });
      } catch (e) {
        consecutiveThrows++;
        const message = e instanceof Error ? e.message : String(e);
        await heartbeat(subject, { consecutive_failures: consecutiveThrows, last_error: message });
      }
      await new Promise((r) => setTimeout(r, TICK_DELAY_MS));
    }
    const finalPool = await activePoolCount(subject);
    const stalled = finalPool < targetPool;
    const lastError = !stalled
      ? null
      : consecutiveThrows >= MAX_CONSECUTIVE_FAILURES
        ? "生成が連続して失敗しました"
        : `生成を${attempts}回試行しましたが目標数に届きませんでした（却下${rejectedCount}件）`;
    await supabase()
      .from("generation_jobs")
      .update({ status: stalled ? "stalled" : "idle", last_error: lastError, updated_at: new Date().toISOString() })
      .eq("subject", subject);
  } finally {
    localLoops.delete(subject);
  }
}

/**
 * 科目の問題プールをtargetPoolまで満たすバックグラウンド生成を開始する（未開始の場合のみ）。
 * fire-and-forget: 呼び出し元はawaitせず、現在のジョブ状態をすぐ返す。
 *
 * 注: 現状はNodeプロセス内の非同期ループで実行（next dev/startのようにプロセスが
 * 常駐する環境が前提）。Vercel等のサーバーレスにデプロイする場合、レスポンス返却後に
 * このループが継続する保証が無いため、代わりにcron等から一定間隔でこの関数（またはtick単位の
 * 処理）を呼び出す方式に置き換えること。ジョブ行によるクレーム機構はそのまま流用できる。
 */
export async function ensureGeneration(subject: string, targetPool = 5, llm?: Partial<LlmSettings>): Promise<JobStatus> {
  if (!localLoops.has(subject)) {
    const claimed = await claim(subject, targetPool);
    if (claimed) {
      localLoops.add(subject);
      void runLoop(subject, targetPool, llm);
    }
  }
  return getJobStatus(subject);
}
