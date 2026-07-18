import { supabase } from "./supabase";
import { generateOneQuestion } from "./generation";
import { logError } from "./errorLog";
import { listSubjects } from "./subjects";
import type { Question } from "./types";
import { EXAM_SUBJECT_COUNTS, EXAM_STOCK_SESSIONS_AHEAD, ExamPart } from "./examFormat";

// 累積アクティブ数がこれ未満の間は、ストック補充のたびに必ず新規生成する
const FULL_GENERATION_UNTIL = 50;
// これに達したら新規生成を止め、以降はプールからの再出題のみにする
const SUBJECT_TARGET = 200;
// 却下(rejected)も安全弁の分母に数える。却下ばかりの科目でも必ずここで新規生成が止まる。
// アクティブ数がSUBJECT_TARGETに届かなくても、総試行数がここに達したら諦める。
const HARD_CAP_TOTAL = 250;

const QUESTION_COLS =
  "id, subject, taxonomy_id, question_type, stem, case_text, options, correct, explanations, key_points, citations";

// pool='general'（通常プール）に限定するのが既定。'exam'ストック関連の関数だけが
// 明示的に'exam'を渡す。こうしないと実戦模試専用の未消費問題が分野別演習・
// ミニ模試に混入してしまう。
async function countBySubject(subject: string, statuses: string[], pool: "general" | "exam" = "general"): Promise<number> {
  const { count } = await supabase()
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("subject", subject)
    .eq("pool", pool)
    .in("status", statuses);
  return count ?? 0;
}

async function fetchUnseenActive(subject: string, excludeIds: number[]): Promise<Question | null> {
  let query = supabase()
    .from("questions")
    .select(QUESTION_COLS)
    .eq("subject", subject)
    .eq("status", "active")
    .eq("pool", "general")
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
    .eq("status", "active")
    .eq("pool", "general");
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

// 科目ごとに常時これだけ「本人がまだ一度も出題されていないactive問題」を確保しておく目標値。
// ユーザーが解くスピードの方がその場生成より速いため、事前にストックしておくことで
// リクエスト駆動の生成待ちを実質無くす（出題と生成の非同期化）。
const STOCK_TARGET = 5;
// 1回の呼び出し（cronでも回答直後のフックでも）で生成するのは高々この件数まで。
const TOPUP_BATCH_CAP = 10;

/**
 * 「本人(profile='self')がまだ一度も出題されていないactive問題」の件数。
 * activeなquestions行数は出題されても減らない（消費されない）ため、それとは別の指標として
 * 見る必要がある。これが「今すぐ出せる在庫」の実態に対応する。
 */
async function countUnservedActive(subject: string): Promise<number> {
  const { data: active } = await supabase()
    .from("questions")
    .select("id")
    .eq("subject", subject)
    .eq("status", "active")
    .eq("pool", "general");
  const ids = (active ?? []).map((r) => r.id as number);
  if (ids.length === 0) return 0;
  const { data: attempted } = await supabase()
    .from("attempts")
    .select("question_id")
    .eq("profile", "self")
    .in("question_id", ids);
  const attemptedIds = new Set((attempted ?? []).map((r) => r.question_id as number));
  return ids.filter((id) => !attemptedIds.has(id)).length;
}

// 同じ科目に対するtopUpSubjectの多重起動を防ぐガード（同一インスタンス内のみ有効な
// ベストエフォート。分野別演習は出題のたびにこの関数を呼ぶため、セッション開始直後の
// 先読みチェーンが同じ科目に対して短時間に何度も呼ぶバーストを潰す目的。インスタンスを
// またぐ多重実行が万一起きても、下の科目上限（SUBJECT_TARGET/HARD_CAP_TOTAL）は
// DBの行数を直接数えて判定するため、コストが際限なく増えることはない）
const topUpInFlight = new Set<string>();

/**
 * 指定科目の「未出題ストック」がSTOCK_TARGET未満なら生成して埋める。ただし
 * 「50問に達するまでは必ず新規、200問に向けて徐々に新規率を下げる」という
 * コスト上限のポリシー自体は変わらない。生成のタイミングが同期（即時）から
 * 非同期（このストック補充）に移っただけで、成熟した科目（50〜200問）では
 * 確率で「今回は生成しない」が選ばれることがあり、その場合はストックが
 * 5に届いていなくても無理に埋めようとせず、そのまま打ち切る
 * （却下含め生成に失敗し続ける場合も同様に打ち切る。TOPUP_BATCH_CAPが上限）。
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
  opts: { maxGenerate?: number; timeBudgetMs?: number } = {},
): Promise<{ generated: number; unservedBefore: number }> {
  const { maxGenerate = TOPUP_BATCH_CAP, timeBudgetMs = Infinity } = opts;
  if (topUpInFlight.has(subject)) return { generated: 0, unservedBefore: -1 };
  topUpInFlight.add(subject);
  const start = Date.now();
  try {
    const unservedBefore = await countUnservedActive(subject);
    let unserved = unservedBefore;
    let generated = 0;
    while (unserved < STOCK_TARGET && generated < maxGenerate && Date.now() - start < timeBudgetMs) {
      const totalCount = await countBySubject(subject, ["active", "rejected"]);
      const activeCount = await countBySubject(subject, ["active"]);
      if (totalCount >= HARD_CAP_TOTAL || activeCount >= SUBJECT_TARGET) break;

      const newProbability =
        activeCount < FULL_GENERATION_UNTIL ? 1 : (SUBJECT_TARGET - activeCount) / (SUBJECT_TARGET - FULL_GENERATION_UNTIL);
      if (Math.random() >= newProbability) break;

      try {
        const result = await generateOneQuestion(subject);
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
    topUpInFlight.delete(subject);
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
export async function topUpAllSubjects(): Promise<{ results: Record<string, number>; remaining: string[] }> {
  const start = Date.now();
  const results: Record<string, number> = {};
  const snapshot = await getStockSnapshot();
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
        const { generated } = await topUpSubject(subject, { timeBudgetMs: remainingMs });
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
 * 新しいデプロイのコールドスタート直後（`web/instrumentation.ts`）に、全科目のストック補充を
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

/** 管理者ページ表示用。科目ごとの「未出題ストック」「アクティブ総数」「総試行数(却下含む)」のスナップショット。 */
export async function getStockSnapshot(): Promise<SubjectStock[]> {
  const subjects = await listSubjects();
  return Promise.all(
    subjects.map(async (subject) => {
      const [unserved, active, total] = await Promise.all([
        countUnservedActive(subject),
        countBySubject(subject, ["active"]),
        countBySubject(subject, ["active", "rejected"]),
      ]);
      return { subject, unserved, active, total };
    }),
  );
}

// 実戦模試専用の未消費ストック（pool='exam', status='active'）の科目ごとの件数。
async function countExamPoolActive(subject: string): Promise<number> {
  return countBySubject(subject, ["active"], "exam");
}

// topUpSubjectと同じ「同一プロセス内での多重起動防止」ガード。キーを分けて
// 通常プールのtopUpSubjectとは独立に動くようにする。
const examTopUpInFlight = new Set<string>();

/**
 * 実戦模試プールを「科目ごとの本番出題数 × EXAM_STOCK_SESSIONS_AHEAD」まで埋める。
 * 通常プールの50/200テーパー（コスト逓減ポリシー）は適用しない ── 実戦模試は
 * 月5回という需要が明確なので、単純に目標件数までひたすら埋めるだけでよい。
 * 却下が続いても諦めずに時間予算いっぱいまで試行する（topUpSubjectと同じ考え方）。
 */
export async function topUpExamPool(opts: { timeBudgetMs?: number } = {}): Promise<{ generated: number }> {
  const { timeBudgetMs = Infinity } = opts;
  const start = Date.now();
  let generated = 0;
  for (const { subject, questions } of EXAM_SUBJECT_COUNTS) {
    if (Date.now() - start >= timeBudgetMs) break;
    if (examTopUpInFlight.has(subject)) continue;
    examTopUpInFlight.add(subject);
    try {
      const target = questions * EXAM_STOCK_SESSIONS_AHEAD;
      let active = await countExamPoolActive(subject);
      while (active < target && Date.now() - start < timeBudgetMs) {
        try {
          const result = await generateOneQuestion(subject, { pool: "exam" });
          generated++;
          if (result.status === "active") {
            active++;
          } else {
            await logError("generation-rejected", new Error("実戦模試用の問題が却下されました"), {
              subject,
              topic: result.topic,
              problems: result.problems,
            });
          }
        } catch (e) {
          await logError("exam-topup", e, { subject });
          break;
        }
      }
    } finally {
      examTopUpInFlight.delete(subject);
    }
  }
  return { generated };
}

/** 管理者ページ表示用。実戦模試プールの科目ごとの在庫スナップショット（目標件数付き）。 */
export async function getExamStockSnapshot(): Promise<(SubjectStock & { target: number; part: ExamPart })[]> {
  return Promise.all(
    EXAM_SUBJECT_COUNTS.map(async ({ subject, part, questions }) => {
      const [active, total] = await Promise.all([
        countExamPoolActive(subject),
        countBySubject(subject, ["active", "rejected"], "exam"),
      ]);
      const target = questions * EXAM_STOCK_SESSIONS_AHEAD;
      return { subject, unserved: active, active, total, target, part };
    }),
  );
}

/**
 * 管理者ページ表示用。「今すぐ実戦模試を何回分開始できるか」をパートごとに返す。
 * 各科目の在庫を本番出題数で割った回数のうち、そのパート内で最も少ない科目が
 * ボトルネックになる（1科目でも本番出題数に届いていなければ、そのパートは0回扱い）。
 */
export async function getExamReadyRounds(): Promise<{ common: number; specialized: number }> {
  const snapshot = await getExamStockSnapshot();
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
  const { data: attemptedRows, error: attemptedErr } = await sb.from("attempts").select("question_id");
  if (attemptedErr) throw new Error(attemptedErr.message);
  const attemptedIds = new Set((attemptedRows ?? []).map((r) => r.question_id as number));

  const { data: candidates, error: candErr } = await sb.from("questions").select("id").in("status", ["active", "rejected"]);
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

  // かんばん方式のストック（topUpSubject、cron + /api/quiz/nextの出題直後フック）が
  // 常時ストックを補充しているため、ここ（ユーザーへの出題そのもの）では既存の未出題
  // 問題があれば必ずそれを即座に返す。その場ライブ生成（ユーザーを待たせる）は、
  // 本当にストックが尽きている場合の最終手段としてのみ行う。
  const shouldGenerate = canGenerate && !existing;

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
