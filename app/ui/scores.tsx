import { useRef, useState } from "react";
import { Avatar } from "./shared";

// ── Results › Scores face-lift ──
// The ledger rows, the scoresheet (one ball per goal) and the Man of the
// Match poll folded behind "See who voted". The data still comes from
// ResultsTab; these only draw it.

// Behind each month's card, cycling through the app's own night photos.
const MONTH_PHOTOS = ["/floodlight-haze.jpg", "/pitch-night.jpg", "/pitch-floodlit.jpg", "/net-rain.jpg"];
export const monthPhoto = (ym: string) => MONTH_PHOTOS[(Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7))) % MONTH_PHOTOS.length];

export function GoalBalls({ n, start = 0, children }: { n: number; start?: number; children?: React.ReactNode }) {
  return (
    <span className="wcf-sc-balls" aria-label={`${n} ${n === 1 ? "goal" : "goals"}`}>
      {Array.from({ length: n }, (_, i) => (
        <svg key={i} viewBox="0 0 24 24" style={{ ["--i" as string]: start + i }} aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#f4f6fa" />
          <path d="M12 7.2l4.2 3-1.6 5h-5.2l-1.6-5z" fill="#1a2030" />
          <path d="M12 1v6.2M16.2 10.2l6-2M14.6 15.2l3.6 5.2M9.4 15.2l-3.6 5.2M7.8 10.2l-6-2" stroke="#1a2030" strokeWidth="1.2" />
        </svg>
      ))}
      {children}
    </span>
  );
}

type Face = { id: string; name: string; avatarUrl?: string | null; gradient: string };
export type PollRow = Face & { votes: number; top: boolean; voters: Face[] };

const Chev = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// Who voted who: closed to a single "See who voted" strip under the Man of
// the Match card; open, every player with a vote, a bar, and (tap a row)
// the names of who voted for them. The winner's voters show straight away.
export function MotmPoll({ rows, total }: { rows: PollRow[]; total: number }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Set<string>>(() => new Set(rows.filter((r) => r.top).map((r) => r.id)));
  const ref = useRef<HTMLDivElement>(null);
  const maxVotes = Math.max(1, ...rows.map((r) => r.votes));
  const peek = rows.flatMap((r) => r.voters).slice(0, 4);
  const toggle = (id: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div ref={ref} className={"wcf-poll" + (open ? " open" : "")}>
      <button
        className="wcf-poll-see"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) setTimeout(() => ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 400);
        }}
      >
        <span>{open ? "Hide the vote" : "See who voted"}</span>
        <span className="wcf-poll-peek">
          <span className="wcf-poll-stack">
            {peek.map((v) => (
              <Avatar key={v.id} name={v.name} avatarUrl={v.avatarUrl} className="wcf-poll-av" background={v.gradient} />
            ))}
          </span>
          {total} {total === 1 ? "vote" : "votes"}
          <Chev className="wcf-poll-ar" />
        </span>
      </button>
      <div className="wcf-poll-wrap">
        <div>
          <div className="wcf-poll-tip">Tap a name to see who voted for them</div>
          {rows.map((r, i) => {
            const on = shown.has(r.id);
            return (
              <div key={r.id}>
                <button
                  className={"wcf-poll-row" + (r.top ? " top" : "") + (on ? " on" : "")}
                  style={{ ["--i" as string]: i, ["--w" as string]: `${Math.max(6, (100 * r.votes) / maxVotes)}%` }}
                  onClick={() => toggle(r.id)}
                  aria-expanded={on}
                  aria-label={`${r.name}, ${r.votes} ${r.votes === 1 ? "vote" : "votes"}. See who voted for them`}
                >
                  <Avatar name={r.name} avatarUrl={r.avatarUrl} className="wcf-poll-face" background={r.gradient} />
                  <span className="wcf-poll-mid">
                    <span className="wcf-poll-name">{r.name}</span>
                    <span className="wcf-poll-bar">
                      <i />
                    </span>
                  </span>
                  <span className="wcf-poll-stack">
                    {r.voters.slice(0, 3).map((v) => (
                      <Avatar key={v.id} name={v.name} avatarUrl={v.avatarUrl} className="wcf-poll-av" background={v.gradient} />
                    ))}
                    {r.voters.length > 3 && <span className="wcf-poll-av more">+{r.voters.length - 3}</span>}
                  </span>
                  <span className="wcf-poll-n">{r.votes}</span>
                  <Chev className="wcf-poll-rc" />
                </button>
                <div className={"wcf-poll-voters" + (on ? " on" : "")}>
                  <div>
                    <div className="wcf-poll-chips">
                      {r.voters.map((v) => (
                        <span key={v.id}>
                          <Avatar name={v.name} avatarUrl={v.avatarUrl} className="wcf-poll-av" background={v.gradient} />
                          {v.name.split(" ")[0]}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const scoresCss = `
.wcf-result.wcf-sc-heroart{padding:0;overflow:hidden;margin-bottom:14px}
.wcf-sc-heroart .wcf-result-detail{padding:0 14px 14px}
.wcf-sc-hero{padding:16px 16px 14px}
.wcf-sc-score{color:#fff}
.wcf-sc-hero-k{font-size:10px;font-weight:800;letter-spacing:.2em;color:#f5d97a;text-transform:uppercase}
.wcf-sc-hero-score{display:flex;align-items:center;gap:14px;margin-top:10px;font-family:var(--display)}
.wcf-sc-hero-side{display:flex;flex-direction:column;align-items:center;gap:3px;font-family:var(--sans);font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#cbd5e1}
.wcf-sc-hero-side b{font-family:var(--display);font-size:44px;line-height:1;font-weight:800;letter-spacing:0;font-variant-numeric:tabular-nums}
.wcf-sc-hero-dash{font-size:26px;color:#64748b;margin-top:14px}
.wcf-sc-hero-score .wcf-res-pill{margin-left:auto;align-self:center}
.wcf-sc-hero-mo{display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);font-size:13px;color:#e2e8f0;min-width:0}
.wcf-sc-hero-mo>div{min-width:0}
.wcf-sc-hero-mo small{display:block;font-size:11px;color:#94a3b8}
.wcf-sc-hero-mo b{color:#f5d97a}
.wcf-sc-face38{width:38px;height:38px;flex:none;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:15px;color:#fff;border:2px solid #f5d97a;box-shadow:0 0 14px rgba(245,217,122,.35)}
.wcf-sc-open{color:var(--green)!important}

.wcf-sc-month{margin:0 0 14px;border-radius:18px;overflow:hidden;border:1px solid var(--line);background-color:var(--panel);background-repeat:no-repeat;background-size:100% 100%,100% auto;background-position:0 0,50% 30%;animation:wcfScRise .5s cubic-bezier(.2,.9,.3,1.1) backwards}
.wcf-sc-month-h{display:flex;align-items:center;gap:10px;padding:50px 14px 10px;text-shadow:0 1px 8px rgba(0,0,0,.7)}
.wcf-sc-month-h h4{margin:0;font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#fff}
.wcf-sc-strip{display:flex;gap:3px}
.wcf-sc-strip i{width:6px;height:6px;border-radius:2px;display:block}
.wcf-sc-tally{margin-left:auto;font-size:10.5px;color:#cbd5e1;white-space:nowrap;font-variant-numeric:tabular-nums}
.wcf-sc-item{position:relative;border-top:1px solid var(--line)}
.wcf-sc-item.open{background:rgba(6,9,16,.55)}
.wcf-sc-row{display:grid;grid-template-columns:38px auto minmax(0,1fr) 14px;gap:10px;align-items:center;padding:11px 12px 11px 0;position:relative;animation:wcfScRise .45s cubic-bezier(.2,.9,.3,1.1) backwards;animation-delay:calc(var(--i,0) * 45ms)}
.wcf-sc-row::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--edge)}
.wcf-sc-date{text-align:center;font-family:var(--display);font-weight:800;font-size:16px;line-height:1;color:#fff;padding-left:4px}
.wcf-sc-date span{display:block;font-family:var(--sans);font-size:9px;letter-spacing:.14em;color:var(--dim);margin-top:3px}
.wcf-sc-score{font-family:var(--display);font-weight:800;font-size:19px;white-space:nowrap;font-variant-numeric:tabular-nums;min-width:58px}
.wcf-sc-score .lose,.wcf-sc-score i{color:#64748b;font-style:normal}
.wcf-sc-who{min-width:0;display:flex;align-items:center;gap:8px}
.wcf-sc-who>div{min-width:0}
.wcf-sc-who b{display:block;font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-sc-who small{display:block;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-sc-face26{width:26px;height:26px;flex:none;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:11px;color:#fff;border:1.5px solid #f5d97a}
.wcf-sc-dbl{font-size:9px;font-weight:800;letter-spacing:.1em;color:#f5d97a;border:1px solid rgba(245,217,122,.4);border-radius:5px;padding:1px 4px;margin-left:5px;vertical-align:2px}
.wcf-sc-item .wcf-res-chev{width:14px;height:14px}
.wcf-sc-item .wcf-result-detail{padding:0 12px 14px}
@keyframes wcfScRise{from{opacity:0;transform:translateY(12px)}}

.wcf-sc-board{margin-top:4px;border-radius:18px;border:1px solid var(--line);padding:18px 14px 14px;background:linear-gradient(180deg,rgba(8,11,20,.3) 0%,rgba(8,11,20,.62) 45%,rgba(8,11,20,.93) 100%),url('/pitch-floodlit.jpg') 50% 35%/cover}
.wcf-sc-board-meta{text-align:center;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#cbd5e1;font-weight:700;text-shadow:0 2px 10px rgba(0,0,0,.8)}
.wcf-sc-board-big{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;margin-top:8px}
.wcf-sc-board-tm{text-align:center;font-size:10.5px;letter-spacing:.18em;font-weight:800;text-transform:uppercase;color:#cbd5e1;text-shadow:0 2px 10px rgba(0,0,0,.8)}
.wcf-sc-board-tm b{display:block;font-family:var(--display);font-size:50px;line-height:1;color:#fff;letter-spacing:0;margin-bottom:4px;font-variant-numeric:tabular-nums}
.wcf-sc-board-tm.win b{color:#f5d97a;text-shadow:0 0 22px rgba(245,217,122,.4)}
.wcf-sc-board-ft{font-size:11px;font-weight:800;letter-spacing:.14em;color:#94a3b8}
.wcf-sc-share{display:flex;height:6px;border-radius:6px;overflow:hidden;margin:12px 4px 0;background:var(--red-team,#e63946)}
.wcf-sc-share i{display:block;height:100%;width:var(--w);animation:wcfScShare 1.2s cubic-bezier(.2,.9,.3,1) .2s backwards}
@keyframes wcfScShare{from{width:50%}}

.wcf-sc-halves{display:grid;grid-template-columns:1fr 1fr;margin-top:12px;border-radius:16px;border:1px solid var(--line);overflow:hidden;background:linear-gradient(180deg,rgba(12,16,28,.82),rgba(12,16,28,.94)),url('/pitch-night.jpg') center/cover}
.wcf-sc-half{padding:12px 10px;min-width:0;display:flex;flex-direction:column;gap:10px}
.wcf-sc-half+.wcf-sc-half{border-left:1px solid var(--line)}
.wcf-sc-half h5{margin:0;display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#cbd5e1}
.wcf-sc-half h5 i{width:8px;height:8px;border-radius:50%;display:block}
.wcf-sc-scorer{display:flex;gap:8px;align-items:center;min-width:0;background:none;border:0;padding:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
.wcf-sc-scorer>span:last-child{min-width:0}
.wcf-sc-face32{width:32px;height:32px;flex:none;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:13px;color:#fff}
.wcf-sc-scorer-nm{display:block;font-size:12px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-sc-balls{display:flex;flex-wrap:wrap;gap:2px;margin-top:3px;align-items:center}
.wcf-sc-balls svg{width:12px;height:12px;animation:wcfScBall .45s cubic-bezier(.3,1.7,.5,1) backwards;animation-delay:calc(450ms + var(--i) * 110ms)}
@keyframes wcfScBall{from{opacity:0;transform:scale(.2) translateY(-12px)}}
.wcf-sc-ht{white-space:nowrap;font-size:8.5px;font-weight:800;letter-spacing:.1em;color:#1a1404;background:#f5d97a;border-radius:4px;padding:1px 4px;margin-left:4px;animation:wcfScFade .3s backwards;animation-delay:calc(500ms + var(--i) * 110ms)}
@keyframes wcfScFade{from{opacity:0}}
.wcf-sc-none{font-size:12px;color:var(--dim)}

.wcf-sc-steps{display:flex;justify-content:space-between;gap:8px;margin-top:12px}
.wcf-sc-steps button{background:none;border:1px solid var(--line);color:#e2e8f0;border-radius:10px;padding:8px 12px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.wcf-sc-steps button:only-child.newer{margin-left:auto}

.wcf-sc-motm.wcf-motm-card{padding:0;overflow:hidden;background:linear-gradient(180deg,transparent 0,transparent 96px,rgba(13,18,32,.98) 136px),linear-gradient(90deg,rgba(12,15,26,.97) 0%,rgba(12,15,26,.85) 52%,rgba(12,15,26,.2) 100%),url('/wrapped/motm.jpg') right 0 top 30%/52% auto no-repeat,#0d1220}
.wcf-sc-motm>.wcf-motm-card-k,.wcf-sc-motm>.wcf-motm-card-main{margin-left:14px;margin-right:14px}
.wcf-sc-motm>.wcf-motm-card-k{margin-top:14px}
.wcf-sc-motm>.wcf-motm-card-main{margin-bottom:14px}
.wcf-sc-motm .wcf-motm-card-tip{padding:0 14px 10px}

.wcf-poll{border-top:1px solid rgba(245,217,122,.22)}
.wcf-poll-see{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;background:rgba(245,217,122,.05);border:0;font:inherit;font-size:13px;font-weight:800;color:#f5d97a;cursor:pointer}
.wcf-poll-peek{display:flex;align-items:center;gap:8px;color:var(--dim);font-weight:500;font-size:12px}
.wcf-poll-ar{transition:transform .35s}
.wcf-poll.open .wcf-poll-ar{transform:rotate(90deg)}
.wcf-poll-wrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s cubic-bezier(.2,.9,.3,1)}
.wcf-poll.open .wcf-poll-wrap{grid-template-rows:1fr}
.wcf-poll-wrap>div{overflow:hidden}
.wcf-poll-tip{padding:10px 14px 2px;font-size:11px;color:#64748b}
.wcf-poll-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto 20px 14px;gap:10px;align-items:center;width:100%;padding:8px 14px;background:none;border:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
.wcf-poll-face{width:30px;height:30px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:12px;color:#fff}
.wcf-poll-row.top .wcf-poll-face{border:2px solid #f5d97a}
.wcf-poll-mid{min-width:0;display:flex;flex-direction:column;gap:5px}
.wcf-poll-name{font-size:13px;font-weight:700;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-poll-row.top .wcf-poll-name{color:#f5d97a}
.wcf-poll-bar{display:block;height:5px;border-radius:5px;background:rgba(148,163,184,.15);overflow:hidden}
.wcf-poll-bar i{display:block;height:100%;width:0;border-radius:5px;background:#64748b;transition:width .9s cubic-bezier(.2,.9,.3,1);transition-delay:calc(200ms + var(--i) * 110ms)}
.wcf-poll-row.top .wcf-poll-bar i{background:linear-gradient(90deg,#e8b93c,#f5d97a)}
.wcf-poll.open .wcf-poll-bar i{width:var(--w)}
.wcf-poll-stack{display:flex;align-items:center}
.wcf-poll-av{width:22px;height:22px;flex:none;box-sizing:border-box;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:9px;color:#fff;border:2px solid #111827;margin-left:-7px}
.wcf-poll-stack .wcf-poll-av:first-child{margin-left:0}
.wcf-poll-av.more{background:#2a3450}
.wcf-poll-n{font-family:var(--display);font-weight:800;font-size:15px;color:#fff;text-align:right;font-variant-numeric:tabular-nums}
.wcf-poll-row.top .wcf-poll-n{color:#f5d97a}
.wcf-poll-rc{color:#64748b;transition:transform .3s}
.wcf-poll-row.on .wcf-poll-rc{transform:rotate(90deg)}
.wcf-poll-voters{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s ease}
.wcf-poll-voters.on{grid-template-rows:1fr}
.wcf-poll-voters>div{overflow:hidden}
.wcf-poll-chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 14px 10px 54px}
.wcf-poll-chips span{display:flex;align-items:center;gap:5px;font-size:11.5px;color:#e2e8f0;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:999px;padding:2px 8px 2px 2px}
.wcf-poll-chips .wcf-poll-av{width:18px;height:18px;margin:0;border:0;font-size:8px}
@media (prefers-reduced-motion: reduce){.wcf-sc-row,.wcf-sc-month,.wcf-sc-balls svg,.wcf-sc-ht,.wcf-sc-share i{animation:none}.wcf-poll-bar i,.wcf-poll-wrap,.wcf-poll-voters{transition:none}}
`;
