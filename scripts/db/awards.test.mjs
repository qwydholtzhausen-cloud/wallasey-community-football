// Season awards voting, tested against a real Postgres copy of the club
// database (db.mjs). Each check prints PASS/FAIL; the script exits 1 on any FAIL.
import { makeDb, as } from "./db.mjs";

const { db, failures } = await makeDb();
await db.exec(`alter table public.profiles add column if not exists is_test boolean not null default false;
  alter table public.profiles drop column if exists payment_code cascade;
  alter table public.bookings drop column if exists auto_confirmed cascade;`);

let failed = 0, passed = 0;
const check = (name, ok, extra = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + extra}`); };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const asQ = (who, sql, p) => as(db, who, () => db.query(sql, p));

check("the awards SQL loads with no errors", !failures.some((f) => /award/i.test(f.stmt)), JSON.stringify(failures.filter((f) => /award/i.test(f.stmt))));

const ids = { admin: "a0000000-0000-0000-0000-000000000001" };
for (let i = 1; i <= 6; i++) ids["p" + i] = `b0000000-0000-0000-0000-00000000000${i}`;
for (const [k, id] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, `${k}@test.local`, JSON.stringify({ display_name: k.toUpperCase() })]);
  const has = await one(`select id from public.profiles where id = $1`, [id]);
  if (!has) await db.query(`insert into public.profiles (id, display_name) values ($1, $2)`, [id, k.toUpperCase()]);
  await db.query(`update public.profiles set display_name = $2, role = $3, status = 'active' where id = $1`, [id, k.toUpperCase(), k === "admin" ? "admin" : "player"]);
}
// A test season this year, so "games this season" counts real past games.
const S = (await one(`select extract(year from now())::int y`)).y;
const setWindow = (nom, open, late, close, reveal) =>
  db.query(`insert into public.award_seasons values ($1, now() + $2::interval, now() + $3::interval, now() + $4::interval, now() + $5::interval, now() + $6::interval)
    on conflict (season) do update set nominations_from = excluded.nominations_from, opens_at = excluded.opens_at, late_nominations_until = excluded.late_nominations_until, closes_at = excluded.closes_at, reveal_at = excluded.reveal_at`, [S, nom, open, late, close, reveal]);

// Played games: admin, p1, p2, p3 play three; p4 plays two; p5 plays one; p6 none.
const games = [];
for (let n = 1; n <= 3; n++) {
  const g = (await one(`insert into public.games (date, kickoff, venue, pitch, price, max_players, published, team_white_score, team_red_score)
    values (make_date($1, 1, $2), '20:00', 'Solar Campus', '8-a-side', 5, 16, true, 3, 2) returning id`, [S, n])).id;
  games.push(g);
}
const play = async (who, count) => { for (let i = 0; i < count; i++) await db.query(`insert into public.bookings (game_id, player_id) values ($1, $2)`, [games[i], who]); };
await play(ids.admin, 3); await play(ids.p1, 3); await play(ids.p2, 3); await play(ids.p3, 3); await play(ids.p4, 2); await play(ids.p5, 1);
check("setup: games played counts", (await one(`select public.award_games_played($1, $2) n`, [ids.p1, S])).n === 3 && (await one(`select public.award_games_played($1, $2) n`, [ids.p4, S])).n === 2);

const vote = (who, award, target, isNom = false) =>
  asQ(who, `insert into public.award_votes (season, award, ${isNom ? "nomination_id" : "player_id"}) values ($1, $2, $3)
    on conflict (season, award, voter_id) do update set ${isNom ? "nomination_id" : "player_id"} = excluded.${isNom ? "nomination_id" : "player_id"}`, [S, award, target]);

console.log("\n— Nominations, before voting opens —");
await setWindow("-1 day", "+5 days", "+8 days", "+10 days", "+11 days");
const nom = async (award, title, player = null, status = "shortlisted") =>
  (await asQ(ids.admin, `insert into public.award_nominations (season, award, title, player_id, status) values ($1, $2, $3, $4, $5) returning id`, [S, award, title, player, status])).rows[0].id;
const goalP1 = await nom("goal", "P1's volley", ids.p1);
const goalP2 = await nom("goal", "P2's chip", ids.p2);
const glove = await nom("golden_glove", "P3 in goal", ids.p3);
const moment = await nom("moment", "The 11-0", null);
check("admins can shortlist goals, keepers and moments", !!goalP1 && !!glove && !!moment);
const sug = await err(() => asQ(ids.p4, `insert into public.award_nominations (season, award, title, status) values ($1, 'goal', 'P4 suggests a screamer', 'suggested')`, [S]));
check("a player can suggest a goal", sug === null, sug);
check("…but not put it straight on the shortlist", !!(await err(() => asQ(ids.p4, `insert into public.award_nominations (season, award, title, status) values ($1, 'goal', 'Sneaky', 'shortlisted')`, [S]))));
check("…or nominate a keeper", !!(await err(() => asQ(ids.p4, `insert into public.award_nominations (season, award, title, status) values ($1, 'golden_glove', 'Me', 'suggested')`, [S]))));
check("…or suggest as someone else", !!(await err(() => asQ(ids.p4, `insert into public.award_nominations (season, award, title, status, suggested_by) values ($1, 'goal', 'X', 'suggested', $2)`, [S, ids.p5]))));
check("a player sees the shortlist and their own suggestion", (await asQ(ids.p4, `select title from public.award_nominations`)).rows.length === 5);
check("…but not other people's suggestions", (await asQ(ids.p5, `select title from public.award_nominations`)).rows.length === 4);
check("a player can't edit a nomination", (await asQ(ids.p4, `update public.award_nominations set title = 'Hacked' where id = $1 returning id`, [goalP1])).rows.length === 0);
check("voting isn't open yet", /isn't open/.test((await err(() => vote(ids.p1, "players_player", ids.p2))) ?? ""));

console.log("\n— Voting —");
await setWindow("-10 days", "-1 hour", "+3 days", "+5 days", "+6 days");
check("a player with 3 games can vote", (await err(() => vote(ids.p1, "players_player", ids.p2))) === null);
check("a player with 2 games can't", /3 games/.test((await err(() => vote(ids.p4, "players_player", ids.p1))) ?? ""));
check("you can't vote for yourself", /yourself/.test((await err(() => vote(ids.p2, "players_player", ids.p2))) ?? ""));
check("…or for your own goal", /yourself/.test((await err(() => vote(ids.p1, "goal", goalP1, true))) ?? ""));
check("you can't vote for someone who hasn't played", /haven't played/.test((await err(() => vote(ids.p1, "unsung_hero", ids.p6))) ?? ""));
check("anyone who's played once can get a vote", (await err(() => vote(ids.p1, "unsung_hero", ids.p5))) === null);
const sugId = (await one(`select id from public.award_nominations where status = 'suggested'`)).id;
check("a suggestion that isn't shortlisted can't be voted for", /shortlist/.test((await err(() => vote(ids.p1, "goal", sugId, true))) ?? ""));
check("a nomination can't be used for a different award", /shortlist/.test((await err(() => vote(ids.p1, "golden_glove", goalP2, true))) ?? ""));
check("a shortlisted goal can be voted for", (await err(() => vote(ids.p1, "goal", goalP2, true))) === null);
check("a player award needs a player, not a nomination", !!(await err(() => asQ(ids.p1, `insert into public.award_votes (season, award, nomination_id) values ($1, 'unsung_hero', $2)`, [S, moment]))));
check("you can't vote as someone else", !!(await err(() => asQ(ids.p2, `insert into public.award_votes (season, award, voter_id, player_id) values ($1, 'players_player', $2, $3)`, [S, ids.p3, ids.p1]))));
await vote(ids.p1, "players_player", ids.p3);
const mine = (await asQ(ids.p1, `select award, player_id from public.award_votes where award = 'players_player'`)).rows;
check("changing your vote replaces it (still one vote)", mine.length === 1 && mine[0].player_id === ids.p3, JSON.stringify(mine));
await vote(ids.p2, "players_player", ids.p3); await vote(ids.p3, "players_player", ids.p1); await vote(ids.admin, "players_player", ids.p1);
check("you only ever see your own votes", (await asQ(ids.p1, `select * from public.award_votes`)).rows.every((r) => r.voter_id === ids.p1));
check("…admins included", (await asQ(ids.admin, `select * from public.award_votes`)).rows.every((r) => r.voter_id === ids.admin));
const t = (await asQ(ids.admin, `select public.award_turnout($1) t`, [S])).rows[0].t;
check("admins see turnout: 4 voted of 4 eligible", t.voted === 4 && t.eligible === 4 && t.by_award.players_player === 4, JSON.stringify(t));
check("players can't see turnout", /Only admins/.test((await err(() => asQ(ids.p1, `select public.award_turnout($1)`, [S]))) ?? ""));
check("nobody sees results before Awards Night", /secret/.test((await err(() => asQ(ids.admin, `select * from public.award_results($1)`, [S]))) ?? ""));

console.log("\n— A late nomination —");
await vote(ids.p2, "goal", goalP1, true);
const msgs = async () => (await q(`select recipient_id from public.admin_messages where message like 'New nominations added for Goal of the Season%'`)).map((r) => r.recipient_id);
await nom("goal", "P3's late winner", ids.p3);
let m = await msgs();
check("voters in that award get a message", m.length === 2 && m.includes(ids.p1) && m.includes(ids.p2), JSON.stringify(m));
await nom("goal", "Another late one", ids.p2);
check("…only once every 6 hours", (await msgs()).length === 2);
await nom("moment", "Late moment");
check("voters in other awards aren't messaged about it", (await msgs()).length === 2);
await asQ(ids.admin, `update public.award_nominations set status = 'shortlisted' where id = $1`, [sugId]);
check("shortlisting a suggestion puts it on the ballot", (await err(() => vote(ids.p3, "goal", sugId, true))) === null);

console.log("\n— Closing and the reveal —");
await setWindow("-10 days", "-5 days", "-3 days", "-1 hour", "+1 day");
check("no voting after the close", /closed/.test((await err(() => vote(ids.p3, "unsung_hero", ids.p5))) ?? ""));
check("still secret between the close and Awards Night", /secret/.test((await err(() => asQ(ids.p1, `select * from public.award_results($1)`, [S]))) ?? ""));
await setWindow("-10 days", "-5 days", "-3 days", "-2 days", "-1 minute");
const res = (await asQ(ids.p4, `select * from public.award_results($1)`, [S])).rows;
const pp = res.filter((r) => r.award === "players_player");
check("after the reveal anyone sees the results", pp.length === 2, JSON.stringify(pp));
check("ties are joint winners (p1 and p3 on 2 each)", pp.every((r) => r.votes === 2 && r.winner), JSON.stringify(pp));
const g = res.filter((r) => r.award === "goal");
check("Goal of the Season counts nomination votes", g.reduce((a, r) => a + r.votes, 0) === 3, JSON.stringify(g));
await asQ(ids.admin, `delete from public.award_nominations where id = $1`, [goalP2]);
check("deleting a nomination removes its votes", (await one(`select count(*)::int n from public.award_votes where nomination_id = $1`, [goalP2])).n === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
