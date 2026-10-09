// Game credits, tested against a real Postgres copy of the club database
// (db.mjs). Each check prints PASS/FAIL; the script exits 1 on any FAIL.
import { makeDb, as } from "./db.mjs";

const { db } = await makeDb();
// Match the live database where schema.sql has drifted (checked 9 Oct):
// live has is_test; live has no Monzo payment_code / auto_confirmed.
await db.exec(`alter table public.profiles add column if not exists is_test boolean not null default false;
  alter table public.profiles drop column if exists payment_code cascade;
  alter table public.bookings drop column if exists auto_confirmed cascade;`);

let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + extra}`); };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// --- people ---
const ids = { admin: "a0000000-0000-0000-0000-000000000001", p1: "b0000000-0000-0000-0000-000000000001", p2: "b0000000-0000-0000-0000-000000000002", p3: "b0000000-0000-0000-0000-000000000003", p4: "b0000000-0000-0000-0000-000000000004", p5: "b0000000-0000-0000-0000-000000000005" };
for (const [k, id] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, `${k}@test.local`, JSON.stringify({ display_name: k.toUpperCase() })]);
  const has = await one(`select id from public.profiles where id = $1`, [id]);
  if (!has) await db.query(`insert into public.profiles (id, display_name) values ($1, $2)`, [id, k.toUpperCase()]);
  await db.query(`update public.profiles set display_name = $2, role = $3, status = 'active' where id = $1`, [id, k.toUpperCase(), k === "admin" ? "admin" : "player"]);
}
// --- fixtures (UK dates, like the app) ---
const day = (n) => `(timezone('Europe/London', now())::date + ${n})`;
const mk = async (label, n, price, max, kickoff = "20:00") =>
  (await one(`insert into public.games (date, kickoff, venue, pitch, price, max_players, published) values (${day(n)}, $1, 'Solar Campus', '8-a-side', $2, $3, true) returning id`, [kickoff, price, max])).id;
const G = {
  a: await mk("a", 5, 5, 2), // 2 places so a waiting list forms
  b: await mk("b", 6, 5, 16),
  c: await mk("c", 7, 5, 16),
  sp: await mk("sp", 10, 7, 22, "12:00"), // the £7 special
  d: await mk("d", 8, 5, 16),
  past: await mk("past", -1, 5, 16),
};
const book = async (game, player, status = "unpaid", extra = {}) => {
  const b = await one(`insert into public.bookings (game_id, player_id) values ($1, $2) returning id, waiting`, [game, player]);
  await db.query(`update public.bookings set status = $2, pot_exempt_reason = $3 where id = $1`, [b.id, status, extra.exempt ?? null]);
  return b;
};
const creditsOf = (p) => q(`select * from public.player_credits where player_id = $1 order by created_at, id`, [p]);
const msgsOf = (p) => q(`select message from public.admin_messages where recipient_id = $1 order by created_at`, [p]);
const delAs = (who, bookingId) => as(db, who, () => db.query(`delete from public.bookings where id = $1`, [bookingId]));
const rpcAs = (who, fn, args) => as(db, who, () => db.query(`select public.${fn}(${args.map((_, i) => "$" + (i + 1)).join(", ")}) as r`, args));

console.log("\n— Earning a credit by dropping out —");
const a1 = await book(G.a, ids.p1, "confirmed");
const a2 = await book(G.a, ids.p2, "unpaid");
const a3 = await book(G.a, ids.p3, "unpaid"); // 3rd on a 2-place game -> waiting
check("setup: 3rd booking on a full game goes on the waiting list", a3.waiting === true);
await delAs(ids.p1, a1.id);
let c = await creditsOf(ids.p1);
check("paid (approved) drop-out by the player gives 1 available credit", c.length === 1 && c[0].status === "available" && c[0].source === "dropout" && c[0].source_game_id === G.a, JSON.stringify(c));
check("…worth £5", c[0]?.value === 5);
check("…and sends them an inbox message", (await msgsOf(ids.p1)).some((m) => /so you've got a game credit/.test(m.message)));
check("existing rule still works: waiting list moves up", (await one(`select waiting from public.bookings where id = $1`, [a3.id])).waiting === false);
check("existing rule still works: drop-out is logged", !!(await one(`select 1 from public.booking_cancellations where player_id = $1 and game_id = $2 and reason = 'self'`, [ids.p1, G.a])));

const b2 = await book(G.b, ids.p2, "pending");
await delAs(ids.p2, b2.id);
c = await creditsOf(ids.p2);
check("'I've paid' (not yet approved) drop-out waits for an admin check", c.length === 1 && c[0].status === "awaiting_check", JSON.stringify(c));
check("…with no inbox message yet", (await msgsOf(ids.p2)).length === 0);

const b4 = await book(G.b, ids.p4, "unpaid");
await delAs(ids.p4, b4.id);
check("unpaid drop-out gives no credit", (await creditsOf(ids.p4)).length === 0);

const w = await book(G.a, ids.p5, "confirmed"); // game a is full again -> waiting
check("setup: p5 is on the waiting list", w.waiting === true);
await delAs(ids.p5, w.id);
check("leaving the waiting list gives no credit, even if marked paid", (await creditsOf(ids.p5)).length === 0);

const bd = await book(G.c, ids.p5, "confirmed", { exempt: "birthday" });
await delAs(ids.p5, bd.id);
check("dropping out of a free (birthday) game gives no credit", (await creditsOf(ids.p5)).length === 0);

const pastB = await book(G.past, ids.p4, "confirmed");
await as(db, ids.admin, () => db.query(`delete from public.bookings where id = $1`, [pastB.id]));
check("removed after kick-off (no-show) gives no credit", (await creditsOf(ids.p4)).length === 0);

const adminRemoved = await book(G.d, ids.p4, "confirmed");
await as(db, ids.admin, () => db.query(`delete from public.bookings where id = $1`, [adminRemoved.id]));
check("admin removing a paid player before kick-off gives them a credit", (await creditsOf(ids.p4)).filter((x) => x.status === "available").length === 1);

console.log("\n— Spending a credit —");
const p1b = await book(G.b, ids.p1, "unpaid");
let r = await rpcAs(ids.p1, "use_credit", [p1b.id]);
check("Use credit on a £5 game returns £0 left to pay", r.rows[0].r === 0, JSON.stringify(r.rows));
check("…and confirms the booking straight away", (await one(`select status from public.bookings where id = $1`, [p1b.id])).status === "confirmed");
c = await creditsOf(ids.p1);
check("…marks the credit used on that booking", c[0].status === "used" && c[0].used_on_booking_id === p1b.id);
check("…and sends a message", (await msgsOf(ids.p1)).some((m) => /Your credit paid for/.test(m.message)));
const p1c = await book(G.c, ids.p1, "unpaid");
check("with no credit left, Use credit is refused", /don't have a credit/.test(await err(() => rpcAs(ids.p1, "use_credit", [p1c.id])) ?? ""));

const p2own = await book(G.c, ids.p2, "unpaid");
check("can't spend a credit on someone else's booking", /isn't yours/.test(await err(() => rpcAs(ids.p4, "use_credit", [p2own.id])) ?? ""));
const p4wait = await book(G.a, ids.p4, "unpaid"); // still full -> waiting
check("can't use a credit while on the waiting list", p4wait.waiting && /waiting list/.test(await err(() => rpcAs(ids.p4, "use_credit", [p4wait.id])) ?? ""));
const p4paid = await book(G.c, ids.p4, "confirmed");
check("can't use a credit on a game already paid", /doesn't need paying/.test(await err(() => rpcAs(ids.p4, "use_credit", [p4paid.id])) ?? ""));
const p4past = await book(G.past, ids.p4, "unpaid");
check("can't use a credit on a game that has kicked off", /haven't kicked off/.test(await err(() => rpcAs(ids.p4, "use_credit", [p4past.id])) ?? ""));
check("p4 still has their 1 credit after the refused attempts", (await creditsOf(ids.p4)).filter((x) => x.status === "available").length === 1);

console.log("\n— The £7 special game —");
const sp = await book(G.sp, ids.p4, "unpaid");
r = await rpcAs(ids.p4, "use_credit", [sp.id]);
check("Use credit on the £7 game returns £2 left to pay", r.rows[0].r === 2, JSON.stringify(r.rows));
check("…booking stays unpaid until the £2 is paid", (await one(`select status from public.bookings where id = $1`, [sp.id])).status === "unpaid");
check("…message says £2 left", (await msgsOf(ids.p4)).some((m) => /covered £5 .* £2 left to pay/.test(m.message)));
await rpcAs(ids.admin, "admin_add_credit", [ids.p4, null]);
check("a second credit can't go on the same game", /already used a credit/.test(await err(() => rpcAs(ids.p4, "use_credit", [sp.id])) ?? ""));
await as(db, ids.p4, () => db.query(`update public.bookings set status = 'pending' where id = $1`, [sp.id]));
check("player can still mark the £2 as paid ('I've paid')", (await one(`select status from public.bookings where id = $1`, [sp.id])).status === "pending");

console.log("\n— Dropping out of a game paid with a credit —");
const before = (await creditsOf(ids.p1)).length;
await delAs(ids.p1, p1b.id);
c = await creditsOf(ids.p1);
check("the same credit comes back (no extra one created)", c.length === before && c.filter((x) => x.status === "available").length === 1 && c[0].used_on_booking_id === null, JSON.stringify(c.map((x) => x.status)));
check("…with a message saying so", (await msgsOf(ids.p1)).some((m) => /credit is back/.test(m.message)));

console.log("\n— Who can see and change credits —");
const seenByP1 = await as(db, ids.p1, () => q(`select player_id from public.player_credits`));
check("a player sees only their own credits", seenByP1.length > 0 && seenByP1.every((x) => x.player_id === ids.p1), JSON.stringify(seenByP1));
const seenByAdmin = await as(db, ids.admin, () => q(`select distinct player_id from public.player_credits`));
check("an admin sees everyone's", seenByAdmin.length >= 3);
check("a player can't give themselves a credit (insert blocked)", !!(await err(() => as(db, ids.p2, () => db.query(`insert into public.player_credits (player_id, source) values ($1, 'admin')`, [ids.p2])))));
await as(db, ids.p2, () => db.query(`update public.player_credits set status = 'available' where player_id = $1`, [ids.p2]));
check("a player can't approve their own pending credit (update has no effect)", (await creditsOf(ids.p2))[0].status === "awaiting_check");
check("a player can't call the admin add-credit", /Only admins/.test(await err(() => rpcAs(ids.p2, "admin_add_credit", [ids.p2, "x"])) ?? ""));
const p2check = (await creditsOf(ids.p2))[0].id;
check("a player can't resolve a check", /Only admins/.test(await err(() => rpcAs(ids.p2, "resolve_credit_check", [p2check, true])) ?? ""));

console.log("\n— Admin tools —");
const auditBefore = (await one(`select count(*)::int n from public.audit_log`)).n;
const addRes = await rpcAs(ids.admin, "admin_add_credit", [ids.p5, "  Paid cash, dropped out 5 Oct  "]);
check("Add credit hands back the inbox message (for the push)", !!(await one(`select 1 from public.admin_messages where id = $1 and recipient_id = $2`, [addRes.rows[0].r, ids.p5])), JSON.stringify(addRes.rows));
c = await creditsOf(ids.p5);
check("Add credit gives the player an available credit with the note", c.length === 1 && c[0].status === "available" && c[0].source === "admin" && c[0].note === "Paid cash, dropped out 5 Oct", JSON.stringify(c));
check("…messages the player", (await msgsOf(ids.p5)).some((m) => /given you a game credit/.test(m.message)));
check("…and writes the activity log", (await one(`select count(*)::int n from public.audit_log`)).n === auditBefore + 1);
await rpcAs(ids.admin, "admin_cancel_credit", [ids.p5]);
check("Cancel a credit cancels it", (await creditsOf(ids.p5))[0].status === "cancelled");
check("cancelling when they have none is refused", /don't have a credit/.test(await err(() => rpcAs(ids.admin, "admin_cancel_credit", [ids.p5])) ?? ""));
const check2 = (await creditsOf(ids.p2))[0];
const yesRes = await rpcAs(ids.admin, "resolve_credit_check", [check2.id, true]);
check("'Yes' hands back the inbox message (for the push)", !!(await one(`select 1 from public.admin_messages where id = $1 and recipient_id = $2`, [yesRes.rows[0].r, ids.p2])));
check("'Yes, give credit' makes the waiting credit available", (await creditsOf(ids.p2))[0].status === "available");
check("…and messages the player", (await msgsOf(ids.p2)).some((m) => /confirmed your payment/.test(m.message)));
check("resolving the same check twice is refused", /Already sorted/.test(await err(() => rpcAs(ids.admin, "resolve_credit_check", [check2.id, true])) ?? ""));
const p3pend = await book(G.d, ids.p3, "pending");
await delAs(ids.p3, p3pend.id);
const p3check = (await creditsOf(ids.p3))[0].id;
const noRes = await rpcAs(ids.admin, "resolve_credit_check", [p3check, false]);
check("'No' hands back nothing to push", noRes.rows[0].r === null);
check("'No' marks it declined, no credit", (await creditsOf(ids.p3))[0].status === "declined" && (await msgsOf(ids.p3)).length === 0);

console.log("\n— Spending order and double spending —");
await rpcAs(ids.admin, "admin_add_credit", [ids.p3, "first"]);
await rpcAs(ids.admin, "admin_add_credit", [ids.p3, "second"]);
const x1 = await book(G.b, ids.p3, "unpaid"), x2 = await book(G.c, ids.p3, "unpaid"), x3 = await book(G.d, ids.p3, "unpaid");
await rpcAs(ids.p3, "use_credit", [x1.id]);
check("the oldest credit is spent first", (await creditsOf(ids.p3)).find((x) => x.note === "first").status === "used");
await rpcAs(ids.p3, "use_credit", [x2.id]);
check("2 credits pay for exactly 2 games; the 3rd is refused", /don't have a credit/.test(await err(() => rpcAs(ids.p3, "use_credit", [x3.id])) ?? ""));

console.log("\n— Deleting a whole fixture —");
const gx = await mk("gx", 9, 5, 16);
await book(gx, ids.p5, "confirmed");
const delErr = await err(() => db.query(`delete from public.games where id = $1`, [gx]));
check("deleting a fixture with paid bookings works (no error)", delErr === null, delErr);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
