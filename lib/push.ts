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
}

// Every trigger point (booking, fixture creation, cron jobs, webhooks) goes
// through this - it's the one place that knows how to actually reach a
// device, so opt-out and dead-subscription cleanup only need handling once.
export async function sendPushToUsers(userIds: string[], payload: PushPayload) {
  if (userIds.length === 0) return;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: optedIn } = await admin.from("profiles").select("id").in("id", userIds).eq("push_opt_in", true);
  const allowedIds = (optedIn ?? []).map((p) => p.id);
  if (allowedIds.length === 0) return;

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .in("user_id", allowedIds);
  if (!subs || subs.length === 0) return;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          JSON.stringify(payload)
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Stale (uninstalled, permission revoked, storage cleared) -
          // clean it up rather than retrying a dead endpoint forever.
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          console.error("Push send failed for subscription", sub.id, err);
        }
      }
    })
  );
}

export async function sendPushBroadcast(payload: PushPayload, excludeUserId?: string) {
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profiles } = await admin.from("profiles").select("id").eq("push_opt_in", true);
  const ids = (profiles ?? []).map((p) => p.id).filter((id) => id !== excludeUserId);
  await sendPushToUsers(ids, payload);
}
