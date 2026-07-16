import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data, error } = await supabase()
    .from("error_logs")
    .select("id, source, message, detail, created_at")
    .order("id", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ errors: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { error } = await supabase().from("error_logs").delete().gte("id", 0);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
