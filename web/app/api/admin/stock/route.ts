import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { getStockSnapshot, getExamStockSnapshot } from "@/lib/questionSupply";
import { logError } from "@/lib/errorLog";

/** 管理者ページを開いた時点での、科目ごとの未出題ストック数・実戦模試プール在庫のスナップショットを返す */
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const [stock, examPool] = await Promise.all([getStockSnapshot(), getExamStockSnapshot()]);
    return NextResponse.json({ stock, examPool, checkedAt: new Date().toISOString() });
  } catch (e) {
    await logError("admin-stock", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
