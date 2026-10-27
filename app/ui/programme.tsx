import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, avatarFor } from "./shared";
import type { Programme, ProgPerson } from "../../lib/programme";
import { FIRST_XI_DATE_LABEL } from "../../lib/firstXI";
import { nowInLondon } from "../../lib/time";

// ── The First XI matchday programme ──
// A cream paper programme you page through, for the club's first
// 11-a-side. The same 16 pages from the moment it's out until kick-off;
// once the result is in, a Full time page is added and it lives on in
// History and behind everyone's pennant. Facts come from lib/programme.ts.

export type ProgrammeAd = { company: string; description: string | null; tag: string | null; logoUrl: string | null; owner: string };
export type ProgrammeResult = { white: number; red: number; scorers: string; motm: string | null; redScorers?: string; whiteScorers?: string };

const dt = (s: string, o: Intl.DateTimeFormatOptions) => new Date(s + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
const short = (s: string) => dt(s, { day: "numeric", month: "short" });
const long = (s: string) => dt(s, { weekday: "long", day: "numeric", month: "long" });

export function MatchdayProgramme({
  prog,
  members,
  potm,
  firstGoal,
  ads,
  avatarOf,
  result,
  onClose,
  onSharePoster,
}: {
  prog: Programme;
  members: number;
  potm: { month: string; id: string; name: string }[];
  firstGoal: string | null;
  ads: ProgrammeAd[];
  avatarOf: (id: string) => string | null | undefined;
  result: ProgrammeResult | null;
  onClose: () => void;
  onSharePoster?: () => void;
}) {
  const face = (p: ProgPerson, cls: string, style?: React.CSSProperties) => (
    <Avatar name={p.name} avatarUrl={avatarOf(p.id)} className={cls} background={avatarFor(p.name).gradient} style={style} />
  );
  // "Today" only on the day itself; before it (and in History after) the
  // programme talks about the day by name.
  const wd = dt(prog.game.date, { weekday: "long" });
  const isDay = nowInLondon().slice(0, 10) === prog.game.date;
  const day = isDay ? "today" : wd; // "Sunday is the first…"
  const Day = isDay ? "Today" : wd;
  const onDay = isDay ? "today" : `on ${wd}`; // "playing on Sunday"
  const OnDay = isDay ? "Today" : `On ${wd}`;
  const dayS = isDay ? "today's" : `${wd}'s`;
  const DayS = isDay ? "Today's" : `${wd}'s`;
  const sideOf = (id: string) => (prog.reds.some((p) => p.id === id) ? "Reds" : "Whites");
  const cap = (id: string) => prog.captains.includes(id);
  const { h2h, tape, watch, records: rec } = prog;
  const folio = (t: string) => (
    <div className="pgm-folio">
      <span>THE FIRST XI · {FIRST_XI_DATE_LABEL}</span>
      <span>
        {t} · <i className="pgm-fn" />
      </span>
    </div>
  );
  const stub = (eb: string, title: React.ReactNode, rule = true) => (
    <>
      <div className="pgm-eb">{eb}</div>
      <h3>{title}</h3>
      {rule && <div className="pgm-rule" />}
    </>
  );

  const pages: { key: string; label: string; body: React.ReactNode }[] = [
    {
      key: "cover",
      label: "Cover",
      body: (
        <div className="pgm-pg pgm-cover">
          <div className="pgm-band">
            <div className="pgm-top">
              <span>MATCHDAY PROGRAMME · Nº1</span>
              <span className="pgm-price">FREE</span>
            </div>
          </div>
          <div className="pgm-low">
            <img src="/crest.png" alt="" />
            <div className="pgm-t">
              The <span>First</span> XI
            </div>
            <div className="pgm-vs">
              <i style={{ background: "var(--pgm-red)" }} />
              Reds v Whites
              <i style={{ background: "#fff" }} />
            </div>
            <div className="pgm-meta">
              {dt(prog.game.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · Kick-off {prog.game.kickoff}
              <br />
              Solar Campus · The club&apos;s first 11-a-side
            </div>
            <div className="pgm-strip" />
          </div>
        </div>
      ),
    },
    {
      key: "welcome",
      label: "Welcome",
      body: (
        <div className="pgm-pg">
          <div className="pgm-hero" style={{ backgroundImage: "url(/first-xi/bench.jpg)" }} />
          {stub(
            "WELCOME",
            <>
              A word before
              <br />
              kick-off
            </>,
          )}
          <div className="pgm-letter">
            <p className="pgm-drop">
              Wirral Community Football started with a simple aim. Many of us came over from another group, and we wanted to do it better: games that everyone can
              afford, run properly, and built to last.
            </p>
            <p>
              Since the first game{prog.firstDate ? ` on ${long(prog.firstDate)}` : ""}, that&apos;s meant {prog.games} games, {prog.goals} goals and {members} members. {OnDay} we
              do something new: eleven against eleven, on a full-size pitch.
            </p>
            <p>Thank you to everyone who books, pays on time, turns up and votes. That&apos;s what keeps the price down and the games going.</p>
            <p>Play hard, play fair and look after each other. Enjoy it. You only play the first one once.</p>
          </div>
          <div className="pgm-sign">
            The Admins<small>WIRRAL COMMUNITY FOOTBALL</small>
          </div>
          {folio("WELCOME")}
        </div>
      ),
    },
    {
      key: "teams",
      label: "The teams",
      body: (
        <div className="pgm-pg">
          {stub(`${DayS.toUpperCase()} TEAMS`, "Reds v Whites")}
          <div className="pgm-sides">
            {(
              [
                ["Reds", prog.reds, "var(--pgm-red)"],
                ["Whites", prog.whites, "#9aa3b5"],
              ] as const
            ).map(([n, list, c]) => (
              <div key={n} className="pgm-side" style={{ ["--c" as string]: c }}>
                <h4>{n}</h4>
                {list.map((p) => (
                  <div key={p.id}>
                    {face(p, "pgm-ph")}
                    <span>{p.name}</span>
                    {cap(p.id) && <em>C</em>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="pgm-foot">C = captain, voted by each team. Positions are sorted out between you on the day.</div>
          {folio("SQUAD")}
        </div>
      ),
    },
    {
      key: "tape",
      label: "Tale of the tape",
      body: (
        <div className="pgm-pg">
          <div className="pgm-hero" style={{ backgroundImage: "url(/first-xi/shirts.jpg)", backgroundPosition: "center 30%" }} />
          {stub(
            "TALE OF THE TAPE",
            <>
              {DayS} XIs,
              <br />
              this season
            </>,
          )}
          <div className="pgm-tape">
            <div className="pgm-hd">
              <span style={{ color: "var(--pgm-red)" }}>Reds XI</span>
              <span />
              <span>Whites XI</span>
            </div>
            {(
              [
                ["GAMES PLAYED", tape.reds.apps, tape.whites.apps, ""],
                ["WINS", tape.reds.wins, tape.whites.wins, ""],
                ["WIN RATE", tape.reds.rate, tape.whites.rate, "%"],
                ["GOALS", tape.reds.goals, tape.whites.goals, ""],
                ["MAN OF THE MATCH", tape.reds.motm, tape.whites.motm, ""],
              ] as const
            ).map(([l, a, b, u]) => (
              <div key={l} className="pgm-row">
                <b className={a > b ? "win" : ""}>
                  {a}
                  {u}
                </b>
                <small>{l}</small>
                <b className={b > a ? "win" : ""}>
                  {b}
                  {u}
                </b>
              </div>
            ))}
          </div>
          <div className="pgm-verdict">
            {tape.whites.goals > tape.reds.goals ? (
              <>
                <b>On paper, it&apos;s Whites</b> on goals.
              </>
            ) : (
              <>
                <b>On paper, it&apos;s Reds</b> on goals.
              </>
            )}{" "}
            <b>But who has the form?</b> The next page shows.
          </div>
          {folio("TALE OF THE TAPE")}
        </div>
      ),
    },
    {
      key: "form",
      label: "Form guide",
      body: (
        <div className="pgm-pg">
          <div className="pgm-hero" style={{ backgroundImage: "url(/first-xi/board.jpg)", backgroundPosition: "center 40%" }} />
          {stub("FORM GUIDE", "The last six")}
          <div className="pgm-form">
            {[...prog.form].reverse().map((g, i) => {
              const r = g.red > g.white ? "R" : g.white > g.red ? "W" : "D";
              return (
                <div key={i} className="pgm-fr">
                  <small>{short(g.date).toUpperCase()}</small>
                  <b>
                    Reds {g.red}–{g.white} Whites
                  </b>
                  <em className={r === "R" ? "" : r === "W" ? "w" : "d"}>{r}</em>
                </div>
              );
            })}
          </div>
          {(() => {
            let n = 0;
            const last = [...prog.form].reverse();
            const who = last[0] ? (last[0].red > last[0].white ? "Reds" : last[0].white > last[0].red ? "Whites" : null) : null;
            for (const g of last) {
              const w = g.red > g.white ? "Reds" : g.white > g.red ? "Whites" : null;
              if (w && w === who) n++;
              else break;
            }
            // A run of 3+ just broken by the latest game is the story too.
            const other = who === "Reds" ? "Whites" : "Reds";
            const run = prog.runEnded;
            const ended = who && n === 1 && run >= 3;
            const lastG = last[0];
            const lastDay = lastG ? new Date(lastG.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }) : "";
            return who && n >= 2 ? (
              <div className="pgm-streak">
                <span>
                  {n} straight {who} wins.
                </span>{" "}
                Can {other} stop the run?
              </div>
            ) : ended ? (
              <div className="pgm-streak">
                <span>
                  {who} ended it on {lastDay}, {Math.max(lastG.red, lastG.white)}–{Math.min(lastG.red, lastG.white)}.
                </span>{" "}
                {other} had won {run} in a row. Who carries it into {Day}?
              </div>
            ) : null;
          })()}
          {folio("FORM")}
        </div>
      ),
    },
    {
      key: "rivalry",
      label: "All-time",
      body: (
        <div className="pgm-pg">
          {stub(
            "ALL-TIME",
            <>
              Reds v Whites,
              <br />
              every game
            </>,
          )}
          <div className="pgm-big">
            <div>
              <b style={{ color: "var(--pgm-red)" }}>{h2h.reds}</b>
              <small>REDS WINS</small>
            </div>
            <div className="d">{h2h.draws} DRAWN</div>
            <div>
              <b>{h2h.whites}</b>
              <small>WHITES WINS</small>
            </div>
          </div>
          <div className="pgm-hb">
            <i style={{ flex: h2h.reds || 0.01, background: "var(--pgm-red)" }} />
            <i style={{ flex: h2h.draws || 0.01, background: "#9a8b6c" }} />
            <i style={{ flex: h2h.whites || 0.01, background: "#fff" }} />
          </div>
          <div className="pgm-copy">
            <p>
              <b>
                {prog.games} games, {prog.goals} goals.
              </b>{" "}
              Reds have scored {h2h.redGoals} to Whites&apos; {h2h.whiteGoals}.
            </p>
            <p>
              Every one of them was on a small pitch. <b>{Day} is the first on a full one:</b> more space, longer runs, heavier legs. And it starts at 0–0.
            </p>
          </div>
          {folio("RIVALRY")}
        </div>
      ),
    },
    {
      key: "watch",
      label: "Ones to watch",
      body: (
        <div className="pgm-pg">
          {stub(
            "ONES TO WATCH",
            <>
              Three names
              <br />
              to know
            </>,
          )}
          {(
            [
              ["THE GOALSCORER", watch.goalscorer, (s: NonNullable<typeof watch.goalscorer>) => `${s.goals} goals in ${s.apps} games. Nobody's scored more.`],
              ["THE SQUAD'S PICK", watch.squadsPick, (s: NonNullable<typeof watch.goalscorer>) => `Man of the Match ${s.motm} ${s.motm === 1 ? "time" : "times"}, with ${s.goals} goals in ${s.apps} games.`],
              ["THE EVER-PRESENT", watch.everPresent, (s: NonNullable<typeof watch.goalscorer>) => `${s.apps} games. Hardly ever misses one.`],
            ] as const
          ).map(([k, s, line]) =>
            s ? (
              <div key={k} className="pgm-star">
                {face(s, "pgm-sph")}
                <div>
                  <small>{k}</small>
                  <b>{s.name}</b>
                  <span>
                    {line(s)} {OnDay}: {sideOf(s.id)}.
                  </span>
                </div>
              </div>
            ) : null,
          )}
          {folio("PLAYERS")}
        </div>
      ),
    },
    {
      key: "honour",
      label: "Roll of honour",
      body: (
        <div className="pgm-pg">
          {stub(
            "ROLL OF HONOUR",
            <>
              Players of
              <br />
              the Month
            </>,
          )}
          <div className="pgm-hon">
            {potm.map((x) => {
              const playing = [...prog.reds, ...prog.whites].some((p) => p.id === x.id);
              return (
                <div key={x.month} className="pgm-hr">
                  {face(x, "pgm-hph")}
                  <div>
                    <small>{x.month.toUpperCase()}</small>
                    <b>{x.name}</b>
                    <span>{playing ? `Playing ${onDay}, for ${sideOf(x.id)}${cap(x.id) ? " (captain)" : ""}` : `Not in ${dayS} squad`}</span>
                  </div>
                </div>
              );
            })}
            {rec.bestHaul && (
              <div className="pgm-hr" style={{ border: 0 }}>
                {face(rec.bestHaul, "pgm-hph")}
                <div>
                  <small>CLUB RECORD · MOST GOALS IN A GAME</small>
                  <b>{rec.bestHaul.name}</b>
                  <span>
                    {rec.bestHaul.goals} in one night, {short(rec.bestHaul.date)}.
                    {[...prog.reds, ...prog.whites].some((p) => p.id === rec.bestHaul!.id) ? ` Playing ${onDay}, for ${sideOf(rec.bestHaul.id)}.` : ""}
                  </span>
                </div>
              </div>
            )}
          </div>
          {folio("HONOURS")}
        </div>
      ),
    },
    {
      key: "records",
      label: "The record book",
      body: (
        <div className="pgm-pg">
          {stub(
            "THE RECORD BOOK",
            <>
              Records to
              <br />
              break {onDay}
            </>,
          )}
          {rec.biggestWin && (
            <div className="pgm-rec">
              <small>BIGGEST WIN</small>
              <b>
                {rec.biggestWin.red >= rec.biggestWin.white
                  ? `Reds ${rec.biggestWin.red}–${rec.biggestWin.white} Whites`
                  : `Whites ${rec.biggestWin.white}–${rec.biggestWin.red} Reds`}
              </b>
              <span>{short(rec.biggestWin.date)}</span>
              <strong>{Math.abs(rec.biggestWin.red - rec.biggestWin.white)}</strong>
              <div className="ask">Can anyone win by more on a big pitch?</div>
            </div>
          )}
          {rec.mostGoals && (
            <div className="pgm-rec">
              <small>MOST GOALS IN ONE GAME</small>
              <b>
                Reds {rec.mostGoals.red}–{rec.mostGoals.white} Whites
              </b>
              <span>{short(rec.mostGoals.date)}</span>
              <strong>{rec.mostGoals.red + rec.mostGoals.white}</strong>
            </div>
          )}
          {rec.bestHaul && (
            <div className="pgm-rec" style={{ border: 0 }}>
              <small>MOST GOALS BY ONE PLAYER</small>
              <b>{rec.bestHaul.name}</b>
              <span>{short(rec.bestHaul.date)}</span>
              <strong>{rec.bestHaul.goals}</strong>
            </div>
          )}
          {folio("RECORDS")}
        </div>
      ),
    },
    {
      key: "road",
      label: "The road here",
      body: (
        <div className="pgm-pg">
          {stub("THE ROAD HERE", "From a Monday kickabout")}
          <div className="pgm-illo" style={{ backgroundImage: "url(/first-xi/road.jpg)" }} />
          <div className="pgm-road">
            {prog.firstDate && (
              <div className="pgm-stop">
                <small>{short(prog.firstDate).toUpperCase()}</small>
                <b>The first game</b>
                <span>
                  A new club: affordable games, run properly. {prog.originals.length} of {dayS} 22 were there.
                </span>
              </div>
            )}
            {firstGoal && (
              <div className="pgm-stop">
                <small>THE SAME NIGHT</small>
                <b>The first goal</b>
                <span>{firstGoal}, the first name on the scoresheet.</span>
              </div>
            )}
            {prog.goal100 && (
              <div className="pgm-stop">
                <small>{short(prog.goal100).toUpperCase()}</small>
                <b>Goal number 100</b>
                <span>The club passes a hundred.</span>
              </div>
            )}
            {prog.twoGameNight && (
              <div className="pgm-stop">
                <small>{short(prog.twoGameNight).toUpperCase()}</small>
                <b>The first two-game night</b>
                <span>Two pitches, both sold out.</span>
              </div>
            )}
            {(() => {
              // The last game before this one, and whether it ended a run.
              const last = [...prog.form].reverse();
              const lg = last[0];
              if (!lg) return null;
              const win = (g: { red: number; white: number }) => (g.red > g.white ? "Reds" : g.white > g.red ? "Whites" : null);
              const who = win(lg);
              const run = prog.runEnded;
              return (
                <div className="pgm-stop">
                  <small>{short(lg.date).toUpperCase()}</small>
                  <b>The last game before</b>
                  <span>
                    {who ? `${who} won ${Math.max(lg.red, lg.white)}–${Math.min(lg.red, lg.white)}` : `${lg.red}–${lg.white}, honours even`}
                    {who && run >= 3 ? `, ending a run of ${run} ${who === "Reds" ? "Whites" : "Reds"} wins` : ""}.
                  </span>
                </div>
              );
            })()}
            <div className="pgm-stop now">
              <small>{isDay ? "TODAY" : short(prog.game.date).toUpperCase()}</small>
              <b>The First XI</b>
              <span>Eleven a side, for the first time.</span>
            </div>
          </div>
          {folio("HISTORY")}
        </div>
      ),
    },
    {
      key: "originals",
      label: "The originals",
      body: (
        <div className="pgm-pg">
          {stub("HERE FROM DAY ONE", "The originals")}
          <p className="pgm-p">
            {prog.originals.length} of {dayS} 22 played the very first game{prog.firstDate ? `, on ${long(prog.firstDate)}` : ""}.
          </p>
          <div className="pgm-orig">
            {prog.originals.map((p, i) => (
              <div key={p.id}>
                {face(p, "pgm-oph", { ["--r" as string]: `${[-3, 2, -1, 3, -2, 1, -3, 2, 0][i % 9]}deg` } as React.CSSProperties)}
                <span>{p.name.split(" ")[0]}</span>
              </div>
            ))}
          </div>
          {folio("ORIGINALS")}
        </div>
      ),
    },
    {
      key: "numbers",
      label: "The club in numbers",
      body: (
        <div className="pgm-pg">
          {stub(
            "THE CLUB IN NUMBERS",
            <>
              The story
              <br />
              so far
            </>,
          )}
          <div className="pgm-nums">
            <div>
              <b>{prog.games}</b>
              <small>GAMES PLAYED</small>
            </div>
            <div>
              <b>{prog.goals}</b>
              <small>GOALS SCORED</small>
            </div>
            <div>
              <b>{prog.players}</b>
              <small>PLAYERS HAVE PLAYED</small>
            </div>
            <div>
              <b>{members}</b>
              <small>MEMBERS</small>
            </div>
            <div>
              <b>{prog.hatTricks}</b>
              <small>HAT-TRICKS</small>
            </div>
            <div>
              <b>{prog.games ? (prog.goals / prog.games).toFixed(1) : "0"}</b>
              <small>GOALS A GAME</small>
            </div>
          </div>
          {folio("NUMBERS")}
        </div>
      ),
    },
    {
      key: "ads",
      label: "The Boot Room",
      body: (
        <div className="pgm-pg">
          {stub(
            "THE BOOT ROOM",
            <>
              Support the
              <br />
              squad&apos;s businesses
            </>,
          )}
          <div className="pgm-ads">
            {ads.length === 0 && <p className="pgm-p">The squad&apos;s own trades and services live in the Boot Room. Claim your peg there.</p>}
            {ads.slice(0, 4).map((a) => (
              <div key={a.company} className={"pgm-ad" + (a.logoUrl ? " has" : "")}>
                {a.logoUrl && <img src={a.logoUrl} alt="" />}
                <div className="kicker">{(a.tag ?? "LOCAL").toUpperCase()}</div>
                <b>{a.company}</b>
                {a.description && <p>{a.description.trim().replace(/([^.!?])$/, "$1.")}</p>}
                <div className="by">RUN BY {a.owner.toUpperCase()} · IN THE BOOT ROOM</div>
              </div>
            ))}
          </div>
          {folio("ADVERTS")}
        </div>
      ),
    },
    {
      key: "quiz",
      label: "Half-time quiz",
      body: (
        <div className="pgm-pg">
          {stub(
            "HALF-TIME QUIZ",
            <>
              How well do you
              <br />
              know the club?
            </>,
          )}
          {firstGoal && (
            <div className="pgm-q">
              <b>1</b>Who scored the club&apos;s first ever goal?
            </div>
          )}
          {rec.bestHaul && (
            <div className="pgm-q">
              <b>2</b>How many goals did {rec.bestHaul.name} score in one game?
            </div>
          )}
          <div className="pgm-q">
            <b>3</b>Which side has won more: Reds or Whites?
          </div>
          {prog.goal100 && (
            <div className="pgm-q">
              <b>4</b>When did the 100th goal go in?
            </div>
          )}
          <div className="pgm-ans">
            ANSWERS: {firstGoal ? `1 ${firstGoal} · ` : ""}
            {rec.bestHaul ? `2 ${rec.bestHaul.goals} · ` : ""}3 {h2h.reds >= h2h.whites ? "Reds" : "Whites"}, {Math.max(h2h.reds, h2h.whites)} to {Math.min(h2h.reds, h2h.whites)}
            {prog.goal100 ? ` · 4 ${dt(prog.goal100, { day: "numeric", month: "long" })}` : ""}
          </div>
          {folio("QUIZ")}
        </div>
      ),
    },
    {
      key: "matchday",
      label: "On the day",
      body: (
        <div className="pgm-pg">
          {stub("MATCHDAY", "On the day")}
          <dl className="pgm-tick">
            <dt>KICK-OFF</dt>
            <dd>{prog.game.kickoff}, so be there 20 minutes early</dd>
            <dt>VENUE</dt>
            <dd>Solar Campus</dd>
            <dt>FORMAT</dt>
            <dd>11-a-side, a club first</dd>
            <dt>SQUAD</dt>
            <dd>
              22{prog.waiting ? `, plus ${prog.waiting} on the waiting list` : ""}
            </dd>
            <dt>AFTER</dt>
            <dd>Man of the Match vote opens at full time</dd>
            <dt>KEEP</dt>
            <dd>Every player gets the First XI pennant</dd>
            <dt>FOREVER</dt>
            <dd>This programme stays in History</dd>
          </dl>
          <div className="pgm-stub">
            <span>ADMIT ONE · THE FIRST XI</span>
            <b>Nº1</b>
          </div>
          {folio("MATCHDAY")}
        </div>
      ),
    },
    ...(result
      ? [
          {
            key: "ft",
            label: "Full time",
            // Once it's all confirmed (score in, Man of the Match vote
            // closed) the closing page is the full result sheet.
            body: result.motm ? (
              <div className="pgm-pg pgm-final">
                <div className="pgm-fa-top">
                  <img src="/crest.png" alt="" />
                  <span>
                    <small>WIRRAL COMMUNITY FOOTBALL</small>
                    <b>The First XI</b>
                  </span>
                </div>
                <div className="pgm-fa-k">FULL TIME</div>
                <div className="pgm-fa-sc">
                  <span className="t r">Reds</span>
                  <span className="n">
                    <b className="r">{result.red}</b>
                    <i>–</i>
                    <b>{result.white}</b>
                  </span>
                  <span className="t">Whites</span>
                </div>
                <div className="pgm-fa-gl">
                  <span>{result.redScorers ?? ""}</span>
                  <span>{result.whiteScorers ?? ""}</span>
                </div>
                <div className="pgm-fa-mo">
                  <span className="medal" aria-hidden="true">
                    ★
                  </span>
                  <span>
                    <small>MAN OF THE MATCH</small>
                    <b>{result.motm}</b>
                  </span>
                </div>
                <div className="pgm-fa-xi">
                  {(
                    [
                      ["REDS", prog.reds, "r"],
                      ["WHITES", prog.whites, ""],
                    ] as const
                  ).map(([label, list, cls]) => (
                    <div key={label}>
                      <h4 className={cls}>{label}</h4>
                      <ul>
                        {[...list]
                          .sort((a, b) => Number(cap(b.id)) - Number(cap(a.id)))
                          .map((p) => (
                            <li key={p.id}>
                              {p.name}
                              {cap(p.id) && <em>C</em>}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
                </div>
                {onSharePoster && (
                  <button
                    className="pgm-fa-share"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSharePoster();
                    }}
                  >
                    Share the full-time poster ›
                  </button>
                )}
                <div className="pgm-fa-foot">
                  <span>{dt(prog.game.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase()}</span>
                  <span>SOLAR CAMPUS</span>
                  <span>Nº1</span>
                </div>
              </div>
            ) : (
              <div className="pgm-pg">
                {stub("FULL TIME", "How it finished")}
                <div className="pgm-score">
                  <div>
                    <b style={{ color: "var(--pgm-red)" }}>{result.red}</b>
                    <small>REDS</small>
                  </div>
                  <div className="d">FT</div>
                  <div>
                    <b>{result.white}</b>
                    <small>WHITES</small>
                  </div>
                </div>
                <dl className="pgm-ftd">
                  {result.scorers && (
                    <>
                      <dt>GOALS</dt>
                      <dd>{result.scorers}</dd>
                    </>
                  )}
                  {result.motm && (
                    <>
                      <dt>MAN OF THE MATCH</dt>
                      <dd>{result.motm}, with the First XI medal</dd>
                    </>
                  )}
                  <dt>PLAYED</dt>
                  <dd>22 players, the club&apos;s first 11-a-side</dd>
                </dl>
                {folio("FULL TIME")}
              </div>
            ),
          },
        ]
      : []),
    {
      key: "back",
      label: "Back cover",
      body: (
        <div className="pgm-pg pgm-backc">
          <img src="/crest.png" alt="" />
          <b>
            See you
            <br />
            next week
          </b>
          <span>Book your next game in the app. Mondays and Thursdays, all year round.</span>
          <div className="pgm-strip" />
        </div>
      ),
    },
  ];

  const [pg, setPg] = useState(0);
  const [leaving, setLeaving] = useState<{ i: number; dir: 1 | -1 } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const go = (n: number) => {
    const next = Math.max(0, Math.min(pages.length - 1, n));
    if (next === pg) return;
    setLeaving({ i: pg, dir: next > pg ? 1 : -1 });
    setPg(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLeaving(null), 520);
  };
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(pg + 1);
      if (e.key === "ArrowLeft") go(pg - 1);
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pg]);
  // Swipe to turn.
  const touch = useRef<number | null>(null);
  const numbered = useMemo(() => pages.map((p, i) => ({ ...p, n: i + 1 })), [pages]);

  return (
    <div className="pgm" role="dialog" aria-label="The First XI matchday programme">
      <style>{programmeCss}</style>
      <button className="pgm-x" onClick={onClose} aria-label="Close the programme">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div
        className="pgm-book"
        onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touch.current == null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          touch.current = null;
          if (Math.abs(dx) > 40) go(dx < 0 ? pg + 1 : pg - 1);
        }}
      >
        {numbered.map((p, i) => {
          const on = i === pg;
          const out = leaving?.i === i;
          if (!on && !out) return null;
          return (
            <div
              key={p.key}
              className={"pgm-leaf" + (on ? " on" : "") + (out ? (leaving!.dir === 1 ? " out" : " outb") : "") + (on && leaving?.dir === -1 ? " inb" : "")}
              onClick={() => on && go(pg + 1)}
              style={{ ["--n" as string]: `"${p.n}"` } as React.CSSProperties}
            >
              {p.body}
            </div>
          );
        })}
      </div>
      <div className="pgm-nav">
        <button onClick={() => go(pg - 1)} disabled={pg === 0}>
          ‹ Back
        </button>
        <span>
          {pg + 1} / {pages.length}
        </span>
        <button onClick={() => go(pg + 1)} disabled={pg === pages.length - 1}>
          Turn page ›
        </button>
      </div>
    </div>
  );
}

export const programmeCss = `
.pgm-final{display:flex;flex-direction:column;padding:22px 20px 16px !important}
.pgm-fa-top{display:flex;align-items:center;gap:10px;border-bottom:3px solid var(--pgm-red);padding-bottom:10px}
.pgm-fa-top img{width:40px}
.pgm-fa-top small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.26em;color:var(--pgm-red)}
.pgm-fa-top b{display:block;font:700 24px/1 var(--font-oswald),sans-serif;text-transform:uppercase;color:var(--pgm-ink)}
.pgm-fa-k{margin-top:18px;text-align:center;font:700 14px var(--font-oswald),sans-serif;letter-spacing:.42em;color:var(--pgm-mute)}
.pgm-fa-sc{display:grid;grid-template-columns:1fr auto 1fr;align-items:center}
.pgm-fa-sc .t{font:700 20px var(--font-oswald),sans-serif;letter-spacing:.1em;text-transform:uppercase;text-align:center;color:var(--pgm-ink)}
.pgm-fa-sc .t.r{color:var(--pgm-red)}
.pgm-fa-sc .n{display:flex;align-items:center;gap:12px;font:700 92px/1 var(--font-oswald),sans-serif;color:var(--pgm-ink)}
.pgm-fa-sc .n .r{color:var(--pgm-red)}
.pgm-fa-sc .n i{font-style:normal;font-size:44px;color:#b8ab90}
.pgm-fa-gl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px;font:600 11.5px/1.45 var(--sans);text-align:center;color:#3a352b}
.pgm-fa-mo{display:flex;align-items:center;gap:12px;margin:18px auto 0;padding:8px 18px 8px 8px;border:2px solid var(--pgm-ink);border-radius:100px}
.pgm-fa-mo .medal{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 28%,#fff6d1,#f5d97a 50%,#b8902a);color:#3a2a08;font-size:20px}
.pgm-fa-mo small{display:block;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.26em;color:var(--pgm-red)}
.pgm-fa-mo b{display:block;font:700 20px/1.1 var(--font-oswald),sans-serif;text-transform:uppercase;color:var(--pgm-ink)}
.pgm-fa-xi{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px;border-top:2px solid var(--pgm-ink);padding-top:12px}
.pgm-fa-xi h4{margin:0 0 6px;font:700 11px var(--font-oswald),sans-serif;letter-spacing:.3em;color:var(--pgm-ink)}
.pgm-fa-xi h4.r{color:var(--pgm-red)}
.pgm-fa-xi ul{list-style:none;margin:0;padding:0;font:500 11.5px/1.6 var(--sans);color:#3a352b}
.pgm-fa-xi em{display:inline-block;margin-left:5px;padding:0 4px;border-radius:3px;background:var(--pgm-red);color:#fff;font:700 8.5px/1.5 var(--font-oswald),sans-serif;font-style:normal;vertical-align:1px}
.pgm-fa-share{align-self:center;margin-top:auto;padding:9px 18px;border-radius:999px;border:2px solid var(--pgm-ink);background:none;color:var(--pgm-ink);font:700 12px var(--font-oswald),sans-serif;letter-spacing:.16em;text-transform:uppercase;cursor:pointer}
.pgm-fa-foot{display:flex;justify-content:space-between;margin-top:14px;padding-top:8px;border-top:2px solid var(--pgm-ink);font:600 9px var(--font-oswald),sans-serif;letter-spacing:.2em;color:var(--pgm-mute)}
.pgm{--pgm-red:#d62839;--pgm-paper:#f3ead8;--pgm-ink:#1b1a17;--pgm-mute:#6f6450;position:fixed;inset:0;z-index:150;background:radial-gradient(80% 60% at 50% 40%,#1b2032,#07080d);display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top,0px) + 10px) 0 calc(env(safe-area-inset-bottom,0px) + 10px);animation:pgmIn .3s ease-out}
@keyframes pgmIn{from{opacity:0}}
.pgm-x{position:absolute;right:14px;top:calc(env(safe-area-inset-top,0px) + 14px);z-index:9;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(6,8,14,.7);color:#fff;display:grid;place-items:center;cursor:pointer}
.pgm-book{position:relative;flex:1;width:100%;max-width:440px;margin:0 auto;min-height:0}
.pgm-leaf{position:absolute;inset:6px 14px 8px;border-radius:3px 10px 10px 3px;box-shadow:0 20px 40px -12px rgba(0,0,0,.8);overflow:hidden;cursor:pointer}
.pgm-leaf.out{z-index:5;animation:pgmOut .5s cubic-bezier(.5,0,.75,0) forwards;pointer-events:none}
.pgm-leaf.outb{z-index:5;animation:pgmOutB .5s cubic-bezier(.5,0,.75,0) forwards;pointer-events:none}
.pgm-leaf.on.inb{animation:pgmInB .5s ease-out}
@keyframes pgmOut{to{transform:translateX(-112%) rotate(-5deg);opacity:.2}}
@keyframes pgmOutB{to{transform:translateX(112%) rotate(5deg);opacity:.2}}
@keyframes pgmInB{from{transform:translateX(-30px);opacity:0}}
.pgm-nav{display:flex;justify-content:center;align-items:center;gap:12px;padding-top:6px}
.pgm-nav button{height:38px;padding:0 16px;border-radius:19px;border:1px solid rgba(148,163,184,.2);background:rgba(6,8,14,.7);color:#fff;font:700 13px var(--sans);cursor:pointer}
.pgm-nav button:disabled{opacity:.35}
.pgm-nav span{font-size:12px;color:#94a3b8;min-width:48px;text-align:center;font-variant-numeric:tabular-nums}
.pgm-pg{position:absolute;inset:0;background:var(--pgm-paper);color:var(--pgm-ink);padding:18px 18px 30px;background-image:radial-gradient(rgba(0,0,0,.035) 1px,transparent 1px);background-size:3px 3px;overflow:hidden;font-family:var(--sans);text-align:left}
.pgm-pg::after{content:"";position:absolute;left:0;top:0;bottom:0;width:16px;background:linear-gradient(90deg,rgba(0,0,0,.16),transparent);pointer-events:none}
.pgm-folio{position:absolute;left:18px;right:18px;bottom:10px;display:flex;justify-content:space-between;font:500 9.5px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--pgm-mute)}
.pgm-fn::after{content:var(--n);font-style:normal}
.pgm-leaf .pgm-fn{font-style:normal}
.pgm-eb{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;color:var(--pgm-red)}
.pgm-pg h3{font:700 30px/.95 var(--font-oswald),sans-serif;text-transform:uppercase;margin:4px 0 0;color:var(--pgm-ink)}
.pgm-rule{height:3px;background:var(--pgm-ink);margin:10px 0 12px}
.pgm-hero{margin:-18px -18px 12px;height:150px;background:center 60%/cover;border-bottom:3px solid var(--pgm-ink)}
.pgm-p{font-size:12.5px;margin:0 0 10px;color:#3a342a;line-height:1.45}
.pgm-cover{background:#0e1220;color:#fff;display:flex;flex-direction:column;padding:0}
.pgm-band{position:relative;flex:1.15;min-height:0;background:linear-gradient(180deg,rgba(14,18,32,.4) 0%,rgba(14,18,32,0) 22%,rgba(14,18,32,0) 62%,#0e1220 100%),url(/first-xi/cover.jpg) 50% 70%/cover}
.pgm-top{position:absolute;left:16px;right:16px;top:14px;display:flex;justify-content:space-between;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em}
.pgm-price{background:var(--pgm-red);padding:3px 8px}
.pgm-low{padding:0 18px 18px;margin-top:-34px;position:relative;display:flex;flex-direction:column}
.pgm-low img{width:58px}
.pgm-t{font:700 50px/.9 var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:6px}
.pgm-t span{color:#f5d97a}
.pgm-vs{display:flex;align-items:center;gap:8px;margin-top:10px;font:600 17px var(--font-oswald),sans-serif;letter-spacing:.1em;text-transform:uppercase}
.pgm-vs i{width:24px;height:6px;display:inline-block}
.pgm-meta{margin-top:6px;font-size:12px;color:#e2e8f0;line-height:1.45}
.pgm-strip{margin-top:14px;height:8px;background:repeating-linear-gradient(90deg,var(--pgm-red) 0 18px,#fff 18px 36px)}
.pgm-letter{font-family:Georgia,serif;font-size:12.6px;line-height:1.5;color:#2b2720}
.pgm-letter p{margin:0 0 7px}
.pgm-drop::first-letter{float:left;font:700 46px/.8 var(--font-oswald),sans-serif;color:var(--pgm-red);margin:4px 6px 0 0}
.pgm-sign{font:700 26px var(--font-caveat),cursive;color:var(--pgm-ink);margin-top:4px}
.pgm-sign small{display:block;font:500 10px var(--font-oswald),sans-serif;letter-spacing:.2em;color:var(--pgm-mute)}
.pgm-sides{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pgm-side h4{margin:0 0 6px;font:700 16px var(--font-oswald),sans-serif;letter-spacing:.12em;text-transform:uppercase;padding-bottom:5px;border-bottom:3px solid var(--c);color:var(--pgm-ink)}
.pgm-side div{display:flex;align-items:center;gap:6px;padding:3.5px 0;border-bottom:1px dotted rgba(0,0,0,.22);font-size:12px;min-width:0}
.pgm-side span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pgm-side em{font-style:normal;font:700 9px var(--font-oswald),sans-serif;color:#fff;background:var(--pgm-ink);padding:1px 4px;margin-left:2px;flex:none}
.pgm-ph{width:22px;height:22px;border-radius:50%;object-fit:cover;filter:grayscale(1) contrast(1.1);flex:none;display:grid;place-items:center;font:700 10px var(--font-oswald),sans-serif;color:#fff}
.pgm-foot{margin-top:10px;font-size:11px;color:var(--pgm-mute);font-style:italic}
.pgm-tape .pgm-hd{display:grid;grid-template-columns:1fr auto 1fr;align-items:end;font:700 18px var(--font-oswald),sans-serif;text-transform:uppercase;border-bottom:3px solid var(--pgm-ink);padding-bottom:6px}
.pgm-tape .pgm-hd span:last-child{text-align:right}
.pgm-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:7px 0;border-bottom:1px solid rgba(0,0,0,.15)}
.pgm-row b{font:700 26px/1 var(--font-oswald),sans-serif}
.pgm-row b:last-child{text-align:right}
.pgm-row b.win{color:var(--pgm-red)}
.pgm-row small{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--pgm-mute);text-align:center;padding:0 6px}
.pgm-verdict{margin-top:12px;padding:10px 12px;background:var(--pgm-ink);color:var(--pgm-paper);font-size:12.5px;line-height:1.45}
.pgm-verdict b{color:#f5d97a}
.pgm-fr{display:grid;grid-template-columns:54px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(0,0,0,.15)}
.pgm-fr small{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.14em;color:var(--pgm-mute)}
.pgm-fr b{font:700 17px var(--font-oswald),sans-serif}
.pgm-fr em{font-style:normal;width:26px;height:26px;display:grid;place-items:center;font:700 13px var(--font-oswald),sans-serif;color:#fff;background:var(--pgm-red)}
.pgm-fr em.w{background:#fff;color:var(--pgm-ink);border:2px solid var(--pgm-ink)}
.pgm-fr em.d{background:#9a8b6c}
.pgm-streak{margin-top:12px;font:700 20px/1.15 var(--font-oswald),sans-serif;text-transform:uppercase}
.pgm-streak span{color:var(--pgm-red)}
.pgm-big{display:grid;grid-template-columns:1fr auto 1fr;align-items:end;text-align:center;margin-top:4px}
.pgm-big b{display:block;font:700 92px/.85 var(--font-oswald),sans-serif}
.pgm-big small{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.2em}
.pgm-big .d{font:600 13px var(--font-oswald),sans-serif;letter-spacing:.1em;color:var(--pgm-mute);padding-bottom:16px}
.pgm-hb{display:flex;height:10px;margin-top:14px;border:2px solid var(--pgm-ink)}
.pgm-copy{font-size:12.5px;line-height:1.55;color:#3a342a;margin-top:12px;columns:2;column-gap:14px}
.pgm-copy p{margin:0 0 8px}
.pgm-copy b{color:var(--pgm-ink)}
.pgm-star{display:grid;grid-template-columns:86px 1fr;gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid rgba(0,0,0,.15)}
.pgm-star:last-of-type{border:0}
.pgm-sph{width:86px;height:86px;object-fit:cover;filter:grayscale(1) contrast(1.1);border:3px solid var(--pgm-ink);display:grid;place-items:center;font:700 36px var(--font-oswald),sans-serif;color:#fff}
.pgm-star>div>small,.pgm-hr>div>small,.pgm-rec>small{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.2em;color:var(--pgm-red)}
.pgm-star>div>b,.pgm-hr>div>b{display:block;font:700 20px/1.05 var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:2px}
.pgm-star>div>span,.pgm-hr>div>span{display:block;font-size:11.5px;color:#4a4236;margin-top:4px;line-height:1.35}
.pgm-hon{display:grid;gap:10px}
.pgm-hr{display:grid;grid-template-columns:62px 1fr;gap:12px;align-items:center;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,.15)}
.pgm-hph{width:62px;height:62px;border-radius:50%;object-fit:cover;border:3px solid #f5d97a;display:grid;place-items:center;font:700 24px var(--font-oswald),sans-serif;color:#fff;box-shadow:0 0 0 2px var(--pgm-ink)}
.pgm-rec{padding:10px 0;border-bottom:1px solid rgba(0,0,0,.18);display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:end}
.pgm-rec>small{grid-column:1/-1}
.pgm-rec b{font:700 19px/1.1 var(--font-oswald),sans-serif;text-transform:uppercase}
.pgm-rec span{font-size:11.5px;color:var(--pgm-mute)}
.pgm-rec strong{font:700 34px/1 var(--font-oswald),sans-serif;grid-row:2/4;grid-column:2}
.pgm-rec .ask{grid-column:1/-1;font:700 15px var(--font-caveat),cursive;color:var(--pgm-red);margin-top:2px}
.pgm-illo{height:190px;margin:0 0 12px;border:3px solid var(--pgm-ink);background:center 30%/cover}
.pgm-road{position:relative;padding-left:20px}
.pgm-road::before{content:"";position:absolute;left:6px;top:6px;bottom:6px;width:2px;background:var(--pgm-ink)}
.pgm-stop{position:relative;padding:0 0 9px}
.pgm-stop::before{content:"";position:absolute;left:-19px;top:4px;width:12px;height:12px;border-radius:50%;background:var(--pgm-paper);border:2.5px solid var(--pgm-ink)}
.pgm-stop.now::before{background:var(--pgm-red);border-color:var(--pgm-red);box-shadow:0 0 0 4px rgba(214,40,57,.2)}
.pgm-stop small{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--pgm-mute)}
.pgm-stop b{display:block;font:700 14.5px/1.15 var(--font-oswald),sans-serif;text-transform:uppercase}
.pgm-stop span{display:block;font-size:11.5px;color:#4a4236;line-height:1.35}
.pgm-orig{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.pgm-orig div{text-align:center;font-size:11px;font-weight:700}
.pgm-oph{width:100%;aspect-ratio:1;object-fit:cover;filter:grayscale(1) sepia(.3) contrast(1.05);border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.3);display:grid;place-items:center;font:700 26px var(--font-oswald),sans-serif;color:#fff;transform:rotate(var(--r))}
.pgm-orig span{display:block;margin-top:5px}
.pgm-nums{display:grid;grid-template-columns:1fr 1fr;border-top:3px solid var(--pgm-ink)}
.pgm-nums div{padding:10px 4px 9px;border-bottom:1px solid rgba(0,0,0,.18)}
.pgm-nums div:nth-child(odd){border-right:1px solid rgba(0,0,0,.18);padding-right:10px}
.pgm-nums div:nth-child(even){padding-left:12px}
.pgm-nums b{display:block;font:700 42px/1 var(--font-oswald),sans-serif}
.pgm-nums small{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--pgm-mute)}
.pgm-ads{display:grid;gap:9px}
.pgm-ad{border:3px double var(--pgm-ink);padding:10px 12px;position:relative;background:#fbf5e8;text-align:center}
.pgm-ad.has{text-align:left;padding-right:104px}
.pgm-ad .kicker{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.22em;color:var(--pgm-mute)}
.pgm-ad b{display:block;font:italic 700 21px/1.05 var(--font-playfair),Georgia,serif;margin-top:2px}
.pgm-ad p{margin:4px 0 0;font-size:11.5px;line-height:1.4;color:#3a342a}
.pgm-ad .by{margin-top:5px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.14em;color:var(--pgm-red)}
.pgm-ad img{position:absolute;right:10px;top:10px;width:84px;border:1px solid #000}
.pgm-q{padding:9px 0;border-bottom:1px dotted rgba(0,0,0,.3);font-size:13px}
.pgm-q b{font:700 14px var(--font-oswald),sans-serif;color:var(--pgm-red);margin-right:6px}
.pgm-ans{margin-top:14px;padding:10px;border:2px dashed rgba(0,0,0,.3);transform:rotate(180deg);font-size:11.5px;color:#4a4236;line-height:1.5}
.pgm-tick{display:grid;grid-template-columns:auto 1fr;gap:7px 12px;margin:4px 0 0;font-size:12.5px}
.pgm-tick dt{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--pgm-mute);padding-top:2px}
.pgm-tick dd{margin:0;font-weight:700}
.pgm-stub{margin-top:14px;border:2px dashed rgba(0,0,0,.35);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;font:600 11px var(--font-oswald),sans-serif;letter-spacing:.14em}
.pgm-stub b{font:700 24px var(--font-oswald),sans-serif;color:var(--pgm-red)}
.pgm-score{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;text-align:center}
.pgm-score b{font:700 80px/.9 var(--font-oswald),sans-serif}
.pgm-score small{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.2em}
.pgm-score .d{font:600 22px var(--font-oswald),sans-serif;color:var(--pgm-mute)}
.pgm-ftd{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;margin:14px 0 0;font-size:12.5px}
.pgm-ftd dt{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--pgm-mute);padding-top:2px}
.pgm-ftd dd{margin:0;font-weight:700}
.pgm-backc{color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;text-align:center;padding-bottom:44px;background-image:linear-gradient(180deg,rgba(150,16,30,0) 0%,rgba(150,16,30,.05) 55%,rgba(150,16,30,.94) 80%),url(/first-xi/spot.jpg);background-size:cover;background-position:50% 40%}
.pgm-backc img{width:54px}
.pgm-backc b{font:700 34px/1 var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:14px}
.pgm-backc span{font-size:12.5px;margin-top:8px;color:#ffe1e3;max-width:24ch;line-height:1.5}
.pgm-backc .pgm-strip{position:absolute;left:0;right:0;bottom:0;height:12px;margin:0;background:repeating-linear-gradient(90deg,#fff 0 18px,var(--pgm-red) 18px 36px)}
@media (prefers-reduced-motion: reduce){.pgm,.pgm-leaf{animation:none!important}}
`;
