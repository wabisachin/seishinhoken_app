// 実戦模試（本番同形式・時間制限つき模試）の出題構成。
// 出題数は past_questions テーブルの実集計（第37・38回=共通84問・12科目、
// 第27・28回=専門48問・6科目、複数回で一致）に基づく。時間は公式サイト
// （sssc.or.jp/seishin/tetsuzuki.html）の午前10:00-12:20・午後14:00-15:30より。
export type ExamPart = "common" | "specialized";

export const EXAM_TIME_LIMIT_SECONDS: Record<ExamPart, number> = {
  common: 140 * 60,
  specialized: 90 * 60,
};

export const EXAM_SUBJECT_COUNTS: { subject: string; part: ExamPart; questions: number }[] = [
  { subject: "医学概論", part: "common", questions: 6 },
  { subject: "心理学と心理的支援", part: "common", questions: 6 },
  { subject: "社会学と社会システム", part: "common", questions: 6 },
  { subject: "社会福祉の原理と政策", part: "common", questions: 9 },
  { subject: "社会保障", part: "common", questions: 9 },
  { subject: "権利擁護を支える法制度", part: "common", questions: 6 },
  { subject: "地域福祉と包括的支援体制", part: "common", questions: 9 },
  { subject: "障害者福祉", part: "common", questions: 6 },
  { subject: "刑事司法と福祉", part: "common", questions: 6 },
  { subject: "ソーシャルワークの基盤と専門職", part: "common", questions: 6 },
  { subject: "ソーシャルワークの理論と方法", part: "common", questions: 9 },
  { subject: "社会福祉調査の基礎", part: "common", questions: 6 },
  { subject: "精神医学と精神医療", part: "specialized", questions: 9 },
  { subject: "現代の精神保健の課題と支援", part: "specialized", questions: 9 },
  { subject: "精神保健福祉の原理", part: "specialized", questions: 9 },
  { subject: "ソーシャルワークの理論と方法(専門)", part: "specialized", questions: 9 },
  { subject: "精神障害リハビリテーション論", part: "specialized", questions: 6 },
  { subject: "精神保健福祉制度論", part: "specialized", questions: 6 },
];

// 合格基準の「科目群」区分（①〜⑨のいずれか1つでも0点だと総得点に関係なく不合格）
export const EXAM_SUBJECT_GROUPS: { label: string; subjects: string[] }[] = [
  { label: "①", subjects: ["精神医学と精神医療"] },
  { label: "②", subjects: ["現代の精神保健の課題と支援"] },
  { label: "③", subjects: ["精神保健福祉の原理"] },
  { label: "④", subjects: ["ソーシャルワークの理論と方法(専門)"] },
  { label: "⑤", subjects: ["精神障害リハビリテーション論", "精神保健福祉制度論"] },
  { label: "⑥", subjects: ["医学概論", "心理学と心理的支援", "社会学と社会システム"] },
  { label: "⑦", subjects: ["社会福祉の原理と政策", "社会保障", "権利擁護を支える法制度"] },
  { label: "⑧", subjects: ["地域福祉と包括的支援体制", "障害者福祉", "刑事司法と福祉"] },
  { label: "⑨", subjects: ["ソーシャルワークの基盤と専門職", "ソーシャルワークの理論と方法", "社会福祉調査の基礎"] },
];

export const EXAM_PASS_SCORE_RATE = 0.6;
// 実戦模試ストックとして常時確保しておく「回」数（1回=共通84問+専門48問ぶん）。
// 月次上限(EXAM_MONTHLY_LIMIT)とは別の値 ── こちらは裏側の在庫バッファの厚みで、
// 大きいほど初回ビルドアップが長くかかるだけなので、月の上限と一致させる必要は無い。
// 生成プロンプト・モデルを変更した際は既存ストックを作り直す必要があるため、
// トークン消費を抑える観点から必要最小限の1回分先までに留める。
export const EXAM_STOCK_SESSIONS_AHEAD = 1;
export const EXAM_MONTHLY_LIMIT = 5;

export function subjectsForPart(part: ExamPart): { subject: string; questions: number }[] {
  return EXAM_SUBJECT_COUNTS.filter((s) => s.part === part).map((s) => ({ subject: s.subject, questions: s.questions }));
}

/**
 * verdict.failedGroups（["⑤", "⑥"]のような番号だけの配列）は、番号が何の科目群を
 * 指すのか利用者にはわからない。表示するときは必ずこれを通し、科目名を添える
 * （例: "⑤（精神障害リハビリテーション論・精神保健福祉制度論）"）。
 */
export function describeFailedGroups(labels: string[]): string {
  return labels
    .map((label) => {
      const group = EXAM_SUBJECT_GROUPS.find((g) => g.label === label);
      return group ? `${label}（${group.subjects.join("・")}）` : label;
    })
    .join("、");
}
