// Club history moments (history_moments), tested against a real Postgres
// copy of the club database (db.mjs). Exits 1 on any FAIL.
import { makeDb, as } from "./db.mjs";

const { db } = await makeDb();
// Match the live database where schema.sql has drifted (checked 9 Oct).
await db.exec(`alter table public.profiles add column if not exists is_test boolean not null default false;
  alter table public.profiles drop column if exists payment_code cascade;
  alter table public.bookings drop column if exists auto_confirmed cascade;`);
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + extra}`); };
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const ids = { admin: "a0000000-0000-0000-0000-000000000001", p1: "b0000000-0000-0000-0000-000000000001", pending: "c0000000-0000-0000-0000-000000000001" };
for (const [k, id] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${k}@test.local`]);
  if (!(await db.query(`select 1 from public.profiles where id = $1`, [id])).rows.length) await db.query(`insert into public.profiles (id, display_name) values ($1, $2)`, [id, k]);
  await db.query(`update public.profiles set role = $2, status = $3 where id = $1`, [id, k === "admin" ? "admin" : "player", k === "pending" ? "pending" : "active"]);
}
const read = (who) => as(db, who, () => db.query(`select id, title from public.history_moments order by happened_on`)).then((r) => r.rows);
const add = (who, title = "New kit arrives", date = "2026-09-01") => as(db, who, () => db.query(`insert into public.history_moments (happened_on, title) values ($1, $2) returning id`, [date, title])).then((r) => r.rows[0]);

console.log("\n— Club history moments —");
check("the table and its rules are created from schema.sql", !!(await db.query(`select to_regclass('public.history_moments') as t`)).rows[0].t);
const m = await add(ids.admin, "New kit arrives", "2026-08-20");
check("an admin can add a moment, back-dated", !!m);
check("…and members can read it", (await read(ids.p1)).some((r) => r.title === "New kit arrives"));
check("a member waiting for approval can't read them", (await read(ids.pending)).length === 0);
check("a player can't add a moment", !!(await err(() => add(ids.p1, "Sneaky"))));
const del = await as(db, ids.p1, () => db.query(`delete from public.history_moments where id = $1`, [m.id]));
check("a player can't remove one", (del.affectedRows ?? 0) === 0 && (await read(ids.admin)).some((r) => r.title === "New kit arrives"));
check("a title has to be at least 2 characters", !!(await err(() => add(ids.admin, "x"))));
check("only 'note' or 'goal' styles", !!(await err(() => as(db, ids.admin, () => db.query(`insert into public.history_moments (happened_on, title, kind) values ('2026-08-20', 'Bad style', 'video')`)))));
const del2 = await as(db, ids.admin, () => db.query(`delete from public.history_moments where id = $1`, [m.id]));
check("an admin can remove one", (del2.affectedRows ?? 0) === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
