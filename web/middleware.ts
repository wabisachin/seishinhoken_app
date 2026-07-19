import { NextResponse, NextRequest, after } from "next/server";
import { shouldAttemptDeployTopUp } from "@/lib/deployTopUp";

// Supabase/LLM呼び出しを含む通常のNode.js実行環境で動かす（Edgeのデフォルトを避ける）。
export const runtime = "nodejs";

/**
 * デプロイ直後、このインスタンスが処理する最初のリクエストで、全科目のストック補充を
 * 1回だけ非ブロッキングで走らせる。以前はinstrumentation.tsのregister()が立てた
 * フラグをここで消費する2段構成だったが、register()とmiddleware.tsが同じモジュール
 * 状態を共有しているとは限らないことが判明した（app_settings.last_topup_deployment_id
 * が10回のデプロイに渡って一度も更新されていなかった）ため、middleware.ts単体で
 * 完結する方式にした。shouldAttemptDeployTopUp()はこのインスタンス内で1回だけtrueを
 * 返す軽量な間引きに過ぎず、正しさ自体はclaimDeploymentTopUp()の原子的なDB更新が
 * 担保している（複数インスタンスから重複して呼ばれても実害は無い）。
 * after()で実行するため、このリクエスト自体の応答には一切影響しない。
 */
export function middleware(req: NextRequest) {
  if (shouldAttemptDeployTopUp()) {
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (deploymentId) {
      after(async () => {
        const { claimDeploymentTopUp, topUpAllSubjects } = await import("@/lib/questionSupply");
        const { logError } = await import("@/lib/errorLog");
        try {
          const claimed = await claimDeploymentTopUp(deploymentId);
          // デプロイ直後の一括補充も本人(self)専用（cronと同じ理由でコストを一定に保つ）。
          if (claimed) await topUpAllSubjects("self");
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
