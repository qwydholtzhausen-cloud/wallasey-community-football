import { Avatar, POSITION_LABEL, TeamCallout, avatarFor, fmtDate, readableTextColor, teamGradient, type PlayerPosition } from "./shared";
import { EmptyScene } from "./EmptyScene";
import { PredictPanel } from "./predict";
import { predictionPoints, topScorers, type LeaderboardRow, type ScoredPrediction } from "../../lib/predictions";
import type { BookingRow, ClubSettings, GameRow, ScorePrediction, Team } from "../WirralCommunityFootball";

// ── The Line-up tab ──
// Team Sheet (the pitch, line-up editing and the walkout), the admin Teams
// view (generate and balance) and Predict. Its state and actions live in
// the main app, because Fixtures, Admin and pushes share them; this draws
// it. A straight move out of the main file: same markup.
export type LineupTabProps = {
  applySuggestedTeams: () => Promise<void>;
  avatarByPlayerId: Map<string, string | null | undefined>;
  balanceHistory: {
    rows: { id: string; venue: string; date: string; method: "generated" | "manual"; whiteScore: number; redScore: number; margin: number }[];
    avgGenerated: number | null;
    avgManual: number | null;
  };
  balanceScore: (
    white: ReturnType<
      (playerIds: string[]) => { fitness: number; attack: number; defence: number; positions: Record<PlayerPosition, number>; rated: number; total: number }
    >,
    red: ReturnType<
      (playerIds: string[]) => { fitness: number; attack: number; defence: number; positions: Record<PlayerPosition, number>; rated: number; total: number }
    >,
  ) => number | null;
  cancelEditingLineup: () => void;
  cancelEditingPositions: () => void;
  copyLineup: () => Promise<void>;
  cs: ClubSettings;
  currentMonthKey: string;
  currentSeasonYear: number;
  draggingPlayerId: string | null;
  editGrouped: { white: BookingRow[]; red: BookingRow[]; unassigned: BookingRow[] };
  editingLineup: boolean;
  editingPositions: boolean;
  finishWalkout: () => void;
  generateBalancedTeams: () => { white: string[]; red: string[] };
  isAdmin: boolean;
  lineupDisplayView: "pitch" | "list";
  lineupGames: GameRow[];
  setLineupGameId: (id: string) => void;
  lineupView: "sheet" | "fairness" | "predict";
  movePlayerTo: (playerId: string, clientX: number, clientY: number) => void;
  myId: string;
  nextConfirmed: BookingRow[];
  nextConfirmedRatings: {
    id: string;
    name: string;
    source: "admin" | "self" | "unrated";
    position: PlayerPosition | null;
    fitness: number | null;
    attack: number | null;
    defence: number | null;
    goalkeeping: number | null;
    overall: number | null;
  }[];
  nextGame: GameRow;
  nextGrouped: { white: BookingRow[]; red: BookingRow[]; unassigned: BookingRow[] };
  openPlayerCard: (id: string, team?: { name: string; color: string } | null) => void;
  pitchCardRef: React.MutableRefObject<HTMLDivElement | null>;
  pitchTokens: { booking: BookingRow; isRed: boolean; x: number; y: number; role: string }[];
  playerStats: { name: string; apps: number; goals: number; lastPlayed: string; id: string }[];
  predictionMonthlyLeaderboards: Record<string, LeaderboardRow[]>;
  predictionMonths: string[];
  predictionSeasonLeaderboard: LeaderboardRow[];
  predictOpenId: string | null;
  predictView: string;
  resetPositions: () => Promise<void>;
  saveLineup: () => Promise<void>;
  savePositions: () => Promise<void>;
  savePrediction: (gameId: string, predictedWhite: number, predictedRed: number) => Promise<void>;
  scoredPredictionInputs: ScoredPrediction[];
  scorePredictions: ScorePrediction[];
  selectedLineupPlayerId: string | null;
  setDraggingPlayerId: React.Dispatch<React.SetStateAction<string | null>>;
  setLineupDisplayView: React.Dispatch<React.SetStateAction<"pitch" | "list">>;
  setLineupView: React.Dispatch<React.SetStateAction<"sheet" | "fairness" | "predict">>;
  setPredictOpenId: React.Dispatch<React.SetStateAction<string | null>>;
  setPredictView: React.Dispatch<React.SetStateAction<string>>;
  setSelectedLineupPlayerId: React.Dispatch<React.SetStateAction<string | null>>;
  setShowTeamRatings: React.Dispatch<React.SetStateAction<boolean>>;
  setSuggestedTeams: React.Dispatch<React.SetStateAction<{ white: string[]; red: string[] } | null>>;
  setTab: React.Dispatch<React.SetStateAction<"fixtures" | "feed" | "lineup" | "results" | "account" | "admin">>;
  setTeamDraft: React.Dispatch<React.SetStateAction<Record<string, Team | null>>>;
  showTeamRatings: boolean;
  startEditingLineup: () => void;
  startEditingPositions: () => void;
  suggestedTeams: { white: string[]; red: string[] } | null;
  teamDraft: Record<string, Team | null>;
  teamFairness: {
    white: { fitness: number; attack: number; defence: number; positions: Record<PlayerPosition, number>; rated: number; total: number };
    red: { fitness: number; attack: number; defence: number; positions: Record<PlayerPosition, number>; rated: number; total: number };
    flags: string[];
  };
  teamStats: (playerIds: string[]) => {
    fitness: number;
    attack: number;
    defence: number;
    positions: Record<PlayerPosition, number>;
    rated: number;
    total: number;
  };
};

export function LineupTab({
  applySuggestedTeams,
  avatarByPlayerId,
  balanceHistory,
  balanceScore,
  cancelEditingLineup,
  cancelEditingPositions,
  copyLineup,
  cs,
  currentMonthKey,
  currentSeasonYear,
  draggingPlayerId,
  editGrouped,
  editingLineup,
  editingPositions,
  finishWalkout,
  generateBalancedTeams,
  isAdmin,
  lineupDisplayView,
  lineupGames,
  setLineupGameId,
  lineupView,
  movePlayerTo,
  myId,
  nextConfirmed,
  nextConfirmedRatings,
  nextGame,
  nextGrouped,
  openPlayerCard,
  pitchCardRef,
  pitchTokens,
  playerStats,
  predictionMonthlyLeaderboards,
  predictionMonths,
  predictionSeasonLeaderboard,
  predictOpenId,
  predictView,
  resetPositions,
  saveLineup,
  savePositions,
  savePrediction,
  scoredPredictionInputs,
  scorePredictions,
  selectedLineupPlayerId,
  setDraggingPlayerId,
  setLineupDisplayView,
  setLineupView,
  setPredictOpenId,
  setPredictView,
  setSelectedLineupPlayerId,
  setShowTeamRatings,
  setSuggestedTeams,
  setTab,
  setTeamDraft,
  showTeamRatings,
  startEditingLineup,
  startEditingPositions,
  suggestedTeams,
  teamDraft,
  teamFairness,
  teamStats,
}: LineupTabProps) {
  return (
    <>
      <div className="wcf-subtabs">
        <button className={lineupView === "sheet" ? "active" : ""} onClick={() => setLineupView("sheet")}>
          Team Sheet
        </button>
        {isAdmin && (
          <button className={lineupView === "fairness" ? "active" : ""} onClick={() => setLineupView("fairness")}>
            Teams
          </button>
        )}
        <button className={lineupView === "predict" ? "active" : ""} onClick={() => setLineupView("predict")}>
          Predict
        </button>
      </div>

      {/* Two (or more) games on the next match day: pick which one. Starts
          on the one you're booked on. */}
      {lineupGames.length > 1 && nextGame && (
        <div className="wcf-gamepick" role="tablist" aria-label="Which game">
          {lineupGames.map((g) => {
            const mine = g.bookings.find((b) => b.player_id === myId);
            const [h, m] = g.kickoff.split(":").map(Number);
            const time = `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
            return (
              <button key={g.id} role="tab" aria-selected={g.id === nextGame.id} className={g.id === nextGame.id ? "active" : ""} onClick={() => setLineupGameId(g.id)}>
                <b>{time}</b>
                <span>{g.venue}</span>
                {mine && <i>{mine.waiting ? "Waiting" : "You're in"}</i>}
              </button>
            );
          })}
        </div>
      )}

      {lineupView === "fairness" && isAdmin && (
        <>
          {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}

          {nextGame &&
            (() => {
              // Picking teams first; the ratings behind them fold away
              // below. Shows the suggested split if one's been generated,
              // otherwise the saved teams, otherwise the Generate button.
              const savedWhite = nextGrouped.white.map((b) => b.player_id);
              const savedRed = nextGrouped.red.map((b) => b.player_id);
              const hasSaved = savedWhite.length > 0 || savedRed.length > 0;
              const whiteIds = suggestedTeams?.white ?? savedWhite;
              const redIds = suggestedTeams?.red ?? savedRed;
              const showing = suggestedTeams || hasSaved;
              const white = teamStats(whiteIds);
              const red = teamStats(redIds);
              const score = showing ? balanceScore(white, red) : null;
              const savedScore = suggestedTeams && hasSaved ? balanceScore(teamFairness.white, teamFairness.red) : null;
              const verdict = score === null ? "Not enough ratings to judge" : score >= 85 ? "Well balanced" : score >= 60 ? "Fairly even" : "Uneven";
              const rating = (id: string) => nextConfirmedRatings.find((r) => r.id === id);
              const POS_ORDER: Record<string, number> = { keeper: 0, defence: 1, midfield: 2, attack: 3 };
              const POS_SHORT: Record<string, string> = { keeper: "GK", defence: "DEF", midfield: "MID", attack: "ATT" };
              const lineup = (ids: string[]) =>
                ids
                  .map((id) => ({ id, name: nextConfirmed.find((b) => b.player_id === id)?.player.display_name ?? "?", pos: rating(id)?.position ?? null }))
                  .sort((a, b) => (POS_ORDER[a.pos ?? ""] ?? 4) - (POS_ORDER[b.pos ?? ""] ?? 4) || a.name.localeCompare(b.name));

              // A keeper note that says what to do, not just "keepers
              // aren't evenly split" when only one is booked at all.
              const keeperScore = (id: string) => {
                const r = rating(id);
                return r && r.goalkeeping != null ? r.goalkeeping / (r.source === "admin" ? 10 : 5) : -1;
              };
              const keeperLabel = (id: string) => {
                const r = rating(id)!;
                return `${r.goalkeeping}/${r.source === "admin" ? 10 : 5}`;
              };
              const bestKeeper = (ids: string[]) => ids.filter((id) => rating(id)?.position !== "keeper").sort((a, b) => keeperScore(b) - keeperScore(a))[0];
              const keepersW = whiteIds.filter((id) => rating(id)?.position === "keeper");
              const keepersR = redIds.filter((id) => rating(id)?.position === "keeper");
              const nameOf = (id: string) => nextConfirmed.find((b) => b.player_id === id)?.player.display_name ?? "?";
              let keeperNote: React.ReactNode = null;
              if (showing && keepersW.length + keepersR.length === 1) {
                const onWhite = keepersW.length === 1;
                const k = (onWhite ? keepersW : keepersR)[0];
                const other = bestKeeper(onWhite ? redIds : whiteIds);
                keeperNote = (
                  <>
                    Only <b>{nameOf(k)}</b> is booked in goal ({onWhite ? cs.team_white_name : cs.team_red_name}).
                    {other && keeperScore(other) >= 0 && (
                      <>
                        {" "}
                        <b>{rating(other)!.name}</b> is {onWhite ? cs.team_red_name : cs.team_white_name}&apos; best option ({keeperLabel(other)}).
                      </>
                    )}
                  </>
                );
              } else if (showing && keepersW.length + keepersR.length === 0) {
                const bw = bestKeeper(whiteIds);
                const br = bestKeeper(redIds);
                if (bw && br && keeperScore(bw) >= 0 && keeperScore(br) >= 0) {
                  keeperNote = (
                    <>
                      No keeper booked. Best in goal: <b>{rating(bw)!.name}</b> ({cs.team_white_name}, {keeperLabel(bw)}) and <b>{rating(br)!.name}</b> (
                      {cs.team_red_name}, {keeperLabel(br)}).
                    </>
                  );
                }
              } else if (showing && Math.abs(keepersW.length - keepersR.length) >= 2) {
                const heavy = keepersW.length > keepersR.length;
                keeperNote = (
                  <>
                    {heavy ? cs.team_white_name : cs.team_red_name} have <b>{Math.max(keepersW.length, keepersR.length)}</b> keepers and{" "}
                    {heavy ? cs.team_red_name : cs.team_white_name} have <b>{Math.min(keepersW.length, keepersR.length)}</b>. Move one across.
                  </>
                );
              }
              // Real imbalances only, each saying which way and by how much.
              const gaps: { key: string; icon: "scale" | "split"; title: string; body: React.ReactNode }[] = [];
              if (showing && white.rated > 0 && red.rated > 0) {
                for (const m of ["fitness", "attack", "defence"] as const) {
                  if (Math.abs(white[m] - red[m]) >= 1) {
                    gaps.push({
                      key: m,
                      icon: "scale",
                      title: `${m[0].toUpperCase() + m.slice(1)} gap`,
                      body: (
                        <>
                          {cs.team_white_name} <b>{white[m].toFixed(1)}</b> v {cs.team_red_name} <b>{red[m].toFixed(1)}</b>.
                          {suggestedTeams ? " Tap Shuffle again for a closer split." : ""}
                        </>
                      ),
                    });
                  }
                }
              }
              if (showing) {
                for (const p of ["defence", "midfield", "attack"] as PlayerPosition[]) {
                  if (Math.abs(white.positions[p] - red.positions[p]) >= 2) {
                    const word = p === "defence" ? "defender" : p === "midfield" ? "midfielder" : "attacker";
                    const label = (n: number) => (n === 1 ? word : `${word}s`);
                    gaps.push({
                      key: p,
                      icon: "split",
                      title: `${POSITION_LABEL[p]} split`,
                      body: (
                        <>
                          {cs.team_white_name} have <b>{white.positions[p]}</b> {label(white.positions[p])}, {cs.team_red_name} <b>{red.positions[p]}</b>.
                        </>
                      ),
                    });
                  }
                }
              }

              return (
                <>
                  <div className="wcf-teams-hero">
                    <div className="wcf-teams-k">
                      {fmtDate(nextGame.date)} · {nextConfirmed.length} booked
                    </div>
                    {!showing ? (
                      <>
                        <div className="wcf-teams-t">Teams not picked yet</div>
                        <div className="wcf-teams-s">
                          {nextConfirmed.length > 0
                            ? "Generate a balanced split from everyone's ratings, or pick them by hand on the Team Sheet."
                            : "No one's booked in yet."}
                        </div>
                        {nextConfirmed.length > 0 && (
                          <button className="wcf-teams-go" onClick={() => setSuggestedTeams(generateBalancedTeams())}>
                            Generate teams
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="wcf-teams-top">
                          {score !== null && (
                            <div className="wcf-teams-ring" style={{ "--pct": `${score}%` } as React.CSSProperties}>
                              <div>{score}%</div>
                            </div>
                          )}
                          <div>
                            <div className="wcf-teams-t">{verdict}</div>
                            <div className="wcf-teams-s">
                              {suggestedTeams
                                ? "Suggested split. Nothing changes until you use it, and you can still move anyone on the Team Sheet."
                                : "These are the saved teams."}
                              {savedScore !== null &&
                                score !== null &&
                                Math.abs(score - savedScore) >= 3 &&
                                (score > savedScore
                                  ? ` That's ${score - savedScore}% more balanced than the saved teams.`
                                  : ` The saved teams are ${savedScore - score}% more balanced.`)}
                            </div>
                          </div>
                        </div>
                        <div className="wcf-teams-acts">
                          {suggestedTeams ? (
                            <>
                              <button className="wcf-teams-ghost" onClick={() => setSuggestedTeams(generateBalancedTeams())}>
                                ↻ Shuffle again
                              </button>
                              <button className="wcf-teams-ghost" onClick={() => setSuggestedTeams(null)} aria-label="Discard the suggestion">
                                ✕
                              </button>
                              <button className="wcf-teams-go" onClick={applySuggestedTeams}>
                                Use these teams
                              </button>
                            </>
                          ) : (
                            <button className="wcf-teams-ghost wide" onClick={() => setSuggestedTeams(generateBalancedTeams())}>
                              Generate a new split
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {showing && (
                    <>
                      <div className="wcf-teams-cols">
                        {(
                          [
                            ["white", whiteIds, cs.team_white_name, cs.team_white_color],
                            ["red", redIds, cs.team_red_name, cs.team_red_color],
                          ] as const
                        ).map(([key, ids, name, color]) => (
                          <div key={key} className="wcf-teams-col" style={{ "--team": color } as React.CSSProperties}>
                            <div className="wcf-teams-col-h">
                              <span>{name}</span>
                              <span>{ids.length}</span>
                            </div>
                            {lineup(ids).map((p) => (
                              <div key={p.id} className="wcf-teams-pl">
                                <Avatar name={p.name} avatarUrl={avatarByPlayerId.get(p.id)} className="wcf-teams-av" background={avatarFor(p.name).gradient} />
                                <span className="wcf-teams-nm">{p.name}</span>
                                {p.pos && <span className={"wcf-teams-pos" + (p.pos === "keeper" ? " gk" : "")}>{POS_SHORT[p.pos]}</span>}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>

                      {white.rated > 0 && red.rated > 0 && (
                        <div className="wcf-teams-card" style={{ "--wc": cs.team_white_color, "--rc": cs.team_red_color } as React.CSSProperties}>
                          <div className="wcf-teams-card-h">How they compare</div>
                          {(["fitness", "attack", "defence"] as const).map((m) => (
                            <div key={m} className="wcf-teams-cmp">
                              <div className="wcf-teams-cmp-l">
                                <span>{white[m].toFixed(1)}</span>
                                <span>{m[0].toUpperCase() + m.slice(1)}</span>
                                <span>{red[m].toFixed(1)}</span>
                              </div>
                              <div className="wcf-teams-bar">
                                <i className="w" style={{ flex: Math.max(white[m], 0.1) }} />
                                <i className="r" style={{ flex: Math.max(red[m], 0.1) }} />
                              </div>
                            </div>
                          ))}
                          {(white.rated < white.total || red.rated < red.total) && (
                            <div className="wcf-teams-rated">
                              {white.rated + red.rated} of {white.total + red.total} rated
                            </div>
                          )}
                        </div>
                      )}

                      {keeperNote && (
                        <TeamCallout tone="gold" icon="glove" title="Keeper cover">
                          {keeperNote}
                        </TeamCallout>
                      )}
                      {gaps.map((g) => (
                        <TeamCallout key={g.key} tone="red" icon={g.icon} title={g.title}>
                          {g.body}
                        </TeamCallout>
                      ))}
                      {gaps.length === 0 && white.rated > 0 && red.rated > 0 && (
                        <TeamCallout tone="green" icon="check" title="No big gaps">
                          Ratings and positions are evenly spread.
                        </TeamCallout>
                      )}
                    </>
                  )}
                </>
              );
            })()}

          {nextGame && nextConfirmedRatings.length > 0 && (
            <>
              <button className="wcf-teams-row" onClick={() => setShowTeamRatings((v) => !v)} aria-expanded={showTeamRatings}>
                Player ratings
                <span>
                  {nextConfirmedRatings.filter((r) => r.source !== "unrated").length} rated <b className={showTeamRatings ? "open" : ""}>›</b>
                </span>
              </button>
              {showTeamRatings && (
                <div className="wcf-ratings-table">
                  <div className="wcf-ratings-rows">
                    {nextConfirmedRatings.map((r) => (
                      <div key={r.id} className="wcf-ratings-row">
                        <div className="wcf-ratings-name">
                          <span className="wcf-ratings-who">{r.name}</span>
                          {r.position && <span className="wcf-ratings-pos">{POSITION_LABEL[r.position]}</span>}
                          {r.source !== "unrated" && <span className={"wcf-ratings-source " + r.source}>{r.source === "admin" ? "Admin /10" : "Self /5"}</span>}
                        </div>
                        {r.source === "unrated" ? (
                          <span className="wcf-ratings-unrated">Not rated yet</span>
                        ) : (
                          // Bars fill against each rating's own scale (admin /10,
                          // self /5), so an 8 from an admin and a 4 from a
                          // self-rating look the same - which they are.
                          <div className="wcf-ratings-bars">
                            {(
                              [
                                ["Fitness", r.fitness],
                                ["Attack", r.attack],
                                ["Defence", r.defence],
                                ["Keeper", r.goalkeeping],
                              ] as const
                            ).map(([label, v]) => (
                              <div key={label} className="wcf-ratings-bar">
                                <span className="wcf-ratings-bar-top">
                                  <span>{label}</span>
                                  <b>{v}</b>
                                </span>
                                <span className="wcf-ratings-track">
                                  <i style={{ width: `${Math.max(0, Math.min(100, ((v ?? 0) / (r.source === "admin" ? 10 : 5)) * 100))}%` }} />
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {balanceHistory.rows.length > 0 &&
            (() => {
              const margins = balanceHistory.rows.map((r) => r.margin);
              const avg = margins.reduce((s, m) => s + m, 0) / margins.length;
              const generated = balanceHistory.rows.filter((r) => r.method === "generated").length;
              return (
                <div className="wcf-teams-card">
                  <div className="wcf-teams-card-h">
                    Recent games <span>avg margin {avg.toFixed(1)}</span>
                  </div>
                  <div className="wcf-teams-hist-s">
                    Winning margin, newest first.{" "}
                    {generated === 0
                      ? "All picked by hand so far."
                      : `Generated teams: avg ${balanceHistory.avgGenerated?.toFixed(1) ?? "—"}. By hand: avg ${balanceHistory.avgManual?.toFixed(1) ?? "—"}.`}
                  </div>
                  <div className="wcf-teams-hist">
                    {balanceHistory.rows.map((r) => (
                      <i
                        key={r.id}
                        className={(r.margin <= 1 ? "ok" : r.margin >= 6 ? "big" : "") + (r.method === "generated" ? " gen" : "")}
                        title={`${fmtDate(r.date)}: ${r.whiteScore}–${r.redScore}${r.method === "generated" ? " (generated)" : ""}`}
                      >
                        {r.margin}
                      </i>
                    ))}
                  </div>
                </div>
              );
            })()}
        </>
      )}

      {lineupView === "sheet" && (
        <>
          {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}
          {nextGame && (
            <>
              <div className="wcf-lineup-head">
                <div className="wcf-lineup-eyebrow">Line-up</div>
                <div className="wcf-lineup-title">{nextGame.venue}</div>
                <div className="wcf-lineup-sub">
                  {fmtDate(nextGame.date)} · {nextGame.kickoff}
                </div>
                {isAdmin && (
                  <div className="wcf-lineup-head-actions">
                    {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                      <button className="wcf-lineup-pill" onClick={copyLineup}>
                        Copy for WhatsApp
                      </button>
                    )}
                    {editingLineup ? (
                      <>
                        <button className="wcf-lineup-pill" onClick={cancelEditingLineup}>
                          Cancel
                        </button>
                        <button className="wcf-lineup-pill primary" onClick={saveLineup}>
                          Save
                        </button>
                      </>
                    ) : (
                      <button className="wcf-lineup-pill" onClick={startEditingLineup}>
                        Edit line-up
                      </button>
                    )}
                  </div>
                )}
              </div>
              {nextConfirmed.length === 0 && (
                <EmptyScene kind="sheet" title="No one's booked in yet" text="Be first on the team sheet.">
                  <button className="wcf-book" onClick={() => setTab("fixtures")}>
                    Grab a spot
                  </button>
                </EmptyScene>
              )}

              {isAdmin && editingLineup && (
                // A live count, then anyone still to place first.
                <>
                  <div className="wcf-lineup-count">
                    <span>
                      <b>{editGrouped.white.length}</b> {cs.team_white_name} · <b>{editGrouped.red.length}</b> {cs.team_red_name}
                    </span>
                    {editGrouped.unassigned.length > 0 ? (
                      <span className="todo">{editGrouped.unassigned.length} to place</span>
                    ) : (
                      <span className="done">All placed ✓</span>
                    )}
                  </div>
                  <button
                    className="wcf-lineup-gen"
                    onClick={() => {
                      cancelEditingLineup();
                      setLineupView("fairness");
                    }}
                  >
                    Generate teams instead ›
                  </button>
                </>
              )}
              {isAdmin &&
                editingLineup &&
                (() => {
                  return (
                    [
                      ["unassigned", editGrouped.unassigned, "To place", null],
                      ["white", editGrouped.white, cs.team_white_name, cs.team_white_color],
                      ["red", editGrouped.red, cs.team_red_name, cs.team_red_color],
                    ] as const
                  ).map(
                    ([key, group, name, color]) =>
                      group.length > 0 && (
                        <div key={key} className={"wcf-lineup-group" + (key === "unassigned" ? " todo" : "")}>
                          <div className="wcf-lineup-group-label">
                            {color && <span className="wcf-lineup-group-dot" style={{ background: color }} />}
                            {name} · {group.length}
                          </div>
                          {group.map((b) => (
                            <div key={b.id} className={"wcf-lineup-row" + (b.player_id === myId ? " me-edit" : "")}>
                              <Avatar
                                name={b.player.display_name}
                                avatarUrl={b.player.avatar_url}
                                className="wcf-lineup-av"
                                background={avatarFor(b.player.display_name).gradient}
                              />
                              <span className="wcf-lineup-name">
                                {b.player.display_name}
                                {b.player_id === myId ? " (you)" : ""}
                              </span>
                              <div className="wcf-lineup-picks">
                                <button
                                  style={
                                    teamDraft[b.id] === "white"
                                      ? { background: cs.team_white_color, color: readableTextColor(cs.team_white_color), borderColor: cs.team_white_color }
                                      : undefined
                                  }
                                  className="wcf-lineup-pick"
                                  onClick={() => setTeamDraft((d) => ({ ...d, [b.id]: d[b.id] === "white" ? null : "white" }))}
                                >
                                  {cs.team_white_name}
                                </button>
                                <button
                                  style={
                                    teamDraft[b.id] === "red"
                                      ? { background: cs.team_red_color, color: readableTextColor(cs.team_red_color), borderColor: cs.team_red_color }
                                      : undefined
                                  }
                                  className="wcf-lineup-pick"
                                  onClick={() => setTeamDraft((d) => ({ ...d, [b.id]: d[b.id] === "red" ? null : "red" }))}
                                >
                                  {cs.team_red_name}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ),
                  );
                })()}

              {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                <div className="wcf-lineup-strip-row">
                  {(
                    [
                      ["red", cs.team_red_name, cs.team_red_color, nextGrouped.red.length],
                      ["white", cs.team_white_name, cs.team_white_color, nextGrouped.white.length],
                    ] as const
                  ).map(([key, name, color, count]) => (
                    <div
                      key={key}
                      className="wcf-lineup-strip"
                      style={{ background: `linear-gradient(135deg, ${color}2e, rgba(13,13,26,.6))`, borderColor: `${color}57` }}
                    >
                      <span className="wcf-lineup-strip-dot" style={{ background: color }} />
                      <span className="wcf-lineup-strip-name">{name}</span>
                      <span className="wcf-lineup-strip-count">{count}</span>
                    </div>
                  ))}
                </div>
              )}

              {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                <div className="wcf-lineup-views">
                  <button className={"wcf-lineup-view-btn " + (lineupDisplayView === "pitch" ? "on" : "")} onClick={() => setLineupDisplayView("pitch")}>
                    Pitch
                  </button>
                  <button className={"wcf-lineup-view-btn " + (lineupDisplayView === "list" ? "on" : "")} onClick={() => setLineupDisplayView("list")}>
                    List
                  </button>
                </div>
              )}

              {!editingLineup &&
                (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) &&
                (() => {
                  const allTokens = pitchTokens;
                  const selected = allTokens.find((t) => t.booking.player_id === selectedLineupPlayerId);
                  const selectedStats = selected ? playerStats.find((p) => p.id === selected.booking.player_id) : null;
                  const selectColor = (isRed: boolean) => (isRed ? cs.team_red_color : cs.team_white_color);

                  const renderToken = (t: (typeof allTokens)[number]) => {
                    const me = t.booking.player_id === myId;
                    const color = selectColor(t.isRed);
                    const draggable = isAdmin && editingPositions;
                    return (
                      <button
                        key={t.booking.id}
                        className={"wcf-lineup-token" + (draggable ? " draggable" : "") + (draggingPlayerId === t.booking.player_id ? " dragging" : "")}
                        data-red={t.isRed ? "1" : "0"}
                        data-me={me ? "1" : "0"}
                        style={{ left: `${t.x}%`, top: `${t.y}%` }}
                        onClick={() => {
                          if (!draggable) setSelectedLineupPlayerId((v) => (v === t.booking.player_id ? null : t.booking.player_id));
                        }}
                        onPointerDown={
                          draggable
                            ? (e) => {
                                e.preventDefault();
                                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                setDraggingPlayerId(t.booking.player_id);
                                movePlayerTo(t.booking.player_id, e.clientX, e.clientY);
                              }
                            : undefined
                        }
                        onPointerMove={
                          draggable
                            ? (e) => {
                                if (draggingPlayerId === t.booking.player_id) movePlayerTo(t.booking.player_id, e.clientX, e.clientY);
                              }
                            : undefined
                        }
                        onPointerUp={draggable ? () => setDraggingPlayerId(null) : undefined}
                      >
                        <Avatar
                          name={t.booking.player.display_name}
                          avatarUrl={t.booking.player.avatar_url}
                          className="wcf-lineup-token-chip"
                          background={teamGradient(color)}
                          style={{ color: readableTextColor(color), boxShadow: me ? "0 0 0 2px var(--blue), 0 6px 14px -6px rgba(0,0,0,.85)" : undefined }}
                        />
                        <span className="wcf-lineup-token-label">{t.booking.player.display_name.split(" ")[0]}</span>
                      </button>
                    );
                  };

                  return (
                    <>
                      {lineupDisplayView === "pitch" && isAdmin && (
                        <div className="wcf-lineup-position-controls">
                          {editingPositions ? (
                            <>
                              <button className="wcf-ghost" onClick={cancelEditingPositions}>
                                Cancel
                              </button>
                              <button className="wcf-save-red" style={{ flex: 1 }} onClick={savePositions}>
                                Lock in positions
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="wcf-ghost" onClick={startEditingPositions}>
                                Drag to arrange
                              </button>
                              {nextGame?.lineup_positions && (
                                <button className="wcf-ghost danger" onClick={resetPositions}>
                                  Reset to auto
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {lineupDisplayView === "pitch" && (
                        <div className="wcf-lineup-pitch-card" ref={pitchCardRef} onClick={finishWalkout}>
                          <svg viewBox="0 0 200 300" preserveAspectRatio="none" className="wcf-lineup-pitch-lines">
                            <rect x="10" y="8" width="180" height="284" rx="2" />
                            <line x1="10" y1="150" x2="190" y2="150" />
                            <circle cx="100" cy="150" r="30" />
                            <circle cx="100" cy="150" r="1.6" fill="#e2e8f0" stroke="none" />
                            <rect x="55" y="8" width="90" height="34" rx="1" />
                            <rect x="78" y="8" width="44" height="14" rx="1" />
                            <rect x="55" y="258" width="90" height="34" rx="1" />
                            <rect x="78" y="278" width="44" height="14" rx="1" />
                          </svg>
                          <div className="wcf-lineup-pitch-tokens">{allTokens.map(renderToken)}</div>
                        </div>
                      )}
                      {lineupDisplayView === "pitch" && !editingPositions && (
                        <p className="wcf-lineup-pitch-note">
                          {cs.team_red_name} attack down, {cs.team_white_name} attack up. Tap a shirt for that player&apos;s season stats.
                        </p>
                      )}
                      {lineupDisplayView === "pitch" && editingPositions && (
                        <p className="wcf-lineup-pitch-note">Drag any player to reposition them, then Lock in positions to save it for everyone.</p>
                      )}

                      {lineupDisplayView === "list" && (
                        <div className="wcf-lineup-list-wrap">
                          {[
                            ["red", nextGrouped.red, cs.team_red_name, cs.team_red_color] as const,
                            ["white", nextGrouped.white, cs.team_white_name, cs.team_white_color] as const,
                          ].map(([key, group, name, color]) => (
                            <div key={key} className="wcf-lineup-list-card">
                              <div className="wcf-lineup-list-head" style={{ color }}>
                                {name}
                              </div>
                              {group.map((b) => (
                                <button
                                  key={b.id}
                                  className="wcf-lineup-list-row"
                                  onClick={() => setSelectedLineupPlayerId((v) => (v === b.player_id ? null : b.player_id))}
                                >
                                  <Avatar
                                    name={b.player.display_name}
                                    avatarUrl={b.player.avatar_url}
                                    className="wcf-lineup-list-chip"
                                    background={teamGradient(color)}
                                    style={{ color: readableTextColor(color) }}
                                  />
                                  <span className="wcf-lineup-list-name">
                                    {b.player.display_name}
                                    {b.player_id === myId ? " (you)" : ""}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}

                      {selected && (
                        <div className="wcf-lineup-selected">
                          <Avatar
                            name={selected.booking.player.display_name}
                            avatarUrl={selected.booking.player.avatar_url}
                            className="wcf-lineup-selected-chip"
                            background={teamGradient(selectColor(selected.isRed))}
                            style={{ color: readableTextColor(selectColor(selected.isRed)) }}
                          />
                          <div className="wcf-lineup-selected-body">
                            <div
                              className="wcf-lineup-selected-name clickable"
                              onClick={() =>
                                openPlayerCard(selected.booking.player_id, {
                                  name: selected.isRed ? cs.team_red_name : cs.team_white_name,
                                  color: selected.isRed ? cs.team_red_color : cs.team_white_color,
                                })
                              }
                            >
                              {selected.booking.player.display_name}
                              {selected.booking.player_id === myId ? " (you)" : ""}
                            </div>
                            <div className="wcf-lineup-selected-role">
                              {selected.role} · {selected.isRed ? cs.team_red_name : cs.team_white_name}
                            </div>
                          </div>
                          <div className="wcf-lineup-selected-stat">
                            <div>{selectedStats?.apps ?? 0}</div>
                            <span>apps</span>
                          </div>
                          <div className="wcf-lineup-selected-stat">
                            <div>{selectedStats?.goals ?? 0}</div>
                            <span>goals</span>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}

              {!editingLineup && nextGrouped.unassigned.length > 0 && (
                <div className="wcf-lineup-group">
                  {/* "Unassigned" is admin language. Before any teams are
                        picked this is simply who's playing. */}
                  <div className="wcf-lineup-group-label">
                    {nextGrouped.white.length === 0 && nextGrouped.red.length === 0 ? "Who's in" : "Still to be picked"} · {nextGrouped.unassigned.length}
                  </div>
                  {nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && <p className="wcf-lineup-group-note">Teams get picked nearer kick-off.</p>}
                  {/* A grid of faces rather than one full-width row each:
                        sixteen rows was a long scroll to see who's playing,
                        and faces are what people recognise at a glance. */}
                  <div className="wcf-lineup-grid">
                    {nextGrouped.unassigned.map((b) => (
                      <button key={b.id} className={"wcf-lineup-chip" + (b.player_id === myId ? " me" : "")} onClick={() => openPlayerCard(b.player_id)}>
                        <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-lineup-chip-avatar" />
                        <span className="wcf-lineup-chip-name">{b.player_id === myId ? "You" : b.player.display_name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                <PredictPanel
                  key={nextGame.id}
                  gameId={nextGame.id}
                  whiteLabel={cs.team_white_name}
                  redLabel={cs.team_red_name}
                  isBooked={nextConfirmed.some((b) => b.player_id === myId)}
                  myPrediction={scorePredictions.find((p) => p.game_id === nextGame.id && p.player_id === myId) ?? null}
                  onSave={savePrediction}
                />
              )}
              {!editingLineup && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && nextConfirmed.length > 0 && (
                <div className="wcf-predict">
                  <div className="wcf-predict-gate">
                    <div className="wcf-predict-gate-icon">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="9" />
                        <circle cx="12" cy="12" r="5" />
                        <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
                      </svg>
                    </div>
                    <div className="wcf-predict-gate-text">
                      <b>Predictions open once teams are posted</b> for this game — check back here nearer kickoff.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {lineupView === "predict" &&
        (() => {
          const isSeason = predictView === "season";
          const board = isSeason ? predictionSeasonLeaderboard : (predictionMonthlyLeaderboards[predictView] ?? []);
          const isCurrentMonth = !isSeason && predictView === currentMonthKey;
          // The free-game prize is for a *completed* month, not a
          // running mid-month lead that could still change - same
          // "reveal once it's over" cadence as Player of the Month.
          const leaders = !isSeason && !isCurrentMonth ? topScorers(board) : [];
          const monthLabel = !isSeason ? new Date(predictView + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "";
          const scopeInputs = isSeason
            ? scoredPredictionInputs.filter((p) => p.gameDate.slice(0, 4) === String(currentSeasonYear))
            : scoredPredictionInputs.filter((p) => p.gameDate.slice(0, 7) === predictView);
          const leader = board[0];

          return (
            <>
              {/* The thing you came to do, first: the same prediction box
                      as the Team Sheet (or "opens when teams are posted"),
                      rather than a button below all 28 leaderboard rows. */}
              {nextGame && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                <div className="wcf-predict-top">
                  <PredictPanel
                    key={"top-" + nextGame.id}
                    gameId={nextGame.id}
                    whiteLabel={cs.team_white_name}
                    redLabel={cs.team_red_name}
                    isBooked={nextConfirmed.some((b) => b.player_id === myId)}
                    myPrediction={scorePredictions.find((p) => p.game_id === nextGame.id && p.player_id === myId) ?? null}
                    onSave={savePrediction}
                  />
                </div>
              )}
              {nextGame && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && (
                <div className="wcf-predict wcf-predict-top">
                  <div className="wcf-predict-gate">
                    <div className="wcf-predict-gate-icon">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="9" />
                        <circle cx="12" cy="12" r="5" />
                        <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
                      </svg>
                    </div>
                    <div className="wcf-predict-gate-text">
                      <b>{fmtDate(nextGame.date)}: predictions open once teams are posted.</b> Check back here nearer kickoff. They lock at kickoff.
                    </div>
                  </div>
                </div>
              )}

              <select
                className="wcf-month-filter"
                value={predictView}
                onChange={(e) => {
                  setPredictView(e.target.value);
                  setPredictOpenId(null);
                }}
              >
                <option value="season">Overall (this season)</option>
                {predictionMonths.map((m) => (
                  <option key={m} value={m}>
                    {new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
                  </option>
                ))}
              </select>

              {leader && (
                <div className="wcf-pl-leader-card">
                  <div className="wcf-pl-leader-eyebrow">Leader · {isSeason ? "This season" : monthLabel}</div>
                  <div className="wcf-pl-leader-row">
                    <Avatar
                      name={leader.playerName}
                      avatarUrl={avatarByPlayerId.get(leader.playerId)}
                      className="wcf-pl-leader-avatar"
                      background={avatarFor(leader.playerName).gradient}
                    />
                    <div className="wcf-pl-leader-body">
                      <div className="wcf-pl-leader-name">{leader.playerName}</div>
                      <div className="wcf-pl-leader-sub">
                        {leader.exactCount} exact · {leader.points - leader.exactCount * 3} results · {leader.gamesGuessed} played
                      </div>
                    </div>
                    <div className="wcf-pl-leader-pts">
                      <div>{leader.points}</div>
                      <span>points</span>
                    </div>
                  </div>
                </div>
              )}

              {isSeason && (
                <div className="wcf-lb-prize">
                  <span className="wcf-lb-medals" aria-hidden="true">
                    <i className="g">1</i>
                    <i className="s">2</i>
                    <i className="b">3</i>
                  </span>
                  <span className="wcf-lb-prize-text">
                    Top 3 at season&apos;s end win from the pot
                    <small>3 pts exact score · 1 pt right result · booked players only</small>
                  </span>
                </div>
              )}
              {!isSeason && isCurrentMonth && (
                <div className="wcf-lb-prize">
                  <span className="wcf-lb-prize-ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" />
                    </svg>
                  </span>
                  <span className="wcf-lb-prize-text">
                    {monthLabel} is still in progress
                    <small>Standings so far, not final.</small>
                  </span>
                </div>
              )}
              {!isSeason && !isCurrentMonth && leaders.length > 0 && (
                <div className="wcf-lb-prize">
                  <span className="wcf-lb-medals" aria-hidden="true">
                    <i className="g">1</i>
                  </span>
                  <span className="wcf-lb-prize-text">
                    {monthLabel} winner: <b>{leaders.map((l) => l.playerName).join(" & ")}</b>
                    <small>A free game this month.</small>
                  </span>
                </div>
              )}
              {!isSeason && <div className="wcf-lb-key">3 pts exact score · 1 pt correct result · booked players only</div>}

              {board.length > 0 && (
                <div className="wcf-pl-legend">
                  <span>
                    <span className="wcf-pl-dot" style={{ background: "var(--green)" }} />
                    exact
                  </span>
                  <span>
                    <span className="wcf-pl-dot" style={{ background: "var(--blue)" }} />
                    result
                  </span>
                  <span>
                    <span className="wcf-pl-dot" style={{ background: "rgba(148,163,184,.28)" }} />
                    miss
                  </span>
                  <span className="wcf-pl-legend-last">last 5</span>
                </div>
              )}

              {board.length === 0 && <p className="wcf-empty">No predictions scored yet {isSeason ? "this season" : "this month"}.</p>}
              {board.length > 0 && (
                <div className="wcf-lb">
                  {board.map((row, i) => {
                    const inPrizes = isSeason && i < 3 && row.points > 0;
                    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
                    const results = row.points - row.exactCount * 3;
                    const a = avatarFor(row.playerName);
                    const form = scopeInputs
                      .filter((p) => p.playerId === row.playerId)
                      .sort((x, y) => x.gameDate.localeCompare(y.gameDate))
                      .slice(-5)
                      .map((p) => predictionPoints(p.predictedWhite, p.predictedRed, p.actualWhite, p.actualRed));
                    const open = predictOpenId === row.playerId;
                    return (
                      <div key={row.playerId}>
                        <div
                          className={"wcf-pl-row" + (i === 0 ? " lead" : "") + (row.playerId === myId ? " me" : "")}
                          onClick={() => setPredictOpenId((v) => (v === row.playerId ? null : row.playerId))}
                        >
                          <span className={"wcf-lb-rank" + (inPrizes ? " top" : "")}>{inPrizes ? medal : i + 1}</span>
                          <Avatar name={row.playerName} avatarUrl={avatarByPlayerId.get(row.playerId)} className="wcf-pl-avatar" background={a.gradient} />
                          <div className="wcf-pl-body">
                            <div className="wcf-pl-name">
                              {row.playerName}
                              {row.playerId === myId ? " (you)" : ""}
                            </div>
                            <div className="wcf-pl-sub-row">
                              {row.exactCount > 0 && (
                                <span className="wcf-pl-exact">
                                  {row.exactCount} exact score{row.exactCount === 1 ? "" : "s"}
                                </span>
                              )}
                              {form.length > 0 && (
                                <span className="wcf-pl-form">
                                  {form.map((pts, fi) => (
                                    <span
                                      key={fi}
                                      className="wcf-pl-dot"
                                      style={{ background: pts === 3 ? "var(--green)" : pts === 1 ? "var(--blue)" : "rgba(148,163,184,.28)" }}
                                    />
                                  ))}
                                </span>
                              )}
                            </div>
                          </div>
                          <span className="wcf-lb-pts">{row.points}</span>
                        </div>
                        {open && (
                          <div className="wcf-pl-detail">
                            <span>
                              Exact <b style={{ color: "var(--green)" }}>{row.exactCount}</b>
                            </span>
                            <span>
                              Results <b style={{ color: "var(--blue)" }}>{results}</b>
                            </span>
                            <span>
                              Played <b>{row.gamesGuessed}</b>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
    </>
  );
}
