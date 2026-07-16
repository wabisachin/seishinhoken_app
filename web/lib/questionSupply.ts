import { supabase } from "./supabase";
import { generateOneQuestion } from "./generation";
import { logError } from "./errorLog";
import type { Question } from "./types";

// 累積アクティブ数がこれ未満の間は毎回新規生成する
const FULL_GENERATION_UNTIL = 50;
// これに達したら新規生成を止め、以降はプールからの再出題のみにする
const SUBJECT_TARGET = 200;
// 却下(rejected)も安全弁の分母に数える。却下ばかりの科目でも必ずここで新規生成が止まる。
// アクティブ数がSUBJECT_TARGETに届かなくても、総試行数がここに達したら諦める。
const HARD_CAP_TOTAL = 250;

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

async function countBySubject(subject: string, statuses: string[]): Promise<number> {
  const { count } = await supabase()
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("subject", subject)
    .in("status", statuses);
  return count ?? 0;
}

async function fetchUnseenActive(subject: string, excludeIds: number[]): Promise<Question | null> {
  let query = supabase()
    .from("questions")
    .select(QUESTION_COLS)
    .eq("subject", subject)
    .eq("status", "active")
    .limit(1);
  if (excludeIds.length > 0) query = query.not("id", "in", `(${excludeIds.join(",")})`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as Question | undefined) ?? null;
}

/**
 * 新規生成もせず、今回のセッションで未出題の問題も無くなった場合の再出題用。
 * 「上限に達した＝新規が出ないだけで、既出の問題が出るだけ」という仕様を守るため、
 * セッション内の除外は無視してプールから選ぶ。出題回数（attempts数）が最も少ない
 * 問題を優先し、同率の場合はランダムに選ぶ（特定の1問ばかり繰り返さないため）。
 * null になるのは、その科目にactiveな問題が1問も無い場合のみ
 * （＝本当の意味での「出題できる問題が無い」状態）。
 */
async function fetchLeastAttempted(subject: string): Promise<Question | null> {
  const { data: active } = await supabase()
    .from("questions")
    .select(QUESTION_COLS)
    .eq("subject", subject)
    .eq("status", "active");
  const rows = (active ?? []) as Question[];
  if (rows.length === 0) return null;

  const ids = rows.map((r) => r.id);
  const { data: attempts } = await supabase().from("attempts").select("question_id").in("question_id", ids);
  const countByQuestion = new Map<number, number>();
  for (const a of attempts ?? []) {
    countByQuestion.set(a.question_id, (countByQuestion.get(a.question_id) ?? 0) + 1);
  }
  const minCount = Math.min(...rows.map((r) => countByQuestion.get(r.id) ?? 0));
  const leastAttempted = rows.filter((r) => (countByQuestion.get(r.id) ?? 0) === minCount);
  return leastAttempted[Math.floor(Math.random() * leastAttempted.length)];
}

async function fetchQuestionById(id: number): Promise<Question | null> {
  const { data } = await supabase().from("questions").select(QUESTION_COLS).eq("id", id).maybeSingle();
  return (data as Question | null) ?? null;
}

export type NextQuestionResult = {
  question: Question | null;
  /** true: 上限に達しており、かつ出せる問題も無い（=これ以上待っても無駄、即エラー表示してよい） */
  exhausted: boolean;
};

/**
 * 分野別演習の「次の1問」を返す。
 *
 * 設計方針（コスト安全性が最優先）:
 * - バックグラウンドで生成し続けるループは持たない。生成は必ずこの関数の
 *   1回の呼び出しにつき高々1回（1問ぶん）だけ行う、完全にリクエスト駆動の方式。
 * - 上限判定は毎回questionsテーブルの行数を直接数えて行う（専用のカウンタ状態を
 *   一切持たない）。プロセス再起動やリクエストの再送があっても、上限そのものが
 *   リセットされたり回避されたりすることは無い。
 * - 却下(rejected)も上限の分母に含めるため、却下が続く科目でも必ず生成が止まる。
 */
export async function getOrGenerateNext(subject: string, excludeIds: number[]): Promise<NextQuestionResult> {
  const existing = await fetchUnseenActive(subject, excludeIds);

  const activeCount = await countBySubject(subject, ["active"]);
  const totalCount = await countBySubject(subject, ["active", "rejected"]);
  const canGenerate = totalCount < HARD_CAP_TOTAL && activeCount < SUBJECT_TARGET;

  // 50問に達するまでは常に新規、そこから200問に向けて徐々に新規率を下げる
  const newProbability = !canGenerate
    ? 0
    : activeCount < FULL_GENERATION_UNTIL
      ? 1
      : (SUBJECT_TARGET - activeCount) / (SUBJECT_TARGET - FULL_GENERATION_UNTIL);

  const shouldGenerate = canGenerate && (!existing || Math.random() < newProbability);

  if (!shouldGenerate) {
    if (existing) return { question: existing, exhausted: false };
    // 今回のセッションで未出題の問題は無いが、新規も生成しない（上限 or 確率で見送り）場合。
    // 「上限に達したら新規が出ないだけで既出の問題が出る」という仕様を守るため、
    // セッション内の除外を無視してプールから再出題する。nullになるのはactiveが1問も無い時だけ。
    const repeat = await fetchLeastAttempted(subject);
    return { question: repeat, exhausted: !repeat };
  }

  // generateOneQuestionは例外を投げることがある（キー不正・課金上限・レート制限等）。
  // ここでは握りつぶさず呼び出し元に伝播させ、フロント側で即座にエラー表示させる
  // （「却下」と違い、無言でポーリングを続けさせるべきではないため）。ただし後から
  // 管理画面や開発者が原因を追えるよう、伝播させる前にログとして残しておく。
  let result;
  try {
    result = await generateOneQuestion(subject);
  } catch (e) {
    await logError("generation", e, { subject });
    throw e;
  }
  if (result.status === "active" && result.questionId) {
    const fresh = await fetchQuestionById(result.questionId);
    if (fresh) return { question: fresh, exhausted: false };
  }
  // 却下された場合は、代わりに出せる既存問題があればそれを返す
  const unseenFallback = existing ?? (await fetchUnseenActive(subject, excludeIds));
  const stillCanGenerate = (await countBySubject(subject, ["active", "rejected"])) < HARD_CAP_TOTAL;
  if (unseenFallback || stillCanGenerate) {
    // まだ試行の余地がある（クライアントがリトライすれば良い）ので、ここではexhausted扱いにしない
    return { question: unseenFallback, exhausted: false };
  }
  // これ以上生成もできず、未出題の問題も無い。それでも既出のactiveが1問でもあれば再出題する
  const repeat = await fetchLeastAttempted(subject);
  return { question: repeat, exhausted: !repeat };
}
