// Calling off a game, tested against a real Postgres copy of the club
// database (db.mjs). Each check prints PASS/FAIL; the script exits 1 on any FAIL.
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

const ids = { admin: "a0000000-0000-0000-0000-000000000001" };
for (let i = 1; i <= 7; i++) ids["p" + i] = `b0000000-0000-0000-0000-00000000000${i}`;
for (const [k, id] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, `${k}@test.local`, JSON.stringify({ display_name: k.toUpperCase() })]);
  const has = await one(`select id from public.profiles where id = $1`, [id]);
  if (!has) await db.query(`insert into public.profiles (id, display_name) values ($1, $2)`, [id, k.toUpperCase()]);
  await db.query(`update public.profiles set display_name = $2, role = $3, status = 'active' where id = $1`, [id, k.toUpperCase(), k === "admin" ? "admin" : "player"]);
}
const day = (n) => `(timezone('Europe/London', now())::date + ${n})`;
const mk = async (n, max = 6) => (await one(`insert into public.games (date, kickoff, venue, pitch, price, max_players, published) values (${day(n)}, '20:00', 'Solar Campus', '8-a-side', 5, $1, true) returning id`, [max])).id;
const book = async (game, player, status = "unpaid", exempt = null) => {
  const b = await one(`insert into public.bookings (game_id, player_id) values ($1, $2) returning id, waiting`, [game, player]);
  await db.query(`update public.bookings set status = $2, pot_exempt_reason = $3 where id = $1`, [b.id, status, exempt]);
  return b;
};
const creditsOf = (p) => q(`select * from public.player_credits where player_id = $1 order by created_at, id`, [p]);
const msgsOf = (p) => q(`select message from public.admin_messages where recipient_id = $1 order by created_at`, [p]);
const rpcAs = (who, fn, args) => as(db, who, () => db.query(`select public.${fn}(${args.map((_, i) => "$" + (i + 1)).join(", ")}) as r`, args));

const G = await mk(6);
const b1 = await book(G, ids.p1, "confirmed"); // paid
const b2 = await book(G, ids.p2, "pending"); // says they paid
const b3 = await book(G, ids.p3, "unpaid");
const b4 = await book(G, ids.p4, "confirmed", "prize"); // free place
// p5 pays with a credit
await db.query(`insert into public.player_credits (player_id, status, source) values ($1, 'available', 'admin')`, [ids.p5]);
const b5 = await book(G, ids.p5, "unpaid");
await rpcAs(ids.p5, "use_credit", [b5.id]);
check("setup: p5's booking was paid with a credit", (await creditsOf(ids.p5))[0]?.status === "used");
const b6 = await book(G, ids.p6, "unpaid");
const w7 = await book(G, ids.p7, "unpaid"); // 7th on a 6-place game
check("setup: p7 is on the waiting list", w7.waiting === true);

console.log("\n— Who can call off —");
check("a player can't call off a game", /Only admins/.test((await err(() => rpcAs(ids.p1, "admin_call_off_game", [G, null]))) ?? ""));
check("…and nothing changed", (await one(`select called_off_at from public.games where id = $1`, [G])).called_off_at === null);

console.log("\n— Calling it off —");
const r = (await rpcAs(ids.admin, "admin_call_off_game", [G, " Pitch waterlogged "])).rows[0].r;
check("returns how many got a credit (paid + paid-with-credit = 2)", r === 2, String(r));
const g = await one(`select called_off_at, called_off_reason from public.games where id = $1`, [G]);
check("the game is marked called off, with the reason trimmed", !!g.called_off_at && g.called_off_reason === "Pitch waterlogged", JSON.stringify(g));
check("the bookings are kept", (await one(`select count(*)::int n from public.bookings where game_id = $1`, [G])).n === 7);
let c = await creditsOf(ids.p1);
check("paid player gets 1 available 'calloff' credit for this game", c.length === 1 && c[0].status === "available" && c[0].source === "calloff" && c[0].source_game_id === G, JSON.stringify(c));
check("…and an inbox message with the reason", (await msgsOf(ids.p1)).some((m) => /has been called off \(Pitch waterlogged\)\. You'd paid, so you've got a game credit/.test(m.message)));
c = await creditsOf(ids.p2);
check("'said I paid' player gets an awaiting-check credit, like a drop-out", c.length === 1 && c[0].status === "awaiting_check" && c[0].source === "calloff", JSON.stringify(c));
check("unpaid player gets nothing", (await creditsOf(ids.p3)).length === 0 && (await creditsOf(ids.p6)).length === 0);
check("free (pot-exempt) place gets nothing", (await creditsOf(ids.p4)).length === 0);
c = await creditsOf(ids.p5);
check("paid-with-credit player gets that same credit back (no new one)", c.length === 1 && c[0].status === "available" && c[0].used_on_booking_id === null, JSON.stringify(c));
check("…with a message saying so", (await msgsOf(ids.p5)).some((m) => /paid with a game credit, so it's back with you/.test(m.message)));
check("waiting list gets nothing", (await creditsOf(ids.p7)).length === 0);

console.log("\n— After it's called off —");
check("can't call it off twice", /already called off/.test((await err(() => rpcAs(ids.admin, "admin_call_off_game", [G, null]))) ?? ""));
check("a player can't drop out (no second credit)", /called off/.test((await err(() => as(db, ids.p1, () => db.query(`delete from public.bookings where id = $1`, [b1.id])))) ?? ""));
check("…still exactly 1 credit", (await creditsOf(ids.p1)).length === 1);
const newcomer = "c0000000-0000-0000-0000-000000000009";
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'n@test.local', '{"display_name":"N"}')`, [newcomer]);
await db.query(`insert into public.profiles (id, display_name) values ($1, 'N') on conflict (id) do nothing`, [newcomer]);
await db.query(`update public.profiles set status = 'active' where id = $1`, [newcomer]);
check("a new player can't book onto it", /called off/.test((await err(() => as(db, newcomer, () => db.query(`insert into public.bookings (game_id, player_id) values ($1, $2)`, [G, newcomer])))) ?? ""));
check("an admin can't mark someone paid on it", /called off/.test((await err(() => as(db, ids.admin, () => db.query(`update public.bookings set status = 'confirmed' where id = $1`, [b3.id])))) ?? ""));
check("an admin can still delete the whole fixture", (await err(() => as(db, ids.admin, () => db.query(`delete from public.games where id = $1`, [G])))) === null);
check("…and the credits stay", (await creditsOf(ids.p1))[0]?.status === "available" && (await creditsOf(ids.p5))[0]?.status === "available");

console.log("\n— Other games are untouched —");
const H = await mk(8);
const h1 = await book(H, ids.p1, "confirmed");
await as(db, ids.p1, () => db.query(`delete from public.bookings where id = $1`, [h1.id]));
check("dropping out of a normal game still gives a 'dropout' credit", (await creditsOf(ids.p1)).some((x) => x.source === "dropout" && x.source_game_id === H));
const S = await mk(-1);
await db.query(`update public.games set team_white_score = 3, team_red_score = 2 where id = $1`, [S]);
check("a game with a result can't be called off", /already has a result/.test((await err(() => rpcAs(ids.admin, "admin_call_off_game", [S, null]))) ?? ""));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
