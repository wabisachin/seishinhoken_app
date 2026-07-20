import { supabase } from "./supabase";
import { generateOneQuestion, CaseAxis } from "./generation";
import { logError } from "./errorLog";
import { listSubjects } from "./subjects";
import type { Question } from "./types";
import { EXAM_SUBJECT_COUNTS, EXAM_STOCK_SESSIONS_AHEAD, ExamPart } from "./examFormat";

// これに達したら新規生成を止め、以降はプールからの再出題のみにする
export const SUBJECT_TARGET = 200;
// 却下(rejected)も安全弁の分母に数える。却下ばかりの科目でも必ずここで新規生成が止まる。
// アクティブ数がSUBJECT_TARGETに届かなくても、総試行数がここに達したら諦める。
const HARD_CAP_TOTAL = 250;

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

// pool='general'（通常プール）に限定するのが既定。'exam'ストック関連の関数だけが
// 明示的に'exam'を渡す。こうしないと実戦模試専用の未消費問題が科目別演習・
// 全科目演習に混入してしまう。profileも同様に必須引数にし（デフォルト値を持たせない）、
// 呼び出し元に「本人／動作テスト用どちらのプールを見ているか」を毎回明示させる
// （うっかりスコープをつけ忘れるミスをコンパイルエラーに変えるため）。
async function countBySubject(
  subject: string,
  statuses: string[],
  pool: "general" | "exam",
  profile: string,
): Promise<number> {
  const { count } = await supabase()
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("subject", subject)
    .eq("pool", pool)
    .eq("profile", profile)
    .in("status", statuses);
  return count ?? 0;
}

async function fetchUnseenActive(
  subject: string,
  excludeIds: number[],
  profile: string,
  caseAxis?: CaseAxis,
): Promise<Question | null> {
  let query = supabase()
    .from("questions")
    .select(QUESTION_COLS)
    .eq("subject", subject)
    .eq("status", "active")
    .eq("pool", "general")
    .eq("profile", profile);
  // caseAxisを指定すると、case_textの有無で「事例問題のみ／事例なし」に絞り込む
  // （科目別演習の出題形式フィルタ用。未指定なら従来通り全形式を対象にする）
  if (caseAxis === "case") query = query.not("case_text", "is", null);
  if (caseAxis === "nocase") query = query.is("case_text", null);
  if (excludeIds.length > 0) query = query.not("id", "in", `(${excludeIds.join(",")})`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Question[];
  if (rows.length === 0) return null;

  // 「未出題」とは本人がこれまで一度も解答したことがない問題を指す（countUnservedActiveと
  // 同じ定義）。この判定を怠ると、excludeIdsは今回のセッション内でしか積み上がらないため、
  // セッションをまたぐたび（例:「もう一度」ボタン）にORDER BY未指定のクエリが返す先頭の
  // 既出問題が毎回同じ順番で繰り返し出題されてしまう（実際に発生したバグの再発防止）。
  const ids = rows.map((r) => r.id);
  const { data: attempted } = await supabase().from("attempts").select("question_id").eq("profile", profile).in("question_id", ids);
  const attemptedIds = new Set((attempted ?? []).map((r) => r.question_id as number));
  const unseen = rows.filter((r) => !attemptedIds.has(r.id));
  if (unseen.length === 0) return null;
  return unseen[Math.floor(Math.random() * unseen.length)];
}

/**
 * 既出（本人が一度以上解答済み）の問題からの再出題用。出題回数（attempts数）が最も
 * 少ない問題を優先し、同率の場合はランダムに選ぶ（特定の1問ばかり繰り返さないため）。
 * excludeIdsは今回のセッションで既に出した問題のIDで、候補が余っている限りは
 * 同じセッション内での即座の再登場を避ける（候補が無くなったら除外を無視して選び直す。
 * 1問しか既出が無い場合にnullを返して出題不能にしてしまわないため）。
 * null になるのは、その科目にactiveな問題が1問も無い場合のみ
 * （＝本当の意味での「出題できる問題が無い」状態）。
 */
async function fetchLeastAttempted(
  subject: string,
  profile: string,
  caseAxis?: CaseAxis,
  excludeIds: number[] = [],
): Promise<Question | null> {
  let query = supabase()
    .from("questions")
    .select(QUESTION_COLS)
    .eq("subject", subject)
    .eq("status", "active")
    .eq("pool", "general")
    .eq("profile", profile);
  if (caseAxis === "case") query = query.not("case_text", "is", null);
  if (caseAxis === "nocase") query = query.is("case_text", null);
  const { data: active } = await query;
  let rows = (active ?? []) as Question[];
  if (rows.length === 0) return null;

  const withoutExcluded = rows.filter((r) => !excludeIds.includes(r.id));
  if (withoutExcluded.length > 0) rows = withoutExcluded;

  const ids = rows.map((r) => r.id);
  // パーティション不変条件（1問は必ず1つのprofileにしか属さない）上は冗長だが、
  // 防御的に明示しておく。
  const { data: attempts } = await supabase()
    .from("attempts")
    .select("question_id")
    .eq("profile", profile)
    .in("question_id", ids);
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

// 科目ごとに常時これだけ「本人がまだ一度も出題されていないactive問題」を確保しておく目標値。
// ユーザーが解くスピードの方がその場生成より速いため、事前にストックしておくことで
// リクエスト駆動の生成待ちを実質無くす（出題と生成の非同期化）。
const STOCK_TARGET = 5;
// 1回の呼び出し（cronでも回答直後のフックでも）で生成するのは高々この件数まで。
const TOPUP_BATCH_CAP = 10;

/**
 * 指定profileがまだ一度も出題されていないactive問題の件数。
 * activeなquestions行数は出題されても減らない（消費されない）ため、それとは別の指標として
 * 見る必要がある。これが「今すぐ出せる在庫」の実態に対応する。
 */
async function countUnservedActive(subject: string, profile: string, caseAxis?: CaseAxis): Promise<number> {
  let query = supabase()
    .from("questions")
    .select("id")
    .eq("subject", subject)
    .eq("status", "active")
    .eq("pool", "general")
    .eq("profile", profile);
  if (caseAxis === "case") query = query.not("case_text", "is", null);
  if (caseAxis === "nocase") query = query.is("case_text", null);
  const { data: active } = await query;
  const ids = (active ?? []).map((r) => r.id as number);
  if (ids.length === 0) return 0;
  const { data: attempted } = await supabase()
    .from("attempts")
    .select("question_id")
    .eq("profile", profile)
    .in("question_id", ids);
  const attemptedIds = new Set((attempted ?? []).map((r) => r.question_id as number));
  return ids.filter((id) => !attemptedIds.has(id)).length;
}

// 同じ科目に対するtopUpSubjectの多重起動を防ぐガード（同一インスタンス内のみ有効な
// ベストエフォート。科目別演習は出題のたびにこの関数を呼ぶため、セッション開始直後の
// 先読みチェーンが同じ科目に対して短時間に何度も呼ぶバーストを潰す目的。インスタンスを
// またぐ多重実行が万一起きても、下の科目上限（SUBJECT_TARGET/HARD_CAP_TOTAL）は
// DBの行数を直接数えて判定するため、コストが際限なく増えることはない）
const topUpInFlight = new Set<string>();

/**
 * 指定科目の「未出題ストック」がSTOCK_TARGET未満なら、上限に達するまで無条件に生成して埋める。
 * 新規問題を出題するかどうかのテーパー確率（(SUBJECT_TARGET - activeCount) / SUBJECT_TARGET）は
 * ここではなく、実際にユーザーへ出題する側のgetOrGenerateNextだけが持つ。この関数の役割は
 * あくまで「新規が選ばれた時に即座に出せるよう、未出題ストックを常に満タンにしておく」こと
 * だけであり、テーパーによる新規率の抑制と二重に効かせると、新規が選ばれたのにストックが
 * 切れていてライブ生成待ちが増える、という本末転倒が起きるため（却下含め生成に失敗し
 * 続ける場合はTOPUP_BATCH_CAPで打ち切る）。
 *
 * 1日1回のCron（`/api/cron/topup`）と、出題直後のバックグラウンドフック
 * （`/api/quiz/next`、Next.jsの`after()`で非ブロッキング実行）の両方から呼ばれる。
 * どちらもこの関数自体が「呼ばれた分しか動かない」ため、常駐ループにはならない。
 *
 * timeBudgetMsで経過時間による打ち切りを指定できる（既定は無制限＝呼び出し元の
 * 外側にあるループ・maxDurationに委ねる）。回数（maxGenerate）ではなく時間で
 * 打ち切るのは、却下が続いても「1回も生成できないまま終わる」ことを避け、時間の
 * 許す限り5問到達を狙うため。ホストするルートのmaxDurationより確実に短い値を
 * 渡すこと（そうしないとVercelに強制終了され、topUpInFlightの解除(finally)が
 * 走らずその科目が以後スキップされ続けるバグになる。実際にこれで起きた）。
 */
export async function topUpSubject(
  subject: string,
  profile: string,
  opts: { maxGenerate?: number; timeBudgetMs?: number } = {},
): Promise<{ generated: number; unservedBefore: number }> {
  const { maxGenerate = TOPUP_BATCH_CAP, timeBudgetMs = Infinity } = opts;
  const key = `${subject}:${profile}`;
  if (topUpInFlight.has(key)) return { generated: 0, unservedBefore: -1 };
  topUpInFlight.add(key);
  const start = Date.now();
  try {
    // 本人・動作テスト用はそれぞれ独立したプールとしてストックを補充する
    // （SUBJECT_TARGET/HARD_CAP_TOTALの上限もプールごとに別々に判定する）。
    const unservedBefore = await countUnservedActive(subject, profile);
    let unserved = unservedBefore;
    let generated = 0;
    while (unserved < STOCK_TARGET && generated < maxGenerate && Date.now() - start < timeBudgetMs) {
      const totalCount = await countBySubject(subject, ["active", "rejected"], "general", profile);
      const activeCount = await countBySubject(subject, ["active"], "general", profile);
      if (totalCount >= HARD_CAP_TOTAL || activeCount >= SUBJECT_TARGET) break;

      try {
        const result = await generateOneQuestion(subject, profile);
        generated++;
        if (result.status === "active") {
          unserved++;
        } else {
          // 却下の実際の理由（構造チェック不備か、内容の自己検証NGか）を残しておく。
          // これが無いと「却下が続く」ことしか分からず、原因究明ができないため。
          await logError("generation-rejected", new Error("生成した問題が却下されました"), {
            subject,
            topic: result.topic,
            problems: result.problems,
          });
        }
      } catch (e) {
        await logError("topup", e, { subject });
        break;
      }
    }
    return { generated, unservedBefore };
  } finally {
    topUpInFlight.delete(key);
  }
}

// 全科目分をまとめて処理する時（Cron／管理者操作からの再構築）の並列数と時間予算。
// Vercel関数のタイムアウトに収まるよう、予算を超えたら残りは次回の呼び出しに委ねる
// （topUpSubject自体が「その時点のストック不足分だけ埋める」冪等な処理なので安全）。
const TOPUP_ALL_CONCURRENCY = 4;
const TOPUP_ALL_TIME_BUDGET_MS = 270_000;

/**
 * 「不足分(weight)が大きいほど選ばれやすい」重み付き抽選で、復元無しの処理順を作る。
 * 単純な降順ソートにしない理由: 却下が続いて時間を食う科目が万一あっても、それが
 * 毎回必ず先頭に来て他の科目の順番を恒常的に奪う、という固定化を避けるため。
 * 確率的に不足が大きい科目を優先しつつ、ある程度のばらつきを残す。
 */
function weightedShuffle<T>(items: { key: T; weight: number }[]): T[] {
  const pool = items.filter((i) => i.weight > 0).map((i) => ({ ...i }));
  const order: T[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, i) => sum + i.weight, 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    order.push(pool.splice(idx, 1)[0].key);
  }
  return order;
}

/**
 * 処理順を「未出題ストックの不足分（STOCK_TARGET - unserved）」に比例した重み付き抽選で
 * 決める。すでに目標を満たしている科目は対象から除外する（時間予算を無駄にしない）。
 * こうしないと、たまたま先頭付近にある・不足していない科目にも均等に時間を使ってしまい、
 * 本当に不足している科目が時間切れで後回しにされ続けるということが起こり得る。
 */
export async function topUpAllSubjects(profile: string): Promise<{ results: Record<string, number>; remaining: string[] }> {
  const start = Date.now();
  const results: Record<string, number> = {};
  const snapshot = await getStockSnapshot(profile);
  const queue = weightedShuffle(
    snapshot.map((s) => ({ key: s.subject, weight: Math.max(0, STOCK_TARGET - s.unserved) })),
  );

  async function worker() {
    while (queue.length > 0 && Date.now() - start < TOPUP_ALL_TIME_BUDGET_MS) {
      const subject = queue.shift();
      if (!subject) break;
      try {
        // 1科目の却下連発で全体予算を大幅に超過しないよう、残り時間だけを渡す
        // （渡さないと、1科目の内部リトライが長引いた場合にCron自体がVercelの
        // maxDurationで強制終了されるリスクがある）。
        const remainingMs = TOPUP_ALL_TIME_BUDGET_MS - (Date.now() - start);
        const { generated } = await topUpSubject(subject, profile, { timeBudgetMs: remainingMs });
        results[subject] = generated;
      } catch (e) {
        await logError("topup-all", e, { subject });
        results[subject] = -1;
      }
    }
  }

  await Promise.all(Array.from({ length: TOPUP_ALL_CONCURRENCY }, () => worker()));
  return { results, remaining: queue };
}

/**
 * 新しいデプロイ後の最初のリクエスト（`web/middleware.ts`）で、全科目のストック補充を
 * 1回だけ走らせるための「claim」。`app_settings.last_topup_deployment_id`と比較し、
 * 今回のdeploymentIdとまだ一致していなければ、それを新しい値に書き換えた上でtrueを返す
 * （= このインスタンスが実行担当）。Vercelの同時コールドスタートで複数インスタンスが
 * 同時にこの関数を呼んでも、DBの行を条件付きで更新するのは1インスタンスだけになる
 * （後勝ちで多少の重複が起き得るが、実害はtopUpSubjectの冪等性・上限で吸収される）。
 */
export async function claimDeploymentTopUp(deploymentId: string): Promise<boolean> {
  const { data, error } = await supabase()
    .from("app_settings")
    .update({ last_topup_deployment_id: deploymentId })
    .eq("id", 1)
    .or(`last_topup_deployment_id.is.null,last_topup_deployment_id.neq.${deploymentId}`)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export type SubjectStock = { subject: string; unserved: number; active: number; total: number };

/**
 * 科目ごとの「未出題ストック」「アクティブ総数」「総試行数(却下含む)」のスナップショット。
 * 管理者ページからは常に"self"を明示的に渡す（在庫管理は本人のプールのみが対象という
 * 明示的な設計判断。動作テスト用のプールはここに含めない）。ホーム画面のおすすめ機能
 * （nextAction.ts）からはアクティブprofileを渡し、動作テスト用でも同機能を検証できるようにする。
 */
export async function getStockSnapshot(profile: string): Promise<SubjectStock[]> {
  const subjects = await listSubjects();
  return Promise.all(
    subjects.map(async (subject) => {
      const [unserved, active, total] = await Promise.all([
        countUnservedActive(subject, profile),
        countBySubject(subject, ["active"], "general", profile),
        countBySubject(subject, ["active", "rejected"], "general", profile),
      ]);
      return { subject, unserved, active, total };
    }),
  );
}

// 科目別演習の「出題形式フィルタ（事例問題のみ／事例なし）」用に、科目ごと・枠組み軸
// ごとに常時確保しておく未出題ストックの目標値。通常のSTOCK_TARGET（形式を問わない
// 合計5問）とは別に、フィルタ利用時にすぐ枯渇しないよう各軸5問ずつを別枠で確保する。
const AXIS_STOCK_TARGET = 5;
const CASE_AXES: CaseAxis[] = ["case", "nocase"];

// topUpSubjectと同じ「同一プロセス内での多重起動防止」ガード。キーは`${subject}:${axis}`。
const axisTopUpInFlight = new Set<string>();

/**
 * 指定科目について、事例あり／事例なしそれぞれの未出題ストックがAXIS_STOCK_TARGET未満なら
 * generateOneQuestion(subject, { forceCaseAxis })で狙い撃ちで埋める。科目によっては
 * 実績比率上どちらかの軸がほぼ出ない（例:「精神医学と精神医療」はcase比率がほぼ0%）ため、
 * 通常のtopUpSubject（形式を問わない確率抽選）任せではこの軸のストックがいつまでも
 * 貯まらない。そのため専用に軸を固定して生成する。生成上限（HARD_CAP_TOTAL/SUBJECT_TARGET）は
 * topUpSubjectと共有する。
 */
export async function topUpCaseAxisStock(
  subject: string,
  profile: string,
  opts: { timeBudgetMs?: number } = {},
): Promise<{ generated: number }> {
  const { timeBudgetMs = Infinity } = opts;
  const start = Date.now();
  let generated = 0;
  for (const axis of CASE_AXES) {
    if (Date.now() - start >= timeBudgetMs) break;
    const key = `${subject}:${axis}:${profile}`;
    if (axisTopUpInFlight.has(key)) continue;
    axisTopUpInFlight.add(key);
    try {
      // topUpSubjectと同じく、本人・動作テスト用それぞれ独立したプールとして補充する。
      let unserved = await countUnservedActive(subject, profile, axis);
      while (unserved < AXIS_STOCK_TARGET && Date.now() - start < timeBudgetMs) {
        const totalCount = await countBySubject(subject, ["active", "rejected"], "general", profile);
        const activeCount = await countBySubject(subject, ["active"], "general", profile);
        if (totalCount >= HARD_CAP_TOTAL || activeCount >= SUBJECT_TARGET) break;
        try {
          const result = await generateOneQuestion(subject, profile, { forceCaseAxis: axis });
          generated++;
          if (result.status === "active") {
            unserved++;
          } else {
            await logError("generation-rejected", new Error("出題形式別ストック補充の問題が却下されました"), {
              subject,
              axis,
              topic: result.topic,
              problems: result.problems,
            });
          }
        } catch (e) {
          await logError("axis-topup", e, { subject, axis });
          break;
        }
      }
    } finally {
      axisTopUpInFlight.delete(key);
    }
  }
  return { generated };
}

/** 全科目分の出題形式別ストックをまとめて補充する（Cronから呼ぶ）。時間予算は科目数で均等割りする。 */
export async function topUpCaseAxisAllSubjects(
  profile: string,
  opts: { timeBudgetMs?: number } = {},
): Promise<{ results: Record<string, number> }> {
  const { timeBudgetMs = Infinity } = opts;
  const start = Date.now();
  const subjects = await listSubjects();
  const results: Record<string, number> = {};
  for (const subject of subjects) {
    const remainingMs = timeBudgetMs - (Date.now() - start);
    if (remainingMs <= 0) break;
    try {
      const { generated } = await topUpCaseAxisStock(subject, profile, { timeBudgetMs: remainingMs });
      results[subject] = generated;
    } catch (e) {
      await logError("axis-topup-all", e, { subject });
      results[subject] = -1;
    }
  }
  return { results };
}

// 実戦模試専用の未消費ストック（pool='exam', status='active'）の科目ごとの件数。
async function countExamPoolActive(subject: string, profile: string): Promise<number> {
  return countBySubject(subject, ["active"], "exam", profile);
}

// topUpSubjectと同じ「同一プロセス内での多重起動防止」ガード。キーを分けて
// 通常プールのtopUpSubjectとは独立に動くようにする。
const examTopUpInFlight = new Set<string>();

/**
 * 実戦模試プールを「科目ごとの本番出題数 × EXAM_STOCK_SESSIONS_AHEAD」まで埋める。
 * 通常プール(getOrGenerateNext)の新規率テーパーは出題側だけの仕組みで、ここには
 * 関係しない ── 実戦模試は月5回という需要が明確なので、単純に目標件数までひたすら埋めるだけでよい。
 * 却下が続いても諦めずに時間予算いっぱいまで試行する（topUpSubjectと同じ考え方）。
 */
export async function topUpExamPool(profile: string, opts: { timeBudgetMs?: number } = {}): Promise<{ generated: number }> {
  const { timeBudgetMs = Infinity } = opts;
  const start = Date.now();
  let generated = 0;
  // 全科目を1問ずつ順番に回すラウンドロビン方式（以前は科目ごとに目標達成まで使い切って
  // から次の科目に進む方式だったため、却下が多い科目や配列前方の共通科目(午前)で時間を
  // 使い切ってしまい、専門科目(午後)がいつまで経っても在庫ゼロのまま溜まらない問題が
  // あった。ラウンドロビンなら1回の実行時間予算が短くても18科目に均等に進捗が付く）。
  let anyRemaining = true;
  while (anyRemaining && Date.now() - start < timeBudgetMs) {
    anyRemaining = false;
    for (const { subject, questions } of EXAM_SUBJECT_COUNTS) {
      if (Date.now() - start >= timeBudgetMs) break;
      const key = `${subject}:${profile}`;
      if (examTopUpInFlight.has(key)) continue;
      const target = questions * EXAM_STOCK_SESSIONS_AHEAD;
      const active = await countExamPoolActive(subject, profile);
      if (active >= target) continue;
      anyRemaining = true;
      examTopUpInFlight.add(key);
      try {
        const result = await generateOneQuestion(subject, profile, { pool: "exam" });
        generated++;
        if (result.status !== "active") {
          await logError("generation-rejected", new Error("実戦模試用の問題が却下されました"), {
            subject,
            topic: result.topic,
            problems: result.problems,
          });
        }
      } catch (e) {
        await logError("exam-topup", e, { subject });
      } finally {
        examTopUpInFlight.delete(key);
      }
    }
  }
  return { generated };
}

/**
 * 実戦模試プールの科目ごとの在庫スナップショット（目標件数付き）。管理者ページからは
 * 常に"self"を明示的に渡す（在庫表示は本人のプールのみが対象という明示的な設計判断）。
 */
export async function getExamStockSnapshot(profile: string): Promise<(SubjectStock & { target: number; part: ExamPart })[]> {
  return Promise.all(
    EXAM_SUBJECT_COUNTS.map(async ({ subject, part, questions }) => {
      const [active, total] = await Promise.all([
        countExamPoolActive(subject, profile),
        countBySubject(subject, ["active", "rejected"], "exam", profile),
      ]);
      const target = questions * EXAM_STOCK_SESSIONS_AHEAD;
      return { subject, unserved: active, active, total, target, part };
    }),
  );
}

/**
 * 「今すぐ実戦模試を何回分開始できるか」をパートごとに返す。各科目の在庫を本番出題数で
 * 割った回数のうち、そのパート内で最も少ない科目がボトルネックになる（1科目でも
 * 本番出題数に届いていなければ、そのパートは0回扱い）。管理者ページからは常に"self"を渡す。
 */
export async function getExamReadyRounds(profile: string): Promise<{ common: number; specialized: number }> {
  const snapshot = await getExamStockSnapshot(profile);
  const readyRoundsByPart = (part: ExamPart): number => {
    const subjects = snapshot.filter((s) => s.part === part);
    if (subjects.length === 0) return 0;
    return Math.min(
      ...subjects.map((s) => {
        const questions = EXAM_SUBJECT_COUNTS.find((c) => c.subject === s.subject)?.questions ?? 1;
        return Math.floor(s.active / questions);
      }),
    );
  };
  return { common: readyRoundsByPart("common"), specialized: readyRoundsByPart("specialized") };
}

/**
 * モデルやプロンプトの変更で、既存の未出題問題（本人に一度も出題されていないもの）が
 * 現在の生成方針と合わなくなった場合に使う。既に出題済み（attemptsが1件でもある）問題は
 * 解答履歴・成績に影響するため一切削除しない。削除するのは「まだ誰にも出したことがない」
 * activeな問題と、却下(rejected)済みの問題（そもそも出したことが無い）だけ。
 */
export async function resetUnservedQuestions(): Promise<{ deleted: number }> {
  const sb = supabase();
  // 本人(self)のプール専用の操作（明示的な設計判断。動作テスト用のプールは対象外）。
  const { data: attemptedRows, error: attemptedErr } = await sb
    .from("attempts")
    .select("question_id")
    .eq("profile", "self");
  if (attemptedErr) throw new Error(attemptedErr.message);
  const attemptedIds = new Set((attemptedRows ?? []).map((r) => r.question_id as number));

  const { data: candidates, error: candErr } = await sb
    .from("questions")
    .select("id")
    .eq("profile", "self")
    .in("status", ["active", "rejected"]);
  if (candErr) throw new Error(candErr.message);
  const idsToDelete = (candidates ?? []).map((r) => r.id as number).filter((id) => !attemptedIds.has(id));

  const CHUNK = 500;
  for (let i = 0; i < idsToDelete.length; i += CHUNK) {
    const chunk = idsToDelete.slice(i, i + CHUNK);
    const { error } = await sb.from("questions").delete().in("id", chunk);
    if (error) throw new Error(error.message);
  }
  return { deleted: idsToDelete.length };
}

export type NextQuestionResult = {
  question: Question | null;
  /** true: 上限に達しており、かつ出せる問題も無い（=これ以上待っても無駄、即エラー表示してよい） */
  exhausted: boolean;
};

/**
 * generateOneQuestionを1回だけ試み、採用(active)されればその問題を返す。却下された場合は
 * nullを返す（呼び出し側が「まだ試行の余地があるか」を判断してリトライ or フォールバックする）。
 * generateOneQuestion自体が投げる例外（キー不正・課金上限・レート制限等）はここでは握り
 * つぶさず、呼び出し元へそのまま伝播させる（「却下」と違い、無言でポーリングを続けさせる
 * べきではないため）。ただし後から管理画面や開発者が原因を追えるよう、伝播させる前に
 * ログとして残しておく。
 */
async function attemptLiveGeneration(subject: string, profile: string, caseAxis: CaseAxis | undefined): Promise<Question | null> {
  let result;
  try {
    result = await generateOneQuestion(subject, profile, caseAxis ? { forceCaseAxis: caseAxis } : {});
  } catch (e) {
    await logError("generation", e, { subject });
    throw e;
  }
  if (result.status === "active" && result.questionId) {
    const fresh = await fetchQuestionById(result.questionId);
    if (fresh) return fresh;
  }
  return null;
}

/**
 * 科目別演習の「次の1問」を返す。
 *
 * 新規(本人が一度も解答していない)問題を出すか、既出（過去に解答済み）の問題を再出題するかは
 * newProbability = (SUBJECT_TARGET - activeCount) / SUBJECT_TARGET の確率で毎回抽選する
 * （0問なら100%新規、100問で50%、150問で25%、200問(SUBJECT_TARGET)で0%と線形に下がる）。
 * プールが育つにつれ、常に完全新規を出し続けるのではなく、既出問題への自然な再接触を
 * 少しずつ混ぜていく（復習モード・記憶の庭とは別に、科目別演習自体の中でも反復に触れる
 * 機会を作るための設計）。抽選した側に候補が無い場合（新規側が空、または既出側がまだ
 * 1問も無い＝本当に何も解いていない科目）は、もう一方の側にフォールバックする。
 *
 * 未出題ストックの確保自体はtopUpSubject（かんばん方式の裏側の補充）の責務であり、
 * この関数はそれを消費するだけ。その場ライブ生成（ユーザーを待たせる）は、新規側が
 * 選ばれたのにストックが尽きている場合の最終手段としてのみ行う。
 *
 * 設計方針（コスト安全性が最優先）:
 * - バックグラウンドで生成し続けるループは持たない。生成は必ずこの関数の
 *   1回の呼び出しにつき高々1回（1問ぶん）だけ行う、完全にリクエスト駆動の方式。
 * - 上限判定は毎回questionsテーブルの行数を直接数えて行う（専用のカウンタ状態を
 *   一切持たない）。プロセス再起動やリクエストの再送があっても、上限そのものが
 *   リセットされたり回避されたりすることは無い。
 * - 却下(rejected)も上限の分母に含めるため、却下が続く科目でも必ず生成が止まる。
 *
 * caseAxisを指定すると、科目別演習の「事例問題のみ／事例なし」フィルタに従って
 * 出題・生成の両方を絞り込む（未指定なら従来通り全形式が対象）。
 *
 * profileは必須引数。本人・動作テスト用はそれぞれ独立したプールとして扱われ、
 * どちらも自分のプールに対して新規生成できる（生成された問題はそのprofileの
 * プールにのみ保存され、互いに混ざらない）。上限判定（HARD_CAP_TOTAL/SUBJECT_TARGET）も
 * プールごとに独立して適用される。
 */
export async function getOrGenerateNext(
  subject: string,
  excludeIds: number[],
  profile: string,
  caseAxis?: CaseAxis,
): Promise<NextQuestionResult> {
  const activeCount = await countBySubject(subject, ["active"], "general", profile);
  const totalCount = await countBySubject(subject, ["active", "rejected"], "general", profile);
  const canGenerate = totalCount < HARD_CAP_TOTAL && activeCount < SUBJECT_TARGET;
  const newProbability = Math.max(0, (SUBJECT_TARGET - activeCount) / SUBJECT_TARGET);
  const preferNew = Math.random() < newProbability;

  async function tryNew(): Promise<NextQuestionResult | null> {
    const existing = await fetchUnseenActive(subject, excludeIds, profile, caseAxis);
    if (existing) return { question: existing, exhausted: false };
    if (!canGenerate) return null;
    const fresh = await attemptLiveGeneration(subject, profile, caseAxis);
    if (fresh) return { question: fresh, exhausted: false };
    // 却下された場合、直後に別経路で未出題が増えていないか念のため再確認してから、
    // まだ生成の余地があるかどうかで「クライアントにリトライさせる」か諦めるかを決める。
    const unseenAfterReject = await fetchUnseenActive(subject, excludeIds, profile, caseAxis);
    if (unseenAfterReject) return { question: unseenAfterReject, exhausted: false };
    const stillCanGenerate = (await countBySubject(subject, ["active", "rejected"], "general", profile)) < HARD_CAP_TOTAL;
    // まだ試行の余地がある（クライアントがリトライすれば良い）ので、ここではexhausted扱いにしない
    if (stillCanGenerate) return { question: null, exhausted: false };
    return null;
  }

  async function tryExisting(): Promise<NextQuestionResult | null> {
    const repeat = await fetchLeastAttempted(subject, profile, caseAxis, excludeIds);
    if (repeat) return { question: repeat, exhausted: false };
    return null;
  }

  const primary = preferNew ? await tryNew() : await tryExisting();
  if (primary) return primary;
  const fallback = preferNew ? await tryExisting() : await tryNew();
  if (fallback) return fallback;
  // 新規側・既出側どちらにも候補が無い（＝この科目にactiveな問題が1問も無い）
  return { question: null, exhausted: true };
}
