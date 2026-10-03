import type { SupabaseClient } from "@supabase/supabase-js";

// Test accounts (profiles.is_test) sign in like anyone else so the smoke
// tests can drive the real app, but they're hidden from every member list,
// the Feed, Stats and GaffAI. Any error - e.g. before the column exists -
// just means nobody's hidden.
export async function testAccountIds(admin: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await admin.from("profiles").select("id").eq("is_test", true);
  return new Set(error ? [] : (data ?? []).map((r: { id: string }) => r.id));
}
