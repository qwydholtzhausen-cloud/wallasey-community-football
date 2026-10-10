import { useEffect, useState } from "react";
import { MATCH_DURATION_MINUTES, kickoffCutoff, nowInLondon } from "../../lib/time";
import { Avatar, avatarFor } from "./shared";

// Match-day mode: on the day of a game you're playing in, the "Next match"
// card becomes the day's hub - a MATCHDAY badge, a live countdown (amber in
// the last hour), your team once it's picked, then LIVE NOW with the match
// clock. After full time the game leaves Fixtures and the usual "Rate
// tonight" / MOTM vote prompts take over.

// Seconds-accurate "now" in the same pretend-UTC frame as kickoffCutoff.
function nowMs() {
  return new Date(nowInLondon() + ":00Z").getTime() + new Date().getSeconds() * 1000;
}
const kickMs = (date: string, kickoff: string) => new Date(kickoffCutoff(date, kickoff, 0) + ":00Z").getTime();

export function isMatchDay(date: string, kickoff: string) {
  return nowInLondon().slice(0, 10) === date && nowMs() < kickMs(date, kickoff) + MATCH_DURATION_MINUTES * 60000;
}

// From kick-off to full time: no booking or drop-out buttons then.
export function isLiveNow(date: string, kickoff: string) {
  const now = nowMs(), k = kickMs(date, kickoff);
  return now >= k && now < k + MATCH_DURATION_MINUTES * 60000;
}

export function MatchDayClock({ date, kickoff }: { date: string; kickoff: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.floor((kickMs(date, kickoff) - nowMs()) / 1000);
  if (diff > 0) {
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      <div className={"wcf-md-count" + (diff <= 3600 ? " hot" : "")}>
        {diff > 3600 ? (
          <>
            {h}<i>h</i> {pad(m)}<i>m</i>
          </>
        ) : (
          `${pad(m)}:${pad(s)}`
        )}
        <small>to kick-off at {kickoff}</small>
      </div>
    );
  }
  const minute = Math.min(MATCH_DURATION_MINUTES, Math.floor(-diff / 60) + 1);
  return (
    <div className="wcf-md-livebox">
      <div className="wcf-md-min">
        {minute}&apos;<span className="wcf-md-live"><i />Live</span>
      </div>
      <div className="wcf-md-bar"><i style={{ width: `${(minute / MATCH_DURATION_MINUTES) * 100}%` }} /></div>
    </div>
  );
}

export function MatchDayTeam({
  name,
  color,
  mates,
}: {
  name: string;
  color: string;
  mates: { display_name: string; avatar_url?: string | null }[];
}) {
  const light = ["#f5f6f8", "#ffffff", "#fff"].includes(color.toLowerCase());
  return (
    <div className="wcf-md-team" style={{ ["--team" as string]: color }}>
      <svg className="bib" viewBox="0 0 40 46" aria-hidden="true">
        <path d="M10 2h5q5 9 10 0h5q.5 10 6 15v26q0 1-1 1H4q-1 0-1-1V17q5.5-5 6-15z" fill={color} stroke={light ? "#94a3b8" : "rgba(255,255,255,.55)"} strokeWidth="1.3" />
        <path d="M6 20v20h28V20" fill="none" stroke={light ? "rgba(13,13,26,.3)" : "rgba(255,255,255,.4)"} strokeWidth="1" strokeDasharray="2 2" />
      </svg>
      <div className="tx">
        <small>Your side tonight</small>
        <b>
          You&apos;re on the <em>{name}</em>
        </b>
        {mates.length > 0 && (
          <span className="mates">
            {mates.map((m) => (
              <Avatar key={m.display_name} name={m.display_name} avatarUrl={m.avatar_url} className="wcf-avatar-chip" background={avatarFor(m.display_name).gradient} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
