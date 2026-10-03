// Gives the "Qwyd Test Account" a password so the smoke tests can sign in
// as it (the app itself signs people in with emailed codes, which a script
// can't receive). Run it yourself, once:
//
//   1. Add a line to .env.local:  TEST_PLAYER_PASSWORD=<a long password>
//   2. node --env-file=.env.local scripts/set-test-password.mjs
//
// It only ever touches this one account, and refuses if that account has
// become an admin or has any real history.
import { createClient } from "@supabase/supabase-js";

const TEST_PLAYER_ID = "fc8a3e7d-4f5a-42e4-818c-d610f0c22aef";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.TEST_PLAYER_PASSWORD;
if (!url || !key) throw new Error("Run with --env-file=.env.local so the Supabase settings are loaded.");
if (!password || password.length < 12) throw new Error("Set TEST_PLAYER_PASSWORD in .env.local first (12+ characters).");

const admin = createClient(url, key, { auth: { persistSession: false } });

const { data: profile, error } = await admin.from("profiles").select("id, display_name, role").eq("id", TEST_PLAYER_ID).single();
if (error || !profile) throw new Error("Couldn't find the test account.");
if (profile.display_name !== "Qwyd Test Account") throw new Error(`Refusing: that account is now called "${profile.display_name}".`);
if (profile.role !== "player") throw new Error(`Refusing: the test account has role "${profile.role}", not player.`);
const { count } = await admin.from("game_stats").select("*", { count: "exact", head: true }).eq("player_id", TEST_PLAYER_ID);
if (count) throw new Error("Refusing: the test account has goals recorded, so it may be a real player now.");

const { data: user, error: upErr } = await admin.auth.admin.updateUserById(TEST_PLAYER_ID, { password });
if (upErr) throw upErr;
console.log(`Done. Password set for ${profile.display_name} (${user.user.email}).`);
console.log(`Add this line to .env.local too:  TEST_PLAYER_EMAIL=${user.user.email}`);
