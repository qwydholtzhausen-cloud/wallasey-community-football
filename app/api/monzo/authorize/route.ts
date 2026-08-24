import { NextResponse } from "next/server";

// The one link a non-technical Monzo account holder needs to click to kick
// off the whole OAuth flow, rather than being handed a URL to construct
// themselves. Requires MONZO_CLIENT_ID to already be set in Vercel (from
// the OAuth client created at developers.monzo.com) - this route exists
// purely to redirect to Monzo's real authorize screen with the right
// client_id/redirect_uri baked in.
const REDIRECT_URI = "https://wirral-community-football.vercel.app/api/monzo/callback";

export async function GET() {
  const clientId = process.env.MONZO_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "MONZO_CLIENT_ID isn't set in Vercel yet - add it, then this link will work." },
      { status: 500 }
    );
  }

  const state = crypto.randomUUID();
  const url = new URL("https://auth.monzo.com/");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
