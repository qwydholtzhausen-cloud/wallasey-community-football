// Smoke test: signs in as the test player (profiles.is_test) on a phone-sized
// screen and walks the real app - Fixtures, a player card, Feed, Line-up,
// Results, Account - checking each screen loads with no errors, and saving
// a screenshot of each. Read-only: it never books, votes or posts.
//
//   npm run smoke                         live site
//   npm run smoke -- http://localhost:3000   a local build
//
// Needs TEST_PLAYER_EMAIL and TEST_PLAYER_PASSWORD in .env.local
// (see scripts/set-test-password.mjs).
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] || "https://www.wirral-community-football.com";
const OUT = "smoke-output";
const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, TEST_PLAYER_EMAIL: email, TEST_PLAYER_PASSWORD: password } = process.env;
if (!url || !anonKey || !email || !password) {
  console.error("Missing settings. Run with: node --env-file=.env.local scripts/smoke.mjs");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// Sign in once here, then hand the session to the browser the same way the
// app stores it, so the page opens already signed in.
const sb = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password });
if (authErr) {
  console.error("Couldn't sign in as the test player:", authErr.message);
  process.exit(2);
}
const { data: me } = await sb.from("profiles").select("is_test").eq("id", auth.user.id).single();
if (!me?.is_test) {
  console.error("Refusing: that login isn't marked as a test account (profiles.is_test).");
  process.exit(2);
}
const storageKey = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  // Reduce Motion: the app skips its big moments, so nothing pops over the
  // screens being checked.
  reducedMotion: "reduce",
});
await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [storageKey, JSON.stringify(auth.session)]);
const page = await context.newPage();

const problems = [];
page.on("pageerror", (e) => problems.push(`Page error: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon|Failed to load resource: net::ERR_ABORTED/.test(m.text())) problems.push(`Console error: ${m.text().slice(0, 200)}`);
});
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().includes(".supabase.co")) problems.push(`HTTP ${r.status()} from ${new URL(r.url()).pathname}`);
});

const results = [];
async function step(name, fn) {
  const before = problems.length;
  const t0 = Date.now();
  try {
    await fn();
    const shot = `${OUT}/${String(results.length + 1).padStart(2, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
    await page.screenshot({ path: shot });
    // The whole screen's text too, so a before/after comparison catches
    // changes below the fold.
    const text = await page.evaluate(() => document.querySelector(".wcf-main")?.innerText ?? "").catch(() => "");
    writeFileSync(shot.replace(/\.png$/, ".txt"), text);
    const fresh = problems.slice(before);
    results.push({ name, ok: fresh.length === 0, ms: Date.now() - t0, notes: fresh });
  } catch (e) {
    await page.screenshot({ path: `${OUT}/FAILED-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png` }).catch(() => {});
    results.push({ name, ok: false, ms: Date.now() - t0, notes: [String(e.message || e).split("\n")[0], ...problems.slice(before)] });
  }
}
const heading = () => page.locator(".wcf-heading h2").first();
async function tab(label, expected) {
  await page.locator(".wcf-navbtn", { hasText: label }).first().dispatchEvent("click");
  await page.waitForFunction((t) => document.querySelector(".wcf-heading h2")?.textContent?.startsWith(t), expected, { timeout: 10000 });
  await page.waitForTimeout(600);
}

await step("Open the app", async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".wcf-sp", { state: "detached", timeout: 20000 });
  await heading().waitFor({ timeout: 10000 });
  const h = await heading().textContent();
  if (!h?.startsWith("Upcoming fixtures")) throw new Error(`Expected Fixtures, got "${h}"`);
});
await step("Fixtures has games", async () => {
  const cards = await page.locator(".wcf-card").count();
  if (cards === 0 && !(await page.locator(".wcf-es").count())) throw new Error("No fixture cards and no empty screen");
});
await step("Player card", async () => {
  await tab("Line-up", "Next game line-up");
  const chip = page.locator(".wcf-lineup-chip").first();
  if (!(await chip.count())) throw new Error("No players on the team sheet to open");
  await chip.dispatchEvent("click");
  await page.waitForSelector(".wcf-pcard", { timeout: 8000 });
  await page.waitForTimeout(2200);
});
await step("Feed", async () => {
  await page.locator(".wcf-lightbox-close").first().dispatchEvent("click").catch(() => {});
  await tab("Feed", "Club feed");
  if (!(await page.locator(".wcf-feed-item, .wcf-es").count())) throw new Error("Feed shows neither posts nor the empty screen");
  const testPost = await page.locator(".wcf-feed-item", { hasText: "Qwyd Test Account" }).count();
  if (testPost) throw new Error("The test account is showing on the Feed");
});
await step("Boot Room", async () => {
  await page.locator(".wcf-feed-hero-tabs button", { hasText: "Boot Room" }).first().dispatchEvent("click");
  await page.waitForSelector("[class^='wcf-br-'], [class*=' wcf-br-']", { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.locator(".wcf-feed-hero-tabs button", { hasText: "Feed" }).first().dispatchEvent("click");
});
await step("Line-up", async () => tab("Line-up", "Next game line-up"));
await step("Results", async () => tab("Results", "Results"));
for (const sub of ["Season", "Stats", "Records", "Scores", "Pot"]) {
  await step(`Results: ${sub}`, async () => {
    await page.locator(".wcf-subtabs button", { hasText: sub }).first().dispatchEvent("click");
    await page.waitForFunction((t) => document.querySelector(".wcf-subtabs button.active")?.textContent?.trim() === t, sub, { timeout: 8000 });
    await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelector(".wcf-main")?.scrollTo(0, 0));
  });
}
await step("Account", async () => {
  await page.locator(".wcf-role").first().dispatchEvent("click");
  await page.waitForFunction(() => document.querySelector(".wcf-heading h2")?.textContent?.startsWith("Your account"), null, { timeout: 10000 });
});

await browser.close();
await sb.auth.signOut();

console.log(`\nSmoke test against ${BASE}\n`);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
  for (const n of r.notes) console.log(`        ${n}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${OUT}/`);
process.exit(failed ? 1 : 0);
