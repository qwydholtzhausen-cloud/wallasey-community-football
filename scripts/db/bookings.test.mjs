// Booking, waiting list, drop-outs and payments, tested against a real
// Postgres copy of the club database (db.mjs). These are the rules the
// Fixtures and Admin screens rely on, so a change to either (or to the
// SQL) that breaks one shows up here first. Exits 1 on any FAIL.
import { makeDb, as } from "./db.mjs";

const { db } = await makeDb();
// Match the live database where schema.sql has drifted (checked 9 Oct).
await db.exec(`alter table public.profiles add column if not exists is_test boolean not null default false;
  alter table public.profiles drop column if exists payment_code cascade;
  alter table public.bookings drop column if exists auto_confirmed cascade;`);

let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + extra}`); };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// --- people: an admin, 14 players, and one member still waiting for approval ---
const ids = { admin: "a0000000-0000-0000-0000-000000000001", pending: "c0000000-0000-0000-0000-000000000001" };
for (let i = 1; i <= 14; i++) ids["p" + i] = `b0000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
for (const [k, id] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, `${k}@test.local`, JSON.stringify({ display_name: k.toUpperCase() })]);
  if (!(await one(`select id from public.profiles where id = $1`, [id]))) await db.query(`insert into public.profiles (id, display_name) values ($1, $2)`, [id, k.toUpperCase()]);
  await db.query(`update public.profiles set display_name = $2, role = $3, status = $4 where id = $1`, [id, k.toUpperCase(), k === "admin" ? "admin" : "player", k === "pending" ? "pending" : "active"]);
}
const P = (n) => ids["p" + n];
const day = (n) => `(timezone('Europe/London', now())::date + ${n})`;
const mk = async (n, max) => (await one(`insert into public.games (date, kickoff, venue, pitch, price, max_players, published) values (${day(n)}, '20:00', 'Solar Campus', '8-a-side', 5, $1, true) returning id`, [max])).id;

// As a player, the way the app does it.
const bookAs = (who, game, player = who) => as(db, who, () => db.query(`insert into public.bookings (game_id, player_id) values ($1, $2) returning id, waiting`, [game, player])).then((r) => r.rows[0]);
const dropAs = (who, bookingId) => as(db, who, () => db.query(`delete from public.bookings where id = $1`, [bookingId])).then((r) => r.affectedRows ?? 0);
const updAs = (who, bookingId, set) => as(db, who, () => db.query(`update public.bookings set ${set} where id = $1`, [bookingId])).then((r) => r.affectedRows ?? 0);
const row = (id) => one(`select * from public.bookings where id = $1`, [id]);
const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct created_at for queue order

console.log("\n— Booking a spot —");
const G = await mk(5, 3); // 3 places so the waiting list forms quickly
const b1 = await bookAs(P(1), G);
check("a player can book their own spot", !!b1 && b1.waiting === false);
check("…which starts unpaid", (await row(b1.id)).status === "unpaid");
check("a player can't book someone else in", !!(await err(() => bookAs(P(2), G, P(3)))));
check("the same player can't book the same game twice", !!(await err(() => bookAs(P(1), G))));
check("an admin can book a player in", (await bookAs(ids.admin, G, P(2)))?.waiting === false);
check("a member still waiting for approval can't book", !!(await err(() => bookAs(ids.pending, G))));
await tick();
const b3 = await bookAs(P(3), G);
check("the last place is still a real spot", b3.waiting === false);

console.log("\n— The waiting list —");
const waits = [];
for (let n = 4; n <= 13; n++) { await tick(); waits.push(await bookAs(P(n), G)); }
check("once full, new bookings go on the waiting list", waits.every((w) => w.waiting === true));
check("the waiting list stops at 10", /waiting list is full/i.test((await err(() => bookAs(P(14), G))) ?? ""));
await err(() => updAs(P(4), waits[0].id, "waiting = false"));
check("a waiting player can't move themselves off the list", (await row(waits[0].id)).waiting === true, JSON.stringify(await row(waits[0].id)));
const jump = await err(() => updAs(P(5), waits[1].id, "waiting = false, status = 'pending'"));
const afterJump = await row(waits[1].id);
check("…not even by marking 'I've paid' at the same time", afterJump.waiting === true, `waiting=${afterJump.waiting} status=${afterJump.status} err=${jump}`);
if (!afterJump.waiting) await db.query(`update public.bookings set waiting = true, status = 'unpaid' where id = $1`, [waits[1].id]); // put it back for the rest

console.log("\n— Dropping out —");
await db.query(`insert into public.game_stats (game_id, player_id, goals) values ($1, $2, 2)`, [G, P(1)]);
check("a player can't remove someone else's booking", (await dropAs(P(2), b1.id)) === 0 && !!(await row(b1.id)));
await dropAs(P(1), b1.id);
check("a player can drop out of their own spot", !(await row(b1.id)));
let first = await row(waits[0].id);
check("…and the longest-waiting player moves up", first.waiting === false, JSON.stringify(first));
check("…with the time they moved up recorded", !!first.promoted_at);
check("…and the next in line is now first", (await row(waits[1].id)).waiting === true);
check("dropping out removes their goals for that game", !(await one(`select 1 from public.game_stats where game_id = $1 and player_id = $2`, [G, P(1)])));
const before = (await q(`select id from public.bookings where game_id = $1 and waiting = false`, [G])).length;
await dropAs(P(13), waits[9].id);
check("leaving the waiting list doesn't move anyone up", (await q(`select id from public.bookings where game_id = $1 and waiting = false`, [G])).length === before);
await dropAs(ids.admin, b3.id);
check("an admin removing a player moves the waiting list up too", (await row(waits[1].id)).waiting === false);

console.log("\n— Paying —");
const G2 = await mk(6, 16);
const pay = await bookAs(P(6), G2);
check("a player can mark their own booking 'I've paid'", (await updAs(P(6), pay.id, "status = 'pending'")) === 1 && (await row(pay.id)).status === "pending");
const selfConfirm = await err(() => updAs(P(6), pay.id, "status = 'confirmed'"));
check("…but can't mark it confirmed themselves", (await row(pay.id)).status === "pending", `err=${selfConfirm}`);
const other = await bookAs(P(7), G2);
const free = await err(() => updAs(P(6), pay.id, "status = 'pending', pot_exempt_reason = 'birthday'"));
check("…and can't make their own game free while doing it", (await row(pay.id)).pot_exempt_reason === null, `err=${free}`);
const G3 = await mk(7, 16);
const move = await err(() => updAs(P(6), pay.id, `status = 'pending', game_id = '${G3}'`));
check("…or move their booking to a different game", (await row(pay.id)).game_id === G2, `err=${move}`);
check("a player can't change someone else's payment", (await updAs(P(6), other.id, "status = 'pending'")) === 0 && (await row(other.id)).status === "unpaid");
check("an admin can confirm a payment", (await updAs(ids.admin, pay.id, "status = 'confirmed'")) === 1 && (await row(pay.id)).status === "confirmed");
check("a player can't set their own team", !!(await err(() => updAs(P(7), other.id, "team = 'red'"))));
check("an admin can set teams", (await updAs(ids.admin, other.id, "team = 'red'")) === 1);

console.log("\n— Overdue payments block new bookings —");
const OLD = await mk(-3, 16);
const NEXT = await mk(9, 16);
await db.query(`insert into public.bookings (game_id, player_id) values ($1, $2)`, [OLD, P(8)]); // played, never paid
check("someone who owes for a past game can't book another", !!(await err(() => bookAs(P(8), NEXT))));
check("…but an admin can still book them in", (await bookAs(ids.admin, NEXT, P(8)))?.waiting === false);
await db.query(`insert into public.bookings (game_id, player_id, pot_exempt_reason) values ($1, $2, 'birthday')`, [OLD, P(9)]);
check("a free game (birthday etc.) in the past doesn't count as owing", !!(await bookAs(P(9), NEXT)));
await db.query(`update public.bookings set status = 'confirmed' where game_id = $1 and player_id = $2`, [OLD, P(8)]);
check("once it's confirmed, they can book again", !!(await bookAs(P(8), await mk(10, 16))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
