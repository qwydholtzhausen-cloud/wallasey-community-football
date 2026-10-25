// One house style (2026-10-17): the app grew a tab at a time, so the same
// screen used several label styles, button shapes and tab switchers. This
// sheet pulls them onto one kit without touching any layout:
// - labels: Oswald section heads on a short gold rule; gold labels on photos
// - tabs: one segmented switcher (Feed's Feed/Boot Room now matches Line-up
//   and Results)
// - buttons: glossy red for the one thing to do, glass for everything else,
//   one frosted pill for extras
// - cards: one corner radius and edge highlight
// Takeovers (.special, .mdx) keep their own look because their rules are
// more specific. Added only while HOUSE_STYLE is on for this player.

const LABELS =
  ".wcf-eyebrow,.wcf-heading h2,.wcf-month-head,.wcf-feed-section-label,.wcf-stories-head b,.wcf-lineup-group-label,.wcf-ft-label,.wcf-h2h-header,.wcf-rivalry-title";
const PHOTO_LABELS =
  ".wcf-feed-hero-eyebrow,.wcf-lineup-eyebrow,.wcf-potm-eyebrow,.wcf-season-hero-eyebrow,.wcf-streak-eyebrow,.wr-banner .k,.wcf-prog-card small";
const PRIMARY = ".wcf-book:not(.cancel):not(.waitlist),.wcf-owe .go";
const SECONDARY = ".wcf-book.cancel,.wcf-book.waitlist,.wcf-ghost,.wcf-cal-btn";
const PILLS = ".wcf-addbtn.ghost,.wcf-story-pill,.wcf-potm-share,.wcf-stories-head button,.wcf-notif-on";
const CARDS = ".wcf-fx-row,.wcf-owe,.wr-banner,.wcf-prog-card,.wcf-rate-card,.wcf-vote-prompt,.wcf-feed-item,.wcf-lineup-head";

export const houseStyleCss = `
${LABELS}{font:600 12.5px/1.2 var(--font-oswald),sans-serif!important;letter-spacing:.16em!important;text-transform:uppercase!important;color:#e2e8f0!important;border-left:3px solid #f5d97a!important;padding-left:8px!important}
${PHOTO_LABELS}{font:600 11px/1.2 var(--font-oswald),sans-serif!important;letter-spacing:.22em!important;text-transform:uppercase!important;color:#f5d97a!important}
.wcf-feed-hero-tabs,.wcf-subtabs{display:flex!important;gap:4px!important;padding:4px!important;border-radius:14px!important;background:rgba(255,255,255,.05)!important;border:1px solid rgba(255,255,255,.1)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)!important}
.wcf-feed-hero-tabs button,.wcf-subtabs button{flex:1!important;min-height:36px!important;padding:8px 6px!important;border-radius:10px!important;border:0!important;background:transparent!important;color:#94a3b8!important;font:800 12px var(--display)!important;letter-spacing:.01em!important;box-shadow:none!important}
.wcf-feed-hero-tabs button.active,.wcf-subtabs button.active{background:linear-gradient(180deg,#ef4655,#d62839)!important;color:#fff!important;box-shadow:0 6px 16px -8px rgba(230,57,70,.95),inset 0 1px 0 rgba(255,255,255,.22)!important}
${PRIMARY}{background:linear-gradient(180deg,#ef4655,#d62839)!important;color:#fff!important;border:0!important;border-radius:14px!important;font:800 13.5px var(--display)!important;box-shadow:0 10px 22px -12px rgba(230,57,70,.95),inset 0 1px 0 rgba(255,255,255,.22)!important}
.wcf-book:disabled{background:var(--panel2)!important;color:var(--dim)!important;box-shadow:none!important}
${SECONDARY}{background:rgba(255,255,255,.05)!important;color:#f1f5f9!important;border:1px solid rgba(255,255,255,.14)!important;border-radius:14px!important;font:800 13.5px var(--display)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)!important}
.wcf-owe .go{font-size:12px!important;padding:8px 13px!important;border-radius:10px!important}
${PILLS}{background:rgba(13,13,26,.55)!important;color:#e2e8f0!important;border:1px solid rgba(255,255,255,.18)!important;border-radius:999px!important;font:700 12px var(--sans)!important;padding:7px 13px!important;min-height:0!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)!important;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
${CARDS}{border-radius:18px!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 18px 38px -30px #000!important}
`;
