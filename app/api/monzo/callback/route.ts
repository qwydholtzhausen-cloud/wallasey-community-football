import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { registerMonzoWebhook } from "../../../../lib/monzo";

// Where Monzo redirects back to after the account holder approves access
// in their Monzo app. Exchanges the one-time authorization code for a
// long-lived refresh token + short-lived access token, then stores them in
// the monzo_tokens table (server-only, no RLS policy grants any client
// access to it) for the background refresh job to use from here on. This
// exact URL has to be registered character-for-character as the Redirect
// URL on the OAuth client at developers.monzo.com.
const REDIRECT_URI = "https://www.wirral-community-football.com/api/monzo/callback";

function htmlPage(title: string, body: string, ok: boolean) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8" /><title>${title}</title></head>
    <body style="font-family:-apple-system,sans-serif;background:#0d0d1a;color:#F5F6F8;text-align:center;padding:70px 24px;">
      <div style="font-size:40px;margin-bottom:12px;">${ok ? "✅" : "⚠️"}</div>
      <h1 style="font-size:20px;">${title}</h1>
      <p style="color:#94a3b8;max-width:340px;margin:10px auto 0;line-height:1.5;">${body}</p>
    </body></html>`,
    { status: ok ? 200 : 500, headers: { "Content-Type": "text/html" } }
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const monzoError = req.nextUrl.searchParams.get("error");
  if (monzoError) {
    return htmlPage("Monzo declined this", "Nothing was connected. You can close this page and try again from the link you were sent.", false);
  }
  if (!code) {
    return htmlPage("Missing code", "Monzo didn't send back an authorization code. Close this page and try the link again.", false);
  }

  const clientId = process.env.MONZO_CLIENT_ID;
  const clientSecret = process.env.MONZO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return htmlPage("Not set up yet", "MONZO_CLIENT_ID / MONZO_CLIENT_SECRET aren't configured in Vercel yet.", false);
  }

  const tokenRes = await fetch("https://api.monzo.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      code,
    }),
  });

  if (!tokenRes.ok) {
    return htmlPage("Monzo rejected this", "The token exchange failed - close this page and let whoever's setting this up know.", false);
  }

  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Find the actual account to watch for payments - the everyday spending
  // account, not a savings Pot, and not a closed/old one.
  const accountsRes = await fetch("https://api.monzo.com/accounts", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const accountsBody = accountsRes.ok ? ((await accountsRes.json()) as { accounts: { id: string; closed: boolean; type: string }[] }) : null;
  const account = accountsBody?.accounts.find((a) => !a.closed && (a.type === "uk_retail" || a.type === "uk_retail_joint"));

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error } = await supabase.from("monzo_tokens").upsert({
    id: true,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    account_id: account?.id ?? null,
    webhook_registered: false,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return htmlPage("Connected, but not saved", "Monzo approved access but saving it failed - let whoever's setting this up know.", false);
  }

  if (account) {
    await registerMonzoWebhook(supabase, tokens.access_token, account.id);
  }

  return htmlPage("Connected!", "Wirral Community Football is now linked to this Monzo account. You can close this page.", true);
}
