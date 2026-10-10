import { useState } from "react";

// A brand-new member's first few minutes: what to call them (only when
// they arrived without a name, i.e. named after their email), three
// welcome cards (how it works, where their best chance of a game is, and
// notifications), then a "first game" card on Fixtures until they've
// played. Existing members never see the first two.

export type BestChance = { id: string; dow: string; day: string; mon: string; waiting: number; place: number; full: boolean };
export type PushState = "on" | "available" | "install" | "unsupported";

const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

export function NameStep({ suggested, onSave, onSkip }: { suggested: { first: string; last: string }; onSave: (name: string) => Promise<boolean>; onSkip: () => void }) {
  const [first, setFirst] = useState(suggested.first);
  const [last, setLast] = useState(suggested.last);
  const [busy, setBusy] = useState(false);
  const f = first.trim(), l = last.trim();
  const ok = f.length >= 2;
  return (
    <div className="wcf-np">
      <style>{newPlayerCss}</style>
      <div className="wcf-np-photo" style={{ backgroundImage: "url('/floodlit-signin.jpg')" }} />
      <div className="wcf-np-scrim" />
      <form
        className="wcf-np-name"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok || busy) return;
          setBusy(true);
          const saved = await onSave([f, l].filter(Boolean).join(" "));
          setBusy(false);
          if (!saved) return;
        }}
      >
        <div className="k">You&apos;re in · one last thing</div>
        <h1>What should we call you?</h1>
        <p>This is how you&apos;ll show on the team sheet and in the squad. You can change it later in Account.</p>
        <div className="row">
          <input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First name" autoComplete="given-name" maxLength={20} aria-label="First name" />
          <input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last name" autoComplete="family-name" maxLength={20} aria-label="Last name" />
        </div>
        <div className="preview" aria-hidden="true">
          <span className="tok">
            <span className="face">{(f[0] || "?").toUpperCase()}</span>
            <span>{f || "You"}</span>
          </span>
          <span className="say">
            <small>On the team sheet</small>
            <b>{[f, l].filter(Boolean).join(" ") || "Your name"}</b>
          </span>
        </div>
        <button type="submit" className="wcf-np-gold" disabled={!ok || busy}>
          {busy ? "Saving…" : "That's me"}
        </button>
        <button type="button" className="wcf-np-ghost" onClick={onSkip}>
          Skip for now
        </button>
      </form>
    </div>
  );
}

export function WelcomeCards({
  firstName,
  how,
  best,
  push,
  onEnablePush,
  onDone,
}: {
  firstName: string;
  how: { days: string; kickoff: string; venue: string; price: number; format: string };
  best: BestChance | null;
  push: PushState;
  onEnablePush: () => Promise<boolean>;
  onDone: () => void;
}) {
  const [i, setI] = useState(0);
  const [pushOn, setPushOn] = useState(push === "on");
  const [busy, setBusy] = useState(false);
  const cards = 3;
  const cls = (k: number) => "wcf-np-card" + (k < i ? " left" : k > i ? " right" : "");
  return (
    <div className="wcf-np">
      <style>{newPlayerCss}</style>
      <div className="wcf-np-cards">
        <div className={cls(0)}>
          <div className="wcf-np-photo" style={{ backgroundImage: "url('/pitch-floodlit.jpg')" }} />
          <div className="wcf-np-scrim" />
          <div className="k">{firstName ? `Welcome, ${firstName}` : "Welcome to the club"}</div>
          <h2>How it works</h2>
          <p>
            {how.format} at {how.venue}, {how.days} at {how.kickoff}. Book a spot, pay before kick-off, turn up and play.
          </p>
          <div className="steps">
            <div><b>1</b><span>Book a spot in Fixtures</span></div>
            <div><b>2</b><span>Pay £{how.price} before kick-off</span></div>
            <div><b>3</b><span>Teams go up on the day</span></div>
          </div>
        </div>
        <div className={cls(1)}>
          <div className="wcf-np-photo" style={{ backgroundImage: "url('/lineup-teams.jpg')" }} />
          <div className="wcf-np-scrim" />
          {best && !best.full ? (
            <>
              <div className="k">There&apos;s a spot for you</div>
              <h2>Grab your first game</h2>
              <p>Games book up fast, but there&apos;s still room on this one.</p>
              <div className="best">
                <div className="d"><small>{best.dow}</small>{best.day}<small>{best.mon}</small></div>
                <div className="t">Next free spot: <b>{best.dow} {best.day} {best.mon}</b>. Head to Fixtures to book it.</div>
              </div>
            </>
          ) : (
            <>
              <div className="k">Games fill up fast</div>
              <h2>Get in line, you&apos;ll move up</h2>
              <p>Every game is full right now, so join a waiting list. When someone drops out, the next person in line gets their spot.</p>
              {best && (
                <div className="best">
                  <div className="d"><small>{best.dow}</small>{best.day}<small>{best.mon}</small></div>
                  <div className="t">Your best chance: you&apos;d be <b>{nth(best.place)} in line</b> on {best.dow} {best.day} {best.mon}. {best.waiting === 0 ? "Nobody's waiting yet." : `Only ${best.waiting} ${best.waiting === 1 ? "person is" : "people are"} waiting.`}</div>
                </div>
              )}
            </>
          )}
        </div>
        <div className={cls(2)}>
          <div className="wcf-np-photo" style={{ backgroundImage: "url('/celebration.jpg')" }} />
          <div className="wcf-np-scrim" />
          <div className="k">Don&apos;t miss your spot</div>
          <h2>Get told the second you&apos;re in</h2>
          <p>When a spot opens, the next person in line gets it, and a notification is how you&apos;ll know.</p>
          <div className="bell">
            {push === "install" && (
              <div className="opt"><span className="ic">!</span><span><b>On iPhone:</b> tap Share, then <b>Add to Home Screen</b>, and open the app from there. Notifications only work that way.</span></div>
            )}
            {(push === "available" || push === "on") && (
              <button
                type="button"
                className="wcf-np-gold"
                disabled={pushOn || busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await onEnablePush();
                  setBusy(false);
                  if (ok) setPushOn(true);
                }}
              >
                {pushOn ? "✓ Notifications on" : busy ? "Turning on…" : "Turn on notifications"}
              </button>
            )}
            {push === "unsupported" && <div className="opt"><span className="ic">!</span><span>This browser can&apos;t do notifications, so check the app now and then, and keep an eye on your inbox.</span></div>}
          </div>
        </div>
      </div>
      <div className="wcf-np-foot">
        <div className="dots">{Array.from({ length: cards }, (_, k) => <i key={k} className={k === i ? "on" : ""} />)}</div>
        <button type="button" className="wcf-np-gold" onClick={() => (i < cards - 1 ? setI(i + 1) : onDone())}>
          {i < cards - 1 ? "Next" : "Show me the games"}
        </button>
        <button type="button" className="wcf-np-ghost" onClick={onDone}>Skip</button>
      </div>
    </div>
  );
}

// On Fixtures until your first game: three steps and the games where
// you'd be nearest the front of the queue.
export function FirstGameCard({ booked, chances, onOpen }: { booked: boolean; chances: BestChance[]; onOpen: (id: string) => void }) {
  return (
    <div className="wcf-fg">
      <style>{newPlayerCss}</style>
      <div className="wcf-fg-hero">
        <div className="k">New here · your first game</div>
        <b>Three steps to your first game</b>
        <div className="bar">
          <span className="done">✓ Joined</span>
          <span className={booked ? "done" : "next"}>{booked ? "✓ In a game or queue" : chances[0]?.full === false ? "Book a spot" : "Join a waiting list"}</span>
          <span>Play</span>
        </div>
      </div>
      {!booked && chances.length > 0 && (
        <>
          <div className="wcf-fg-eye">{chances[0].full ? "Your best chances" : "Games with a free spot"}</div>
          {chances.map((c, k) => (
            <button key={c.id} type="button" className={"wcf-fg-row" + (k === 0 ? " top" : "")} onClick={() => onOpen(c.id)}>
              <span className="d"><small>{c.dow}</small>{c.day}</span>
              <span className="t">
                <b>{c.dow} {c.day} {c.mon}</b>
                <span>{c.full ? `${c.waiting} waiting · you'd be ${nth(c.place)} in line` : "Spots left"}</span>
              </span>
              <span className="go">{c.full ? "Join" : "Book"}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export const newPlayerCss = `
.wcf-np{position:fixed;inset:0;z-index:300;background:#080912;display:flex;flex-direction:column;color:#F5F6F8;animation:wcfNpIn .35s ease-out}
@keyframes wcfNpIn{from{opacity:0}to{opacity:1}}
.wcf-np-photo{position:absolute;inset:0;background:center/cover}
.wcf-np-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,9,18,.45),rgba(8,9,18,.2) 30%,rgba(8,9,18,.92) 62%,#080912)}
.wcf-np-gold{min-height:50px;width:100%;border-radius:15px;border:0;background:#f5d97a;color:#1a1405;font-weight:800;font-size:15px;cursor:pointer;font-family:var(--sans)}
.wcf-np-gold:disabled{opacity:.4;cursor:default}
.wcf-np-ghost{min-height:42px;width:100%;border-radius:13px;border:0;background:none;color:var(--dim);font-weight:700;font-size:13px;cursor:pointer;font-family:var(--sans)}
.wcf-np-name{position:relative;margin-top:auto;padding:0 22px calc(18px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:12px;max-width:520px;width:100%;align-self:center}
.wcf-np .k{font-size:11px;font-weight:800;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.wcf-np-name h1{margin:0;font-family:var(--display);font-weight:800;font-size:30px;line-height:1.05}
.wcf-np-name p{margin:0;font-size:13.5px;color:#cbd5e1;line-height:1.5}
.wcf-np-name .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wcf-np-name input{width:100%;min-width:0;min-height:50px;border-radius:13px;border:1px solid rgba(255,255,255,.14);background:rgba(15,20,35,.88);color:#F5F6F8;padding:0 14px;font-size:16px;font-family:var(--sans)}
.wcf-np-name .preview{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:16px;background:rgba(15,20,35,.78);border:1px solid var(--line)}
.wcf-np-name .tok{display:grid;justify-items:center;gap:4px;font-size:11px;font-weight:700;min-width:48px}
.wcf-np-name .face{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:15px;background:linear-gradient(135deg,#E42A36,#7f1018);box-shadow:0 0 0 2px rgba(255,255,255,.6)}
.wcf-np-name .say{min-width:0}
.wcf-np-name .say small{display:block;font-size:10px;font-weight:800;letter-spacing:.16em;color:var(--dim);text-transform:uppercase}
.wcf-np-name .say b{display:block;font-size:15px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-np-cards{position:relative;flex:1;overflow:hidden}
.wcf-np-card{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:0 22px 16px;transition:transform .45s cubic-bezier(.3,1,.4,1),opacity .35s}
.wcf-np-card.left{transform:translateX(-100%);opacity:0;pointer-events:none}
.wcf-np-card.right{transform:translateX(100%);opacity:0;pointer-events:none}
.wcf-np-card>*:not(.wcf-np-photo):not(.wcf-np-scrim){position:relative;max-width:520px;width:100%;align-self:center}
.wcf-np-card h2{margin:8px 0 10px;font-family:var(--display);font-weight:800;font-size:28px;line-height:1.05;text-wrap:balance}
.wcf-np-card p{margin:0;font-size:14px;color:#cbd5e1;line-height:1.55}
.wcf-np-card .steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:16px}
.wcf-np-card .steps div{padding:12px 8px;border-radius:14px;background:rgba(15,20,35,.82);border:1px solid var(--line);text-align:center}
.wcf-np-card .steps b{display:block;font-family:var(--display);font-size:18px;color:#f5d97a}
.wcf-np-card .steps span{display:block;font-size:11.5px;color:#cbd5e1;margin-top:4px;line-height:1.35}
.wcf-np-card .best{margin-top:16px;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:16px;background:linear-gradient(100deg,rgba(245,217,122,.18),rgba(245,217,122,.05));border:1px solid rgba(245,217,122,.45)}
.wcf-np-card .best .d{flex:none;width:46px;text-align:center;font-family:var(--display);font-weight:800;font-size:20px;line-height:1}
.wcf-np-card .best .d small{display:block;font-family:var(--sans);font-size:9.5px;letter-spacing:.14em;color:var(--dim);margin:3px 0;text-transform:uppercase}
.wcf-np-card .best .t{flex:1;min-width:0;font-size:13px;color:#cbd5e1;line-height:1.4}
.wcf-np-card .best .t b{color:#f5d97a}
.wcf-np-card .bell{margin-top:16px;display:flex;flex-direction:column;gap:8px}
.wcf-np-card .opt{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:rgba(15,20,35,.85);border:1px solid var(--line);font-size:13px;color:#cbd5e1;line-height:1.4}
.wcf-np-card .opt b{color:#F5F6F8}
.wcf-np-card .ic{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(245,217,122,.14);color:#f5d97a;font-weight:800}
.wcf-np-foot{position:relative;padding:12px 22px calc(16px + env(safe-area-inset-bottom,0px));display:grid;gap:8px;background:#080912;max-width:520px;width:100%;align-self:center}
.wcf-np-foot .dots{display:flex;justify-content:center;gap:6px}
.wcf-np-foot .dots i{width:7px;height:7px;border-radius:50%;background:rgba(148,163,184,.3);transition:all .3s}
.wcf-np-foot .dots i.on{width:22px;border-radius:4px;background:#f5d97a}
.wcf-fg{margin:0 0 16px}
.wcf-fg-hero{position:relative;border-radius:20px;overflow:hidden;border:1px solid rgba(245,217,122,.4);padding:16px;background:#0a0d18}
.wcf-fg-hero::before{content:"";position:absolute;inset:0;background:url('/celebration.jpg') center 35%/cover;opacity:.32}
.wcf-fg-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,#0a0d18 30%,rgba(10,13,24,.4))}
.wcf-fg-hero>*{position:relative;z-index:1}
.wcf-fg-hero .k{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#f5d97a}
.wcf-fg-hero b{display:block;font-family:var(--display);font-size:19px;margin:5px 0 0}
.wcf-fg-hero .bar{display:flex;gap:6px;margin-top:12px}
.wcf-fg-hero .bar span{flex:1;padding:8px 6px;border-radius:10px;background:rgba(0,0,0,.35);border:1px solid var(--line);font-size:11px;font-weight:700;color:#cbd5e1;text-align:center;line-height:1.3}
.wcf-fg-hero .bar span.done{border-color:rgba(74,222,128,.45);color:#4ade80}
.wcf-fg-hero .bar span.next{border-color:rgba(245,217,122,.6);color:#f5d97a}
.wcf-fg-eye{font-size:10.5px;font-weight:800;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;margin:16px 2px 8px}
.wcf-fg-row{width:100%;display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:16px;border:1px solid var(--line);background:linear-gradient(170deg,#152033,#0c1020);margin-bottom:8px;color:var(--white);text-align:left;cursor:pointer;font-family:var(--sans)}
.wcf-fg-row.top{border-color:rgba(245,217,122,.6);box-shadow:0 0 0 1px rgba(245,217,122,.2),0 10px 24px -14px rgba(245,217,122,.6)}
.wcf-fg-row .d{flex:none;width:44px;text-align:center;font-family:var(--display);font-weight:800;font-size:20px;line-height:1}
.wcf-fg-row .d small{display:block;font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dim);margin-bottom:4px;font-weight:600;text-transform:uppercase}
.wcf-fg-row .t{flex:1;min-width:0;font-size:12.5px}
.wcf-fg-row .t b{display:block;font-size:13.5px}
.wcf-fg-row .t span{display:block;color:var(--dim);margin-top:2px}
.wcf-fg-row.top .t span{color:#f5d97a}
.wcf-fg-row .go{flex:none;font-size:11px;font-weight:800;padding:6px 12px;border-radius:999px;background:rgba(245,217,122,.14);color:#f5d97a;border:1px solid rgba(245,217,122,.4)}
@media (prefers-reduced-motion:reduce){.wcf-np,.wcf-np-card{animation:none;transition:none}}
`;
