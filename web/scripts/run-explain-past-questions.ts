// 過去問への解説生成を実行する。usage: npx tsx scripts/run-explain-past-questions.ts [limit]
// Next.jsの自動.env読み込みが効かないスタンドアロン実行のため、ここで手動で読み込む
// （dotenvパッケージを追加せず、既存の.envをそのまま読む）
import fs from "fs";
import path from "path";

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

import { fetchUnexplainedPastQuestions, explainPastQuestion } from "../lib/pastQuestionExplain";

async function main() {
  const limit = Number(process.argv[2] ?? 5);
  const rows = await fetchUnexplainedPastQuestions(limit);
  console.log(`target: ${rows.length} questions`);
  let done = 0;
  for (const q of rows) {
    try {
      await explainPastQuestion(q);
      done++;
      console.log(`[${done}/${rows.length}] id=${q.id} subject=${q.subject} ok`);
    } catch (e) {
      console.error(`id=${q.id} FAILED:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`done: ${done}/${rows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
