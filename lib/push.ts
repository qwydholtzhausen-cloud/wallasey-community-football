import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT!,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  // Groups sends for the open-rate numbers GaffAI reports; defaults to a
  // slug of the title ("Teams are out 👕" -> "teams-are-out").
  kind?: string;
}

function kindFromTitle(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "notification"
  );
}

export interface PushResult {
  sent: number;
  failed: number;
}

// Every trigger point (booking, fixture creation, cron jobs, webhooks) goes
// through this - it's the one place that knows how to actually reach a
// device, so opt-out and dead-subscription cleanup only need handling once.
// Returns counts rather than void so callers (notably the test-push route)
// can tell "nothing to send to" apart from "sent successfully" - a silent
// void return here is exactly what made the original delivery problem hard
// to diagnose.
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<PushResult> {
  if (userIds.length === 0) return { sent: 0, failed: 0 };
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: optedIn } = await admin.from("profiles").select("id").in("id", userIds).eq("push_opt_in", true);
  const allowedIds = (optedIn ?? []).map((p) => p.id);
  if (allowedIds.length === 0) return { sent: 0, failed: 0 };

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth_key")
    .in("user_id", allowedIds);
  if (!subs || subs.length === 0) return { sent: 0, failed: 0 };

  // One row per person reached, so taps can be counted. Its random id rides
  // along in the payload and the service worker reports it back on tap.
  // Best-effort: if the table's missing or the insert fails, the push
  // still goes out, just untracked.
  const sendIds = new Map<string, string>();
  try {
    const reached = [...new Set(subs.map((s) => s.user_id))];
    const kind = payload.kind ?? kindFromTitle(payload.title);
    const { data: rows } = await admin
      .from("notification_sends")
      .insert(reached.map((player_id) => ({ player_id, kind, title: payload.title })))
      .select("id, player_id");
    for (const r of rows ?? []) sendIds.set(r.player_id, r.id);
  } catch (err) {
    console.error("Logging notification sends failed", err);
  }

  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          JSON.stringify({ ...payload, sid: sendIds.get(sub.user_id) })
        );
        sent++;
      } catch (err) {
        failed++;
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Stale (uninstalled, permission revoked, storage cleared) -
          // clean it up rather than retrying a dead endpoint forever.
          // Resetting push_opt_in alongside it matters just as much as
          // the delete itself - without this, the toggle kept saying
          // "on" for someone with zero working subscription behind it,
          // which is exactly how it silently drifted out of sync before.
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
          await admin.from("profiles").update({ push_opt_in: false }).eq("id", sub.user_id);
        } else {
          console.error("Push send failed for subscription", sub.id, err);
        }
      }
    })
  );

  return { sent, failed };
}

export async function sendPushBroadcast(payload: PushPayload, excludeUserId?: string): Promise<PushResult> {
  const admin = createClient(supabaseUrl, serviceKey);
  // Members only: anyone waiting for approval (or declined) is left out.
  // "*" rather than naming status, so this still works before that column exists.
  const { data: profiles } = await admin.from("profiles").select("*").eq("push_opt_in", true);
  const ids = (profiles ?? [])
    .filter((p: { status?: string }) => (p.status ?? "active") === "active")
    .map((p: { id: string }) => p.id)
    .filter((id) => id !== excludeUserId);
  return sendPushToUsers(ids, payload);
}
