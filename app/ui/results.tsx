import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Avatar, POT_CATEGORY_LABEL, PillChoice, avatarFor, fmtDate, fmtDateTime, motionAllowed, type PotCategory } from "./shared";
import { CountUp, MotmReveal, PointsPill, PotAmountJar } from "./motion";
import { VoteMedal } from "./celebrate";
import { Icon } from "./icons";
import { EmptyScene } from "./EmptyScene";
import { calmResultsCss } from "./calmresults";
import { PredictorLeagueLink } from "./calmlineup";
import { GoalBalls, MotmPoll, monthPhoto, scoresCss } from "./scores";
import { MOTM_TAGS } from "../motmTags";
import { MOTM_VOTE_WINDOW_MINUTES, kickoffCutoff } from "../../lib/time";
import { predictionPoints, type ScoredPrediction } from "../../lib/predictions";
import type { ClubRecords, Holder, PersonalBests } from "../../lib/records";
import { scorersForSide } from "../../lib/goalSides";
import type { AwardRow, BookingRow, ClubSettings, GameRow, GoalRow, MonzoUnmatchedRow, MotmVote, PotEntry, Profile, Team } from "../WirralCommunityFootball";

// ── The Results tab ──
// Season, Stats, Records, Scores and Pot. Everything it shows is worked
// out in the main app (it's shared with other tabs, Wrapped and GaffAI);
// this draws it. A straight move out of the main file: same markup.
export type ResultsTabProps = {
  activeStatsYear: number;
  addingPotEntry: boolean;
  addPotEntry: (amount: number, description: string, category: PotCategory) => Promise<void>;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean, hold?: boolean) => Promise<boolean>;
  avatarByPlayerId: Map<string, string | null | undefined>;
  awards: AwardRow[];
  castMotmVote: (gameId: string, candidateId: string, candidateName: string) => Promise<void>;
  clubRecords: ClubRecords;
  cs: ClubSettings;
  currentSeasonYear: number;
  deletePotEntry: (id: string) => Promise<void>;
  expandedResultId: string | null;
  exportFinanceCsv: () => void;
  filteredResults: GameRow[];
  financeSummary: {
    income: number;
    expenses: number;
    byCategory: Record<PotCategory, number>;
    balancePoints: { date: string; balance: number }[];
    byFixture: { id: string; date: string; amount: number; description: string; category: PotCategory; kind: "auto"; paid: number }[];
  };
  formGuide: GameRow[];
  goalRows: GoalRow[];
  headToHead: {
    white: { played: number; won: number; drawn: number; lost: number; points: number; goals: number };
    red: { played: number; won: number; drawn: number; lost: number; points: number; goals: number };
  };
  isAdmin: boolean;
  justVoted: { gameId: string; candidateId: string; n: number } | null;
  mainResultsVenue: string;
  monzoUnmatched: MonzoUnmatchedRow[];
  motmBallotCounts: Record<string, number>;
  motmClosesLabel: (g: GameRow) => string;
  motmTallyByGame: Record<string, Record<string, number>>;
  motmTimeLeft: (g: GameRow) => string;
  motmVotes: MotmVote[];
  motmVotingOpen: (g: GameRow) => boolean;
  motmWinnerIdsByGame: Record<string, string[]>;
  myBests: PersonalBests;
  myId: string;
  myMotmVoteByGame: Record<string, string>;
  myProfile: Profile | null;
  nowUk: string;
  openPlayerCard: (id: string, team?: { name: string; color: string } | null) => void;
  pastGames: GameRow[];
  playedIn: (g: GameRow, playerId: string) => boolean;
  playerOfMonth: {
    monthKey: string;
    monthLabel: string;
    names: string[];
    winners: { id: string; name: string; wins: number; votes: number; goals: number }[];
  } | null;
  playerStats: { name: string; apps: number; goals: number; lastPlayed: string; id: string }[];
  potAmount: string;
  potCategory: PotCategory;
  potDescription: string;
  potEntries: PotEntry[];
  potEntryKind: "add" | "deduct";
  potLedger: (
    | { id: string; date: string; amount: number; description: string; category: PotCategory; kind: "auto"; paid: number }
    | { id: string; category: PotCategory; date: string; amount: number; description: string; kind: "manual"; paid: number }
  )[];
  potmLand: boolean;
  potTotal: number;
  profiles: Profile[];
  recordFalls: Record<string, { v: number; who: string }>;
  resultsMonth: string;
  resultsMonths: string[];
  resultsView: "fixtures" | "season" | "table" | "records" | "history" | "pot";
  statsLastGame: { gameId: string; delta: Record<string, { apps: number; goals: number }> } | null;
  rivalryStreak: { winner: Team; count: number; otherLastWon: string | null } | null;
  scoredPastGames: GameRow[];
  scoredPredictionInputs: ScoredPrediction[];
  SEASON_EPOCH_YEAR: 2026;
  seasonYears: number[];
  setAddingPotEntry: React.Dispatch<React.SetStateAction<boolean>>;
  setExpandedResultId: React.Dispatch<React.SetStateAction<string | null>>;
  setMotmVotersFor: React.Dispatch<React.SetStateAction<{ gameId: string; candidateId: string; candidateName: string } | null>>;
  setMotmVoteTag: (gameId: string, tag: string | null) => Promise<void>;
  setPotAmount: React.Dispatch<React.SetStateAction<string>>;
  setPotCategory: React.Dispatch<React.SetStateAction<PotCategory>>;
  setPotDescription: React.Dispatch<React.SetStateAction<string>>;
  setPotEntryKind: React.Dispatch<React.SetStateAction<"add" | "deduct">>;
  setResultsMonth: React.Dispatch<React.SetStateAction<string>>;
  setResultsView: React.Dispatch<React.SetStateAction<"fixtures" | "season" | "table" | "records" | "history" | "pot">>;
  // Results › History ("Our story"), drawn by app/ui/history.tsx.
  historyView: React.ReactNode;
  totmCard: React.ReactNode;
  setShowAllHatTricks: React.Dispatch<React.SetStateAction<boolean>>;
  setStatsOpenId: React.Dispatch<React.SetStateAction<string | null>>;
  setStatsSeasonYear: React.Dispatch<React.SetStateAction<number | null>>;
  setStatsSort: React.Dispatch<React.SetStateAction<"apps" | "goals">>;
  setTab: React.Dispatch<React.SetStateAction<"fixtures" | "feed" | "lineup" | "results" | "account" | "admin">>;
  sharePlayerOfMonth: () => Promise<void>;
  shareResult: (game: GameRow) => Promise<void>;
  showAllHatTricks: boolean;
  statsOpenId: string | null;
  statsSort: "apps" | "goals";
  // Calm Results (admins first, app/ui/calmresults.tsx): Scores, Season
  // and History only; Stats and Records fold into Season, the Pot opens
  // from Account and Admin.
  calm?: boolean;
  // The Record book card scrolled into view (calm Season), so a record
  // that fell plays there rather than on a Records tab.
  onRecordsSeen?: (seen: boolean) => void;
  // Calm Line-up: the predictor league table opens from a card here too.
  predictorLeague?: { rank: number | null; open: () => void } | null;
};

export function ResultsTab({
  historyView,
  totmCard,
  activeStatsYear,
  addingPotEntry,
  addPotEntry,
  askConfirm,
  avatarByPlayerId,
  awards,
  castMotmVote,
  clubRecords,
  cs,
  currentSeasonYear,
  deletePotEntry,
  expandedResultId,
  exportFinanceCsv,
  filteredResults,
  financeSummary,
  formGuide,
  goalRows,
  headToHead,
  isAdmin,
  justVoted,
  mainResultsVenue,
  monzoUnmatched,
  motmBallotCounts,
  motmClosesLabel,
  motmTallyByGame,
  motmTimeLeft,
  motmVotes,
  motmVotingOpen,
  motmWinnerIdsByGame,
  myBests,
  myId,
  myMotmVoteByGame,
  myProfile,
  nowUk,
  openPlayerCard,
  pastGames,
  playedIn,
  playerOfMonth,
  playerStats,
  potAmount,
  potCategory,
  potDescription,
  potEntries,
  potEntryKind,
  potLedger,
  potmLand,
  potTotal,
  profiles,
  recordFalls,
  resultsMonth,
  resultsMonths,
  resultsView,
  statsLastGame,
  rivalryStreak,
  scoredPastGames,
  scoredPredictionInputs,
  SEASON_EPOCH_YEAR,
  seasonYears,
  setAddingPotEntry,
  setExpandedResultId,
  setMotmVoteTag,
  setPotAmount,
  setPotCategory,
  setPotDescription,
  setPotEntryKind,
  setResultsMonth,
  setResultsView,
  setShowAllHatTricks,
  setStatsOpenId,
  setStatsSeasonYear,
  setStatsSort,
  setTab,
  sharePlayerOfMonth,
  shareResult,
  showAllHatTricks,
  statsOpenId,
  statsSort,
  calm = false,
  onRecordsSeen,
  predictorLeague,
}: ResultsTabProps) {
  // A gold dot on the History tab until it's been opened once on this phone.
  const [historyNew, setHistoryNew] = useState(false);
  useEffect(() => {
    try {
      setHistoryNew(!localStorage.getItem("wcf-history-seen"));
    } catch {}
  }, [resultsView]);
  // Calm Season: the leaderboard and Record book cards report when they're
  // first on screen, so their moments play there.
  const [lbSeen, setLbSeen] = useState(false);
  const lbRef = useRef<HTMLElement | null>(null);
  const recRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!calm || resultsView !== "season") {
      setLbSeen(false);
      onRecordsSeen?.(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          if (e.target === lbRef.current) setLbSeen(true);
          if (e.target === recRef.current) onRecordsSeen?.(true);
        }
      },
      { threshold: 0.35 },
    );
    const t = setTimeout(() => {
      if (lbRef.current) io.observe(lbRef.current);
      if (recRef.current) io.observe(recRef.current);
    }, 50);
    return () => {
      clearTimeout(t);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calm, resultsView]);
  const [lbAll, setLbAll] = useState(false);
  const [recAll, setRecAll] = useState(false);
  const [rivAll, setRivAll] = useState(false);
  // ── Climbing the Stats table ──
  // The first open of Stats (this season, within a week) after a game that
  // moved you up the table that's open: the rank card ticks, then your row
  // overtakes the players you passed. Once per game per table.
  const statsSortFn = (a: { goals: number; apps: number }, b: { goals: number; apps: number }) =>
    statsSort === "goals" ? b.goals - a.goals || a.apps - b.apps : b.apps - a.apps || b.goals - a.goals;
  const statsClimb = useMemo(() => {
    if (!statsLastGame || activeStatsYear !== currentSeasonYear) return null;
    const mine = statsLastGame.delta[myId];
    const gained = mine ? (statsSort === "goals" ? mine.goals : mine.apps) : 0;
    if (!gained) return null;
    const now = [...playerStats].sort(statsSortFn);
    const before = playerStats
      .map((r) => {
        const d = statsLastGame.delta[r.id];
        return d ? { ...r, apps: r.apps - d.apps, goals: r.goals - d.goals } : r;
      })
      .filter((r) => r.apps > 0 || r.goals > 0)
      .sort(statsSortFn);
    const from = before.findIndex((r) => r.id === myId);
    const to = now.findIndex((r) => r.id === myId);
    if (from < 0 || to < 0 || from <= to) return null;
    return { key: `wcf-stats-climb-${myId}-${statsLastGame.gameId}-${statsSort}`, from, to, gained, before: before[from] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsLastGame, playerStats, statsSort, myId, activeStatsYear, currentSeasonYear]);
  const [sPhase, setSPhase] = useState<"before" | "rank" | "points" | "move" | "done" | null>(null);
  const sRows = useRef(new Map<string, HTMLDivElement>());
  const sTops = useRef(new Map<string, number>());
  useEffect(() => {
    if (!statsClimb || !(resultsView === "table" || (calm && resultsView === "season" && lbSeen)) || !motionAllowed()) return;
    try {
      if (localStorage.getItem(statsClimb.key)) return;
      localStorage.setItem(statsClimb.key, "1");
    } catch {
      return;
    }
    setSPhase("before");
    const timers = [
      setTimeout(() => setSPhase("rank"), 900),
      setTimeout(() => sRows.current.get(myId)?.scrollIntoView({ block: "center", behavior: "smooth" }), 1700),
      setTimeout(() => setSPhase("points"), 2500),
      setTimeout(() => {
        sTops.current = new Map([...sRows.current].map(([id, el]) => [id, el.getBoundingClientRect().top]));
        setSPhase("move");
      }, 3400),
      setTimeout(() => setSPhase("done"), 4600),
    ];
    return () => {
      timers.forEach(clearTimeout);
      setSPhase((p) => (p ? "done" : p));
    };
  }, [statsClimb, resultsView, myId, lbSeen]);
  useLayoutEffect(() => {
    if (sPhase !== "move") return;
    const ease = "cubic-bezier(.5,0,.2,1)";
    sRows.current.forEach((el, id) => {
      const before = sTops.current.get(id);
      if (before == null) return;
      const d = before - el.getBoundingClientRect().top;
      if (!d) return;
      if (id === myId) el.animate([{ transform: `translateY(${d}px)` }, { transform: `translateY(${d / 2}px) scale(1.04)`, offset: 0.5 }, { transform: "none" }], { duration: 1150, easing: ease });
      else {
        el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 1150, easing: ease });
        el.firstElementChild?.animate([{ filter: "none" }, { filter: "brightness(.65)", transform: "translateX(4px)", offset: 0.4 }, { filter: "none" }], { duration: 650, delay: 250, easing: "ease-out" });
      }
    });
  }, [sPhase, myId]);
  const sBefore = !!statsClimb && (sPhase === "before" || sPhase === "rank" || sPhase === "points");

  // Record rows, shared by Records and the calm Record book, so a record
  // that falls plays the same way in both.
  // Up to three names, each tappable to their player card,
  // then "+N more" rather than a wall of names on a tie.
  const who = (holders: Holder[], withDate = false) => (
    <>
      {holders.slice(0, 3).map((h, i) => (
        <span key={h.playerId + (h.date ?? "") + i}>
          {i > 0 ? ", " : ""}
          <button className="wcf-name-link" onClick={() => openPlayerCard(h.playerId)}>
            {h.name}
          </button>
          {withDate && h.date ? <span className="wcf-rec-date"> · {fmtDate(h.date)}</span> : null}
        </span>
      ))}
      {holders.length > 3 && <span className="wcf-rec-date"> +{holders.length - 3} more</span>}
    </>
  );
  // Holders' faces on the right, and a gold glow on anything you hold.
  const row = (key: string, value: React.ReactNode, label: string, detail: React.ReactNode, holders: Holder[] = []) => {
    const faces = holders.filter((h, i, all) => all.findIndex((x) => x.playerId === h.playerId) === i).slice(0, 3);
    const mine = holders.some((h) => h.playerId === myId);
    const fell = recordFalls[key];
    const was = fell && (key === "win" ? `+${fell.v}` : fell.v);
    return (
      <div key={key} className={"wcf-rec-row" + (faces.length ? " has-faces" : "") + (mine ? " mine" : "") + (fell ? " wcf-rb-play" : "")}>
        <div className="wcf-rec-val">
          {fell ? (
            <>
              <span className="wcf-rb-old">{was}</span>
              <span className="wcf-rb-new">{value}</span>
            </>
          ) : (
            value
          )}
        </div>
        <div className="wcf-rec-body">
          {label && (
            <div className="wcf-rec-label">
              {label}
              {mine && <span className="wcf-rec-you">You</span>}
              {fell && <span className="wcf-rb-chip">NEW</span>}
            </div>
          )}
          <div className="wcf-rec-who">
            {fell ? (
              <>
                <span className="wcf-rb-was">{fell.who}</span>
                <span className="wcf-rb-now">{detail}</span>
              </>
            ) : (
              detail
            )}
          </div>
        </div>
        {fell && <div className="wcf-rb-shine" />}
        {faces.length > 0 && (
          <div className="wcf-rec-faces">
            {faces.map((h) => (
              <Avatar
                key={h.playerId}
                name={h.name}
                avatarUrl={avatarByPlayerId.get(h.playerId)}
                className="wcf-rec-face"
                background={avatarFor(h.name).gradient}
              />
            ))}
          </div>
        )}
      </div>
    );
  };
  const scoreLine = (x: { date: string; white: number; red: number }) => (
    <>
      {cs.team_white_name} {x.white}–{x.red} {cs.team_red_name}
      <span className="wcf-rec-date"> · {fmtDate(x.date)}</span>
    </>
  );

  // ── Calm Season (admins first) ──
  // Whites v Reds as one card, one leaderboard (Goals | Apps) with your
  // climb, your season in a row, and the record book - each record row is
  // the Records row, so a record that falls plays the same.
  const calmSeasonCards = () => {
    const h = headToHead;
    const wName = cs.team_white_name;
    const rName = cs.team_red_name;
    const sorted = [...playerStats].sort(statsSortFn);
    const myIdx = sorted.findIndex((x) => x.id === myId);
    const shown =
      statsClimb && sBefore
        ? [...sorted.slice(0, statsClimb.to), ...sorted.slice(statsClimb.to + 1, statsClimb.from + 1), sorted[statsClimb.to], ...sorted.slice(statsClimb.from + 1)]
        : sorted;
    const oldMe = statsClimb && (sPhase === "before" || sPhase === "points" || sPhase === "rank") ? statsClimb.before : null;
    const climbOn = !!statsClimb && !!sPhase && sPhase !== "done";
    const limit = lbAll ? shown.length : climbOn ? Math.max(8, statsClimb!.from + 1) : 8;
    const pinMe = !lbAll && !climbOn && myIdx >= limit ? sorted[myIdx] : null;
    const medal = ["#f5d97a", "#d6dbe3", "#d79a62"];
    const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th"));
    const lbRow = (row: (typeof sorted)[number], i: number, pinned = false) => {
      const isMe = row.id === myId;
      const climbing = isMe && !!statsClimb && !!sPhase;
      const pre = climbing && oldMe && sPhase !== "points" ? oldMe : null;
      const apps = pre ? pre.apps : row.apps;
      const goals = pre ? pre.goals : row.goals;
      const top = i < 3 && !pinned;
      return (
        <div
          key={row.id + (pinned ? "-pin" : "")}
          ref={(el) => {
            if (pinned) return;
            if (el) sRows.current.set(row.id, el);
            else sRows.current.delete(row.id);
          }}
          className={"cr-lr" + (top ? " top" : "") + (isMe ? " me" : "") + (climbing && sPhase !== "done" ? " wcf-sclimb" : "")}
          style={top ? ({ "--m": medal[i], "--i": i } as React.CSSProperties) : undefined}
          onClick={() => openPlayerCard(row.id)}
        >
          <span className="rk">{i + 1}</span>
          <Avatar name={row.name} avatarUrl={avatarByPlayerId.get(row.id)} className="av" background={avatarFor(row.name).gradient} />
          <span className="nm">
            <b>
              {row.name}
              {isMe && <em>YOU</em>}
              {climbing && sPhase === "done" && (
                <span className="wcf-climb-up">
                  ▲ {statsClimb!.from - statsClimb!.to} {statsClimb!.from - statsClimb!.to === 1 ? "place" : "places"}
                </span>
              )}
            </b>
            <small>{statsSort === "goals" ? `${apps} ${apps === 1 ? "app" : "apps"}` : `${goals || 0} ${goals === 1 ? "goal" : "goals"}`}</small>
          </span>
          {climbing && sPhase === "points" && (
            <span className="wcf-sclimb-plus">
              +{statsClimb!.gained} {statsSort === "goals" ? (statsClimb!.gained === 1 ? "goal" : "goals") : "app"}
            </span>
          )}
          <span className="v">
            <span className={climbing && sPhase === "points" ? "wcf-tick" : undefined} key={pre ? "o" : "n"}>
              {statsSort === "goals" ? goals || "—" : apps}
            </span>
          </span>
        </div>
      );
    };
    const rec = clubRecords;
    const shownKeys = ["goals", "win", "high", "votes1", "ws"];
    const recOpen = recAll || Object.keys(recordFalls).some((k) => !shownKeys.includes(k));
    const b = myBests;
    const tiles: { k: string; v: number | string; label: string; record: boolean }[] = [
      { k: "g", v: b.mostGoals?.goals ?? 0, label: "Goals in a game", record: !!b.mostGoals && b.mostGoals.goals === rec.mostGoalsInGame?.goals },
      { k: "w", v: b.winStreak, label: "Win streak", record: b.winStreak > 0 && b.winStreak === rec.winStreak?.n },
      { k: "u", v: b.unbeaten, label: "Unbeaten run", record: b.unbeaten > 0 && b.unbeaten === rec.unbeaten?.n },
      { k: "r", v: b.gamesInARow, label: "Games in a row", record: b.gamesInARow > 0 && b.gamesInARow === rec.gamesInARow?.n },
    ];
    const meName = myProfile?.display_name ?? "You";
    return (
      <>
        {h.white.played > 0 && (
          <article className={"cr-card cr-riv" + (rivAll ? " open" : "")} style={{ "--ph": "url(/lineup-teams.jpg)" } as React.CSSProperties}>
            <div className="cr-ch">
              <h4>
                {wName} v {rName}
              </h4>
              <span>{h.white.played} games</span>
            </div>
            <div className="cr-rule" />
            <div className="cr-vs">
              <div className="s">
                <small>{wName}</small>
                <b>{h.white.won}</b>
                <span>{h.white.won === 1 ? "win" : "wins"}</span>
              </div>
              <div className="mid">
                <b>{h.white.drawn}</b>
                <span>{h.white.drawn === 1 ? "draw" : "draws"}</span>
              </div>
              <div className="s r">
                <small>{rName}</small>
                <b>{h.red.won}</b>
                <span>{h.red.won === 1 ? "win" : "wins"}</span>
              </div>
            </div>
            <div className="cr-bar">
              {h.white.won > 0 && <i className="w" style={{ flex: h.white.won }} />}
              {h.white.drawn > 0 && <i className="d" style={{ flex: h.white.drawn }} />}
              {h.red.won > 0 && <i className="r" style={{ flex: h.red.won }} />}
            </div>
            <div className="cr-goals">
              <span>{h.white.goals} goals</span>
              <span>{h.red.goals} goals</span>
            </div>
            {rivalryStreak && (
              <div className={"cr-run " + rivalryStreak.winner}>
                <i aria-hidden="true" />
                <span>
                  <b>
                    {rivalryStreak.winner === "white" ? wName : rName} have won {rivalryStreak.count} in a row
                  </b>
                  <small>
                    {rivalryStreak.otherLastWon
                      ? `${rivalryStreak.winner === "white" ? rName : wName} haven't won since ${fmtDate(rivalryStreak.otherLastWon)}`
                      : `${rivalryStreak.winner === "white" ? rName : wName} are still waiting for a win`}
                  </small>
                </span>
              </div>
            )}
            <div className="cr-x">
              <div>
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>P</th>
                      <th>W</th>
                      <th>D</th>
                      <th>L</th>
                      <th>GF</th>
                      <th>GA</th>
                      <th>Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["white", h.white, h.red.goals, wName],
                        ["red", h.red, h.white.goals, rName],
                      ] as const
                    )
                      .slice()
                      .sort((a, z) => z[1].points - a[1].points || z[1].goals - z[2] - (a[1].goals - a[2]))
                      .map(([k, row, against, name]) => (
                        <tr key={k}>
                          <td>
                            <i className={"dot " + k} />
                            {name}
                          </td>
                          <td>{row.played}</td>
                          <td>{row.won}</td>
                          <td>{row.drawn}</td>
                          <td>{row.lost}</td>
                          <td>{row.goals}</td>
                          <td>{against}</td>
                          <td>
                            <b>{row.points}</b>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
            <button className="cr-all" onClick={() => setRivAll((v) => !v)}>
              {rivAll ? "Show less" : "Full table"} <u>›</u>
            </button>
          </article>
        )}

        {sorted.length > 0 && (
          <article ref={lbRef} className={"cr-card cr-lb" + (lbSeen ? " seen" : "")} style={{ "--ph": "url(/floodlight-haze.jpg)" } as React.CSSProperties}>
            <div className="cr-ch">
              <h4>Leaderboard</h4>
              <div className="cr-seg" role="tablist">
                {(["goals", "apps"] as const).map((s) => (
                  <button
                    key={s}
                    role="tab"
                    aria-selected={statsSort === s}
                    className={statsSort === s ? "on" : ""}
                    onClick={() => {
                      setStatsSort(s);
                      setStatsOpenId(null);
                    }}
                  >
                    {s === "goals" ? "Goals" : "Apps"}
                  </button>
                ))}
              </div>
            </div>
            <div className="cr-rule" />
            <div className="cr-rows" key={statsSort}>
              {shown.slice(0, limit).map((row, i) => lbRow(row, i))}
              {pinMe && (
                <>
                  <div className="cr-gap">···</div>
                  {lbRow(pinMe, myIdx, true)}
                </>
              )}
            </div>
            {sorted.length > 8 && (
              <button className="cr-all" onClick={() => setLbAll((v) => !v)}>
                {lbAll ? "Show less" : `All ${sorted.length} players`} <u>›</u>
              </button>
            )}
          </article>
        )}

        {b.games > 0 && (
          <article className="cr-card cr-you">
            <div className="cr-youh">
              <Avatar name={meName} avatarUrl={avatarByPlayerId.get(myId)} className="cr-youf" background={avatarFor(meName).gradient} />
              <span>
                <small>Your season</small>
                <b>{meName}</b>
                <i>
                  {b.games} {b.games === 1 ? "game" : "games"} played
                  {myIdx >= 0 ? ` · ${ord(myIdx + 1)} for ${statsSort === "goals" ? "goals" : "apps"}` : ""}
                </i>
              </span>
            </div>
            <div className="cr-cells">
              {tiles.map((x) => (
                <div key={x.k} className={x.record ? "rec" : undefined}>
                  <b>{x.v}</b>
                  <small>{x.label}</small>
                  {x.record && <em>Club record</em>}
                </div>
              ))}
            </div>
          </article>
        )}

        {rec.highestScoring && (
          <article ref={recRef} className={"cr-card cr-recs" + (recOpen ? " open" : "")} style={{ "--ph": "url(/potm-bg.jpg)" } as React.CSSProperties}>
            <div className="cr-ch">
              <h4>Record book</h4>
              <span>
                Season {activeStatsYear - SEASON_EPOCH_YEAR + 1} · {activeStatsYear}
              </span>
            </div>
            <div className="cr-rule" />
            {rec.mostGoalsInGame && row("goals", rec.mostGoalsInGame.goals, "Most goals by one player", who(rec.mostGoalsInGame.holders, true), rec.mostGoalsInGame.holders)}
            {rec.biggestWin && row("win", `+${rec.biggestWin.margin}`, "Biggest win", scoreLine(rec.biggestWin))}
            {rec.highestScoring && row("high", rec.highestScoring.total, "Highest-scoring game", scoreLine(rec.highestScoring))}
            {rec.mostMotmVotesInGame && row("votes1", rec.mostMotmVotesInGame.votes, "Most MOTM votes in a game", who(rec.mostMotmVotesInGame.holders, true), rec.mostMotmVotesInGame.holders)}
            {rec.winStreak && row("ws", rec.winStreak.n, "Longest winning run", who(rec.winStreak.holders), rec.winStreak.holders)}
            {recOpen && (
              <>
                {rec.unbeaten && row("ub", rec.unbeaten.n, "Longest unbeaten run", who(rec.unbeaten.holders), rec.unbeaten.holders)}
                {rec.gamesInARow && row("row", rec.gamesInARow.n, "Most games in a row", who(rec.gamesInARow.holders), rec.gamesInARow.holders)}
                {rec.motmWins && row("mw", rec.motmWins.n, "Most Man of the Match wins", who(rec.motmWins.holders), rec.motmWins.holders)}
                {rec.motmVotes && row("mv", rec.motmVotes.n, "Most MOTM votes", who(rec.motmVotes.holders), rec.motmVotes.holders)}
                {rec.promotions && row("wl", rec.promotions.n, "Most times in off the waiting list", who(rec.promotions.holders), rec.promotions.holders)}
                {rec.hatTricks.length > 0 && <div className="cr-sub">Hat-tricks · {rec.hatTricks.length}</div>}
                {rec.hatTricks.map((ht, i) =>
                  row(
                    ht.playerId + ht.date + i,
                    ht.goals,
                    "",
                    <>
                      <button className="wcf-name-link wcf-rec-name" onClick={() => openPlayerCard(ht.playerId)}>
                        {ht.name}
                      </button>
                      <span className="wcf-rec-date">
                        {ht.goals} goals · {fmtDate(ht.date)}
                      </span>
                    </>,
                    [{ playerId: ht.playerId, name: ht.name }],
                  ),
                )}
              </>
            )}
            <button className="cr-all" onClick={() => setRecAll((v) => !v)}>
              {recOpen ? "Show less" : `All records${rec.hatTricks.length ? ` & ${rec.hatTricks.length} hat-tricks` : ""}`} <u>›</u>
            </button>
          </article>
        )}
        {predictorLeague && <PredictorLeagueLink rank={predictorLeague.rank} onOpen={predictorLeague.open} />}
      </>
    );
  };

  const openHistory = () => {
    setResultsView("history");
    try {
      localStorage.setItem("wcf-history-seen", "1");
    } catch {}
  };
  // Calm: Stats and Records live in Season now.
  const view = calm && (resultsView === "table" || resultsView === "records") ? "season" : resultsView;
  return (
    <>
      {calm && <style>{calmResultsCss}</style>}
      {calm && view === "pot" && (
        <div className="cr-back">
          <button onClick={() => setResultsView("fixtures")}>‹ Results</button>
          <span>Club pot</span>
        </div>
      )}
      {calm && view !== "pot" && (
        <div className="cr-tabs" role="tablist">
          <button role="tab" aria-selected={view === "fixtures"} className={view === "fixtures" ? "on" : ""} onClick={() => setResultsView("fixtures")}>
            Scores
          </button>
          <button role="tab" aria-selected={view === "season"} className={view === "season" ? "on" : ""} onClick={() => setResultsView("season")}>
            Season
          </button>
          <button role="tab" aria-selected={view === "history"} className={view === "history" ? "on" : ""} onClick={openHistory}>
            History
            {historyNew && <i className="wcf-hist-dot" aria-hidden="true" />}
          </button>
        </div>
      )}
      {!calm && (
      <div className="wcf-subtabs">
        <button className={resultsView === "season" ? "active" : ""} onClick={() => setResultsView("season")}>
          Season
        </button>
        <button className={resultsView === "table" ? "active" : ""} onClick={() => setResultsView("table")}>
          Stats
        </button>
        <button className={resultsView === "records" ? "active" : ""} onClick={() => setResultsView("records")}>
          Records
        </button>
        <button className={resultsView === "history" ? "active" : ""} onClick={() => { setResultsView("history"); try { localStorage.setItem("wcf-history-seen", "1"); } catch {} }} style={{ position: "relative" }}>
          History
          {historyNew && <i className="wcf-hist-dot" aria-hidden="true" />}
        </button>
        <button className={resultsView === "fixtures" ? "active" : ""} onClick={() => setResultsView("fixtures")}>
          Scores
        </button>
        <button className={resultsView === "pot" ? "active" : ""} onClick={() => setResultsView("pot")}>
          Pot
        </button>
      </div>
      )}

      {view === "history" && historyView}

      {view === "season" &&
        (() => {
          const seasonGames = pastGames.filter((g) => g.date.slice(0, 4) === String(currentSeasonYear));
          const gamesThisSeason = seasonGames.length;
          // The season's headline numbers, from the scored games only.
          const scoredSeason = seasonGames.filter((g) => g.team_white_score != null && g.team_red_score != null);
          const seasonGoals = scoredSeason.reduce((sum, g) => sum + g.team_white_score! + g.team_red_score!, 0);
          const seasonPlayers = new Set(scoredSeason.flatMap((g) => g.bookings.filter((b) => !b.waiting && b.team).map((b) => b.player_id))).size;
          return (
            <>
              <div className="wcf-season-hero">
                {!calm && (
                  <button type="button" className="wcf-story-pill" onClick={openHistory}>
                    Our story ›
                  </button>
                )}
                <div className="wcf-season-hero-eyebrow">Season {currentSeasonYear - SEASON_EPOCH_YEAR + 1}</div>
                <div className="wcf-season-hero-title">{currentSeasonYear}</div>
                {scoredSeason.length > 0 ? (
                  <SeasonStats
                    year={currentSeasonYear}
                    stats={[
                      { k: "games", v: gamesThisSeason, label: gamesThisSeason === 1 ? "Game" : "Games" },
                      { k: "goals", v: seasonGoals, label: "Goals" },
                      { k: "players", v: seasonPlayers, label: "Players" },
                      { k: "pergame", v: Math.round((seasonGoals / scoredSeason.length) * 10) / 10, label: "Per game", decimals: 1 },
                    ]}
                  />
                ) : (
                  <div className="wcf-season-hero-sub">
                    {gamesThisSeason} game{gamesThisSeason === 1 ? "" : "s"} played so far
                  </div>
                )}
              </div>
              {playerOfMonth &&
                (() => {
                  const ws = playerOfMonth.winners;
                  const joint = ws.length > 1;
                  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
                  return (
                    // A photo card like the season hero above it, not a
                    // text shout-out: the winner's face, name and why.
                    <div className={"wcf-potm-card" + (potmLand ? " wcf-potm-land" : "")}>
                      <div className="wcf-potm-bg" />
                      <div className="wcf-potm-top">
                        <span className="wcf-potm-eyebrow">
                          {joint ? "Players of the month" : "Player of the month"} · {playerOfMonth.monthLabel}
                        </span>
                        <button className="wcf-potm-share" onClick={sharePlayerOfMonth} aria-label="Share Player of the Month">
                          <svg
                            viewBox="0 0 24 24"
                            width="14"
                            height="14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 15V3M7 8l5-5 5 5" />
                            <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
                          </svg>
                          Share
                        </button>
                      </div>
                      <div className="wcf-potm-main">
                        <div className="wcf-potm-faces">
                          {ws.slice(0, 2).map((w) => (
                            <Avatar
                              key={w.id}
                              name={w.name}
                              avatarUrl={avatarByPlayerId.get(w.id)}
                              className="wcf-potm-face"
                              background={avatarFor(w.name).gradient}
                            />
                          ))}
                        </div>
                        <div className="wcf-potm-who">
                          {ws.map((w, i) => (
                            <button key={w.id} className="wcf-potm-name" onClick={() => openPlayerCard(w.id)}>
                              {w.name}
                              {i < ws.length - 1 ? <span className="wcf-potm-amp"> &amp;</span> : null}
                            </button>
                          ))}
                        </div>
                      </div>
                      {!joint && ws[0] && (
                        <div className="wcf-potm-stats">
                          <span>
                            <b>
                              <CountUp to={ws[0].wins} delay={600} run={potmLand} />
                            </b>
                            {ws[0].wins === 1 ? "MOTM win" : "MOTM wins"}
                          </span>
                          <span>
                            <b>
                              <CountUp to={ws[0].votes} delay={700} run={potmLand} />
                            </b>
                            {ws[0].votes === 1 ? "vote" : "votes"}
                          </span>
                          <span>
                            <b>
                              <CountUp to={ws[0].goals} delay={800} run={potmLand} />
                            </b>
                            {ws[0].goals === 1 ? "goal" : "goals"}
                          </span>
                        </div>
                      )}
                      {joint && <div className="wcf-potm-note">Level on {plural(ws[0].wins, "MOTM win", "MOTM wins")} and votes. Shared honours.</div>}
                    </div>
                  );
                })()}
              {totmCard}
              {awards.map((a) => (
                <div key={a.id} className="wcf-shoutout">
                  {a.title} — <strong>{a.value}</strong>
                  {a.note ? ` · ${a.note}` : ""}
                  {a.image_url && <img className="wcf-award-media" src={a.image_url} alt={a.title} loading="lazy" />}
                  {a.video_url && <video className="wcf-award-media" src={a.video_url} controls preload="metadata" />}
                </div>
              ))}

              {!calm &&
                rivalryStreak &&
                (() => {
                  const lead = rivalryStreak.winner === "white" ? cs.team_white_name : cs.team_red_name;
                  const other = rivalryStreak.winner === "white" ? cs.team_red_name : cs.team_white_name;
                  const color = rivalryStreak.winner === "white" ? cs.team_white_color : cs.team_red_color;
                  return (
                    // Same family as the Player of the Month card: a glow in
                    // the leading team's own colour, the number up front.
                    <div className="wcf-streak-card" style={{ "--team": color } as React.CSSProperties}>
                      <div className="wcf-streak-n">{rivalryStreak.count}</div>
                      <div className="wcf-streak-body">
                        <div className="wcf-streak-eyebrow">
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                            <path d="M13.5 2.5c.4 3-1.2 4.6-2.7 6.1C9.4 10 8 11.4 8 14a4 4 0 0 0 8 0c0-1.2-.4-2.2-1-3 2.3.8 4 3.2 4 6a7 7 0 0 1-14 0c0-4.3 2.6-6.6 4.6-8.5 1.9-1.8 3.5-3.4 3.9-6z" />
                          </svg>
                          Winning run
                        </div>
                        <div className="wcf-streak-title">
                          {lead} have won {rivalryStreak.count} in a row
                        </div>
                        <div className="wcf-streak-sub">
                          {rivalryStreak.otherLastWon
                            ? `${other} haven't won since ${fmtDate(rivalryStreak.otherLastWon)}`
                            : `${other} are still waiting for a win`}
                        </div>
                      </div>
                    </div>
                  );
                })()}

              {calm && calmSeasonCards()}
              {!calm &&
                headToHead.white.played > 0 &&
                (() => {
                  // One rivalry, not two mirrored table rows: results and
                  // goals as bars, then the last five actual scores.
                  const h = headToHead;
                  const wName = cs.team_white_name;
                  const rName = cs.team_red_name;
                  const summary =
                    h.white.won === h.red.won
                      ? h.white.goals === h.red.goals
                        ? `Dead level after ${h.white.played} games.`
                        : `Level on wins after ${h.white.played} games. ${h.white.goals > h.red.goals ? wName : rName} ahead on goals.`
                      : `${h.white.won > h.red.won ? wName : rName} lead by ${Math.abs(h.white.won - h.red.won)} ${Math.abs(h.white.won - h.red.won) === 1 ? "win" : "wins"} after ${h.white.played} games.`;
                  const openScore = (id: string) => {
                    setResultsMonth("all");
                    setExpandedResultId(id);
                    setResultsView("fixtures");
                    setTimeout(() => document.getElementById("result-" + id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
                  };
                  return (
                    <div className="wcf-rivalry" style={{ "--wc": cs.team_white_color, "--rc": cs.team_red_color } as React.CSSProperties}>
                      <div className="wcf-rivalry-title">
                        {wName} v {rName}
                      </div>
                      <div className="wcf-rivalry-sub">{summary}</div>
                      <div className="wcf-h2h-table">
                        <div className="wcf-h2h-row wcf-h2h-header">
                          <span>Team</span>
                          <span>P</span>
                          <span>W</span>
                          <span>D</span>
                          <span>L</span>
                          <span>GF</span>
                          <span>GA</span>
                          <span>Pts</span>
                        </div>
                        {(
                          [
                            ["white", h.white, h.red.goals, wName, cs.team_white_color],
                            ["red", h.red, h.white.goals, rName, cs.team_red_color],
                          ] as const
                        )
                          .slice()
                          // Level on points goes to goal difference.
                          .sort((a, b) => b[1].points - a[1].points || b[1].goals - b[2] - (a[1].goals - a[2]))
                          .map(([key, row, against, name, color]) => (
                            <div key={key} className="wcf-h2h-row">
                              <span className="wcf-h2h-team">
                                <span className="wcf-h2h-dot" style={{ background: color }} />
                                {name}
                              </span>
                              <span>{row.played}</span>
                              <span>{row.won}</span>
                              <span>{row.drawn}</span>
                              <span>{row.lost}</span>
                              <span>{row.goals}</span>
                              <span>{against}</span>
                              <span className="wcf-h2h-pts">{row.points}</span>
                            </div>
                          ))}
                      </div>
                      <div className="wcf-rivalry-row">
                        {/* The numbers are in the table above; the bars are the picture of them. */}
                        <div className="wcf-rivalry-cap">Wins{h.white.drawn > 0 ? ` · ${h.white.drawn} ${h.white.drawn === 1 ? "draw" : "draws"}` : ""}</div>
                        <div className="wcf-rivalry-bar">
                          {h.white.won > 0 && <i className="w" style={{ flex: h.white.won }} />}
                          {h.white.drawn > 0 && <i className="d" style={{ flex: h.white.drawn }} />}
                          {h.red.won > 0 && <i className="r" style={{ flex: h.red.won }} />}
                        </div>
                      </div>
                      {h.white.goals + h.red.goals > 0 && (
                        <div className="wcf-rivalry-row">
                          <div className="wcf-rivalry-cap">Goals</div>
                          <div className="wcf-rivalry-bar">
                            {h.white.goals > 0 && <i className="w" style={{ flex: h.white.goals }} />}
                            {h.red.goals > 0 && <i className="r" style={{ flex: h.red.goals }} />}
                          </div>
                        </div>
                      )}
                      {formGuide.length > 0 && (
                        <div className="wcf-rivalry-row">
                          <div className="wcf-rivalry-k">
                            Last {formGuide.length} · {wName} first
                          </div>
                          <div className="wcf-rivalry-scores">
                            {formGuide.map((g, i) => {
                              const res = g.team_white_score! > g.team_red_score! ? "w" : g.team_white_score! < g.team_red_score! ? "r" : "d";
                              return (
                                <button
                                  key={g.id}
                                  className={"wcf-rivalry-score " + res + (i === formGuide.length - 1 ? " latest" : "")}
                                  onClick={() => openScore(g.id)}
                                >
                                  <b>
                                    {g.team_white_score}–{g.team_red_score}
                                  </b>
                                  <span>{new Date(g.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                                </button>
                              );
                            })}
                          </div>
                          <div className="wcf-rivalry-key">
                            <span>
                              <i className="w" />
                              {wName} won
                            </span>
                            <span>
                              <i className="r" />
                              {rName} won
                            </span>
                            <span>
                              <i className="d" />
                              Draw
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
            </>
          );
        })()}

      {view === "table" &&
        (() => {
          // Tied on goals favours fewer games, not more - the better
          // goals-per-game rate should rank above someone who just
          // played more often to reach the same total.
          const sorted = [...playerStats].sort((a, b) => (statsSort === "goals" ? b.goals - a.goals || a.apps - b.apps : b.apps - a.apps || b.goals - a.goals));
          const byGoals = [...playerStats].sort((a, b) => b.goals - a.goals || a.apps - b.apps).slice(0, 3);
          const podiumOrder = [byGoals[1], byGoals[0], byGoals[2]];
          const podiumRing = ["#eab308", "#cbd5e1", "#e63946"];
          const myIdx = sorted.findIndex((r) => r.id === myId);
          const me = sorted[myIdx];
          // Mid-climb: you're still where you were before the last game.
          const shown =
            statsClimb && sBefore
              ? [...sorted.slice(0, statsClimb.to), ...sorted.slice(statsClimb.to + 1, statsClimb.from + 1), sorted[statsClimb.to], ...sorted.slice(statsClimb.from + 1)]
              : sorted;
          const oldMe = statsClimb && (sPhase === "before" || sPhase === "points" || sPhase === "rank") ? statsClimb.before : null;
          const cardOld = statsClimb && sPhase === "before" ? statsClimb.before : null;

          return (
            <div className="wcf-board">
              <div className="wcf-lb-eyebrow">Leaderboard</div>
              <h3 className="wcf-lb-title">Player stats</h3>

              {byGoals.length > 0 && (
                <div className="wcf-lb-podium-card">
                  <div className="wcf-lb-podium-glow" />
                  <div className="wcf-lb-podium-label">
                    <span className="wcf-lb-podium-rule" /> TOP SCORERS <span className="wcf-lb-podium-rule" />
                  </div>
                  <div className="wcf-lb-podium-row">
                    {podiumOrder.map((p, i) => {
                      if (!p) return <div key={i} />;
                      const rank = byGoals.indexOf(p) + 1;
                      const lead = rank === 1;
                      const ring = podiumRing[rank - 1];
                      const a = avatarFor(p.name);
                      return (
                        <div key={p.id} className="wcf-lb-podium-slot">
                          {lead && <div className="wcf-lb-crown">♔</div>}
                          <div
                            className={"wcf-lb-podium-avatar " + (lead ? "lead" : "")}
                            style={{ borderColor: ring, width: lead ? 96 : 74, height: lead ? 96 : 74 }}
                          >
                            {avatarByPlayerId.get(p.id) ? (
                              <img className="wcf-lb-podium-photo" src={avatarByPlayerId.get(p.id) ?? undefined} alt={p.name} />
                            ) : (
                              <span style={{ fontSize: lead ? 26 : 20 }}>{a.initial}</span>
                            )}
                            <span className="wcf-lb-podium-badge" style={{ background: ring }}>
                              {rank}
                            </span>
                          </div>
                          <div className="wcf-lb-podium-name">{p.name.split(" ")[0]}</div>
                          <div className="wcf-lb-podium-goals" style={{ fontSize: lead ? 26 : 22 }}>
                            {p.goals} <span>G</span>
                          </div>
                          <div className="wcf-lb-podium-apps">{p.apps} apps</div>
                          <div
                            className="wcf-lb-podium-plinth"
                            style={{ height: lead ? 34 : rank === 2 ? 22 : 15, borderColor: ring, background: `linear-gradient(0deg,${ring}3d,${ring}0f)` }}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {me && (
                    <div className="wcf-lb-me-card">
                      <div className="wcf-lb-me-rank">
                        <span className={sPhase === "rank" ? "wcf-tick" : undefined} key={cardOld ? "o" : "n"}>
                          {cardOld ? statsClimb!.from + 1 : myIdx + 1}
                        </span>
                      </div>
                      <div className="wcf-lb-me-body">
                        <div className="wcf-lb-me-label">Your rank</div>
                        <div className="wcf-lb-me-name">{me.name}</div>
                      </div>
                      <div className="wcf-lb-me-stat">
                        <div className={sPhase === "rank" ? "wcf-tick" : undefined} key={cardOld ? "oa" : "na"}>
                          {cardOld ? cardOld.apps : me.apps}
                        </div>
                        <span>apps</span>
                      </div>
                      <div className="wcf-lb-me-stat">
                        <div className={sPhase === "rank" ? "wcf-tick" : undefined} key={cardOld ? "og" : "ng"}>
                          {cardOld ? cardOld.goals : me.goals}
                        </div>
                        <span>goals</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="wcf-lb-list-card">
                <PillChoice
                  label="Which season"
                  value={activeStatsYear}
                  onChange={(y) => {
                    setStatsSeasonYear(y);
                    setStatsOpenId(null);
                  }}
                  options={seasonYears.map((y) => ({ value: y, label: `Season ${y - SEASON_EPOCH_YEAR + 1} · ${y}${y === currentSeasonYear ? " (now)" : ""}` }))}
                />
                <p className="wcf-board-note">
                  Games played and goals scored this season, sorted by {statsSort === "goals" ? "goals" : "appearances"}.
                </p>

                <div className="wcf-lb-sorts">
                  {(["apps", "goals"] as const).map((s) => (
                    <button
                      key={s}
                      className={"wcf-lb-sort-btn " + (statsSort === s ? "on" : "")}
                      onClick={() => {
                        setStatsSort(s);
                        setStatsOpenId(null);
                      }}
                    >
                      {s === "apps" ? "Appearances" : "Goals"}
                    </button>
                  ))}
                </div>

                <div className="wcf-board-row wcf-board-header">
                  <span className="wcf-rank" />
                  <span style={{ width: 24 }} />
                  <span className="wcf-board-name">Player</span>
                  <span className={"wcf-board-count" + (statsSort === "apps" ? " on" : "")}>Apps</span>
                  <span className={"wcf-board-count" + (statsSort === "goals" ? " on" : "")}>Goals</span>
                </div>
                {shown.map((row, i) => {
                  const isLead = i === 0;
                  const isMe = row.id === myId;
                  const climbing = isMe && !!statsClimb && !!sPhase;
                  const pre = climbing && oldMe && sPhase !== "points" ? oldMe : null;
                  const a = avatarFor(row.name);
                  const open = statsOpenId === row.id;
                  return (
                    <div
                      key={row.id}
                      className={climbing && sPhase !== "done" ? "wcf-sclimb" : undefined}
                      ref={(el) => {
                        if (el) sRows.current.set(row.id, el);
                        else sRows.current.delete(row.id);
                      }}
                    >
                      <div
                        className={"wcf-board-row " + (isLead ? "lead " : "") + (isMe ? "me" : "")}
                        style={climbing ? { position: "relative" } : undefined}
                        onClick={() => setStatsOpenId((v) => (v === row.id ? null : row.id))}
                      >
                        <span className="wcf-rank">{isLead ? <span className="wcf-rank-star">{Icon.star}</span> : i + 1}</span>
                        <Avatar name={row.name} avatarUrl={avatarByPlayerId.get(row.id)} className="wcf-lb-row-avatar" background={a.gradient} />
                        {/* Badges sit under the name rather than beside it:
                                side by side they squeezed names down to
                                "Jacob…" and "Chris H…". */}
                        <span className="wcf-board-who">
                          <button
                            className="wcf-board-name wcf-name-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPlayerCard(row.id);
                            }}
                          >
                            {row.name}
                          </button>
                          {isMe && (
                            <span className="wcf-board-badges">
                              <span className="wcf-lb-you-badge">you</span>
                              {climbing && sPhase === "done" && (
                                <span className="wcf-climb-up">
                                  ▲ {statsClimb!.from - statsClimb!.to} {statsClimb!.from - statsClimb!.to === 1 ? "place" : "places"}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                        {climbing && sPhase === "points" && (
                          <span className="wcf-sclimb-plus">
                            +{statsClimb!.gained} {statsSort === "goals" ? (statsClimb!.gained === 1 ? "goal" : "goals") : "app"}
                          </span>
                        )}
                        <span className={"wcf-board-count" + (statsSort === "apps" ? " on" : "")}>
                          <span className={climbing && sPhase === "points" ? "wcf-tick" : undefined} key={pre ? "o" : "n"}>
                            {pre ? pre.apps : row.apps}
                          </span>
                        </span>
                        <span className={"wcf-board-count" + (statsSort === "goals" ? " on" : "")}>
                          <span className={climbing && sPhase === "points" ? "wcf-tick" : undefined} key={pre ? "o" : "n"}>
                            {(pre ? pre.goals : row.goals) || "—"}
                          </span>
                        </span>
                      </div>
                      {open && (
                        <div className="wcf-lb-row-detail">
                          <span>
                            Goals / app <b>{(row.goals / row.apps).toFixed(2)}</b>
                          </span>
                          <span>
                            Last played <b>{row.lastPlayed ? fmtDate(row.lastPlayed) : "—"}</b>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="wcf-lb-footer">
                  <span>Tap a row for goals per game and when they last played.</span>
                  <button onClick={() => setTab("fixtures")}>View fixtures</button>
                </div>
              </div>
            </div>
          );
        })()}

      {view === "records" &&
        (() => {
          const r = clubRecords;
          const days = (d: number) => (d < 1 ? "less than a day" : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`);
          const empty = !r.highestScoring;
          return (
            <div className="wcf-board">
              <div className={"wcf-rec-hero" + (recordFalls.goals ? " wcf-rb-play" : "")}>
                <div className="wcf-rec-hero-bg" />
                {recordFalls.goals && <div className="wcf-rb-tag">NEW RECORD</div>}
                <div className="wcf-rec-hero-in">
                  <div className="wcf-lb-eyebrow" style={{ color: "#f5d97a" }}>
                    Record book
                  </div>
                  <h3 className="wcf-lb-title">Club records</h3>
                  {r.mostGoalsInGame && (
                    <div className="wcf-rec-hero-stat">
                      <b>
                        {recordFalls.goals ? (
                          <>
                            <span className="wcf-rb-old">{recordFalls.goals.v}</span>
                            <span className="wcf-rb-new">{r.mostGoalsInGame.goals}</span>
                          </>
                        ) : (
                          r.mostGoalsInGame.goals
                        )}
                      </b>
                      <span>
                        goals in one game
                        <br />
                        {recordFalls.goals && <span className="wcf-rb-was">{recordFalls.goals.who}</span>}
                        <span className={recordFalls.goals ? "wcf-rb-now" : undefined}>
                          {r.mostGoalsInGame.holders[0].name}
                          {r.mostGoalsInGame.holders.length > 1 ? ` +${r.mostGoalsInGame.holders.length - 1}` : ""}
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <PillChoice label="Which season" value={activeStatsYear} onChange={setStatsSeasonYear} options={seasonYears.map((y) => ({ value: y, label: `Season ${y - SEASON_EPOCH_YEAR + 1} · ${y}${y === currentSeasonYear ? " (now)" : ""}` }))} />
              {myBests.games > 0 &&
                (() => {
                  const b = myBests;
                  // A tile is "the club record" when your best equals it.
                  const tiles: { k: string; v: number | string; label: string; sub?: string; record: boolean }[] = [
                    {
                      k: "g",
                      v: b.mostGoals?.goals ?? 0,
                      label: "Goals in a game",
                      sub: b.mostGoals ? fmtDate(b.mostGoals.date) : undefined,
                      record: !!b.mostGoals && b.mostGoals.goals === r.mostGoalsInGame?.goals,
                    },
                    { k: "w", v: b.winStreak, label: "Win streak", record: b.winStreak > 0 && b.winStreak === r.winStreak?.n },
                    { k: "u", v: b.unbeaten, label: "Unbeaten run", record: b.unbeaten > 0 && b.unbeaten === r.unbeaten?.n },
                    { k: "r", v: b.gamesInARow, label: "Games in a row", record: b.gamesInARow > 0 && b.gamesInARow === r.gamesInARow?.n },
                  ];
                  if (b.hatTricks > 0) tiles.push({ k: "h", v: b.hatTricks, label: b.hatTricks === 1 ? "Hat-trick" : "Hat-tricks", record: false });
                  if (b.motmWins > 0)
                    tiles.push({ k: "m", v: b.motmWins, label: b.motmWins === 1 ? "MOTM win" : "MOTM wins", record: b.motmWins === r.motmWins?.n });
                  else if (b.motmVotes > 0)
                    tiles.push({ k: "v", v: b.motmVotes, label: b.motmVotes === 1 ? "MOTM vote" : "MOTM votes", record: b.motmVotes === r.motmVotes?.n });
                  const meName = myProfile?.display_name ?? "You";
                  return (
                    // Same family as the Player of the Month card: a photo
                    // glow, your face in a gold ring, and a clean row of
                    // numbers rather than boxed tiles.
                    <div className="wcf-bests">
                      <div className="wcf-bests-bg" />
                      <div className="wcf-bests-head">
                        <Avatar name={meName} avatarUrl={avatarByPlayerId.get(myId)} className="wcf-bests-face" background={avatarFor(meName).gradient} />
                        <div className="wcf-bests-who">
                          <span className="wcf-bests-eyebrow">Your season</span>
                          <span className="wcf-bests-name">{meName}</span>
                          <span className="wcf-bests-meta">
                            {b.games} {b.games === 1 ? "game" : "games"} played
                          </span>
                        </div>
                      </div>
                      <div className="wcf-bests-grid">
                        {tiles.map((t) => (
                          <div key={t.k} className={"wcf-bests-stat" + (t.record ? " record" : "")}>
                            <b>{t.v}</b>
                            <span>{t.label}</span>
                            {t.record ? (
                              <em>
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
                                  <path d="M3 18h18l-1.6-9.2-4.9 3.9L12 5l-2.5 7.7-4.9-3.9z" />
                                </svg>
                                Club record
                              </em>
                            ) : (
                              t.sub && <small>{t.sub}</small>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              <div className="wcf-lb-list-card">
                {empty ? (
                  <p className="wcf-board-note">No results yet this season. Records start with the first game.</p>
                ) : (
                  <>
                    <div className="wcf-rec-group">In a single game</div>
                    {r.mostGoalsInGame &&
                      row("goals", r.mostGoalsInGame.goals, "Most goals by one player", who(r.mostGoalsInGame.holders, true), r.mostGoalsInGame.holders)}
                    {r.biggestWin && row("win", `+${r.biggestWin.margin}`, "Biggest win", scoreLine(r.biggestWin))}
                    {r.highestScoring && row("high", r.highestScoring.total, "Highest-scoring game", scoreLine(r.highestScoring))}
                    {r.mostMotmVotesInGame &&
                      row(
                        "votes1",
                        r.mostMotmVotesInGame.votes,
                        "Most MOTM votes in a game",
                        who(r.mostMotmVotesInGame.holders, true),
                        r.mostMotmVotesInGame.holders,
                      )}

                    <div className="wcf-rec-group">Over the season</div>
                    {r.winStreak && row("ws", r.winStreak.n, "Longest winning run", who(r.winStreak.holders), r.winStreak.holders)}
                    {r.unbeaten && row("ub", r.unbeaten.n, "Longest unbeaten run", who(r.unbeaten.holders), r.unbeaten.holders)}
                    {r.gamesInARow && row("row", r.gamesInARow.n, "Most games in a row", who(r.gamesInARow.holders), r.gamesInARow.holders)}
                    {r.motmWins && row("mw", r.motmWins.n, "Most Man of the Match wins", who(r.motmWins.holders), r.motmWins.holders)}
                    {r.motmVotes && row("mv", r.motmVotes.n, "Most MOTM votes", who(r.motmVotes.holders), r.motmVotes.holders)}
                    {r.promotions && row("wl", r.promotions.n, "Most times in off the waiting list", who(r.promotions.holders), r.promotions.holders)}

                    {r.hatTricks.length > 0 && (
                      <>
                        <div className="wcf-rec-group">Hat-tricks · {r.hatTricks.length}</div>
                        {/* Same rows as every other record, so the numbers and
                                names line up; the top 5 until asked for the rest,
                                since this list only grows through a season. */}
                        {(showAllHatTricks ? r.hatTricks : r.hatTricks.slice(0, 5)).map((h, i) =>
                          row(
                            h.playerId + h.date + i,
                            h.goals,
                            "",
                            <>
                              <button className="wcf-name-link wcf-rec-name" onClick={() => openPlayerCard(h.playerId)}>
                                {h.name}
                              </button>
                              <span className="wcf-rec-date">
                                {h.goals} goals · {fmtDate(h.date)}
                              </span>
                            </>,
                            [{ playerId: h.playerId, name: h.name }],
                          ),
                        )}
                        {r.hatTricks.length > 5 && (
                          <button className="wcf-rec-more" onClick={() => setShowAllHatTricks((v) => !v)}>
                            {showAllHatTricks ? "Show fewer" : `Show all ${r.hatTricks.length}`}
                          </button>
                        )}
                      </>
                    )}

                    {r.sellOut.soldOut > 0 && (
                      <>
                        <div className="wcf-rec-group">Booking</div>
                        {r.sellOut.averageDays !== null &&
                          row(
                            "avg",
                            `${Math.round(r.sellOut.averageDays)}d`,
                            "Games usually sell out",
                            <>
                              about {days(r.sellOut.averageDays)} before kickoff ({r.sellOut.soldOut} of {r.sellOut.of} sold out)
                            </>,
                          )}
                        {r.sellOut.earliest &&
                          row(
                            "early",
                            `${Math.round(r.sellOut.earliest.days)}d`,
                            "Earliest sell-out",
                            <>
                              {days(r.sellOut.earliest.days)} before kickoff<span className="wcf-rec-date"> · {fmtDate(r.sellOut.earliest.date)}</span>
                            </>,
                          )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })()}

      {view === "fixtures" && (
        <>
          {!calm && (
          <PillChoice
            label="Which results"
            value={resultsMonth}
            onChange={setResultsMonth}
            options={[
              { value: "all", label: "All", count: scoredPastGames.length },
              ...resultsMonths.map((m) => ({ value: m, label: new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: m.slice(0, 4) === String(currentSeasonYear) ? undefined : "numeric" }), count: scoredPastGames.filter((g) => g.date.slice(0, 7) === m).length })),
            ]}
          />
          )}

          {filteredResults.length === 0 &&
            (scoredPastGames.length === 0 ? (
              <EmptyScene kind="results" title="No results yet" text="The first score lands here at full time." />
            ) : (
              <p className="wcf-empty">No results yet.</p>
            ))}
          <style>{scoresCss}</style>
          {(() => {
          const renderResult = (g: GameRow, resultIndex: number, rowIndex = 0) => {
            const scorers = goalRows.filter((r) => r.game_id === g.id && r.goals > 0).sort((a, b) => b.goals - a.goals);
            const teamOf = (playerId: string) => g.bookings.find((b) => b.player_id === playerId)?.team;
            const whiteScorers = scorersForSide(scorers, "white", teamOf);
            const redScorers = scorersForSide(scorers, "red", teamOf);
            // Not split by team - which side an own goal benefited isn't
            // reliably knowable if the scorer switched teams mid-match.
            const ownGoalScorers = goalRows.filter((r) => r.game_id === g.id && r.own_goals > 0);
            // Who actually played, not who's been payment-confirmed -
            // those often lag behind by days, and voting closes hours
            // after kickoff.
            const candidates = g.bookings.filter((b) => !b.waiting);
            const votingOpen = motmVotingOpen(g);
            const tally = motmTallyByGame[g.id] ?? {};
            const totalVotes = Object.values(tally).reduce((sum, n) => sum + n, 0);
            const myVote = myMotmVoteByGame[g.id];
            const ranked = candidates.map((c) => ({ candidate: c, votes: tally[c.player_id] ?? 0 })).sort((a, b) => b.votes - a.votes);
            const topVotes = ranked[0]?.votes ?? 0;
            // Winners under the club's rule (a tie on votes goes to more goals).
            const winnerIds = motmWinnerIdsByGame[g.id] ?? [];
            const expanded = expandedResultId === g.id;
            // Only ever read once voting's closed (the vote buttons
            // above never surface this) - keeps voting itself
            // anonymous while letting the community see who backed
            // who once the result's out, per direct feedback.
            const votersFor = (candidateId: string) =>
              motmVotes
                .filter((v) => v.game_id === g.id && v.candidate_id === candidateId)
                .map((v) => profiles.find((p) => p.id === v.voter_id))
                .filter((p): p is Profile => !!p);
            return (
              <article
                key={g.id}
                id={"result-" + g.id}
                className={resultIndex === 0 ? "wcf-result featured wcf-sc-heroart" : "wcf-sc-item" + (expanded ? " open" : "")}
              >
                <button className="wcf-result-toggle" onClick={() => setExpandedResultId(expanded ? null : g.id)} aria-expanded={expanded}>
                  {(() => {
                    const w = g.team_white_score ?? 0;
                    const r = g.team_red_score ?? 0;
                    const outcome = w > r ? "white" : r > w ? "red" : "draw";
                    const d = new Date(g.date + "T12:00:00Z");
                    const mon = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase();
                    const motmWinners = !votingOpen ? ranked.filter((x) => winnerIds.includes(x.candidate.player_id)) : [];
                    const motmNames = motmWinners.map((x) => x.candidate.player.display_name);
                    const motmFace = motmWinners[0]?.candidate;
                    const top = scorers[0] && scorers[0].goals >= 2 ? scorers[0] : null;
                    const goalsWord = (n: number) => (n === 3 ? "hat-trick" : `${n} goals`);
                    const topLine = top
                      ? motmNames.length === 1 && motmNames[0] === top.player.display_name
                        ? goalsWord(top.goals)
                        : `${top.player.display_name} ${goalsWord(top.goals)}`
                      : null;
                    // Two-game nights are "Solar Campus #1" / "#2".
                    const dbl = g.venue.match(/#(\d+)/)?.[1];
                    const away = g.venue !== mainResultsVenue && !dbl;
                    const chev = (
                      <svg
                        className={"wcf-res-chev" + (expanded ? " open" : "")}
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    );
                    const face = (cls: string) =>
                      motmFace ? (
                        <Avatar
                          name={motmFace.player.display_name}
                          avatarUrl={avatarByPlayerId.get(motmFace.player_id)}
                          className={cls}
                          background={avatarFor(motmFace.player.display_name).gradient}
                        />
                      ) : null;
                    if (resultIndex === 0) {
                      return (
                        <div className="wcf-sc-hero">
                          <div className="wcf-sc-hero-k">
                            Latest · {d.getUTCDate()} {mon}
                            {dbl && <span className="wcf-sc-dbl">#{dbl}</span>}
                          </div>
                          <div className="wcf-sc-hero-score">
                            <div className="wcf-sc-hero-side">
                              {cs.team_white_name}
                              <b style={{ color: outcome === "red" ? "#64748b" : cs.team_white_color }}>{w}</b>
                            </div>
                            <span className="wcf-sc-hero-dash">–</span>
                            <div className="wcf-sc-hero-side">
                              {cs.team_red_name}
                              <b style={{ color: outcome === "white" ? "#64748b" : cs.team_red_color }}>{r}</b>
                            </div>
                            <span
                              className={"wcf-res-pill " + outcome}
                              style={
                                outcome === "white" ? { background: cs.team_white_color } : outcome === "red" ? { background: cs.team_red_color } : undefined
                              }
                            >
                              {outcome === "draw" ? "Draw" : `${outcome === "white" ? cs.team_white_name : cs.team_red_name} win`}
                            </span>
                          </div>
                          <div className="wcf-sc-hero-mo">
                            {face("wcf-sc-face38")}
                            <div>
                              {votingOpen ? (
                                <>
                                  <small>Man of the Match</small>
                                  <b className="wcf-sc-open">Voting open</b>
                                  {topLine && <> · {topLine}</>}
                                </>
                              ) : motmNames.length > 0 ? (
                                <>
                                  <small>{motmNames.length > 1 ? "Joint Man of the Match" : "Man of the Match"}</small>
                                  <b>{motmNames.join(" & ")}</b>
                                  {topLine && <> · {topLine}</>}
                                </>
                              ) : (
                                <>
                                  <small>{fmtDate(g.date)}</small>
                                  {topLine}
                                </>
                              )}
                              {away && <> · {g.venue}</>}
                            </div>
                            <span style={{ marginLeft: "auto" }}>{chev}</span>
                          </div>
                        </div>
                      );
                    }
                    const sub = [
                      motmNames.length > 0 ? "MOTM" : null,
                      motmNames.length > 0 || votingOpen ? topLine : null,
                      away ? g.venue : null,
                    ].filter(Boolean);
                    return (
                      <div
                        className="wcf-sc-row"
                        style={{
                          ["--edge" as string]: outcome === "white" ? cs.team_white_color : outcome === "red" ? cs.team_red_color : "#5a6478",
                          ["--i" as string]: rowIndex,
                        }}
                      >
                        <div className="wcf-sc-date">
                          {d.getUTCDate()}
                          <span>{mon}</span>
                        </div>
                        <div className="wcf-sc-score">
                          <span className={outcome === "red" ? "lose" : ""} style={outcome === "white" ? { color: cs.team_white_color } : undefined}>
                            {w}
                          </span>
                          <i>–</i>
                          <span className={outcome === "white" ? "lose" : ""} style={outcome === "red" ? { color: cs.team_red_color } : undefined}>
                            {r}
                          </span>
                        </div>
                        <div className="wcf-sc-who">
                          {face("wcf-sc-face26")}
                          <div>
                            <b>
                              {votingOpen ? <span className="wcf-sc-open">MOTM voting open</span> : motmNames.length > 0 ? motmNames.join(" & ") : (topLine ?? fmtDate(g.date))}
                              {dbl && <span className="wcf-sc-dbl">#{dbl}</span>}
                            </b>
                            <small>{sub.length > 0 ? sub.join(" · ") : fmtDate(g.date)}</small>
                          </div>
                        </div>
                        {chev}
                      </div>
                    );
                  })()}
                </button>

                {expanded && (
                  <div className="wcf-result-detail">
                    {resultIndex > 0 &&
                      (() => {
                        const w = g.team_white_score ?? 0;
                        const r = g.team_red_score ?? 0;
                        return (
                          <div className="wcf-sc-board">
                            <div className="wcf-sc-board-meta">
                              {fmtDate(g.date)} · {g.venue} · {g.kickoff.slice(0, 5)}
                            </div>
                            <div className="wcf-sc-board-big">
                              <div className={"wcf-sc-board-tm" + (w > r ? " win" : "")}>
                                <b>
                                  <CountUp to={w} delay={120} run={motionAllowed()} />
                                </b>
                                {cs.team_white_name}
                              </div>
                              <div className="wcf-sc-board-ft">FT</div>
                              <div className={"wcf-sc-board-tm" + (r > w ? " win" : "")}>
                                <b>
                                  <CountUp to={r} delay={120} run={motionAllowed()} />
                                </b>
                                {cs.team_red_name}
                              </div>
                            </div>
                            <div className="wcf-sc-share" style={{ background: cs.team_red_color }}>
                              <i style={{ ["--w" as string]: `${w + r ? (100 * w) / (w + r) : 50}%`, background: cs.team_white_color }} />
                            </div>
                          </div>
                        );
                      })()}

                    {scorers.length > 0 &&
                      (() => {
                        // Balls drop in one after another down both columns.
                        let ball = 0;
                        return (
                          <div className="wcf-sc-halves">
                            {(
                              [
                                ["white", whiteScorers, cs.team_white_name, cs.team_white_color],
                                ["red", redScorers, cs.team_red_name, cs.team_red_color],
                              ] as const
                            ).map(([side, list, teamName, color]) => (
                              <div key={side} className="wcf-sc-half">
                                <h5>
                                  <i style={{ background: color }} />
                                  {teamName}
                                </h5>
                                {list.length === 0 && <div className="wcf-sc-none">No scorers</div>}
                                {list.map((s) => {
                                  const start = ball;
                                  ball += s.goals;
                                  return (
                                    <button key={s.id} className="wcf-sc-scorer" onClick={() => openPlayerCard(s.player_id)}>
                                      <Avatar
                                        name={s.player.display_name}
                                        avatarUrl={avatarByPlayerId.get(s.player_id)}
                                        className="wcf-sc-face32"
                                        background={avatarFor(s.player.display_name).gradient}
                                      />
                                      <span>
                                        <span className="wcf-sc-scorer-nm">{s.player.display_name}</span>
                                        <GoalBalls n={s.goals} start={start}>
                                          {s.goals >= 3 && (
                                            <span className="wcf-sc-ht" style={{ ["--i" as string]: start + s.goals }}>
                                              {s.goals >= 6 ? "DOUBLE HAT-TRICK" : "HAT-TRICK"}
                                            </span>
                                          )}
                                        </GoalBalls>
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        );
                      })()}

                    {ownGoalScorers.length > 0 && (
                      <div className="wcf-result-og">
                        Own goal{ownGoalScorers.length > 1 || ownGoalScorers[0].own_goals > 1 ? "s" : ""}:{" "}
                        {ownGoalScorers.map((s, i) => (
                          <span key={s.id}>
                            {i > 0 && ", "}
                            <button className="wcf-name-link" onClick={() => openPlayerCard(s.player_id)}>
                              {s.player.display_name}
                            </button>
                            {s.own_goals > 1 && ` (${s.own_goals})`}
                          </span>
                        ))}
                      </div>
                    )}

                    {votingOpen &&
                      candidates.length > 0 &&
                      (() => {
                        const closes = motmClosesLabel(g);
                        if (!playedIn(g, myId)) {
                          return (
                            <div className="wcf-vote-note">
                              Voting&apos;s for the {candidates.length} who played · result at <b>{closes}</b>
                            </div>
                          );
                        }
                        const goalsOf = (id: string) => scorers.find((s) => s.player_id === id)?.goals ?? 0;
                        // Scorers first, then A-Z; you go last in your own team.
                        const byGoals = (a: BookingRow, b: BookingRow) =>
                          Number(a.player_id === myId) - Number(b.player_id === myId) ||
                          goalsOf(b.player_id) - goalsOf(a.player_id) ||
                          a.player.display_name.localeCompare(b.player.display_name);
                        const groups = [
                          {
                            key: "white",
                            name: cs.team_white_name,
                            color: cs.team_white_color,
                            list: candidates.filter((c) => c.team === "white").sort(byGoals),
                          },
                          { key: "red", name: cs.team_red_name, color: cs.team_red_color, list: candidates.filter((c) => c.team === "red").sort(byGoals) },
                          {
                            key: "none",
                            name: "Also played",
                            color: "var(--dim)",
                            list: candidates.filter((c) => c.team !== "white" && c.team !== "red").sort(byGoals),
                          },
                        ].filter((grp) => grp.list.length > 0);
                        const pickName = myVote ? candidates.find((c) => c.player_id === myVote)?.player.display_name : null;
                        return (
                          <div className="wcf-vote">
                            <div className="wcf-vote-head">
                              <div className="wcf-vote-k">Vote Man of the Match</div>
                              <div className="wcf-vote-meta">
                                Closes <b>{closes}</b> · {motmTimeLeft(g)} left ·{" "}
                                <b className={"wcf-vote-count" + (justVoted?.gameId === g.id ? " tick" : "")} key={motmBallotCounts[g.id] ?? totalVotes}>
                                  {motmBallotCounts[g.id] ?? totalVotes}
                                </b>{" "}
                                of {candidates.length} voted
                              </div>
                            </div>
                            <div className="wcf-vote-teams">
                              {groups.map((grp) => (
                                <div key={grp.key} className={"wcf-vote-col" + (grp.key === "none" ? " wide" : "")}>
                                  <div className="wcf-vote-col-h">
                                    <span className="wcf-h2h-dot" style={{ background: grp.color }} />
                                    {grp.name}
                                  </div>
                                  {grp.list.map((c) => {
                                    const isMe = c.player_id === myId;
                                    const picked = myVote === c.player_id;
                                    const goals = goalsOf(c.player_id);
                                    return (
                                      <button
                                        key={c.id}
                                        className={
                                          "wcf-vote-pick" +
                                          (picked ? " picked" : "") +
                                          (picked && justVoted?.gameId === g.id && justVoted.candidateId === c.player_id ? " fresh" : "") +
                                          (isMe ? " me" : "")
                                        }
                                        disabled={isMe}
                                        onClick={() => castMotmVote(g.id, c.player_id, c.player.display_name)}
                                      >
                                        <Avatar
                                          name={c.player.display_name}
                                          avatarUrl={avatarByPlayerId.get(c.player_id)}
                                          className="wcf-vote-av"
                                          background={avatarFor(c.player.display_name).gradient}
                                        />
                                        <span className="wcf-vote-who">
                                          <span className="wcf-vote-name">{isMe ? "You" : c.player.display_name}</span>
                                          {goals > 0 && (
                                            <span className="wcf-vote-goals">
                                              {goals} {goals === 1 ? "goal" : "goals"}
                                            </span>
                                          )}
                                          {picked && <span className="wcf-vote-yours">✓ Your vote</span>}
                                        </span>
                                        {picked && (
                                          <>
                                            <span className="wcf-vote-shine" aria-hidden="true" />
                                            <VoteMedal gameId={g.id} anim={justVoted?.gameId === g.id && justVoted.candidateId === c.player_id ? justVoted.n : 0} />
                                          </>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              ))}
                            </div>
                            {pickName &&
                              (() => {
                                const myTag = motmVotes.find((v) => v.game_id === g.id && v.voter_id === myId)?.tag ?? null;
                                return (
                                  <div className="wcf-why">
                                    <div className="wcf-why-q">Why {pickName.split(" ")[0]}?</div>
                                    <div className="wcf-why-s">Optional · anonymous · pick one</div>
                                    <div className="wcf-why-tags">
                                      {MOTM_TAGS.map((t) => (
                                        <button
                                          key={t.key}
                                          className={"wcf-why-tag" + (myTag === t.key ? " on" : "")}
                                          onClick={() => setMotmVoteTag(g.id, myTag === t.key ? null : t.key)}
                                          aria-pressed={myTag === t.key}
                                        >
                                          <svg
                                            viewBox="0 0 24 24"
                                            width="22"
                                            height="22"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                          >
                                            {t.icon}
                                          </svg>
                                          <b>{t.label}</b>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}
                            <div className="wcf-vote-foot">
                              {pickName ? (
                                <>
                                  You voted for <b>{pickName}</b>
                                  {(() => {
                                    const t = MOTM_TAGS.find((x) => x.key === motmVotes.find((v) => v.game_id === g.id && v.voter_id === myId)?.tag);
                                    return t ? <> · {t.label}</> : null;
                                  })()}
                                  . Tap someone else to change it. The result&apos;s out at {closes}.
                                </>
                              ) : (
                                <>Tap a player to vote. You can&apos;t vote for yourself. The result&apos;s out at {closes}.</>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                    {!votingOpen &&
                      totalVotes > 0 &&
                      (() => {
                        const winners = ranked.filter((x) => winnerIds.includes(x.candidate.player_id));
                        const winVotes = winners[0]?.votes ?? topVotes;
                        const teamLabel = (t: string | null) => (t === "white" ? cs.team_white_name : t === "red" ? cs.team_red_name : null);
                        const winnerTeams = [...new Set(winners.map((w) => teamLabel(w.candidate.team)).filter(Boolean))];
                        // Same gold family as Player of the Month: the winner's
                        // face up top, then every player who got a vote.
                        const recent = kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES + 7 * 24 * 60) > nowUk;
                        return (
                          <MotmReveal storageKey={`wcf-motm-reveal-${myId}-${g.id}`} eligible={recent}>
                            {(phase, skip, replay) =>
                              phase === "drum" ? (
                                <div className="wcf-motm-card wcf-sc-motm wcf-mr-drumming" onPointerDown={skip}>
                                  <div className="wcf-motm-card-k">{winners.length > 1 ? "Joint Man of the Match" : "Man of the Match"}</div>
                                  <div className="wcf-motm-card-main">
                                    <div className="wcf-motm-card-faces">
                                      <span className="wcf-motm-card-face wcf-mr-mystery">?</span>
                                    </div>
                                    <div className="wcf-mr-wait">
                                      And it goes to
                                      <span className="wcf-mr-drum">
                                        <i />
                                        <i />
                                        <i />
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div className={"wcf-motm-card wcf-sc-motm" + (phase === "reveal" ? " wcf-mr-reveal" : "")}>
                                  <div className="wcf-motm-card-k">{winners.length > 1 ? "Joint Man of the Match" : "Man of the Match"}</div>
                                  <div className="wcf-motm-card-main">
                                    <div className="wcf-motm-card-faces">
                                      {phase === "reveal" && (
                                        <span className="wcf-mr-rays" aria-hidden="true">
                                          {Array.from({ length: 10 }, (_, i) => (
                                            <i key={i} style={{ ["--a" as string]: `${i * 36}deg` }} />
                                          ))}
                                        </span>
                                      )}
                                      {winners.slice(0, 2).map((w) => (
                                        <Avatar
                                          key={w.candidate.id}
                                          name={w.candidate.player.display_name}
                                          avatarUrl={avatarByPlayerId.get(w.candidate.player_id)}
                                          className="wcf-motm-card-face"
                                          background={avatarFor(w.candidate.player.display_name).gradient}
                                        />
                                      ))}
                                    </div>
                                    <div className="wcf-motm-card-who">
                                      <div className="wcf-motm-card-names">
                                        {winners.map((w, i) => (
                                          <button key={w.candidate.id} className="wcf-motm-card-name" onClick={() => openPlayerCard(w.candidate.player_id)}>
                                            {w.candidate.player.display_name}
                                            {i < winners.length - 1 ? <span className="wcf-motm-card-amp"> &amp;</span> : null}
                                          </button>
                                        ))}
                                      </div>
                                      <div className="wcf-motm-card-sub">
                                        <b>
                                          {winVotes} of {totalVotes} votes
                                        </b>
                                        {winnerTeams.length > 0 && ` · ${winnerTeams.join(" & ")}`}
                                      </div>
                                    </div>
                                  </div>
                                  <MotmPoll
                                    key={g.id}
                                    total={totalVotes}
                                    rows={ranked
                                      .filter((x) => x.votes > 0)
                                      .map((x) => ({
                                        id: x.candidate.player_id,
                                        name: x.candidate.player.display_name,
                                        avatarUrl: avatarByPlayerId.get(x.candidate.player_id),
                                        gradient: avatarFor(x.candidate.player.display_name).gradient,
                                        votes: x.votes,
                                        top: winnerIds.includes(x.candidate.player_id),
                                        voters: votersFor(x.candidate.player_id).map((v) => ({
                                          id: v.id,
                                          name: v.display_name,
                                          avatarUrl: v.avatar_url,
                                          gradient: avatarFor(v.display_name).gradient,
                                        })),
                                      }))}
                                  />
                                  {replay && (
                                    <div className="wcf-motm-card-tip">
                                      <button className="wcf-mr-again" onClick={replay}>
                                        Watch the reveal again
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )
                            }
                          </MotmReveal>
                        );
                      })()}

                    {(() => {
                      const gamePredictions = scoredPredictionInputs.filter((p) => p.gameId === g.id);
                      if (gamePredictions.length === 0) return null;
                      const myGamePrediction = gamePredictions.find((p) => p.playerId === myId);
                      const exactCount = gamePredictions.filter(
                        (p) => predictionPoints(p.predictedWhite, p.predictedRed, p.actualWhite, p.actualRed) === 3,
                      ).length;
                      return (
                        <div className="wcf-predict-reveal">
                          <div className="wcf-predict-reveal-label">
                            <span className="wcf-predict-reveal-title">
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="9" />
                                <circle cx="12" cy="12" r="5" />
                                <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
                              </svg>
                              Predictions
                            </span>
                            <span className="wcf-predict-reveal-count">
                              {gamePredictions.length} guess{gamePredictions.length === 1 ? "" : "es"}
                            </span>
                          </div>
                          {myGamePrediction &&
                            (() => {
                              const pts = predictionPoints(
                                myGamePrediction.predictedWhite,
                                myGamePrediction.predictedRed,
                                myGamePrediction.actualWhite,
                                myGamePrediction.actualRed,
                              );
                              return (
                                <div className="wcf-predict-reveal-row">
                                  <span className="wcf-predict-reveal-row-label">
                                    Your guess:{" "}
                                    <b>
                                      {cs.team_white_name} {myGamePrediction.predictedWhite}–{myGamePrediction.predictedRed} {cs.team_red_name}
                                    </b>
                                  </span>
                                  <PointsPill pts={pts} storageKey={`wcf-pts-${myId}-${g.id}`} recent={kickoffCutoff(g.date, g.kickoff, 7 * 24 * 60) > nowUk} />
                                </div>
                              );
                            })()}
                          {exactCount > 0 && (
                            <div className="wcf-predict-fact">
                              {exactCount} player{exactCount === 1 ? "" : "s"} called the exact score.
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {isAdmin && (
                      <div className="wcf-result-share">
                        <button className="wcf-result-share-btn" onClick={() => shareResult(g)}>
                          <svg
                            className="wcf-share-icon"
                            viewBox="0 0 24 24"
                            width="15"
                            height="15"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 15V3M7 8l5-5 5 5" />
                            <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
                          </svg>
                          Share result
                        </button>
                        <span className="wcf-result-admin-tag">Admin only</span>
                      </div>
                    )}

                    {(() => {
                      const older = filteredResults[resultIndex + 1];
                      const newer = filteredResults[resultIndex - 1];
                      if (!older && !newer) return null;
                      const goTo = (id: string) => {
                        setExpandedResultId(id);
                        setTimeout(() => document.getElementById("result-" + id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
                      };
                      const day = (x: GameRow) => new Date(x.date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
                      return (
                        <div className="wcf-sc-steps">
                          {older && (
                            <button className="older" onClick={() => goTo(older.id)}>
                              ‹ {day(older)}
                            </button>
                          )}
                          {newer && (
                            <button className="newer" onClick={() => goTo(newer.id)}>
                              {day(newer)} ›
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </article>
            );
          };
          const [first, ...rest] = filteredResults;
          if (!first) return null;
          const months: { ym: string; games: GameRow[] }[] = [];
          for (const g of rest) {
            const ym = g.date.slice(0, 7);
            const last = months[months.length - 1];
            if (last && last.ym === ym) last.games.push(g);
            else months.push({ ym, games: [g] });
          }
          const winner = (g: GameRow) => {
            const w = g.team_white_score ?? 0;
            const r = g.team_red_score ?? 0;
            return w > r ? "white" : r > w ? "red" : "draw";
          };
          return (
            <>
              {renderResult(first, 0)}
              {months.map((m) => {
                const inMonth = filteredResults.filter((g) => g.date.slice(0, 7) === m.ym);
                const ww = inMonth.filter((g) => winner(g) === "white").length;
                const rw = inMonth.filter((g) => winner(g) === "red").length;
                const dd = inMonth.length - ww - rw;
                return (
                  <section
                    key={m.ym}
                    className="wcf-sc-month"
                    style={{
                      backgroundImage: `linear-gradient(180deg,rgba(8,11,20,.25) 0px,rgba(8,11,20,.78) 80px,rgba(14,19,31,.97) 170px),url('${monthPhoto(m.ym)}')`,
                    }}
                  >
                    <div className="wcf-sc-month-h">
                      <h4>
                        {new Date(m.ym + "-01T00:00:00").toLocaleDateString("en-GB", {
                          month: "long",
                          year: m.ym.slice(0, 4) === String(currentSeasonYear) ? undefined : "numeric",
                        })}
                      </h4>
                      <span className="wcf-sc-strip" aria-hidden="true">
                        {[...inMonth].reverse().map((g) => (
                          <i
                            key={g.id}
                            style={{ background: winner(g) === "white" ? cs.team_white_color : winner(g) === "red" ? cs.team_red_color : "#5a6478" }}
                          />
                        ))}
                      </span>
                      <span className="wcf-sc-tally">
                        {cs.team_white_name.charAt(0)} {ww} · {cs.team_red_name.charAt(0)} {rw}
                        {dd > 0 && ` · D ${dd}`}
                      </span>
                    </div>
                    {m.games.map((g, k) => renderResult(g, filteredResults.indexOf(g), k))}
                  </section>
                );
              })}
            </>
          );
          })()}
        </>
      )}

      {view === "pot" &&
        (() => {
          const chronological = [...potLedger].sort((a, b) => a.date.localeCompare(b.date));
          const series = chronological.reduce<number[]>((acc, e) => {
            acc.push((acc[acc.length - 1] ?? 0) + e.amount);
            return acc;
          }, []);
          const hi = Math.max(...series, 1);
          const lo = Math.min(...series, 0);
          const pt = (v: number, i: number) => {
            const x = (i / Math.max(series.length - 1, 1)) * 300;
            const y = 74 - ((v - lo) / Math.max(hi - lo, 1)) * 66;
            return `${Math.round(x)},${Math.round(y)}`;
          };
          const sparkLine = series.map(pt).join(" ");
          const sparkFill = `0,80 ${sparkLine} 300,80`;
          const gameEntries = potLedger.filter((e) => e.kind === "auto");
          const lastGame = gameEntries[0];
          const firstDate = chronological[0]?.date;
          const shortDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
          const spent = (Object.keys(financeSummary.byCategory) as PotCategory[]).filter((c) => c !== "pitch" && financeSummary.byCategory[c] > 0);
          const money = (n: number) => `${n < 0 ? "−" : ""}£${Math.abs(n) % 1 === 0 ? Math.abs(n).toFixed(0) : Math.abs(n).toFixed(2)}`;

          return (
            <>
              {/* Everyone sees the pot grow game by game; the amounts are
                      the club's (fees in minus pitch hire), never anyone's
                      own payment. */}
              <div className="wcf-pot-hero">
                <div className="wcf-pot-hero-k">Community pot</div>
                <PotAmountJar
                  total={potTotal}
                  money={money}
                  last={lastGame ? { id: lastGame.id, amount: lastGame.amount, paid: (lastGame as { paid?: number }).paid } : undefined}
                  storageKey={`wcf-pot-seen-${myId}`}
                />
                {lastGame && (
                  <div className="wcf-pot-hero-sub">
                    <b>
                      {lastGame.amount >= 0 ? "+" : ""}
                      {money(lastGame.amount)}
                    </b>{" "}
                    from {fmtDate(lastGame.date)} · <b>{gameEntries.length}</b> {gameEntries.length === 1 ? "game" : "games"}
                    {firstDate ? ` since ${shortDate(firstDate)}` : ""}
                  </div>
                )}
                {series.length > 1 && (
                  <>
                    <svg viewBox="0 0 300 80" preserveAspectRatio="none" className="wcf-pot-hero-spark" aria-hidden="true">
                      <polygon points={sparkFill} fill="rgba(34,197,94,.16)" />
                      <polyline
                        points={sparkLine}
                        fill="none"
                        stroke="#22c55e"
                        strokeWidth={2.2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                    <div className="wcf-pot-hero-axis">
                      <span>{shortDate(chronological[0].date)}</span>
                      <span>{shortDate(chronological[chronological.length - 1].date)}</span>
                    </div>
                  </>
                )}
              </div>

              {!isAdmin && (
                <>
                  <div className="wcf-pot-card">
                    <div className="wcf-pot-card-h">So far</div>
                    <div className="wcf-pot-split">
                      <span>
                        <b>{money(financeSummary.income)}</b>
                        {potEntries.some((e) => e.amount > 0) ? "Money in" : "Match fees"}
                      </span>
                      <span>
                        <b className="out">{money(-financeSummary.expenses)}</b>
                        {spent.length > 0 ? "Money out" : "Pitch hire"}
                      </span>
                      <span>
                        <b className="in">{money(potTotal)}</b>In the pot
                      </span>
                    </div>
                  </div>
                  {gameEntries.length > 0 && (
                    <div className="wcf-pot-card">
                      <div className="wcf-pot-card-h">
                        Latest games
                        <span>avg {money(gameEntries.reduce((sum, e) => sum + e.amount, 0) / gameEntries.length)}</span>
                      </div>
                      {gameEntries.slice(0, 3).map((e) => (
                        <div key={e.id} className="wcf-pot-led">
                          <div>
                            {fmtDate(e.date)}
                            <div className="wcf-pot-led-sub">{e.paid} paid</div>
                          </div>
                          <span className={e.amount < 0 ? "out" : ""}>
                            {e.amount >= 0 ? "+" : ""}
                            {money(e.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="wcf-pot-card">
                    <div className="wcf-pot-card-h">Where it&apos;s gone</div>
                    {spent.length === 0 ? (
                      <p className="wcf-pot-empty">
                        Nothing spent yet. The pot goes towards equipment, socials and running the club, and anything spent will show here.
                      </p>
                    ) : (
                      potEntries
                        .filter((e) => e.amount < 0)
                        .slice(0, 5)
                        .map((e) => (
                          <div key={e.id} className="wcf-pot-led">
                            <div>
                              {e.description}
                              <div className="wcf-pot-led-sub">
                                {POT_CATEGORY_LABEL[e.category]} · {fmtDate(e.created_at.slice(0, 10))}
                              </div>
                            </div>
                            <span className="out">{money(e.amount)}</span>
                          </div>
                        ))
                    )}
                  </div>
                </>
              )}

              {isAdmin && (
                <>
                  <div className="wcf-fin-stats">
                    <div className="wcf-fin-tile">
                      <div className="wcf-fin-tile-label">Income</div>
                      <div className="wcf-fin-tile-value green">£{financeSummary.income.toFixed(2)}</div>
                    </div>
                    <div className="wcf-fin-tile">
                      <div className="wcf-fin-tile-label">Expenses</div>
                      <div className="wcf-fin-tile-value red">£{financeSummary.expenses.toFixed(2)}</div>
                    </div>
                    <div className="wcf-fin-tile">
                      <div className="wcf-fin-tile-label">Net</div>
                      <div className={"wcf-fin-tile-value " + (potTotal < 0 ? "red" : "green")}>
                        {potTotal < 0 ? "−" : ""}£{Math.abs(potTotal).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {monzoUnmatched.length > 0 && (
                    <div className="wcf-fin-card">
                      <div className="wcf-fin-card-head">Unmatched Monzo payments</div>
                      <p className="wcf-empty small" style={{ marginBottom: 10 }}>
                        Came in but couldn&apos;t be confirmed automatically — check and mark manually.
                      </p>
                      {monzoUnmatched.map((m) => (
                        <div key={m.id} className="wcf-fin-fx-row">
                          <div>
                            <div className="wcf-fin-fx-desc">{m.player?.display_name ?? (m.code ? `Code ${m.code}` : "No reference")}</div>
                            <div className="wcf-pitch">
                              {fmtDateTime(m.created_at)} · {m.reason}
                            </div>
                          </div>
                          <span className="wcf-fin-fx-net red">£{(m.amount_pence / 100).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="wcf-fin-card">
                    <div className="wcf-fin-card-head">By fixture</div>
                    {financeSummary.byFixture.length === 0 && <p className="wcf-empty small">No fixtures with confirmed payments yet.</p>}
                    {financeSummary.byFixture.map((e) => (
                      <div key={e.id} className="wcf-fin-fx-row">
                        <div>
                          <div className="wcf-fin-fx-desc">{e.description.split(" — ")[0]}</div>
                          <div className="wcf-pitch">{fmtDate(e.date)}</div>
                        </div>
                        <span className={"wcf-fin-fx-net " + (e.amount < 0 ? "red" : "green")}>
                          {e.amount < 0 ? "−" : "+"}£{Math.abs(e.amount).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="wcf-fin-card">
                    <div className="wcf-fin-card-head">Where it's gone</div>
                    {(() => {
                      const totalSpend = Object.values(financeSummary.byCategory).reduce((s, v) => s + v, 0);
                      const cats = (Object.keys(financeSummary.byCategory) as PotCategory[]).filter((c) => financeSummary.byCategory[c] > 0);
                      if (cats.length === 0) return <p className="wcf-empty small">Nothing spent yet.</p>;
                      return cats
                        .sort((a, b) => financeSummary.byCategory[b] - financeSummary.byCategory[a])
                        .map((c) => {
                          const amt = financeSummary.byCategory[c];
                          const pct = totalSpend > 0 ? (amt / totalSpend) * 100 : 0;
                          return (
                            <div key={c} className="wcf-fin-cat-row">
                              <div className="wcf-fin-cat-top">
                                <span>{POT_CATEGORY_LABEL[c]}</span>
                                <span>
                                  £{amt.toFixed(2)} · {pct.toFixed(0)}%
                                </span>
                              </div>
                              <div className="wcf-fin-cat-track">
                                <div className="wcf-fin-cat-fill" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          );
                        });
                    })()}
                  </div>

                  <form
                    className="wcf-pot-add"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const magnitude = Math.abs(Number(potAmount));
                      if (!magnitude || !potDescription.trim()) return;
                      const amount = potEntryKind === "deduct" ? -magnitude : magnitude;
                      setAddingPotEntry(true);
                      await addPotEntry(amount, potDescription.trim(), potCategory);
                      setAddingPotEntry(false);
                      setPotAmount("");
                      setPotDescription("");
                      setPotEntryKind("add");
                      setPotCategory("other");
                    }}
                  >
                    <div className="wcf-pot-kind-toggle">
                      <button type="button" className={potEntryKind === "add" ? "active" : ""} onClick={() => setPotEntryKind("add")}>
                        + Add money
                      </button>
                      <button type="button" className={potEntryKind === "deduct" ? "active deduct" : ""} onClick={() => setPotEntryKind("deduct")}>
                        − Deduct money
                      </button>
                    </div>
                    <select value={potCategory} onChange={(e) => setPotCategory(e.target.value as PotCategory)}>
                      {(Object.keys(POT_CATEGORY_LABEL) as PotCategory[]).map((c) => (
                        <option key={c} value={c}>
                          {POT_CATEGORY_LABEL[c]}
                        </option>
                      ))}
                    </select>
                    <input type="number" step="0.01" min="0" placeholder="Amount, e.g. 20" value={potAmount} onChange={(e) => setPotAmount(e.target.value)} />
                    <input placeholder="e.g. Summer BBQ, new bibs, sponsorship" value={potDescription} onChange={(e) => setPotDescription(e.target.value)} />
                    <button
                      type="submit"
                      className={potEntryKind === "deduct" ? "wcf-pot-submit deduct" : "wcf-pot-submit"}
                      disabled={addingPotEntry || !potAmount || !potDescription.trim()}
                    >
                      {addingPotEntry ? "Saving…" : potEntryKind === "deduct" ? "Deduct from pot" : "Add to pot"}
                    </button>
                  </form>

                  <div className="wcf-pot-ledger-head">
                    <span>Ledger</span>
                    <span>{potLedger.length} entries</span>
                  </div>
                  {potLedger.length === 0 && <p className="wcf-empty">Nothing in the ledger yet.</p>}
                  {potLedger.map((entry) => (
                    <div key={entry.id} className="wcf-pot-row">
                      <span className={"wcf-pot-row-icon " + (entry.amount < 0 ? "neg" : "pos")}>{entry.amount < 0 ? "−" : "+"}</span>
                      <div>
                        <div className="wcf-pot-row-desc">{entry.description}</div>
                        <div className="wcf-pitch">
                          {fmtDate(entry.date)}
                          {entry.kind === "auto" ? " · auto" : ""}
                          <span className="wcf-pot-cat-tag">{POT_CATEGORY_LABEL[entry.category]}</span>
                        </div>
                      </div>
                      <span className={"wcf-pot-row-amount " + (entry.amount < 0 ? "neg" : "pos")}>
                        {entry.amount < 0 ? "−" : "+"}£{Math.abs(entry.amount).toFixed(2)}
                      </span>
                      {entry.kind === "manual" && (
                        <button
                          className="wcf-admin-remove"
                          onClick={async () => {
                            if (await askConfirm("Remove this pot entry?", "This deletes it from the ledger for good.", "Remove")) deletePotEntry(entry.id);
                          }}
                          aria-label="Remove entry"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  {potLedger.length > 0 && <p className="wcf-pot-auto-note">Match surpluses are added automatically once each fixture has been played.</p>}

                  <button className="wcf-ghost wcf-fin-export" onClick={exportFinanceCsv}>
                    ⬇ Export season as CSV
                  </button>
                </>
              )}
            </>
          );
        })()}
    </>
  );
}

// The season's headline numbers. If they've moved since this phone last
// saw them (a new result), it plays like the stadium board: "Since you
// last looked", a sweep of light across the photo, each changed number
// rolling up digit by digit, and a gold "+10" on it.
type SeasonStat = { k: string; v: number; label: string; decimals?: number };
function SeasonStats({ year, stats }: { year: number; stats: SeasonStat[] }) {
  const key = `wcf-season-seen-${year}`;
  const [before] = useState<Record<string, number> | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  });
  const run = !!before && motionAllowed() && stats.some((s) => before[s.k] !== undefined && before[s.k] !== s.v);
  const sig = stats.map((s) => `${s.k}:${s.v}`).join(",");
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(Object.fromEntries(sig.split(",").map((p) => [p.split(":")[0], Number(p.split(":")[1])]))));
    } catch {}
  }, [key, sig]);
  return (
    <>
      {run && <span className="wcf-season-gleam" aria-hidden="true" />}
      {run && <div className="wcf-season-since">Since you last looked</div>}
      <div className={"wcf-season-hero-stats" + (run ? " run" : "")}>
        {stats.map((s, i) => {
          const from = before?.[s.k];
          const moved = run && from !== undefined && from !== s.v;
          const diff = moved ? s.v - from! : 0;
          const d = s.decimals ?? 0;
          return (
            <span key={s.k} className={moved ? "moved" : undefined} style={{ ["--d" as string]: `${500 + i * 180}ms` }}>
              <b>{moved ? <Odometer from={from!.toFixed(d)} to={s.v.toFixed(d)} delay={500 + i * 180} /> : s.v.toFixed(d)}</b>
              <em>
                {s.label}
                {moved && diff > 0 && s.k !== "pergame" && <i className="wcf-season-plus">+{diff}</i>}
              </em>
            </span>
          );
        })}
      </div>
    </>
  );
}
// Each digit is a strip of 0-9 that rolls from the old digit to the new
// one (once round if it has to pass 9), rightmost digit first.
function Odometer({ from, to, delay }: { from: string; to: string; delay: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGo(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  const pad = from.padStart(to.length, " ");
  return (
    <span className="wcf-sodo" aria-label={to}>
      {[...to].map((ch, i) => {
        if (!/\d/.test(ch)) return <span key={i} className="wcf-sodo-ch">{ch}</span>;
        const old = /\d/.test(pad[i]) ? Number(pad[i]) : 0;
        const neu = Number(ch);
        const end = neu >= old ? neu : neu + 10;
        const pos = go ? end : old;
        return (
          <span key={i} className="wcf-sodo-col" aria-hidden="true">
            <span
              className="wcf-sodo-strip"
              style={{ transform: `translateY(-${pos * 5}%)`, transitionDelay: `${(to.length - 1 - i) * 90}ms`, opacity: pad[i] === " " && !go ? 0 : 1 }}
            >
              {Array.from({ length: 20 }, (_, n) => (
                <span key={n}>{n % 10}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
