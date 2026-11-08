"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import {
  AUTO_RULES,
  AWARD_IDEAS,
  KIND_LABEL,
  awardPhase,
  fmtAwardDate,
  isoToLondonWall,
  londonToIso,
  suggestDates,
  type AutoRule,
  type AwardCategory,
  type AwardKind,
  type AwardNomination,
  type AwardSeason,
} from "../../lib/awards";
import { Avatar } from "./shared";
import { awardsCss, type AwardsApi } from "./awards";

// Admin › Awards: set up a season (dates, games to vote), its awards (and
// how each is decided), and build the shortlists, mostly by picking from
// what the app already knows: the season's goals, its moments and records,
// and the players. Players' suggestions wait here to be approved. While
// voting is open it shows turnout only; the ballot is secret.

export type SeasonPlayer = { id: string; name: string; avatar: string | null; apps: number; goals: number };
export type SeasonGame = { id: string; date: string; white: number; red: number };
export type GoalLine = { game_id: string; player_id: string; goals: number };
export type MomentIdea = { key: string; title: string; detail: string; date: string; big: string; player_id: string | null; game_id: string | null };

type Props = {
  api: AwardsApi;
  players: SeasonPlayer[];
  games: SeasonGame[];
  goals: GoalLine[];
  moments: MomentIdea[];
  lastGameDate: string | null;
  today: string;
  whiteName: string;
  redName: string;
  notifyError: (m: string) => void;
  notifySuccess: (m: string) => void;
  confirm: (title: string, message: string, label: string) => Promise<boolean>;
};

type NomDraft = { category_id: string; player_id: string | null; game_id: string | null; title: string; detail: string };
type Sheet =
  | { k: "season" }
  | { k: "ideas" }
  | { k: "award"; cat: Partial<AwardCategory> & { id?: string } }
  | { k: "nominee"; draft: NomDraft }
  | { k: "players"; category_id: string };

const shortDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function AdminAwards(p: Props) {
  const { api } = p;
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [turnout, setTurnout] = useState<{ voted: number; eligible: number; by_award: Record<string, number> } | null>(null);
  const year = Number(p.today.slice(0, 4));
  const season = api.season && api.season.season === year ? api.season : null;
  const phase = season ? awardPhase(season, Date.now()) : null;
  const byId = useMemo(() => new Map(p.players.map((x) => [x.id, x])), [p.players]);
  const gameById = useMemo(() => new Map(p.games.map((g) => [g.id, g])), [p.games]);

  useEffect(() => {
    if (!season || (phase !== "voting" && phase !== "closed")) return;
    supabase.rpc("award_turnout", { p_season: season.season }).then(({ data }) => data && setTurnout(data));
  }, [season, phase, api.myVotes]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) => {
    const { error } = await fn();
    if (error) return p.notifyError(error.message), false;
    await api.reload();
    if (ok) p.notifySuccess(ok);
    return true;
  };

  const eligibleNow = (min: number) => p.players.filter((x) => x.apps >= min).length;
  const gameLine = (id: string | null) => {
    const g = id ? gameById.get(id) : null;
    return g ? `${shortDate(g.date)} · ${p.whiteName} ${g.white}–${g.red} ${p.redName}` : "";
  };
  const face = (id: string | null, fallback = "?") => {
    const pl = id ? byId.get(id) : null;
    return <Avatar name={pl?.name ?? fallback} avatarUrl={pl?.avatar ?? null} className="aw-face" />;
  };

  if (api.missing)
    return (
      <div className="aw">
        <style>{awardsCss}</style>
        <section className="aw-hero">
          <small className="ey">Season awards</small>
          <b>Needs its database update</b>
          <p>Run the season awards SQL in Supabase, then come back here to set up the awards.</p>
        </section>
      </div>
    );
  if (!api.ready) return null;

  const cats = api.categories;
  const cat = openCat ? cats.find((c) => c.id === openCat) ?? null : null;
  const nomsFor = (id: string, status: AwardNomination["status"]) => api.nominations.filter((n) => n.category_id === id && n.status === status);

  return (
    <div className="aw">
      <style>{awardsCss}</style>
      {!season && (
        <section className="aw-hero">
          <small className="ey">Season awards</small>
          <b>Set up the {year} awards</b>
          <p>Pick the dates, how many games people need to vote, and the awards themselves. Nothing reaches players until nominations open.</p>
          <button className="aw-btn" onClick={() => setSheet({ k: "season" })}>
            Set up awards
          </button>
        </section>
      )}

      {season && !cat && (
        <>
          <section className="aw-card">
            <header>
              <h4>{season.title}</h4>
              <button className="lnk" onClick={() => setSheet({ k: "season" })}>
                Edit ›
              </button>
            </header>
            <div className="aw-tl">
              {(
                [
                  ["Nominations open", season.nominations_from, "nominations", false],
                  ["Voting opens", season.opens_at, "voting", true],
                  ["Voting closes", season.closes_at, "closed", true],
                  ["Awards Night", season.reveal_at, "revealed", true],
                ] as const
              ).map(([label, iso, ph, time]) => (
                <div key={label} className={"r" + (phase === ph ? " now" : "") + (ph === "revealed" ? " gold" : "")}>
                  <i />
                  <span>{label}</span>
                  <em>{fmtAwardDate(iso, time)}</em>
                </div>
              ))}
            </div>
            <div className="aw-meta">
              <span className="aw-chip">
                <b>{season.min_games}</b> games to vote
              </span>
              <span className="aw-chip">
                <b>{eligibleNow(season.min_games)}</b> can vote today
              </span>
            </div>
          </section>

          {turnout && (
            <section className="aw-card">
              <header>
                <h4>{phase === "voting" ? "Voting is open" : "Voting has closed"}</h4>
                <span>{phase === "voting" ? `Closes ${fmtAwardDate(season.closes_at, false)}` : `Awards Night ${fmtAwardDate(season.reveal_at, false)}`}</span>
              </header>
              <div className="aw-turn">
                <b>{turnout.voted}</b>
                <span>of {turnout.eligible} have voted</span>
              </div>
              <div className="aw-barr">
                <i style={{ width: `${turnout.eligible ? (turnout.voted / turnout.eligible) * 100 : 0}%` }} />
              </div>
              <div className="aw-per">
                {cats
                  .filter((c) => c.kind !== "auto")
                  .map((c) => (
                    <span key={c.id} style={{ display: "contents" }}>
                      <span>{c.name}</span>
                      <em>{turnout.by_award[c.id] ?? 0}</em>
                    </span>
                  ))}
              </div>
              <div className="aw-seal">
                <i />
                Results are sealed until Awards Night, {fmtAwardDate(season.reveal_at)}. Nobody can see them, admins included.
              </div>
            </section>
          )}

          <section className="aw-card">
            <header>
              <h4>The awards</h4>
              <span>{cats.length ? "In ballot order" : "None yet"}</span>
            </header>
            {cats.map((c, i) => {
              const short = nomsFor(c.id, "shortlisted").length;
              const sugg = nomsFor(c.id, "suggested").length;
              const sub =
                c.kind === "auto"
                  ? `Worked out · ${AUTO_RULES.find((r) => r.key === c.auto_rule)?.label.toLowerCase() ?? ""}`
                  : c.kind === "player"
                    ? KIND_LABEL.player
                    : `From your shortlist · ${short} nominee${short === 1 ? "" : "s"}`;
              const move = async (dir: -1 | 1) => {
                const other = cats[i + dir];
                if (!other) return;
                await run(async () => {
                  const a = await supabase.from("award_categories").update({ sort: i + dir }).eq("id", c.id);
                  if (a.error) return a;
                  return supabase.from("award_categories").update({ sort: i }).eq("id", other.id);
                });
              };
              return (
                <div key={c.id} className="aw-row">
                  <span className="mv">
                    <button disabled={i === 0} onClick={() => move(-1)} aria-label="Move up">
                      ▲
                    </button>
                    <button disabled={i === cats.length - 1} onClick={() => move(1)} aria-label="Move down">
                      ▼
                    </button>
                  </span>
                  <span className={"ic" + (c.kind === "auto" ? " auto" : "")}>{c.kind === "auto" ? "∑" : c.name.trim()[0]?.toUpperCase()}</span>
                  <button className="tx" onClick={() => (c.kind === "shortlist" ? setOpenCat(c.id) : setSheet({ k: "award", cat: c }))}>
                    <b>{c.name}</b>
                    <small>
                      {sub}
                      {sugg > 0 && (
                        <>
                          {" · "}
                          <em>
                            {sugg} suggestion{sugg === 1 ? "" : "s"} to check
                          </em>
                        </>
                      )}
                    </small>
                  </button>
                  <button className="go" onClick={() => (c.kind === "shortlist" ? setOpenCat(c.id) : setSheet({ k: "award", cat: c }))} aria-label={`Open ${c.name}`}>
                    ›
                  </button>
                </div>
              );
            })}
            <button className="aw-add" onClick={() => setSheet({ k: "ideas" })}>
              + Add awards
            </button>
          </section>
        </>
      )}

      {season && cat && (
        <ShortlistView
          {...p}
          cat={cat}
          shortlisted={nomsFor(cat.id, "shortlisted")}
          suggested={nomsFor(cat.id, "suggested")}
          face={face}
          gameLine={gameLine}
          byId={byId}
          onBack={() => setOpenCat(null)}
          onEdit={() => setSheet({ k: "award", cat })}
          onNominee={(draft) => setSheet({ k: "nominee", draft })}
          onPlayers={() => setSheet({ k: "players", category_id: cat.id })}
          run={run}
        />
      )}

      {sheet && <div className="aw-dim" onClick={() => setSheet(null)} />}
      {sheet?.k === "season" && (
        <SeasonSheet
          season={season}
          year={year}
          lastGameDate={p.lastGameDate}
          today={p.today}
          eligible={eligibleNow}
          onClose={() => setSheet(null)}
          onSave={async (row) => {
            const ok = await run(() => supabase.from("award_seasons").upsert(row, { onConflict: "season" }), "Saved");
            if (ok) setSheet(null);
          }}
        />
      )}
      {sheet?.k === "ideas" && season && (
        <section className="aw-sheet">
          <div className="bar" />
          <h3>Add awards</h3>
          <p className="aw-note">Tap one to add it with sensible settings, then change anything you like. Or start from blank.</p>
          <div className="aw-ideas">
            {AWARD_IDEAS.map((idea) => (
              <button
                key={idea.name}
                className="aw-idea"
                disabled={cats.some((c) => c.name.toLowerCase() === idea.name.toLowerCase())}
                onClick={() =>
                  run(
                    () =>
                      supabase.from("award_categories").insert({
                        season: season.season,
                        name: idea.name,
                        description: idea.description,
                        kind: idea.kind,
                        auto_rule: idea.auto_rule ?? null,
                        allow_suggestions: !!idea.allow_suggestions,
                        sort: cats.length,
                      }),
                    `${idea.name} added`
                  )
                }
              >
                {idea.name}
              </button>
            ))}
          </div>
          <button className="aw-btn ghost full" onClick={() => setSheet({ k: "award", cat: { kind: "player", name: "", description: "", allow_suggestions: false, auto_rule: null } })}>
            + A blank award
          </button>
        </section>
      )}
      {sheet?.k === "award" && season && (
        <AwardSheet
          cat={sheet.cat}
          onClose={() => setSheet(null)}
          onSave={async (c) => {
            const row = {
              name: c.name.trim(),
              description: c.description?.trim() || null,
              kind: c.kind,
              auto_rule: c.kind === "auto" ? c.auto_rule : null,
              allow_suggestions: c.kind === "shortlist" && !!c.allow_suggestions,
            };
            const ok = await run(
              () => (sheet.cat.id ? supabase.from("award_categories").update(row).eq("id", sheet.cat.id) : supabase.from("award_categories").insert({ ...row, season: season.season, sort: cats.length })),
              "Saved"
            );
            if (ok) setSheet(null);
          }}
          onRemove={
            sheet.cat.id
              ? async () => {
                  if (!(await p.confirm(`Remove ${sheet.cat.name}?`, "Its nominees and any votes for it go too.", "Remove"))) return;
                  const ok = await run(() => supabase.from("award_categories").delete().eq("id", sheet.cat.id!), "Removed");
                  if (ok) {
                    setSheet(null);
                    setOpenCat(null);
                  }
                }
              : undefined
          }
        />
      )}
      {sheet?.k === "nominee" && (
        <NomineeSheet
          draft={sheet.draft}
          players={p.players}
          games={p.games}
          gameLine={gameLine}
          onClose={() => setSheet(null)}
          onSave={async (d) => {
            const ok = await run(
              () =>
                supabase.from("award_nominations").insert({
                  category_id: d.category_id,
                  player_id: d.player_id,
                  game_id: d.game_id,
                  title: d.title.trim(),
                  detail: d.detail.trim() || null,
                  status: "shortlisted",
                }),
              "Added to the ballot"
            );
            if (ok) setSheet(null);
          }}
        />
      )}
      {sheet?.k === "players" && (
        <PlayersSheet
          players={p.players}
          taken={new Set(nomsFor(sheet.category_id, "shortlisted").map((n) => n.player_id ?? ""))}
          onClose={() => setSheet(null)}
          onSave={async (ids) => {
            const ok = await run(
              () =>
                supabase.from("award_nominations").insert(
                  ids.map((id) => ({ category_id: sheet.category_id, player_id: id, title: byId.get(id)?.name ?? "Player", status: "shortlisted" }))
                ),
              `${ids.length} added to the ballot`
            );
            if (ok) setSheet(null);
          }}
        />
      )}
    </div>
  );
}

function ShortlistView(
  p: Props & {
    cat: AwardCategory;
    shortlisted: AwardNomination[];
    suggested: AwardNomination[];
    face: (id: string | null, fallback?: string) => React.ReactNode;
    gameLine: (id: string | null) => string;
    byId: Map<string, SeasonPlayer>;
    onBack: () => void;
    onEdit: () => void;
    onNominee: (d: NomDraft) => void;
    onPlayers: () => void;
    run: (fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) => Promise<boolean>;
  }
) {
  const [tab, setTab] = useState<"goals" | "games" | "moments" | "suggestions">(p.suggested.length ? "suggestions" : "goals");
  const [openGame, setOpenGame] = useState<string | null>(null);
  const on = (pred: (n: AwardNomination) => boolean) => p.shortlisted.some(pred);
  const draft = (x: Partial<NomDraft>): NomDraft => ({ category_id: p.cat.id, player_id: null, game_id: null, title: "", detail: "", ...x });
  const bigNights = [...p.goals].filter((g) => g.goals >= 2).sort((a, b) => b.goals - a.goals).slice(0, 15);
  const remove = async (n: AwardNomination) => {
    if (!(await p.confirm(`Remove "${n.title}"?`, "It comes off the ballot, with any votes for it.", "Remove"))) return;
    await p.run(() => supabase.from("award_nominations").delete().eq("id", n.id), "Removed");
  };
  const scorerRow = (g: GoalLine) => {
    const pl = p.byId.get(g.player_id);
    const added = on((n) => n.player_id === g.player_id && n.game_id === g.game_id);
    return (
      <div key={g.game_id + g.player_id} className="aw-qa">
        {p.face(g.player_id)}
        <span>
          <b>
            {pl?.name ?? "Player"} · {g.goals} goal{g.goals === 1 ? "" : "s"}
          </b>
          <small>{p.gameLine(g.game_id)}</small>
        </span>
        <button className={"aw-plus" + (added ? " on" : "")} disabled={added} onClick={() => p.onNominee(draft({ player_id: g.player_id, game_id: g.game_id }))}>
          {added ? "✓" : "+"}
        </button>
      </div>
    );
  };
  return (
    <>
      <button className="aw-back" onClick={p.onBack}>
        ‹ Awards
      </button>
      <section className="aw-card">
        <header>
          <h4>{p.cat.name}</h4>
          <button className="lnk" onClick={p.onEdit}>
            Edit ›
          </button>
        </header>
        {p.shortlisted.length === 0 && <p className="aw-note">Nothing on the ballot yet. Add nominees below, or pick them from the season.</p>}
        {p.shortlisted.map((n) => (
          <div key={n.id} className="aw-nom">
            {n.player_id ? p.face(n.player_id) : <span className="aw-big">{n.title.trim()[0]?.toUpperCase()}</span>}
            <span>
              <b>{n.title}</b>
              <small>{[p.gameLine(n.game_id), n.detail].filter(Boolean).join(" · ")}</small>
            </span>
            <button className="aw-x" onClick={() => remove(n)} aria-label={`Remove ${n.title}`}>
              ✕
            </button>
          </div>
        ))}
        <button className="aw-add" onClick={() => p.onNominee(draft({}))}>
          + Write a nominee
        </button>
        <button className="aw-add" onClick={p.onPlayers}>
          + Add players
        </button>
      </section>
      <section className="aw-card">
        <header>
          <h4>From the season</h4>
          <span>Tap + to add</span>
        </header>
        <div className="aw-seg">
          <button className={tab === "goals" ? "on" : ""} onClick={() => setTab("goals")}>
            Big nights
          </button>
          <button className={tab === "games" ? "on" : ""} onClick={() => setTab("games")}>
            Every game
          </button>
          <button className={tab === "moments" ? "on" : ""} onClick={() => setTab("moments")}>
            Moments
          </button>
          <button className={tab === "suggestions" ? "on" : ""} onClick={() => setTab("suggestions")}>
            Ideas{p.suggested.length ? ` · ${p.suggested.length}` : ""}
          </button>
        </div>
        {tab === "goals" && (bigNights.length ? bigNights.map(scorerRow) : <p className="aw-note">No scorers recorded yet.</p>)}
        {tab === "games" &&
          [...p.games]
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((g) => (
              <div key={g.id}>
                <button className={"aw-game" + (openGame === g.id ? " on" : "")} style={{ width: "100%", marginBottom: 6 }} onClick={() => setOpenGame(openGame === g.id ? null : g.id)}>
                  {shortDate(g.date)}
                  <em>
                    {g.white}–{g.red}
                  </em>
                </button>
                {openGame === g.id && (
                  <div style={{ padding: "0 4px 8px" }}>
                    {p.goals.filter((x) => x.game_id === g.id).sort((a, b) => b.goals - a.goals).map(scorerRow)}
                    <button className="aw-add" onClick={() => p.onNominee(draft({ game_id: g.id }))}>
                      + Something else from this game
                    </button>
                  </div>
                )}
              </div>
            ))}
        {tab === "moments" &&
          (p.moments.length ? (
            p.moments.map((m) => {
              const added = on((n) => n.title.toLowerCase() === m.title.toLowerCase());
              return (
                <div key={m.key} className="aw-qa">
                  <span className="aw-big">{m.big}</span>
                  <span>
                    <b>{m.title}</b>
                    <small>
                      {shortDate(m.date)} · {m.detail}
                    </small>
                  </span>
                  <button
                    className={"aw-plus" + (added ? " on" : "")}
                    disabled={added}
                    onClick={() =>
                      p.run(
                        () =>
                          supabase.from("award_nominations").insert({ category_id: p.cat.id, player_id: m.player_id, game_id: m.game_id, title: m.title, detail: m.detail, status: "shortlisted" }),
                        "Added to the ballot"
                      )
                    }
                  >
                    {added ? "✓" : "+"}
                  </button>
                </div>
              );
            })
          ) : (
            <p className="aw-note">No moments yet.</p>
          ))}
        {tab === "suggestions" &&
          (p.suggested.length ? (
            p.suggested.map((n) => (
              <div key={n.id} className="aw-sug">
                <span className="by">Suggested by {p.byId.get(n.suggested_by ?? "")?.name.split(" ")[0] ?? "a player"}</span>
                <b>{n.title}</b>
                <small>{[p.gameLine(n.game_id), n.detail].filter(Boolean).join(" · ")}</small>
                <div className="acts">
                  <button className="aw-btn" onClick={() => p.run(() => supabase.from("award_nominations").update({ status: "shortlisted" }).eq("id", n.id), "Added to the ballot")}>
                    Add to ballot
                  </button>
                  <button className="aw-btn ghost" onClick={() => p.run(() => supabase.from("award_nominations").update({ status: "declined" }).eq("id", n.id), "Declined")}>
                    Decline
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="aw-note">{p.cat.allow_suggestions ? "No suggestions from players yet." : "This award doesn't take suggestions from players. Turn them on with Edit."}</p>
          ))}
      </section>
    </>
  );
}

function SeasonSheet({
  season,
  year,
  lastGameDate,
  today,
  eligible,
  onClose,
  onSave,
}: {
  season: AwardSeason | null;
  year: number;
  lastGameDate: string | null;
  today: string;
  eligible: (min: number) => number;
  onClose: () => void;
  onSave: (row: AwardSeason) => void;
}) {
  const [title, setTitle] = useState(season?.title ?? `Season ${year}`);
  const [min, setMin] = useState(season?.min_games ?? 3);
  const blank = { nominations_from: "", opens_at: "", late_nominations_until: "", closes_at: "", reveal_at: "" };
  const [d, setD] = useState<Record<keyof typeof blank, string>>(
    season
      ? {
          nominations_from: isoToLondonWall(season.nominations_from),
          opens_at: isoToLondonWall(season.opens_at),
          late_nominations_until: isoToLondonWall(season.late_nominations_until),
          closes_at: isoToLondonWall(season.closes_at),
          reveal_at: isoToLondonWall(season.reveal_at),
        }
      : blank
  );
  const sug = lastGameDate ? suggestDates(lastGameDate, today) : null;
  const useSug = () =>
    sug &&
    setD({
      nominations_from: isoToLondonWall(sug.nominations_from),
      opens_at: isoToLondonWall(sug.opens_at),
      late_nominations_until: isoToLondonWall(sug.late_nominations_until),
      closes_at: isoToLondonWall(sug.closes_at),
      reveal_at: isoToLondonWall(sug.reveal_at),
    });
  const filled = Object.values(d).every(Boolean);
  const rows: [keyof typeof blank, string][] = [
    ["nominations_from", "Nominations open"],
    ["opens_at", "Voting opens"],
    ["late_nominations_until", "Last day to add nominations"],
    ["closes_at", "Voting closes"],
    ["reveal_at", "Awards Night"],
  ];
  return (
    <section className="aw-sheet">
      <div className="bar" />
      <small className="ey">Season awards</small>
      <h3>The season</h3>
      {sug && (
        <div className="aw-tip">
          <b>Suggested from your fixtures</b>
          <span>
            Your last game this year is <b style={{ color: "#fff" }}>{shortDate(lastGameDate!)}</b>. Voting would open two weeks before, close that night, and Awards Night would be the next evening.
          </span>
          <button className="aw-btn" onClick={useSug}>
            Use these dates
          </button>
        </div>
      )}
      <div className="aw-f">
        <label htmlFor="aw-title">Name</label>
        <input id="aw-title" className="aw-in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
      </div>
      <div className="aw-f">
        <label>Games needed to vote</label>
        <div className="aw-step">
          <button onClick={() => setMin((m) => Math.max(0, m - 1))} aria-label="Fewer games">
            −
          </button>
          <b>{min}</b>
          <button onClick={() => setMin((m) => m + 1)} aria-label="More games">
            +
          </button>
          <small>{eligible(min)} players can vote today</small>
        </div>
      </div>
      {rows.map(([k, label]) => (
        <div key={k} className="aw-f">
          <label htmlFor={"aw-" + k}>{label}</label>
          <input id={"aw-" + k} className="aw-in" type="datetime-local" value={d[k]} onChange={(e) => setD((x) => ({ ...x, [k]: e.target.value }))} />
        </div>
      ))}
      <button
        className="aw-btn full"
        disabled={!filled || !title.trim()}
        onClick={() =>
          onSave({
            season: season?.season ?? year,
            title: title.trim(),
            min_games: min,
            nominations_from: londonToIso(d.nominations_from),
            opens_at: londonToIso(d.opens_at),
            late_nominations_until: londonToIso(d.late_nominations_until),
            closes_at: londonToIso(d.closes_at),
            reveal_at: londonToIso(d.reveal_at),
          })
        }
      >
        Save
      </button>
      <div style={{ height: 8 }} />
      <button className="aw-btn ghost full" onClick={onClose}>
        Cancel
      </button>
    </section>
  );
}

function AwardSheet({
  cat,
  onClose,
  onSave,
  onRemove,
}: {
  cat: Partial<AwardCategory> & { id?: string };
  onClose: () => void;
  onSave: (c: { name: string; description: string | null; kind: AwardKind; auto_rule: AutoRule | null; allow_suggestions: boolean }) => void;
  onRemove?: () => void;
}) {
  const [name, setName] = useState(cat.name ?? "");
  const [desc, setDesc] = useState(cat.description ?? "");
  const [kind, setKind] = useState<AwardKind>(cat.kind ?? "player");
  const [rule, setRule] = useState<AutoRule>(cat.auto_rule ?? "most_motm");
  const [sugg, setSugg] = useState(!!cat.allow_suggestions);
  return (
    <section className="aw-sheet">
      <div className="bar" />
      <h3>{cat.id ? "Edit award" : "New award"}</h3>
      <div className="aw-f">
        <label htmlFor="aw-name">Name</label>
        <input id="aw-name" className="aw-in" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Players' Player" />
      </div>
      <div className="aw-f">
        <label htmlFor="aw-desc">One line for the ballot (optional)</label>
        <textarea id="aw-desc" className="aw-in" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} />
      </div>
      <div className="aw-f">
        <label>How is it decided?</label>
        <div className="aw-kinds">
          {(
            [
              ["player", "Everyone who's played this season is on the ballot."],
              ["shortlist", "You add the nominees: goals, keepers, moments, anything."],
              ["auto", "No vote. Revealed on Awards Night."],
            ] as const
          ).map(([k, sub]) => (
            <button key={k} className={"aw-kind" + (kind === k ? " on" : "")} onClick={() => setKind(k)}>
              <i />
              <span>
                <b>{KIND_LABEL[k]}</b>
                <small>{sub}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      {kind === "shortlist" && (
        <button className="aw-tog" onClick={() => setSugg((s) => !s)}>
          <span>
            Players can suggest nominees
            <small>You approve each one before it&apos;s on the ballot</small>
          </span>
          <i className={"aw-sw" + (sugg ? " on" : "")} />
        </button>
      )}
      {kind === "auto" && (
        <div className="aw-f">
          <label>Worked out by</label>
          <div className="aw-kinds">
            {AUTO_RULES.map((r) => (
              <button key={r.key} className={"aw-kind" + (rule === r.key ? " on" : "")} onClick={() => setRule(r.key)}>
                <i />
                <span>
                  <b>{r.label}</b>
                  {r.sub && <small>{r.sub}</small>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="aw-btn full" disabled={!name.trim()} onClick={() => onSave({ name, description: desc, kind, auto_rule: kind === "auto" ? rule : null, allow_suggestions: sugg })}>
        {cat.id ? "Save" : "Add award"}
      </button>
      <div style={{ height: 8 }} />
      {onRemove ? (
        <button className="aw-btn danger full" onClick={onRemove}>
          Remove award
        </button>
      ) : (
        <button className="aw-btn ghost full" onClick={onClose}>
          Cancel
        </button>
      )}
    </section>
  );
}

function NomineeSheet({
  draft,
  players,
  games,
  gameLine,
  onClose,
  onSave,
}: {
  draft: NomDraft;
  players: SeasonPlayer[];
  games: SeasonGame[];
  gameLine: (id: string | null) => string;
  onClose: () => void;
  onSave: (d: NomDraft) => void;
}) {
  const [d, setD] = useState(draft);
  const [q, setQ] = useState("");
  const shown = players.filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 24);
  const pl = players.find((x) => x.id === d.player_id);
  return (
    <section className="aw-sheet">
      <div className="bar" />
      <h3>{draft.player_id && draft.game_id ? "Which goal?" : "Add a nominee"}</h3>
      {draft.player_id && draft.game_id ? (
        <div className="aw-nom" style={{ marginBottom: 10 }}>
          <Avatar name={pl?.name ?? "?"} avatarUrl={pl?.avatar ?? null} className="aw-face" />
          <span>
            <b>{pl?.name}</b>
            <small>{gameLine(d.game_id)}</small>
          </span>
          <span />
        </div>
      ) : (
        <>
          <div className="aw-f">
            <label htmlFor="aw-q">Who (optional)</label>
            <input id="aw-q" className="aw-in" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="aw-pick">
              {shown.map((x) => (
                <button key={x.id} className={d.player_id === x.id ? "on" : ""} onClick={() => setD((v) => ({ ...v, player_id: v.player_id === x.id ? null : x.id }))}>
                  <Avatar name={x.name} avatarUrl={x.avatar} className="aw-face" />
                  {x.name.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
          <div className="aw-f">
            <label>Which game (optional)</label>
            <div className="aw-games">
              {[...games]
                .sort((a, b) => b.date.localeCompare(a.date))
                .map((g) => (
                  <button key={g.id} className={"aw-game" + (d.game_id === g.id ? " on" : "")} onClick={() => setD((v) => ({ ...v, game_id: v.game_id === g.id ? null : g.id }))}>
                    {shortDate(g.date)}
                    <em>
                      {g.white}–{g.red}
                    </em>
                  </button>
                ))}
            </div>
          </div>
        </>
      )}
      <div className="aw-f">
        <label htmlFor="aw-ntitle">Name it</label>
        <input id="aw-ntitle" className="aw-in" value={d.title} maxLength={120} placeholder={pl ? `${pl.name.split(" ")[0]}'s …` : "e.g. The 11–0"} onChange={(e) => setD((v) => ({ ...v, title: e.target.value }))} />
      </div>
      <div className="aw-f">
        <label htmlFor="aw-ndetail">One line (optional)</label>
        <textarea id="aw-ndetail" className="aw-in" value={d.detail} maxLength={400} onChange={(e) => setD((v) => ({ ...v, detail: e.target.value }))} />
      </div>
      <button className="aw-btn full" disabled={!d.title.trim()} onClick={() => onSave(d)}>
        Add to the ballot
      </button>
      <div style={{ height: 8 }} />
      <button className="aw-btn ghost full" onClick={onClose}>
        Cancel
      </button>
    </section>
  );
}

function PlayersSheet({ players, taken, onClose, onSave }: { players: SeasonPlayer[]; taken: Set<string>; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const shown = players.filter((x) => !taken.has(x.id) && (!q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <section className="aw-sheet">
      <div className="bar" />
      <h3>Add players</h3>
      <p className="aw-note">Tap everyone you want on the ballot, such as everyone who&apos;s kept goal. They go on by name.</p>
      <input className="aw-in" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} aria-label="Search players" />
      <div className="aw-multi">
        {shown.map((x) => (
          <button key={x.id} className={sel.includes(x.id) ? "on" : ""} onClick={() => setSel((s) => (s.includes(x.id) ? s.filter((i) => i !== x.id) : [...s, x.id]))}>
            <Avatar name={x.name} avatarUrl={x.avatar} className="aw-face" />
            {x.name.split(" ")[0]}
          </button>
        ))}
      </div>
      <div style={{ height: 14 }} />
      <button className="aw-btn full" disabled={!sel.length} onClick={() => onSave(sel)}>
        {sel.length ? `Add ${sel.length} player${sel.length === 1 ? "" : "s"}` : "Pick players"}
      </button>
      <div style={{ height: 8 }} />
      <button className="aw-btn ghost full" onClick={onClose}>
        Cancel
      </button>
    </section>
  );
}
