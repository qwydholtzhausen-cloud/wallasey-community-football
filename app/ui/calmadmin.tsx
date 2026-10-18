// Calm Admin (2026-10-18): the admin tab in the calm family but built for
// getting jobs done. Today is one inbox (each job once; payments open in
// place to confirm one by one or all), then this week at a glance. Games
// splits into Needs you (one big button per job) and On track (quiet rows
// with a paid bar, tap for the full fixture). Money carries the club pot.
// The markup lives in AdminConsole (WirralCommunityFootball.tsx) so it
// reuses its actions; this is the look.

export const calmAdminCss = `
.ca-tabs{display:flex;gap:22px;margin:4px 2px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.ca-tabs button{position:relative;padding:0 0 10px;border:0;background:none;color:#64748b;font:600 12.5px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;cursor:pointer}
.ca-tabs button.on{color:#fff}
.ca-tabs button.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:#f5d97a;border-radius:2px}
.ca-tabs i{position:absolute;top:-10px;right:-18px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#f5d97a;color:#1a1405;font:800 9.5px/16px var(--sans);font-style:normal;text-align:center;letter-spacing:0}
.ca-head{position:relative;overflow:hidden;width:100%;margin:0 0 14px;padding:14px 16px;border-radius:20px;background:#0f1424;border:1px solid rgba(245,217,122,.25);box-shadow:0 22px 44px -28px rgba(0,0,0,.9);text-align:left;color:#fff;cursor:pointer}
.ca-head::before{content:"";position:absolute;inset:0;background:url(/pitch-floodlit.jpg) center 35%/cover;opacity:.3}
.ca-head::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(15,20,36,.96) 40%,rgba(15,20,36,.55))}
.ca-head>*{position:relative;z-index:1}
.ca-head small{display:block;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.ca-head b{display:block;margin-top:3px;font:800 21px/1.15 var(--display);color:#fff}
.ca-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.ca-chips span{padding:3px 9px;border-radius:999px;font:700 11px var(--sans);color:#cbd5e1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}
.ca-chips .g{color:#86efac;border-color:rgba(74,222,128,.3)}
.ca-chips .r{color:#fca5a5;border-color:rgba(248,113,113,.35)}
.ca-chips .w{color:#fde68a;border-color:rgba(245,217,122,.35)}
.ca-card{position:relative;border-radius:22px;overflow:hidden;margin:0 0 14px;padding-bottom:4px;background:#0f1424;border:1px solid rgba(245,217,122,.22);box-shadow:0 22px 44px -28px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05)}
.ca-card.quiet{border-color:rgba(255,255,255,.08)}
.ca-ch{display:flex;align-items:center;gap:10px;padding:16px 16px 10px}
.ca-ch h4{margin:0;font:700 22px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff}
.ca-ch span{margin-left:auto;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#94a3b8}
.ca-rule{height:1px;margin:0 16px 4px;background:linear-gradient(90deg,#f5d97a,rgba(245,217,122,.12) 70%,transparent)}
.ca-row{position:relative;display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.05)}
.ca-rule + .ca-row,.ca-rule + .ca-pay > .ca-row{border-top:0}
.ca-row .i{width:34px;height:34px;flex:none;border-radius:50%;display:grid;place-items:center;font:800 14px var(--display);background:rgba(245,217,122,.12);color:#f5d97a}
.ca-row.blue .i{background:rgba(96,165,250,.12);color:#93c5fd}
.ca-row.red .i{background:rgba(248,113,113,.12);color:#fca5a5}
.ca-row .tx{flex:1;min-width:0}
.ca-row .tx b{display:block;font:700 14px var(--sans);color:#fff}
.ca-row .tx small{display:block;margin-top:1px;font:500 12px var(--sans);color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-row .btns{display:flex;gap:6px;flex:none}
.ca-btn{flex:none;height:34px;padding:0 13px;border-radius:11px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:800 12.5px var(--display);cursor:pointer;white-space:nowrap}
.ca-btn.gold{border:0;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;box-shadow:0 8px 18px -10px rgba(245,217,122,.9)}
.ca-btn.red{color:#fca5a5;border-color:rgba(248,113,113,.4)}
.ca-btn.blue{color:#93c5fd;border-color:rgba(96,165,250,.4)}
.ca-btn u{text-decoration:none;display:inline-block;transition:transform .3s}
.ca-pay.open .ca-btn u{transform:rotate(90deg)}
.ca-x{display:grid;grid-template-rows:0fr;transition:grid-template-rows .45s cubic-bezier(.2,.9,.3,1)}
.ca-x>div{overflow:hidden;min-height:0}
.ca-pay.open .ca-x{grid-template-rows:1fr}
.ca-cl{position:relative;display:flex;align-items:center;gap:11px;padding:10px 16px 10px 20px;border-top:1px solid rgba(255,255,255,.05);background:rgba(245,217,122,.03);transition:opacity .4s}
.ca-av{width:32px;height:32px;border-radius:50%;flex:none;object-fit:cover;display:grid;place-items:center;font:800 12px var(--display);color:#fff;background:linear-gradient(140deg,#475569,#334155)}
.ca-cl .tx{flex:1;min-width:0}
.ca-cl b{display:block;font:700 13.5px var(--sans);color:#fff}
.ca-cl small{display:block;font:500 11.5px var(--sans);color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-cl .stamp{position:absolute;right:20px;top:50%;padding:3px 10px;border:2px solid #4ade80;border-radius:6px;color:#4ade80;font:800 13px var(--font-oswald),sans-serif;letter-spacing:.2em;transform:translateY(-50%) rotate(-12deg) scale(2.2);opacity:0;pointer-events:none}
.ca-cl.stamped .stamp{animation:caStamp .45s cubic-bezier(.3,1.6,.5,1) forwards}
.ca-cl.stamped .ca-btn{visibility:hidden}
.ca-cl.stamped .tx{opacity:.5}
@keyframes caStamp{to{opacity:1;transform:translateY(-50%) rotate(-12deg) scale(1)}}
.ca-all{display:block;width:calc(100% - 32px);margin:10px 16px 10px;height:40px;border-radius:12px;border:1px solid rgba(245,217,122,.5);background:rgba(245,217,122,.1);color:#f5d97a;font:800 13px var(--display);cursor:pointer}
.ca-done{display:flex;align-items:center;gap:10px;padding:14px 16px;font:700 13.5px var(--sans);color:#86efac}
.ca-done span{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:rgba(74,222,128,.15)}
.ca-wk{display:flex;align-items:center;gap:12px;width:100%;padding:11px 16px;border:0;border-top:1px solid rgba(255,255,255,.05);background:none;color:#fff;text-align:left;cursor:pointer}
.ca-rule + .ca-wk,.ca-rule + .ca-gw .ca-nd,.ca-rule + .ca-gw .ca-wk{border-top:0}
.ca-d{width:36px;text-align:center;flex:none}
.ca-d b{display:block;font:800 18px/1 var(--display);color:#fff}
.ca-d small{font:600 9px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#94a3b8}
.ca-wk .tx{flex:1;min-width:0}
.ca-wk .tx b{display:block;font:700 13.5px var(--sans);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-wk .tx small{display:block;font:500 11.5px var(--sans);color:#94a3b8}
.ca-wk .n{font:700 12px var(--sans);color:#94a3b8;font-variant-numeric:tabular-nums}
.ca-wk .ch{color:#475569;font-weight:800}
.ca-bar{display:flex;gap:2px;height:6px;margin:6px 0 5px;border-radius:999px;overflow:hidden}
.ca-bar i{display:block}
.ca-bar .pd,.ca-key .pd{background:#4ade80}
.ca-bar .np,.ca-key .np{background:#f5d97a}
.ca-bar .em,.ca-key .em{background:rgba(255,255,255,.1)}
.ca-key{display:flex;gap:14px;padding:8px 16px 10px;font:600 10.5px var(--sans);color:#64748b}
.ca-key span{display:flex;align-items:center;gap:5px}
.ca-key i{width:8px;height:8px;border-radius:2px}
.ca-xi{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;font:800 9px var(--font-oswald),sans-serif;letter-spacing:.14em;font-style:normal;vertical-align:2px}
.ca-nd{display:flex;align-items:center;gap:12px;padding:14px 16px 8px;border-top:1px solid rgba(255,255,255,.06)}
.ca-nd .ca-d b{font-size:22px}
.ca-nd .tx{flex:1;min-width:0}
.ca-nd em{display:block;font:700 10.5px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;font-style:normal;color:#f5d97a}
.ca-nd .tx > b{display:block;font:800 17px var(--display);color:#fff;margin-top:1px}
.ca-nd small{display:block;font:500 12px var(--sans);color:#94a3b8}
.ca-steps{display:flex;gap:8px;padding:2px 16px 14px}
.ca-steps button{flex:1;height:44px;border-radius:13px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:800 14px var(--display);cursor:pointer;white-space:nowrap}
.ca-steps button.go{border:0;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;box-shadow:0 10px 22px -12px rgba(245,217,122,.9)}
.ca-steps button.red{border-color:rgba(248,113,113,.5);color:#fca5a5;background:rgba(248,113,113,.08)}
.ca-steps button.more{flex:0 0 auto;padding:0 14px;color:#94a3b8}
.ca-open{padding:4px 10px 10px}
.ca-more{display:block;width:100%;padding:12px;border:0;border-top:1px solid rgba(255,255,255,.06);background:none;font:700 12.5px var(--sans);color:#f5d97a;cursor:pointer}
.ca-link{display:flex;align-items:center;gap:12px;width:100%;margin:0 0 16px;padding:13px 16px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#fff;text-align:left;cursor:pointer}
.ca-link span{flex:1}
.ca-link small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#94a3b8}
.ca-link b{display:block;margin-top:2px;font:700 13px var(--sans);color:#e2e8f0}
.ca-link em{font-style:normal;color:#f5d97a;font-weight:800}
.ca-clear{margin:2px 4px 18px;font:600 12.5px var(--sans);color:#86efac}
@media (prefers-reduced-motion: reduce){.ca-cl.stamped .stamp{animation:none;opacity:1;transform:translateY(-50%) rotate(-12deg)}}
`;
