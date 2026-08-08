import { NextResponse } from "next/server";

// No auth needed - just tells a running client what commit is currently
// live, so it can prompt a refresh if it's running something older.
// Public, unauthenticated, and cheap enough to poll from every open tab.
export async function GET() {
  return NextResponse.json(
    { sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
