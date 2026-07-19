import { NextResponse } from "next/server";
import { getNextActionStateHash } from "@/lib/nextAction";
import { logError } from "@/lib/errorLog";

/**
 * 「おすすめの次の一手」の判断材料（弱点ストック・ストック量・受験履歴など）が前回から
 * 変化したかどうかだけを、LLMを呼ばずに安く返す。ホーム画面はこれを前回のstateHashと
 * 比較し、一致すればキャッシュ済みの結果をそのまま使い、不一致の場合だけ
 * /api/home/next-action（LLM呼び出しあり）を叩く。
 */
export async function GET() {
  try {
    const stateHash = await getNextActionStateHash();
    return NextResponse.json({ stateHash });
  } catch (e) {
    await logError("next-action-state-route", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
