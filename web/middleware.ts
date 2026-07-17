import { NextResponse, NextRequest, after } from "next/server";
import { consumePendingDeployTopUp } from "@/lib/deployTopUp";

// Supabase/LLM呼び出しを含む通常のNode.js実行環境で動かす（Edgeのデフォルトを避ける）。
export const runtime = "nodejs";

/**
 * デプロイ直後の最初の本物のリクエストで、全科目のストック補充を1回だけ非ブロッキングで
 * 走らせる（instrumentation.tsが起動時に立てたフラグを消費する）。ここは通常のリクエスト
 * 処理コンテキストなので、instrumentation.tsのregister()と違いfetchが確実に使える。
 * after()で実行するため、このリクエスト自体の応答には一切影響しない。
 */
export function middleware(req: NextRequest) {
  if (consumePendingDeployTopUp()) {
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (deploymentId) {
      after(async () => {
        const { claimDeploymentTopUp, topUpAllSubjects } = await import("@/lib/questionSupply");
        const { logError } = await import("@/lib/errorLog");
        try {
          const claimed = await claimDeploymentTopUp(deploymentId);
          if (claimed) await topUpAllSubjects();
        } catch (e) {
          await logError("deploy-topup", e, { deploymentId });
        }
      });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
