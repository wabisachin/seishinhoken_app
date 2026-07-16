import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { getLlmSettings, setLlmSettings } from "@/lib/appSettings";
import { MODEL_PRESETS } from "@/lib/types";
import { logError } from "@/lib/errorLog";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const settings = await getLlmSettings();
  return NextResponse.json({ settings, presets: MODEL_PRESETS });
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const provider = body.provider;
    const model = body.model;
    const valid = MODEL_PRESETS.some((p) => p.provider === provider && p.model === model);
    if (!valid) return NextResponse.json({ error: "invalid provider/model" }, { status: 400 });
    await setLlmSettings({ provider, model });
    return NextResponse.json({ ok: true });
  } catch (e) {
    await logError("admin-settings", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
