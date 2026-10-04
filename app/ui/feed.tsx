import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Avatar, TickNum, avatarFor, listNames, motionAllowed } from "./shared";
import { EmptyScene } from "./EmptyScene";

export const FEED_REACTION_EMOJI = ["👍", "🔥"] as const;

export type FeedItem = {
  key: string;
  ts: number;
  kind: "derived";
  icon: React.ReactNode;
  tone: "amber" | "green" | "blue";
  text: React.ReactNode;
  // Set on the kinds that arrive in bursts, so the feed can fold them into
  // one card per week (see foldFeedRows).
  group?: "join" | "apps";
  groupLabel?: string;
};

export type FeedRow = { type: "item"; item: FeedItem } | { type: "group"; group: "join" | "apps"; items: FeedItem[] };

// New members and appearance milestones come in bursts - a batch of
// sign-ups, or a game where several players hit 5 - and read as a wall of
// near-identical rows that buries the results and MOTM people come to
// see. Two or more of the same kind within one section fold into a single
// card, placed where the newest of them was; everything else is untouched.
export function foldFeedRows(items: FeedItem[]): FeedRow[] {
  const counts = { join: 0, apps: 0 };
  for (const i of items) if (i.group) counts[i.group]++;
  const rows: FeedRow[] = [];
  const placed = new Set<string>();
  for (const i of items) {
    if (i.group && counts[i.group] >= 2) {
      if (placed.has(i.group)) continue;
      placed.add(i.group);
      rows.push({ type: "group", group: i.group, items: items.filter((x) => x.group === i.group) });
    } else rows.push({ type: "item", item: i });
  }
  return rows;
}

// Feed items are dated historical facts, not live status - without a
// visible date, something like "Pot passed £50" reads as a claim about
// right now rather than a moment that happened and may since have moved.
export function fmtFeedDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// ── Feed motion ──
// The posts you hadn't seen when you opened Feed this visit, and when the
// full-time score should start flipping (later when the FULL TIME band plays).
export const FeedFreshCtx = createContext<{ keys: Set<string>; flapDelay: number }>({ keys: new Set(), flapDelay: 0 });
// A full-time score that flips up goal by goal, the first time you see it.
export function FlapNum({ itemKey, value, color }: { itemKey: string; value: number; color: string }) {
  const { keys, flapDelay } = useContext(FeedFreshCtx);
  const play = keys.has(itemKey) && motionAllowed();
  const [n, setN] = useState(play ? 0 : value);
  useEffect(() => {
    if (!play) return setN(value);
    let iv: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      let i = 0;
      if (value > 0)
        iv = setInterval(() => {
          i++;
          setN(i);
          if (i >= value && iv) clearInterval(iv);
        }, 200);
    }, flapDelay);
    return () => {
      clearTimeout(t);
      if (iv) clearInterval(iv);
    };
  }, [play, value, flapDelay]);
  if (!play) return <b style={{ color }}>{value}</b>;
  return (
    <span className="wcf-flap">
      <b key={n} style={{ color }}>
        {n}
      </b>
    </span>
  );
}
// The pot milestone counts up from the last £50 the first time you see it.
export function PotCount({ itemKey, value }: { itemKey: string; value: number }) {
  const play = useContext(FeedFreshCtx).keys.has(itemKey) && motionAllowed();
  const [n, setN] = useState(play ? value - 50 : value);
  useEffect(() => {
    if (!play) return setN(value);
    let cur = value - 50;
    let iv: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      iv = setInterval(() => {
        cur += 5;
        setN(cur);
        if (cur >= value && iv) clearInterval(iv);
      }, 60);
    }, 700);
    return () => {
      clearTimeout(t);
      if (iv) clearInterval(iv);
    };
  }, [play, value]);
  return <>{n}</>;
}
export function CoinRain() {
  return (
    <span className="wcf-coins" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} style={{ left: `${12 + ((i * 37) % 76)}%`, top: `${6 + ((i * 13) % 26)}px`, "--d": `${0.5 + i * 0.09}s` } as React.CSSProperties}>
          £
        </i>
      ))}
    </span>
  );
}
// Reaction feedback, done on the button itself so it never re-renders the
// whole app: 👍 punches with a ring, 🔥 throws flames, and the 5th 🔥 on a
// post sets the card alight.
export function reactBurst(btn: HTMLElement, emoji: string, newCount: number) {
  if (!motionAllowed()) return;
  btn.classList.remove("punch");
  void btn.offsetWidth;
  btn.classList.add("punch");
  const add = (el: HTMLElement, ms: number) => {
    btn.appendChild(el);
    setTimeout(() => el.remove(), ms);
  };
  if (emoji !== "🔥") {
    const r = document.createElement("span");
    r.className = "wcf-react-ring";
    add(r, 600);
    return;
  }
  for (let i = 0; i < 9; i++) {
    const e = document.createElement("span");
    e.className = "wcf-ember";
    e.textContent = i % 3 ? "🔥" : "✦";
    e.style.cssText = `--x:${Math.round(Math.random() * 70 - 35)}px;--y:${Math.round(-50 - Math.random() * 50)}px;--r:${Math.round(Math.random() * 60 - 30)}deg;--d:${(0.7 + Math.random() * 0.5).toFixed(2)}s;font-size:${Math.round(10 + Math.random() * 8)}px`;
    add(e, 1300);
  }
  const card = btn.closest(".wcf-feed-item") as HTMLElement | null;
  if (newCount === 5 && card) {
    card.classList.add("onfire");
    setTimeout(() => card.classList.remove("onfire"), 3800);
    for (let i = 0; i < 14; i++)
      setTimeout(() => {
        const sp = document.createElement("span");
        sp.className = "wcf-spark";
        sp.style.cssText = `left:${8 + Math.random() * 84}%;top:${Math.random() * 30}%;--x:${Math.round(Math.random() * 30 - 15)}px`;
        card.appendChild(sp);
        setTimeout(() => sp.remove(), 1700);
      }, i * 180);
  }
}
// Pull down at the top of the Feed: a goal net stretches out, and letting
// go fires a ball into it while everything reloads. Touch only, and all done
// on the DOM so dragging never re-renders the app.
export function PullNet({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const el = wrap.current;
    const scroller = el?.closest(".wcf-main") as HTMLElement | null;
    if (!el || !scroller) return;
    const hs = Array.from(el.querySelectorAll<SVGPathElement>(".nh"));
    const vs = Array.from(el.querySelectorAll<SVGPathElement>(".nv"));
    const label = el.querySelector(".wcf-net-label") as HTMLElement;
    const ball = el.querySelector(".wcf-net-ball") as SVGElement;
    let startY: number | null = null;
    let pull = 0;
    let busy = false;
    const draw = (bulge: number) => {
      hs.forEach((p, i) => {
        const y = 12 + i * 17;
        p.setAttribute("d", `M12 ${y} Q 160 ${y - bulge * (0.3 + i / 9)} 308 ${y}`);
      });
      vs.forEach((p, i) => {
        const x = 12 + i * (296 / 12);
        const d = Math.max(0, 1 - Math.abs(x - 160) / 170);
        p.setAttribute("d", `M${x} 6 Q ${x} 78 ${x + (x - 160) * 0.04} ${130 - bulge * d * 0.9}`);
      });
    };
    const set = (px: number) => {
      pull = Math.max(0, Math.min(130, px));
      el.style.height = pull + "px";
      draw((pull / 130) * 8);
      label.textContent = pull > 100 ? "Let go to refresh" : "Pull to refresh";
    };
    draw(0);
    const start = (e: TouchEvent) => {
      if (busy || scroller.scrollTop > 0) return;
      startY = e.touches[0].clientY;
      el.style.transition = "";
    };
    const move = (e: TouchEvent) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      set(dy > 0 ? dy * 0.5 : 0);
    };
    const end = async () => {
      if (startY == null) return;
      startY = null;
      if (pull <= 100) {
        el.style.transition = "height .3s";
        return set(0);
      }
      busy = true;
      el.style.transition = "height .25s";
      el.style.height = "130px";
      label.textContent = "";
      label.classList.remove("ok");
      if (motionAllowed()) {
        ball.animate(
          [
            { opacity: 1, transform: "translateY(30px) scale(1.5)" },
            { opacity: 1, transform: "translateY(-60px) scale(.8)" },
          ],
          { duration: 260, easing: "cubic-bezier(.3,.7,.4,1)", fill: "forwards" },
        );
        const t0 = performance.now() + 260;
        const wob = () => {
          const t = (performance.now() - t0) / 1000;
          if (t < 0) return requestAnimationFrame(wob);
          draw(34 * Math.exp(-t * 4) * Math.cos(t * 16));
          if (t < 1.1) requestAnimationFrame(wob);
          else draw(0);
        };
        requestAnimationFrame(wob);
      }
      await Promise.all([refresh.current().catch(() => null), new Promise((r) => setTimeout(r, 900))]);
      ball.getAnimations().forEach((a) => a.cancel());
      label.textContent = "✓ Up to date";
      label.classList.add("ok");
      setTimeout(() => {
        el.style.transition = "height .45s cubic-bezier(.3,1.3,.5,1)";
        set(0);
        label.textContent = "";
        busy = false;
      }, 900);
    };
    scroller.addEventListener("touchstart", start, { passive: true });
    scroller.addEventListener("touchmove", move, { passive: true });
    scroller.addEventListener("touchend", end);
    scroller.addEventListener("touchcancel", end);
    return () => {
      scroller.removeEventListener("touchstart", start);
      scroller.removeEventListener("touchmove", move);
      scroller.removeEventListener("touchend", end);
      scroller.removeEventListener("touchcancel", end);
    };
  }, []);
  return (
    <div className="wcf-net" ref={wrap} aria-hidden>
      <svg viewBox="0 0 320 130" preserveAspectRatio="none">
        <rect x="0" y="0" width="320" height="130" fill="#0a1424" />
        {Array.from({ length: 7 }, (_, i) => (
          <path key={"h" + i} className="nh" fill="none" stroke="rgba(226,232,240,.55)" strokeWidth="1" />
        ))}
        {Array.from({ length: 13 }, (_, i) => (
          <path key={"v" + i} className="nv" fill="none" stroke="rgba(226,232,240,.4)" strokeWidth="1" />
        ))}
        <rect x="6" y="0" width="6" height="130" fill="#e5e7eb" />
        <rect x="308" y="0" width="6" height="130" fill="#e5e7eb" />
        <rect x="6" y="0" width="308" height="6" fill="#e5e7eb" />
      </svg>
      <svg className="wcf-net-ball" viewBox="0 0 24 24" fill="#fff" stroke="#0d0d1a" strokeWidth="1.3">
        <circle cx="12" cy="12" r="10.5" />
        <path d="M12 7.5l3 2.2-1.1 3.6h-3.8L9 9.7z" fill="#0d0d1a" />
      </svg>
      <div className="wcf-net-label" />
    </div>
  );
}

// ── The Feed tab ──
// Results, MOTM, records, milestones and the pot, newest first, grouped by
// week, with reactions; plus the Boot Room tab when it's open. The posts
// themselves are worked out in the main app (feedItems) because they draw
// on games, goals and the pot; this draws them.
export function FeedTab({
  stories,
  isAdmin,
  myId,
  profiles,
  askConfirm,
  onRefresh,
  feedView,
  setFeedView,
  showArchived,
  setShowArchived,
  bootRoomVisible,
  bootRoom,
  visibleFeedItems,
  hiddenFeedKeys,
  hideFeedItem,
  hideFeedItems,
  unhideFeedItem,
  feedReactions,
  feedReactionTally,
  toggleReaction,
  feedFresh,
  feedFreshLabel,
}: {
  // Game Stories rings, shown at the top of the Feed.
  stories?: React.ReactNode;
  isAdmin: boolean;
  myId: string;
  profiles: { id: string; display_name: string; avatar_url?: string | null }[];
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  onRefresh: () => Promise<unknown>;
  feedView: "feed" | "bootroom";
  setFeedView: (v: "feed" | "bootroom") => void;
  showArchived: boolean;
  setShowArchived: React.Dispatch<React.SetStateAction<boolean>>;
  bootRoomVisible: boolean;
  bootRoom: React.ReactNode;
  visibleFeedItems: FeedItem[];
  hiddenFeedKeys: string[];
  hideFeedItem: (key: string) => void;
  hideFeedItems: (keys: string[]) => void;
  unhideFeedItem: (key: string) => void;
  feedReactions: { item_key: string; emoji: string; user_id: string }[];
  feedReactionTally: Record<string, Record<string, number>>;
  toggleReaction: (key: string, emoji: string) => void;
  feedFresh: { keys: Set<string>; since: number; band: boolean } | null;
  feedFreshLabel: string;
}) {
  const reactionRow = (item: FeedItem) => {
    const tally = feedReactionTally[item.key] ?? {};
    return (
      <div className="wcf-feed-reactions">
        {FEED_REACTION_EMOJI.map((emoji) => {
          const count = tally[emoji] ?? 0;
          const mine = feedReactions.some((r) => r.item_key === item.key && r.emoji === emoji && r.user_id === myId);
          return (
            <button
              key={emoji}
              className={"wcf-feed-pill" + (mine ? " mine" : "")}
              onClick={(e) => {
                if (!mine) reactBurst(e.currentTarget, emoji, count + 1);
                toggleReaction(item.key, emoji);
              }}
            >
              {emoji}
              {count > 0 && (
                <>
                  {" "}
                  <TickNum value={count} />
                </>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {feedView === "feed" && !showArchived && <PullNet onRefresh={onRefresh} />}
      {feedView === "feed" && !showArchived && stories}
      {!showArchived && (
        <div className={"wcf-feed-hero" + (feedView === "bootroom" ? " compact" : "")}>
          <div className="wcf-feed-hero-eyebrow">Community Feed</div>
          <div className="wcf-feed-hero-title">{bootRoomVisible ? <>Goals, shoutouts &amp; the Boot Room</> : <>Goals &amp; shoutouts</>}</div>
          {/* Only one destination while the Boot Room is admin-only,
            so no pill row at all rather than a lone "Feed" pill. */}
          {bootRoomVisible && (
            <div className="wcf-feed-hero-tabs">
              <button className={feedView === "feed" ? "active" : ""} onClick={() => setFeedView("feed")}>
                Feed
              </button>
              <button className={feedView === "bootroom" ? "active" : ""} onClick={() => setFeedView("bootroom")}>
                Boot Room
              </button>
            </div>
          )}
        </div>
      )}

      {feedView === "bootroom" && bootRoomVisible && !showArchived && myId && bootRoom}

      {feedView === "feed" && isAdmin && (
        <button className="wcf-ghost wcf-archive-toggle" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Back to feed" : `Show archived${hiddenFeedKeys.length ? ` (${hiddenFeedKeys.length})` : ""}`}
        </button>
      )}

      {feedView === "feed" &&
        visibleFeedItems.length === 0 &&
        (showArchived ? (
          <p className="wcf-empty">Nothing archived.</p>
        ) : (
          <EmptyScene kind="feed" title="Nothing on the Feed yet" text="Results, goals and shoutouts land here after the first game." />
        ))}

      {feedView === "feed" &&
        visibleFeedItems.length > 0 &&
        (() => {
          const groups: { label: string; items: typeof visibleFeedItems }[] = [];
          const freshKeys = !showArchived && feedFresh ? feedFresh.keys : new Set<string>();
          const freshOrder = visibleFeedItems.filter((i) => freshKeys.has(i.key)).map((i) => i.key);
          const freshStyle = (key: string) => ({ "--d": `${0.15 + Math.max(0, freshOrder.indexOf(key)) * 0.14}s` }) as React.CSSProperties;
          visibleFeedItems.forEach((item) => {
            const days = Math.floor((Date.now() - item.ts) / 86400000);
            const label = freshKeys.has(item.key) ? feedFreshLabel : days <= 7 ? "This week" : days <= 14 ? "Last week" : "Earlier";
            let g = groups.find((x) => x.label === label);
            if (!g) {
              g = { label, items: [] };
              groups.push(g);
            }
            g.items.push(item);
          });
          return (
            <FeedFreshCtx.Provider value={{ keys: freshKeys, flapDelay: feedFresh?.band ? 2100 : 700 }}>
              <div style={{ "--ftd": feedFresh?.band ? "2.1s" : ".7s" } as React.CSSProperties}>
                {groups.map((g) => (
                  <div key={g.label}>
                    <div className={"wcf-feed-section-label" + (g.label === feedFreshLabel && freshKeys.size > 0 ? " fresh" : "")}>{g.label}</div>
                    {(showArchived ? g.items.map((item): FeedRow => ({ type: "item", item })) : foldFeedRows(g.items)).map((row) => {
                      if (row.type === "group") {
                        const first = row.items[0];
                        const names = row.items.map((x) => x.groupLabel ?? "");
                        return (
                          <article
                            key={`group-${row.group}-${first.key}`}
                            className={"wcf-feed-item grouped" + (freshKeys.has(first.key) ? " fresh" : "")}
                            style={freshKeys.has(first.key) ? freshStyle(first.key) : undefined}
                          >
                            <div className={"wcf-feed-icon " + first.tone}>{first.icon}</div>
                            <div className="wcf-feed-body">
                              <div className="wcf-feed-text">
                                {row.group === "join" ? (
                                  <>
                                    <strong>{row.items.length} new faces</strong> joined the club: {listNames(names)}
                                  </>
                                ) : (
                                  <>
                                    <strong>Appearance milestones:</strong> {listNames(names)}
                                  </>
                                )}
                              </div>
                              {row.group === "join" && (
                                <div className={"wcf-faces" + (freshKeys.has(first.key) ? " walk" : "")}>
                                  {row.items.slice(0, 6).map((x, i) => {
                                    const pr = profiles.find((pp) => `join-${pp.id}` === x.key);
                                    if (!pr) return null;
                                    return (
                                      <span key={x.key} className="wcf-face" style={{ "--d": `${0.6 + i * 0.25}s` } as React.CSSProperties}>
                                        <Avatar
                                          name={pr.display_name}
                                          avatarUrl={pr.avatar_url}
                                          className="wcf-avatar-chip"
                                          background={avatarFor(pr.display_name).gradient}
                                        />
                                        <span>{pr.display_name.split(" ")[0]}</span>
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                              <div className="wcf-feed-date">{fmtFeedDate(first.ts)}</div>
                              {isAdmin && (
                                <div className="wcf-feed-item-actions">
                                  <button
                                    className="wcf-feed-archive-btn"
                                    onClick={async () => {
                                      if (
                                        await askConfirm(
                                          `Archive these ${row.items.length}?`,
                                          'You can restore them one by one from "Show archived".',
                                          "Archive",
                                          false,
                                        )
                                      ) {
                                        hideFeedItems(row.items.map((x) => x.key));
                                      }
                                    }}
                                  >
                                    Archive
                                  </button>
                                </div>
                              )}
                            </div>
                          </article>
                        );
                      }
                      const item = row.item;
                      const isHidden = hiddenFeedKeys.includes(item.key);
                      return (
                        <article
                          key={item.key}
                          className={"wcf-feed-item" + (freshKeys.has(item.key) ? " fresh" : "")}
                          style={freshKeys.has(item.key) ? freshStyle(item.key) : undefined}
                        >
                          {(feedReactionTally[item.key]?.["🔥"] ?? 0) >= 5 && <span className="wcf-fire-tag">🔥 On fire</span>}
                          {freshKeys.has(item.key) && item.key.startsWith("pot-") && motionAllowed() && <CoinRain />}
                          <div className={"wcf-feed-icon " + item.tone}>{item.icon}</div>
                          <div className="wcf-feed-body">
                            <div className="wcf-feed-text">{item.text}</div>
                            <div className="wcf-feed-date">{fmtFeedDate(item.ts)}</div>
                            <div className="wcf-feed-item-actions">
                              {reactionRow(item)}
                              {isAdmin && (
                                <button
                                  className="wcf-feed-archive-btn"
                                  onClick={async () => {
                                    if (isHidden) return unhideFeedItem(item.key);
                                    if (await askConfirm("Archive this from the feed?", 'You can restore it later from "Show archived".', "Archive", false)) {
                                      hideFeedItem(item.key);
                                    }
                                  }}
                                >
                                  {isHidden ? "↺ Restore" : "Archive"}
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ))}
              </div>
            </FeedFreshCtx.Provider>
          );
        })()}
    </>
  );
}
