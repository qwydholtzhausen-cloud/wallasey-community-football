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
let page = await context.newPage();

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
await step("Game Stories", async () => {
  const ring = page.locator(".wcf-story-ring").first();
  if (!(await ring.count())) return; // a new month with no games yet
  await ring.dispatchEvent("click");
  await page.locator(".wcf-story .card").waitFor({ timeout: 8000 });
  for (let i = 0; i < 10 && (await page.locator(".wcf-story").count()); i++) {
    await page.locator(".wcf-story .tapzones button[aria-label='Next']").dispatchEvent("click");
    await page.waitForTimeout(250);
  }
  if (await page.locator(".wcf-story").count()) throw new Error("The story didn't close after its last card");
});
await step("Boot Room", async () => {
  await page.locator(".wcf-feed-hero-tabs button", { hasText: "Boot Room" }).first().dispatchEvent("click");
  await page.waitForSelector("[class^='wcf-br-'], [class*=' wcf-br-']", { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.locator(".wcf-feed-hero-tabs button", { hasText: "Feed" }).first().dispatchEvent("click");
});
await step("Line-up", async () => tab("Line-up", "Next game line-up"));
for (const sub of ["Team Sheet", "Predict"]) {
  await step(`Line-up: ${sub}`, async () => {
    await page.locator(".wcf-subtabs button", { hasText: sub }).first().dispatchEvent("click");
    await page.waitForFunction((t) => document.querySelector(".wcf-subtabs button.active")?.textContent?.trim() === t, sub, { timeout: 8000 });
    await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelector(".wcf-main")?.scrollTo(0, 0));
  });
}
// Two-game nights: switch Line-up to the other game and check it follows.
await step("Line-up: second game", async () => {
  await tab("Line-up", "Next game line-up");
  const picks = page.locator(".wcf-gamepick button");
  if ((await picks.count()) < 2) return;
  await page.locator(".wcf-subtabs button", { hasText: "Team Sheet" }).first().dispatchEvent("click");
  const before = await page.locator(".wcf-main").innerText();
  await picks.nth(1).dispatchEvent("click");
  await page.waitForFunction(() => document.querySelectorAll(".wcf-gamepick button")[1]?.classList.contains("active"), null, { timeout: 8000 });
  await page.waitForTimeout(900);
  if ((await page.locator(".wcf-main").innerText()) === before) throw new Error("Switching game didn't change the Line-up");
});
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
  await page.waitForTimeout(900);
});

// ── Admin pass ──
// The test account is a player at rest (its password is simple, so it must
// never be a standing admin). For this pass only it's promoted to admin,
// then put back to player - in a finally, so a failed check can't leave it
// an admin. Look-only: it presses Generate (which only suggests teams on
// screen) but never "Use these teams", and never sends, saves or deletes.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (process.env.SMOKE_ADMIN !== "0" && serviceKey) {
  const svc = createClient(url, serviceKey, { auth: { persistSession: false } });
  const setRole = async (role) => {
    const { error } = await svc.from("profiles").update({ role }).eq("id", auth.user.id).eq("is_test", true);
    if (error) throw new Error(`Couldn't set the test account's role: ${error.message}`);
  };
  try {
    await setRole("admin");
    const adminCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await adminCtx.addInitScript(([k, v]) => localStorage.setItem(k, v), [storageKey, JSON.stringify(auth.session)]);
    const adminPage = await adminCtx.newPage();
    adminPage.on("pageerror", (e) => problems.push(`Page error: ${e.message}`));
    adminPage.on("console", (m) => {
      if (m.type() === "error" && !/favicon|Failed to load resource: net::ERR_ABORTED/.test(m.text())) problems.push(`Console error: ${m.text().slice(0, 200)}`);
    });
    adminPage.on("response", (r) => {
      if (r.status() >= 400 && r.url().includes(".supabase.co")) problems.push(`HTTP ${r.status()} from ${new URL(r.url()).pathname}`);
    });
    page = adminPage;
    await step("Admin: open the app", async () => {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".wcf-sp", { state: "detached", timeout: 20000 });
      await page.locator(".wcf-navbtn", { hasText: "Admin" }).first().waitFor({ timeout: 10000 });
    });
    await step("Admin tab", async () => tab("Admin", "Admin"));
    for (const sub of ["Today", "Fixtures", "Payments", "Messages"]) {
      await step(`Admin: ${sub}`, async () => {
        await page.locator(".wcf-admin-tabs button", { hasText: sub }).first().dispatchEvent("click");
        await page.waitForFunction((t) => document.querySelector(".wcf-admin-tabs button.active")?.textContent?.trim().startsWith(t), sub, { timeout: 8000 });
        await page.waitForTimeout(900);
        await page.evaluate(() => document.querySelector(".wcf-main")?.scrollTo(0, 0));
      });
    }
    await step("Admin: Line-up Teams", async () => {
      await tab("Line-up", "Next game line-up");
      await page.locator(".wcf-subtabs button", { hasText: "Teams" }).first().dispatchEvent("click");
      await page.waitForFunction(() => document.querySelector(".wcf-subtabs button.active")?.textContent?.trim() === "Teams", null, { timeout: 8000 });
      await page.waitForTimeout(900);
    });
    await step("Admin: Teams for the second game", async () => {
      const picks = page.locator(".wcf-gamepick button");
      if ((await picks.count()) < 2) return;
      await picks.nth(1).dispatchEvent("click");
      await page.waitForFunction(() => document.querySelectorAll(".wcf-gamepick button")[1]?.classList.contains("active"), null, { timeout: 8000 });
      await page.waitForTimeout(900);
    });
    // Random split, so its screenshot differs run to run; compare ignores it.
    await step("Admin: Generate teams (random)", async () => {
      const gen = page.locator("button", { hasText: /^(Generate teams|Generate a new split|↻ Shuffle again|Shuffle)/ }).first();
      if (!(await gen.count())) throw new Error("No Generate button on the Teams screen");
      await gen.dispatchEvent("click");
      await page.locator("button", { hasText: "Use these teams" }).first().waitFor({ timeout: 8000 });
      await page.waitForTimeout(600);
    });
    // GaffAI's "thinking" board shows while it works. The reply is held
    // and faked here, so nothing reaches the AI (no cost, no chat saved).
    await step("Admin: GaffAI thinking board", async () => {
      await adminCtx.route("**/api/admin/gaffai", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        if (body.type === "message") { await new Promise((r) => setTimeout(r, 2500)); return route.fulfill({ json: { reply: "Smoke test reply.", history: [] } }); }
        return route.continue();
      });
      await page.locator(".gaffai-fab").dispatchEvent("click");
      await page.locator(".gaffai-composer input").waitFor({ timeout: 8000 });
      await page.locator(".gaffai-composer input").fill("Smoke test");
      await page.locator(".gaffai-send").dispatchEvent("click");
      await page.waitForTimeout(900);
      const h = await page.evaluate(() => document.querySelector(".gaffai-tiki, .gaffai-typing")?.getBoundingClientRect().height ?? 0);
      if (h < 20) throw new Error(`GaffAI's thinking board isn't visible (height ${h})`);
      await page.waitForTimeout(2400);
      await page.locator(".gaffai-sheet-close").first().dispatchEvent("click", undefined, { timeout: 3000 }).catch(() => {});
    });
    await step("Admin: Account", async () => {
      await page.locator(".wcf-role").first().dispatchEvent("click");
      await page.waitForFunction(() => document.querySelector(".wcf-heading h2")?.textContent?.startsWith("Your account"), null, { timeout: 10000 });
      await page.waitForTimeout(900);
    });
    await adminCtx.close();
  } finally {
    await setRole("player");
  }
}

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
