import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Called by the service worker when someone taps a notification. The body
// is just the random id of their notification_sends row (it travelled in
// the push itself), so no login is needed and a guessed id can do nothing
// but mark a notification as opened. First tap only.
export async function POST(req: Request) {
  let sid: unknown;
  try {
    ({ sid } = await req.json());
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof sid !== "string" || !/^[0-9a-f-]{36}$/i.test(sid)) return new NextResponse(null, { status: 400 });

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  await admin.from("notification_sends").update({ opened_at: new Date().toISOString() }).eq("id", sid).is("opened_at", null);
  return new NextResponse(null, { status: 204 });
}
