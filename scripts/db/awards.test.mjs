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
const setWindow = (nom, open, late, close, reveal, min = 3) =>
  db.query(`update public.award_seasons set nominations_from = now() + $2::interval, opens_at = now() + $3::interval, late_nominations_until = now() + $4::interval,
    closes_at = now() + $5::interval, reveal_at = now() + $6::interval, min_games = $7 where season = $1`, [S, nom, open, late, close, reveal, min]);

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

console.log("\n— Setting up a season (admins only) —");
const seasonSql = `insert into public.award_seasons (season, title, min_games, nominations_from, opens_at, late_nominations_until, closes_at, reveal_at)
  values ($1, 'Season test', 3, now() - interval '1 day', now() + interval '5 days', now() + interval '8 days', now() + interval '10 days', now() + interval '11 days')`;
check("a player can't create a season", !!(await err(() => asQ(ids.p1, seasonSql, [S]))));
check("an admin can", (await err(() => asQ(ids.admin, seasonSql, [S]))) === null);
check("dates must be in order (voting can't close before it opens)", !!(await err(() => asQ(ids.admin, `update public.award_seasons set closes_at = opens_at - interval '1 day' where season = $1`, [S]))));
const cat = async (name, kind, extra = {}) =>
  (await asQ(ids.admin, `insert into public.award_categories (season, name, kind, auto_rule, allow_suggestions, sort) values ($1, $2, $3, $4, $5, $6) returning id`,
    [S, name, kind, extra.rule ?? null, extra.suggest ?? false, extra.sort ?? 0])).rows[0].id;
const PP = await cat("Players' Player", "player", { sort: 1 });
const UH = await cat("Unsung Hero", "player", { sort: 2 });
const GOAL = await cat("Goal of the Season", "shortlist", { suggest: true, sort: 3 });
const GLOVE = await cat("Golden Glove", "shortlist", { sort: 4 });
const MOM = await cat("Moment of the Season", "shortlist", { sort: 5 });
const BOOT = await cat("Golden Boot", "auto", { rule: "most_goals", sort: 6 });
check("an admin can add awards of each kind", !!PP && !!GOAL && !!BOOT);
check("a player can't add an award", !!(await err(() => asQ(ids.p1, `insert into public.award_categories (season, name, kind) values ($1, 'Mine', 'player')`, [S]))));
check("an automatic award needs a rule", !!(await err(() => asQ(ids.admin, `insert into public.award_categories (season, name, kind) values ($1, 'X', 'auto')`, [S]))));
check("only a shortlist award can take suggestions", !!(await err(() => asQ(ids.admin, `insert into public.award_categories (season, name, kind, allow_suggestions) values ($1, 'X', 'player', true)`, [S]))));
check("everyone signed in can see the awards", (await asQ(ids.p5, `select name from public.award_categories order by sort`)).rows.length === 6);
const rn = await err(() => asQ(ids.admin, `update public.award_categories set name = 'Players'' Player of the Season' where id = $1`, [PP]));
check("an admin can rename an award", rn === null, rn);

const vote = (who, category, target, isNom = false) =>
  asQ(who, `insert into public.award_votes (category_id, player_id, nomination_id) values ($1, $2, $3)
    on conflict (category_id, voter_id) do update set player_id = excluded.player_id, nomination_id = excluded.nomination_id`, [category, isNom ? null : target, isNom ? target : null]);

console.log("\n— Nominations, before voting opens —");
const nom = async (category, title, player = null, status = "shortlisted") =>
  (await asQ(ids.admin, `insert into public.award_nominations (category_id, title, player_id, status) values ($1, $2, $3, $4) returning id`, [category, title, player, status])).rows[0].id;
const goalP1 = await nom(GOAL, "P1's volley", ids.p1);
const goalP2 = await nom(GOAL, "P2's chip", ids.p2);
const glove = await nom(GLOVE, "P3 in goal", ids.p3);
const moment = await nom(MOM, "The 11-0");
check("admins can shortlist nominees", !!goalP1 && !!glove && !!moment);
const sug = await err(() => asQ(ids.p4, `insert into public.award_nominations (category_id, title, status) values ($1, 'P4 suggests a screamer', 'suggested')`, [GOAL]));
check("a player can suggest for an award that takes suggestions", sug === null, sug);
check("…but not put it straight on the shortlist", !!(await err(() => asQ(ids.p4, `insert into public.award_nominations (category_id, title, status) values ($1, 'Sneaky', 'shortlisted')`, [GOAL]))));
check("…or suggest for one that doesn't take suggestions", !!(await err(() => asQ(ids.p4, `insert into public.award_nominations (category_id, title, status) values ($1, 'Me', 'suggested')`, [GLOVE]))));
check("…or suggest as someone else", !!(await err(() => asQ(ids.p4, `insert into public.award_nominations (category_id, title, status, suggested_by) values ($1, 'X', 'suggested', $2)`, [GOAL, ids.p5]))));
check("a player sees the shortlist and their own suggestion", (await asQ(ids.p4, `select title from public.award_nominations`)).rows.length === 5);
check("…but not other people's suggestions", (await asQ(ids.p5, `select title from public.award_nominations`)).rows.length === 4);
check("a player can't edit a nomination", (await asQ(ids.p4, `update public.award_nominations set title = 'Hacked' where id = $1 returning id`, [goalP1])).rows.length === 0);
check("voting isn't open yet", /isn't open/.test((await err(() => vote(ids.p1, PP, ids.p2))) ?? ""));

console.log("\n— Voting —");
await setWindow("-10 days", "-1 hour", "+3 days", "+5 days", "+6 days");
check("a player with 3 games can vote", (await err(() => vote(ids.p1, PP, ids.p2))) === null);
check("a player with 2 games can't", /3 games/.test((await err(() => vote(ids.p4, PP, ids.p1))) ?? ""));
await setWindow("-10 days", "-1 hour", "+3 days", "+5 days", "+6 days", 2);
check("…until an admin lowers the minimum to 2", (await err(() => vote(ids.p4, UH, ids.p1))) === null);
await asQ(ids.p4, `delete from public.award_votes where category_id = $1`, [UH]);
await setWindow("-10 days", "-1 hour", "+3 days", "+5 days", "+6 days", 3);
check("you can't vote for yourself", /yourself/.test((await err(() => vote(ids.p2, PP, ids.p2))) ?? ""));
check("…or for your own nomination", /yourself/.test((await err(() => vote(ids.p1, GOAL, goalP1, true))) ?? ""));
check("you can't vote for someone who hasn't played", /haven't played/.test((await err(() => vote(ids.p1, UH, ids.p6))) ?? ""));
check("anyone who's played once can get a vote", (await err(() => vote(ids.p1, UH, ids.p5))) === null);
check("an automatic award can't be voted on", /isn't voted/.test((await err(() => vote(ids.p1, BOOT, ids.p2))) ?? ""));
const sugId = (await one(`select id from public.award_nominations where status = 'suggested'`)).id;
check("a suggestion that isn't shortlisted can't be voted for", /shortlist/.test((await err(() => vote(ids.p1, GOAL, sugId, true))) ?? ""));
check("a nomination can't be used for a different award", /shortlist/.test((await err(() => vote(ids.p1, GLOVE, goalP2, true))) ?? ""));
check("a shortlisted nomination can be voted for", (await err(() => vote(ids.p1, GOAL, goalP2, true))) === null);
check("a player award needs a player", /Pick a player/.test((await err(() => asQ(ids.p1, `insert into public.award_votes (category_id, nomination_id) values ($1, $2)`, [UH, moment]))) ?? ""));
check("you can't vote as someone else", !!(await err(() => asQ(ids.p2, `insert into public.award_votes (category_id, voter_id, player_id) values ($1, $2, $3)`, [PP, ids.p3, ids.p1]))));
await vote(ids.p1, PP, ids.p3);
const mine = (await asQ(ids.p1, `select player_id from public.award_votes where category_id = $1`, [PP])).rows;
check("changing your vote replaces it (still one vote)", mine.length === 1 && mine[0].player_id === ids.p3, JSON.stringify(mine));
await vote(ids.p2, PP, ids.p3); await vote(ids.p3, PP, ids.p1); await vote(ids.admin, PP, ids.p1);
check("you only ever see your own votes", (await asQ(ids.p1, `select * from public.award_votes`)).rows.every((r) => r.voter_id === ids.p1));
check("…admins included", (await asQ(ids.admin, `select * from public.award_votes`)).rows.every((r) => r.voter_id === ids.admin));
check("once voted on, an award can't change how it's decided", /already voted/.test((await err(() => asQ(ids.admin, `update public.award_categories set kind = 'auto', auto_rule = 'most_goals' where id = $1`, [PP]))) ?? ""));
const t = (await asQ(ids.admin, `select public.award_turnout($1) t`, [S])).rows[0].t;
check("admins see turnout: 4 voted of 4 eligible", t.voted === 4 && t.eligible === 4 && t.by_award[PP] === 4, JSON.stringify(t));
check("players can't see turnout", /Only admins/.test((await err(() => asQ(ids.p1, `select public.award_turnout($1)`, [S]))) ?? ""));
check("nobody sees results before Awards Night", /secret/.test((await err(() => asQ(ids.admin, `select * from public.award_results($1)`, [S]))) ?? ""));

console.log("\n— A late nomination —");
await vote(ids.p2, GOAL, goalP1, true);
const msgs = async () => (await q(`select recipient_id from public.admin_messages where message like 'New nominations added for Goal of the Season%'`)).map((r) => r.recipient_id);
await nom(GOAL, "P3's late winner", ids.p3);
const m = await msgs();
check("voters in that award get a message naming it", m.length === 2 && m.includes(ids.p1) && m.includes(ids.p2), JSON.stringify(m));
await nom(GOAL, "Another late one", ids.p2);
check("…only once every 6 hours", (await msgs()).length === 2);
await nom(MOM, "Late moment");
check("voters in other awards aren't messaged about it", (await msgs()).length === 2);
await asQ(ids.admin, `update public.award_nominations set status = 'shortlisted' where id = $1`, [sugId]);
check("approving a suggestion puts it on the ballot", (await err(() => vote(ids.p3, GOAL, sugId, true))) === null);

console.log("\n— Closing and the reveal —");
await setWindow("-10 days", "-5 days", "-3 days", "-1 hour", "+1 day");
check("no voting after the close", /closed/.test((await err(() => vote(ids.p3, UH, ids.p5))) ?? ""));
check("still secret between the close and Awards Night", /secret/.test((await err(() => asQ(ids.p1, `select * from public.award_results($1)`, [S]))) ?? ""));
await setWindow("-10 days", "-5 days", "-3 days", "-2 days", "-1 minute");
const res = (await asQ(ids.p4, `select * from public.award_results($1)`, [S])).rows;
const pp = res.filter((r) => r.category_id === PP);
check("after the reveal anyone sees the results", pp.length === 2, JSON.stringify(pp));
check("ties are joint winners (p1 and p3 on 2 each)", pp.every((r) => r.votes === 2 && r.winner), JSON.stringify(pp));
const g = res.filter((r) => r.category_id === GOAL);
check("shortlist awards count nomination votes", g.reduce((a, r) => a + r.votes, 0) === 3, JSON.stringify(g));
await asQ(ids.admin, `delete from public.award_nominations where id = $1`, [goalP2]);
check("deleting a nomination removes its votes", (await one(`select count(*)::int n from public.award_votes where nomination_id = $1`, [goalP2])).n === 0);
await asQ(ids.admin, `delete from public.award_categories where id = $1`, [UH]);
check("deleting an award removes its votes", (await one(`select count(*)::int n from public.award_votes where category_id = $1`, [UH])).n === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
