import type { SupabaseClient } from "@supabase/supabase-js";

// Every key in notified_events (what the crons have already sent). Read a
// page at a time: a plain select stops at 1,000 rows, and once the table
// passed that, any key beyond the first 1,000 looked unsent, so its push
// went out again on every run (every 5 minutes) - 577 to one player in two
// weeks (10 Nov 2026).
export async function loadNotifiedKeys(admin: SupabaseClient): Promise<Set<string>> {
  const keys = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from("notified_events").select("event_key").order("event_key").range(from, from + PAGE - 1);
    if (error) throw new Error(`notified_events: ${error.message}`);
    for (const r of data ?? []) keys.add(r.event_key as string);
    if (!data || data.length < PAGE) break;
  }
  return keys;
}
