import type { SupabaseClient } from "@supabase/supabase-js";

const WEBHOOK_URL = "https://www.wirral-community-football.com/api/monzo/webhook";

interface MonzoTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_id: string | null;
  webhook_registered: boolean;
}

// Access tokens last 30 hours; refreshed here whenever they're within 3
// hours of expiring so the token in the database is always good enough for
// the webhook route to use without needing to refresh mid-request. Returns
// null if there's nothing connected yet, or refresh itself fails (e.g. the
// Monzo holder revoked access) - callers treat that as "not connected".
export async function ensureFreshMonzoToken(admin: SupabaseClient): Promise<MonzoTokenRow | null> {
  const { data: row } = await admin.from("monzo_tokens").select("*").eq("id", true).single();
  if (!row) return null;
  const token = row as MonzoTokenRow;

  const expiresInMs = new Date(token.expires_at).getTime() - Date.now();
  if (expiresInMs > 3 * 60 * 60 * 1000) return token;

  const clientId = process.env.MONZO_CLIENT_ID;
  const clientSecret = process.env.MONZO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return token;

  const res = await fetch("https://api.monzo.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
    }),
  });
  if (!res.ok) return token;

  const fresh = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  await admin
    .from("monzo_tokens")
    .update({ access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("id", true);

  return { ...token, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: expiresAt };
}

// Best-effort: tells Monzo to start POSTing transaction.created events to
// our webhook for this account. Safe to call more than once (Monzo just
// creates another registration pointing at the same URL) but the
// webhook_registered flag stops the refresh cron from doing that on every
// run once it's succeeded once.
export async function registerMonzoWebhook(admin: SupabaseClient, accessToken: string, accountId: string): Promise<boolean> {
  const res = await fetch("https://api.monzo.com/webhooks", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ account_id: accountId, url: WEBHOOK_URL }),
  });
  if (!res.ok) return false;
  await admin.from("monzo_tokens").update({ webhook_registered: true }).eq("id", true);
  return true;
}
