import { useState } from "react";
import { useCredits } from "./credits";
import { creditLabel } from "../../lib/credits";

// Paying on time. Everyone pays in the end; they just pay late, and a red
// strip on every unpaid card (plus a push per booking) shouted about games
// weeks away. So: one "you owe" bar at the top of Fixtures that opens a
// single list of what to pay, and a deadline only on games in the next 7
// days (see payDeadline / GameCard).

export type DueGame = { bookingId: string; gameId: string; date: string; kickoff: string; venue: string; price: number; msToKickoff: number; status: "unpaid" | "pending"; credited?: boolean };

const DAY = 86400000;
export const PAY_SOON_MS = 7 * DAY;

// "1d 7h" / "18h" / "40m" until kick-off.
export function untilLabel(ms: number) {
  const min = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h` : `${m}m`;
}
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", opts);

export function OweBar({ due, onOpen }: { due: DueGame[]; onOpen: () => void }) {
  const unpaid = due.filter((d) => d.status === "unpaid");
  const pending = due.filter((d) => d.status === "pending");
  if (unpaid.length === 0 && pending.length === 0) return null;
  if (unpaid.length === 0)
    return (
      <div className="wcf-owe-clear">
        <i>✓</i>All paid up · {pending.length} {pending.length === 1 ? "game" : "games"} being checked by an admin
      </div>
    );
  const total = unpaid.reduce((s, d) => s + d.price, 0);
  const next = unpaid[0];
  const soon = unpaid.some((d) => d.msToKickoff <= 3 * DAY);
  const pendingTotal = pending.reduce((s, d) => s + d.price, 0);
  return (
    <button type="button" className={"wcf-owe" + (soon ? " soon" : "")} onClick={onOpen}>
      <span className="amt">£{total}</span>
      <span className="tx">
        <b>{unpaid.length} {unpaid.length === 1 ? "game" : "games"} to pay for</b>
        Next: {dayLabel(next.date, { weekday: "short", day: "numeric", month: "short" })}
        {next.msToKickoff <= PAY_SOON_MS ? " · pay before kick-off" : ""}
        {pending.length > 0 && <span className="chk">£{pendingTotal} being checked</span>}
      </span>
      <span className="go">Pay</span>
    </button>
  );
}

export function PaySheet({ due, paymentLink, onMarkPaid, onClose }: { due: DueGame[]; paymentLink: string; onMarkPaid: (bookingId: string) => void; onClose: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const { live, myAvailable, spendCredit } = useCredits();
  const close = () => { setLeaving(true); setTimeout(onClose, 280); };
  const unpaid = due.filter((d) => d.status === "unpaid");
  const pending = due.filter((d) => d.status === "pending");
  const soon = unpaid.filter((d) => d.msToKickoff <= PAY_SOON_MS);
  const later = unpaid.filter((d) => d.msToKickoff > PAY_SOON_MS);
  const total = unpaid.reduce((s, d) => s + d.price, 0);
  const row = (d: DueGame) => (
    <div key={d.bookingId} className={"wcf-prow" + (d.status === "pending" ? " checking" : d.msToKickoff <= PAY_SOON_MS ? " soon" : "")}>
      <span className="d">
        <small>{dayLabel(d.date, { weekday: "short" }).toUpperCase()}</small>
        <b>{dayLabel(d.date, { day: "numeric" })}</b>
      </span>
      <span className="m">
        <b>£{d.price} · {d.venue}</b>
        {d.status === "pending"
          ? "You said you'd paid"
          : d.credited
            ? `Credit covered £5 · £${d.price} left to pay`
            : d.msToKickoff <= PAY_SOON_MS
            ? d.msToKickoff > 0 ? `Pay before kick-off · ${untilLabel(d.msToKickoff)}` : `Pay ${Number(d.kickoff.split(":")[0]) < 17 ? "today" : "tonight"}`
            : `${dayLabel(d.date, { month: "long" })} · ${d.kickoff}`}
      </span>
      {d.status === "pending" ? (
        <span className="chkpill">CHECKING</span>
      ) : live && myAvailable > 0 && !d.credited ? (
        <span className="wcf-prow-btns">
          <button type="button" className="wcf-credit-btn" onClick={() => spendCredit(d.bookingId)}>Use credit</button>
          <button type="button" className="paid-btn" onClick={() => onMarkPaid(d.bookingId)}>I&apos;ve paid</button>
        </span>
      ) : (
        <button type="button" className="paid-btn" onClick={() => onMarkPaid(d.bookingId)}>{d.credited ? `I've paid £${d.price}` : "I've paid"}</button>
      )}
    </div>
  );
  return (
    <div className={"wcf-paysheet-wrap" + (leaving ? " out" : "")} onClick={close}>
      <div className="wcf-paysheet" role="dialog" aria-label="Games to pay for" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <div>
            <h4>To pay</h4>
            <p>An admin ticks each one off once it lands.</p>
          </div>
          <button type="button" className="x" onClick={close} aria-label="Close">✕</button>
        </div>
        {live && myAvailable > 0 && unpaid.some((d) => !d.credited) && (
          <div className="wcf-paysheet-credit">You have {creditLabel(myAvailable)}. One credit covers one game.</div>
        )}
        <div className="body">
          {soon.length > 0 && <div className="grp">This week</div>}
          {soon.map(row)}
          {later.length > 0 && <div className="grp">Later</div>}
          {later.map(row)}
          {pending.length > 0 && <div className="grp">Being checked</div>}
          {pending.map(row)}
          {unpaid.length === 0 && <p className="none">Nothing left to pay. Thanks!</p>}
        </div>
        {unpaid.length > 0 && (
          <div className="ft">
            <div className="tot"><span>Total to pay</span><span>£{total}</span></div>
            {paymentLink && (
              <a className="pn" href={paymentLink} target="_blank" rel="noreferrer">Pay Now</a>
            )}
            <small>Then tap &quot;I&apos;ve paid&quot; on the games you&apos;ve covered.</small>
          </div>
        )}
      </div>
    </div>
  );
}
