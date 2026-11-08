"use client";

import { useMemo, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { fmtAwardDate, type AwardCategory, type AwardNomination, type AwardSeason, type AwardVote } from "../../lib/awards";
import { Avatar } from "./shared";
import { awardsCss } from "./awards";
import type { SeasonGame, SeasonPlayer } from "./awardsadmin";

// The player's side of the season awards: the ballot (an invitation, one
// award per screen, a paper ballot to check, then the wax seal) and the
// "suggest a nominee" sheet while nominations are open. Both open from the
// For you card on Fixtures.

const shortDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function AwardsBallot({
  season,
  categories,
  nominations,
  myVotes,
  players,
  games,
  myId,
  onClose,
  onSaved,
  notifyError,
}: {
  season: AwardSeason;
  categories: AwardCategory[];
  nominations: AwardNomination[];
  myVotes: AwardVote[];
  players: SeasonPlayer[];
  games: SeasonGame[];
  myId: string;
  onClose: () => void;
  onSaved: () => void;
  notifyError: (m: string) => void;
}) {
  const voted = categories.filter((c) => c.kind !== "auto");
  const [step, setStep] = useState(myVotes.length ? voted.length : -1); // -1 intro, 0..n-1 awards, n review, n+1 sealed
  const [picks, setPicks] = useState<Record<string, string | null>>(() => Object.fromEntries(voted.map((c) => [c.id, myVotes.find((v) => v.category_id === c.id)?.player_id ?? myVotes.find((v) => v.category_id === c.id)?.nomination_id ?? null])));
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const candidates = useMemo(() => players.filter((p) => p.id !== myId && p.apps >= 1).sort((a, b) => b.apps - a.apps || a.name.localeCompare(b.name)), [players, myId]);
  const firstCount = useMemo(() => {
    const m = new Map<string, number>();
    players.forEach((p) => m.set(p.name.split(" ")[0], (m.get(p.name.split(" ")[0]) ?? 0) + 1));
    return m;
  }, [players]);
  const short = (n: string) => {
    const [f, s] = n.split(" ");
    return (firstCount.get(f) ?? 0) > 1 && s ? `${f} ${s[0].toUpperCase()}` : f;
  };
  const gameById = new Map(games.map((g) => [g.id, g]));
  const byId = new Map(players.map((p) => [p.id, p]));
  const shortlist = (cid: string) => nominations.filter((n) => n.category_id === cid && n.status === "shortlisted" && n.player_id !== myId);
  const pickLabel = (c: AwardCategory) => {
    const v = picks[c.id];
    if (!v) return null;
    return c.kind === "player" ? byId.get(v)?.name ?? "Player" : nominations.find((n) => n.id === v)?.title ?? "";
  };
  const n = voted.length;
  const cur = step >= 0 && step < n ? voted[step] : null;

  async function seal() {
    setSaving(true);
    for (const c of voted) {
      const v = picks[c.id];
      const had = myVotes.find((x) => x.category_id === c.id);
      const res = v
        ? await supabase
            .from("award_votes")
            .upsert({ category_id: c.id, voter_id: myId, player_id: c.kind === "player" ? v : null, nomination_id: c.kind === "player" ? null : v }, { onConflict: "category_id,voter_id" })
        : had
          ? await supabase.from("award_votes").delete().eq("category_id", c.id).eq("voter_id", myId)
          : { error: null };
      if (res.error) {
        setSaving(false);
        return notifyError(res.error.message);
      }
    }
    setSaving(false);
    setStep(n + 1);
    onSaved();
  }

  return (
    <div className="aw-bal" role="dialog" aria-label={`${season.title} awards ballot`}>
      <style>{awardsCss}</style>
      <div className="top">
        <button className="x" onClick={step === n && n > 0 ? () => setStep(n - 1) : onClose} aria-label={step === n ? "Back" : "Close"}>
          {step === n ? "‹" : "✕"}
        </button>
        {cur && (
          <>
            <span className="prog">
              {voted.map((c, i) => (
                <i key={c.id} className={i <= step ? "on" : undefined} />
              ))}
            </span>
            <small>
              {step + 1} of {n}
            </small>
          </>
        )}
      </div>

      {step === -1 && (
        <>
          <div className="body">
            <div className="intro">
              <img src="/crest.png" alt="" />
              <div className="ey">You&apos;re invited to vote</div>
              <h2 className="foil" style={{ fontSize: 38 }}>
                {season.title.toUpperCase()} AWARDS
              </h2>
              <p className="sub" style={{ maxWidth: "30ch" }}>
                {n} award{n === 1 ? "" : "s"}. Pick one for each, or skip any you&apos;re not sure about.
              </p>
              <div className="list">
                {voted.map((c) => (
                  <span key={c.id}>
                    {c.name}
                    <em>{c.kind === "player" ? "any player" : `${shortlist(c.id).length} nominees`}</em>
                  </span>
                ))}
              </div>
              <div className="facts">
                <i>Secret ballot</i>
                <i>Change until {fmtAwardDate(season.closes_at, false)}</i>
                <i>Revealed {fmtAwardDate(season.reveal_at)}</i>
              </div>
            </div>
          </div>
          <div className="foot one">
            <button className="btn" onClick={() => setStep(0)}>
              Start
            </button>
          </div>
        </>
      )}

      {cur && (
        <>
          <div className="body">
            <div className="ey">{cur.name}</div>
            <h2>{cur.description || cur.name}</h2>
            {cur.kind === "player" ? (
              <>
                <p className="sub">Pick anyone who&apos;s played this season. You&apos;re not on the list.</p>
                <input className="search" placeholder={`Search ${candidates.length} players`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search players" />
                <div className="grid">
                  {candidates
                    .filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
                    .map((p) => (
                      <button key={p.id} className={"pf" + (picks[cur.id] === p.id ? " on" : "")} onClick={() => setPicks((x) => ({ ...x, [cur.id]: x[cur.id] === p.id ? null : p.id }))}>
                        <Avatar name={p.name} avatarUrl={p.avatar} className="aw-face" />
                        <span className="n">{short(p.name)}</span>
                        <small>
                          {p.apps} game{p.apps === 1 ? "" : "s"}
                        </small>
                      </button>
                    ))}
                </div>
              </>
            ) : (
              <>
                <p className="sub">Shortlisted by the admins.</p>
                <div className="noms">
                  {shortlist(cur.id).map((nm) => {
                    const g = nm.game_id ? gameById.get(nm.game_id) : null;
                    const pl = nm.player_id ? byId.get(nm.player_id) : null;
                    return (
                      <button key={nm.id} className={"nm" + (picks[cur.id] === nm.id ? " on" : "")} onClick={() => setPicks((x) => ({ ...x, [cur.id]: x[cur.id] === nm.id ? null : nm.id }))}>
                        {pl ? <Avatar name={pl.name} avatarUrl={pl.avatar} className="aw-face" /> : <span className="aw-big">{nm.title.trim()[0]?.toUpperCase()}</span>}
                        <span>
                          <b>{nm.title}</b>
                          <small>{[g ? shortDate(g.date) : "", nm.detail].filter(Boolean).join(" · ")}</small>
                        </span>
                        <span className="tick" />
                      </button>
                    );
                  })}
                  {shortlist(cur.id).length === 0 && <p className="sub">Nothing to pick here yet.</p>}
                </div>
              </>
            )}
          </div>
          <div className="foot">
            <button
              className="btn ghost"
              onClick={() => {
                setPicks((x) => ({ ...x, [cur.id]: null }));
                setQ("");
                setStep(step + 1);
              }}
            >
              Skip
            </button>
            <button
              className="btn"
              disabled={!picks[cur.id]}
              onClick={() => {
                setQ("");
                setStep(step + 1);
              }}
            >
              {step === n - 1 ? "Check my ballot ›" : "Next ›"}
            </button>
          </div>
        </>
      )}

      {step === n && (
        <>
          <div className="body">
            <div className="aw-paper">
              <h3>{season.title.toUpperCase()} AWARDS</h3>
              <div className="s">OFFICIAL BALLOT · SECRET</div>
              {voted.map((c, i) => (
                <div key={c.id} className="r">
                  <small>{c.name}</small>
                  <b>{pickLabel(c) ?? "— skipped —"}</b>
                  <button onClick={() => setStep(i)}>{picks[c.id] ? "Change" : "Vote"}</button>
                </div>
              ))}
            </div>
          </div>
          <div className="foot one">
            <button className="btn" disabled={saving || !voted.some((c) => picks[c.id])} onClick={seal}>
              {saving ? "Sealing…" : "Seal and cast my votes"}
            </button>
          </div>
        </>
      )}

      {step === n + 1 && (
        <>
          <div className="body">
            <div className="aw-paper" style={{ transform: "rotate(-3deg) scale(.9)" }}>
              <h3>{season.title.toUpperCase()} AWARDS</h3>
              <div className="s">OFFICIAL BALLOT · SECRET</div>
              {voted
                .filter((c) => picks[c.id])
                .map((c) => (
                  <div key={c.id} className="r">
                    <small>{c.name}</small>
                    <b>{pickLabel(c)}</b>
                  </div>
                ))}
              <div className="aw-wax">
                BALLOT
                <br />
                CAST
              </div>
            </div>
            <div className="aw-done">
              <h2 style={{ fontSize: 28 }}>Your votes are in</h2>
              <p className="sub" style={{ maxWidth: "30ch" }}>
                Nobody can see who you picked. You can change your votes until {fmtAwardDate(season.closes_at)}.
              </p>
              <p className="sub" style={{ color: "#f5d97a", fontWeight: 700 }}>
                Awards Night · {fmtAwardDate(season.reveal_at)}
              </p>
            </div>
          </div>
          <div className="foot one">
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function SuggestSheet({
  season,
  categories,
  players,
  games,
  myId,
  onClose,
  onSent,
  notifyError,
}: {
  season: AwardSeason;
  categories: AwardCategory[];
  players: SeasonPlayer[];
  games: SeasonGame[];
  myId: string;
  onClose: () => void;
  onSent: () => void;
  notifyError: (m: string) => void;
}) {
  const open = categories.filter((c) => c.kind === "shortlist" && c.allow_suggestions);
  const [cid, setCid] = useState(open[0]?.id ?? "");
  const [who, setWho] = useState<string | null>(null);
  const [game, setGame] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const c = open.find((x) => x.id === cid);
  const shown = players.filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 24);
  async function send() {
    setBusy(true);
    const { error } = await supabase.from("award_nominations").insert({ category_id: cid, player_id: who, game_id: game, title: title.trim(), detail: detail.trim() || null, status: "suggested", suggested_by: myId });
    setBusy(false);
    if (error) return notifyError(error.message);
    onSent();
  }
  return (
    <>
      <style>{awardsCss}</style>
      <div className="aw-dim" onClick={onClose} />
      <section className="aw-sheet" role="dialog" aria-label="Suggest a nominee">
        <div className="bar" />
        <small className="ey">{season.title} awards</small>
        <h3>Suggest a nominee{c ? ` for ${c.name}` : ""}</h3>
        <p className="aw-note">The admins pick the shortlist. If they add yours, it goes on the ballot on {fmtAwardDate(season.opens_at, false)}.</p>
        {open.length > 1 && (
          <div className="aw-seg">
            {open.map((x) => (
              <button key={x.id} className={x.id === cid ? "on" : ""} onClick={() => setCid(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
        )}
        <div className="aw-f">
          <label htmlFor="aw-sq">Who (optional)</label>
          <input id="aw-sq" className="aw-in" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="aw-pick">
            {shown.map((x) => (
              <button key={x.id} className={who === x.id ? "on" : ""} onClick={() => setWho(who === x.id ? null : x.id)}>
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
                <button key={g.id} className={"aw-game" + (game === g.id ? " on" : "")} onClick={() => setGame(game === g.id ? null : g.id)}>
                  {shortDate(g.date)}
                  <em>
                    {g.white}–{g.red}
                  </em>
                </button>
              ))}
          </div>
        </div>
        <div className="aw-f">
          <label htmlFor="aw-st">What was it?</label>
          <input id="aw-st" className="aw-in" value={title} maxLength={120} placeholder="e.g. Michael's free kick into the top bin" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="aw-f">
          <label htmlFor="aw-sd">Anything else (optional)</label>
          <textarea id="aw-sd" className="aw-in" value={detail} maxLength={400} onChange={(e) => setDetail(e.target.value)} />
        </div>
        <button className="aw-btn full" disabled={busy || !cid || !title.trim()} onClick={send}>
          {busy ? "Sending…" : "Send to the admins"}
        </button>
        <div style={{ height: 8 }} />
        <button className="aw-btn ghost full" onClick={onClose}>
          Cancel
        </button>
      </section>
    </>
  );
}
