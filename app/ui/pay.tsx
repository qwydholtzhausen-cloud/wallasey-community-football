import { useEffect, useState } from "react";

// Paying on time. Everyone pays in the end; they just pay late, and a red
// strip on every unpaid card (plus a push per booking) shouted about games
// weeks away. So: one "you owe" bar at the top of Fixtures that opens a
// single list of what to pay, and a deadline only on games in the next 7
// days (see payDeadline / GameCard).

export type DueGame = { bookingId: string; gameId: string; date: string; kickoff: string; venue: string; price: number; msToKickoff: number; status: "unpaid" | "pending" };

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

export function PaySheet({
  due,
  paymentLink,
  paymentRef,
  onMarkPaid,
  onPayStart,
  onClose,
}: {
  due: DueGame[];
  paymentLink: string;
  // Set once auto-payments are on: pay with this reference and the games
  // confirm themselves (part payments cover the soonest games first).
  paymentRef?: string | null;
  onMarkPaid: (bookingId: string) => void;
  onPayStart?: (amount: number, bookingIds: string[]) => void;
  onClose: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [choice, setChoice] = useState<"soon" | "all">("soon");
  const [copied, setCopied] = useState(false);
  const [otherWay, setOtherWay] = useState(!paymentRef);
  const close = () => { setLeaving(true); setTimeout(onClose, 280); };
  const unpaid = due.filter((d) => d.status === "unpaid");
  const pending = due.filter((d) => d.status === "pending");
  const soon = unpaid.filter((d) => d.msToKickoff <= PAY_SOON_MS);
  const later = unpaid.filter((d) => d.msToKickoff > PAY_SOON_MS);
  const total = unpaid.reduce((s, d) => s + d.price, 0);
  const soonTotal = soon.reduce((s, d) => s + d.price, 0);
  const pick = paymentRef && soon.length > 0 && later.length > 0 && choice === "soon" ? soon : unpaid;
  const pickTotal = pick.reduce((s, d) => s + d.price, 0);
  const copyRef = () => {
    if (!paymentRef) return;
    navigator.clipboard?.writeText(paymentRef).then(() => setCopied(true), () => setCopied(false));
  };
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
          : d.msToKickoff <= PAY_SOON_MS
            ? `Pay before kick-off · ${untilLabel(d.msToKickoff)}`
            : `${dayLabel(d.date, { month: "long" })} · ${d.kickoff}`}
      </span>
      {d.status === "pending" ? (
        <span className="chkpill">CHECKING</span>
      ) : otherWay ? (
        <button type="button" className="paid-btn" onClick={() => onMarkPaid(d.bookingId)}>I&apos;ve paid</button>
      ) : null}
    </div>
  );
  return (
    <div className={"wcf-paysheet-wrap" + (leaving ? " out" : "")} onClick={close}>
      <div className="wcf-paysheet" role="dialog" aria-label="Games to pay for" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <div>
            <h4>To pay</h4>
            <p>{paymentRef ? "Pay with your reference and it confirms itself." : "An admin ticks each one off once it lands."}</p>
          </div>
          <button type="button" className="x" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="body">
          {paymentRef && unpaid.length > 0 && (
            <>
              <div className="wcf-payref">
                <span>
                  <span className="k">YOUR REFERENCE</span>
                  <span className="code">{paymentRef}</span>
                </span>
                <button type="button" onClick={copyRef}>{copied ? "Copied ✓" : "Copy"}</button>
              </div>
              {soon.length > 0 && later.length > 0 && (
                <div className="wcf-paychoose">
                  <button type="button" className={choice === "soon" ? "on" : ""} onClick={() => setChoice("soon")}>
                    <b>£{soonTotal}</b>This week&apos;s {soon.length} {soon.length === 1 ? "game" : "games"}
                  </button>
                  <button type="button" className={choice === "all" ? "on" : ""} onClick={() => setChoice("all")}>
                    <b>£{total}</b>All {unpaid.length} games
                  </button>
                </div>
              )}
              <div className="wcf-payrule">Part payments cover your soonest games first.</div>
            </>
          )}
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
            <div className="tot"><span>{paymentRef && pick !== unpaid ? `Paying now · ${pick.length} of ${unpaid.length} games` : "Total to pay"}</span><span>£{paymentRef ? pickTotal : total}</span></div>
            {paymentLink && (
              <a
                className="pn"
                href={paymentLink}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  if (!paymentRef) return;
                  copyRef();
                  onPayStart?.(pickTotal, pick.map((d) => d.bookingId));
                }}
              >
                {paymentRef ? `Pay £${pickTotal} with ref ${paymentRef}` : "Pay Now"}
              </a>
            )}
            {paymentRef ? (
              !otherWay && (
                <button type="button" className="wcf-payother" onClick={() => setOtherWay(true)}>
                  Paid another way? Tap &quot;I&apos;ve paid&quot; on the games
                </button>
              )
            ) : (
              <small>Then tap &quot;I&apos;ve paid&quot; on the games you&apos;ve covered.</small>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Auto-payments: waiting for it to land, then the receipt ──
export type PayIntent = { amount: number; bookingIds: string[]; at: number };

// Sits where the "you owe" bar does while a payment you just made is on
// its way. After 15 minutes with nothing matched it says an admin will
// sort it (no reference, a different amount, or a bank delay).
export function PayWaiting({ intent, onDismiss }: { intent: PayIntent; onDismiss: () => void }) {
  const late = Date.now() - intent.at > 15 * 60000;
  return (
    <div className={"wcf-paywait" + (late ? " late" : "")}>
      {late ? <span className="warn">!</span> : <span className="spin" aria-hidden="true" />}
      <span className="tx">
        <b>{late ? "Not confirmed yet" : `Waiting for your £${intent.amount}`}</b>
        {late
          ? "If you paid without your reference or a different amount, an admin will match it."
          : "It confirms automatically as soon as it lands. Usually within a minute."}
      </span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}

export function PayReceipt({
  games,
  auto,
  paymentRef,
  onDone,
}: {
  games: { date: string; kickoff: string; price: number }[];
  auto: boolean;
  paymentRef: string | null;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const total = games.reduce((s, g) => s + g.price, 0);
  const close = () => { if (leaving) return; setLeaving(true); setTimeout(onDone, 380); };
  useEffect(() => { const t = setTimeout(close, 4200); return () => clearTimeout(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const day = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
  return (
    <div className={"wcf-rcpt-layer" + (leaving ? " out" : "")} onClick={close} role="dialog" aria-label="Payment received">
      <div className="wcf-rcpt-till" aria-hidden="true" />
      <div className="wcf-rcpt">
        <div className="c big">WIRRAL COMMUNITY<br />FOOTBALL</div>
        <div className="c">PAYMENT RECEIVED</div>
        <hr />
        {paymentRef && <div className="ln"><span>REF</span><span>{paymentRef}</span></div>}
        {games.map((g, i) => (
          <div key={i} className="ln"><span>{day(g.date)} · {g.kickoff}</span><span>£{g.price.toFixed(2)}</span></div>
        ))}
        <hr />
        <div className="ln tot"><span>TOTAL</span><span>£{total.toFixed(2)}</span></div>
        <div className="st">{auto ? "CONFIRMED AUTOMATICALLY ✓" : "CONFIRMED ✓"}</div>
      </div>
    </div>
  );
}
