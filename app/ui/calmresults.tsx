// Calm Results (admins first, 2026-10-17): Scores, Season and History
// instead of six sub-tabs. Season folds in the Stats leaderboard and the
// Records book as cards in the calm Fixtures / Feed family (photo top,
// gold rule, Oswald heading). The markup lives in app/ui/results.tsx so it
// shares the climb and record-falls moments; this is its look.

export const calmResultsCss = `
.cr-tabs{display:flex;gap:26px;margin:4px 2px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.cr-tabs button{position:relative;padding:0 0 10px;border:0;background:none;color:#64748b;font:600 12.5px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;cursor:pointer}
.cr-tabs button.on{color:#fff}
.cr-tabs button.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:#f5d97a;border-radius:2px}
.cr-tabs .wcf-hist-dot{position:absolute;top:-2px;right:-9px}
.cr-back{display:flex;align-items:center;gap:12px;margin:4px 2px 16px}
.cr-back button{padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e2e8f0;font:700 12.5px var(--sans);cursor:pointer}
.cr-back span{font:600 12.5px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#f5d97a}
.cr-card{position:relative;border-radius:22px;overflow:hidden;margin:0 0 14px;background:#0f1424;border:1px solid rgba(245,217,122,.22);box-shadow:0 22px 44px -28px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05)}
.cr-card::before{content:"";position:absolute;inset:0 0 auto 0;height:130px;background:var(--ph) center 40%/cover;opacity:.3;pointer-events:none}
.cr-card::after{content:"";position:absolute;inset:0 0 auto 0;height:130px;background:linear-gradient(180deg,rgba(15,20,36,.2),#0f1424);pointer-events:none}
.cr-card>*{position:relative;z-index:1}
.cr-ch{display:flex;align-items:center;gap:10px;padding:16px 16px 10px}
.cr-ch h4{margin:0;font:700 22px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff}
.cr-ch > span{margin-left:auto;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#94a3b8}
.cr-rule{height:1px;margin:0 16px 4px;background:linear-gradient(90deg,#f5d97a,rgba(245,217,122,.12) 70%,transparent)}
.cr-vs{display:grid;grid-template-columns:1fr auto 1fr;align-items:end;gap:10px;padding:14px 18px 10px}
.cr-vs small{display:block;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#94a3b8}
.cr-vs .s b{display:block;font:800 46px/1 var(--display);letter-spacing:-.03em;color:#e2e8f0;margin-top:4px;font-variant-numeric:tabular-nums}
.cr-vs span{font:600 11px var(--sans);color:#64748b}
.cr-vs .s.r{text-align:right}
.cr-vs .s.r b{color:#ff5a66}
.cr-vs .mid{text-align:center;padding-bottom:2px}
.cr-vs .mid b{display:block;font:800 22px/1 var(--display);color:#94a3b8}
.cr-bar{display:flex;gap:3px;height:8px;margin:2px 18px 6px;border-radius:999px;overflow:hidden}
.cr-bar i{display:block;transform-origin:left;animation:crBar .9s cubic-bezier(.2,.9,.3,1) both}
.cr-bar .w{background:#e2e8f0}.cr-bar .d{background:#475569}.cr-bar .r{background:#e63946;box-shadow:0 0 12px rgba(230,57,70,.6)}
@keyframes crBar{from{transform:scaleX(0)}}
.cr-goals{display:flex;justify-content:space-between;margin:0 18px 12px;font:600 11.5px var(--sans);color:#94a3b8}
.cr-run{display:flex;align-items:center;gap:10px;margin:0 16px 4px;padding:10px 12px;border-radius:14px;background:linear-gradient(90deg,rgba(230,57,70,.16),rgba(230,57,70,.03));border:1px solid rgba(230,57,70,.28)}
.cr-run.white{background:linear-gradient(90deg,rgba(226,232,240,.12),rgba(226,232,240,.02));border-color:rgba(226,232,240,.25)}
.cr-run i{width:8px;height:8px;border-radius:50%;flex:none;background:#ff5a66;animation:crPulse 1.8s ease-in-out infinite}
.cr-run.white i{background:#e2e8f0}
@keyframes crPulse{50%{opacity:.35}}
.cr-run b{display:block;font:800 13.5px var(--display);color:#fff}
.cr-run small{display:block;font:500 11.5px var(--sans);color:#94a3b8}
.cr-x{display:grid;grid-template-rows:0fr;transition:grid-template-rows .5s cubic-bezier(.2,.9,.3,1)}
.cr-x>div{overflow:hidden;min-height:0}
.cr-card.open .cr-x{grid-template-rows:1fr}
.cr-x table{width:calc(100% - 32px);margin:10px 16px 4px;border-collapse:collapse;font:600 12px var(--sans);color:#cbd5e1;font-variant-numeric:tabular-nums}
.cr-x th{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.18em;color:#64748b;text-align:right;padding:4px 0;text-transform:uppercase}
.cr-x td{text-align:right;padding:7px 0;border-top:1px solid rgba(255,255,255,.06)}
.cr-x td:first-child,.cr-x th:first-child{text-align:left}
.cr-x td b{color:#fff}
.cr-x .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}
.cr-x .dot.red{background:#e63946}.cr-x .dot.white{background:#e2e8f0}
.cr-all{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:13px;border:0;border-top:1px solid rgba(255,255,255,.06);background:none;font:700 12.5px var(--sans);color:#f5d97a;cursor:pointer}
.cr-all u{text-decoration:none;display:inline-block;transition:transform .3s}
.cr-card.open .cr-all u{transform:rotate(90deg)}
.cr-seg{margin-left:auto;display:flex;padding:3px;border-radius:10px;background:rgba(255,255,255,.06)}
.cr-seg button{padding:5px 11px;border:0;border-radius:8px;background:none;color:#94a3b8;font:700 11.5px var(--sans);cursor:pointer}
.cr-seg button.on{background:#f5d97a;color:#1a1405}
.cr-rows{margin-top:2px}
.cr-lr{position:relative;display:grid;grid-template-columns:22px 28px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:46px;padding:6px 16px;border-top:1px solid rgba(255,255,255,.05);cursor:pointer;background:#0f1424}
.cr-lr .rk{font:800 13px var(--display);color:#64748b;text-align:center}
.cr-lr .av{width:28px;height:28px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font:800 11px var(--display);color:#fff}
.cr-lr .nm{min-width:0}
.cr-lr .nm b{display:flex;align-items:center;gap:6px;font:700 13px var(--sans);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cr-lr .nm small{display:block;font:500 11px var(--sans);color:#64748b}
.cr-lr .nm em{font-style:normal;font:700 9px var(--font-oswald),sans-serif;letter-spacing:.14em;padding:2px 6px;border-radius:999px;background:#f5d97a;color:#1a1405}
.cr-lr .v{text-align:right;font:800 15px var(--display);color:#e2e8f0;font-variant-numeric:tabular-nums}
.cr-lr.top{border-top:0;padding-top:9px;padding-bottom:9px}
.cr-lr.top .rk{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;color:#1a1405;background:radial-gradient(circle at 35% 28%,#fff,var(--m) 55%);box-shadow:0 0 12px -2px var(--m)}
.cr-lr.top .av{width:42px;height:42px;font-size:15px;box-shadow:0 0 0 2px var(--m)}
.cr-lr.top{grid-template-columns:22px 42px minmax(0,1fr) auto}
.cr-lr.top .nm b{font:800 15px var(--display)}
.cr-lr.top .v{font-size:28px;line-height:1;color:var(--m)}
.cr-lb.seen .cr-lr.top{animation:crRise .55s cubic-bezier(.2,.9,.3,1) both;animation-delay:calc(var(--i) * .12s)}
@keyframes crRise{from{opacity:0;transform:translateY(14px)}}
.cr-lr.me{background:linear-gradient(90deg,rgba(245,217,122,.12),#0f1424)}
.cr-lr.me .v{color:#f5d97a}
.cr-lr .wcf-sclimb-plus{right:52px;transform:translateY(-50%)}
.cr-gap{text-align:center;color:#475569;letter-spacing:.3em;font-size:11px;padding:2px 0}
.cr-you{padding:16px;border-color:rgba(245,217,122,.35);background:linear-gradient(140deg,rgba(245,217,122,.10),#0f1424 55%)}
.cr-you::before,.cr-you::after{display:none}
.cr-youh{display:flex;align-items:center;gap:12px}
.cr-youf{width:46px;height:46px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font:800 17px var(--display);color:#fff;box-shadow:0 0 0 2px #f5d97a,0 0 18px -4px #f5d97a;flex:none}
.cr-youh small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.cr-youh b{display:block;font:800 17px var(--display);color:#fff}
.cr-youh i{display:block;font:500 11.5px var(--sans);font-style:normal;color:#94a3b8}
.cr-cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(245,217,122,.18)}
.cr-cells b{display:block;font:800 22px/1 var(--display);color:#fff;font-variant-numeric:tabular-nums}
.cr-cells small{display:block;margin-top:4px;font:600 9px/1.3 var(--font-oswald),sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8}
.cr-cells em{display:block;margin-top:3px;font:700 9.5px var(--sans);font-style:normal;color:#f5d97a}
.cr-cells .rec b{color:#f5d97a}
.cr-recs .wcf-rec-row{margin:0;border:0;border-top:1px solid rgba(255,255,255,.05);border-radius:0;background:none;padding:10px 16px}
.cr-recs .wcf-rec-row:first-of-type{border-top:0}
.cr-sub{padding:12px 16px 6px;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#94a3b8;border-top:1px solid rgba(255,255,255,.06)}
.cr-pot{display:flex;align-items:center;gap:14px;width:100%;margin:0 0 14px;padding:14px 16px;border-radius:18px;border:1px solid rgba(34,197,94,.35);background:linear-gradient(110deg,rgba(34,197,94,.14),rgba(15,20,36,.96) 60%);color:#fff;text-align:left;cursor:pointer}
.cr-pot span{flex:1;min-width:0}
.cr-pot small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#86efac}
.cr-pot b{display:block;font:800 22px var(--display);color:#fff}
.cr-pot i{display:block;font:500 11.5px var(--sans);font-style:normal;color:#94a3b8}
.cr-pot em{font-style:normal;color:#86efac;font-weight:800}
@media (prefers-reduced-motion: reduce){.cr-bar i,.cr-run i,.cr-lb.seen .cr-lr.top{animation:none!important}}
`;
