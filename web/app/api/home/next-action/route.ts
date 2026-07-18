import { NextResponse } from "next/server";
import { computeNextAction } from "@/lib/nextAction";
import { logError } from "@/lib/errorLog";

export const maxDuration = 30;

/** ホーム画面の「おすすめの次の一手」。ロジックはlib/nextAction.ts参照。 */
export async function GET() {
  try {
    const result = await computeNextAction();
    return NextResponse.json(result);
  } catch (e) {
    await logError("next-action-route", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
