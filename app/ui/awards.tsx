"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import type { AwardCategory, AwardNomination, AwardSeason, AwardVote } from "../../lib/awards";

// Season awards: one hook loads the current season's setup, its awards and
// nominations (players only get the shortlist and their own suggestions,
// by row-level security) and your own votes. Until the award_* SQL is on
// the live database every query fails, and everything stays hidden.

export interface AwardsApi {
  ready: boolean;
  missing: boolean;
  season: AwardSeason | null;
  categories: AwardCategory[];
  nominations: AwardNomination[];
  myVotes: AwardVote[];
  reload: () => Promise<void>;
}

export function useSeasonAwards(myId: string | null): AwardsApi {
  const [state, setState] = useState<Omit<AwardsApi, "reload">>({ ready: false, missing: false, season: null, categories: [], nominations: [], myVotes: [] });
  const reload = useCallback(async () => {
    if (!myId) return;
    const { data: seasons, error } = await supabase.from("award_seasons").select("*").order("season", { ascending: false }).limit(1);
    if (error) return setState({ ready: true, missing: true, season: null, categories: [], nominations: [], myVotes: [] });
    const season = (seasons?.[0] as AwardSeason | undefined) ?? null;
    if (!season) return setState({ ready: true, missing: false, season: null, categories: [], nominations: [], myVotes: [] });
    const { data: cats } = await supabase.from("award_categories").select("*").eq("season", season.season).order("sort").order("created_at");
    const categories = (cats ?? []) as AwardCategory[];
    const ids = categories.map((c) => c.id);
    const [{ data: noms }, { data: votes }] = await Promise.all([
      ids.length ? supabase.from("award_nominations").select("*").in("category_id", ids).order("created_at") : Promise.resolve({ data: [] }),
      ids.length ? supabase.from("award_votes").select("category_id, player_id, nomination_id").in("category_id", ids).eq("voter_id", myId) : Promise.resolve({ data: [] }),
    ]);
    setState({ ready: true, missing: false, season, categories, nominations: (noms ?? []) as AwardNomination[], myVotes: (votes ?? []) as AwardVote[] });
  }, [myId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

export const awardsCss = `
.aw{display:grid;gap:14px;color:#fff;margin-bottom:20px}
.aw small.ey,.aw-sheet small.ey{display:block;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.aw-card{border-radius:20px;padding:16px;background:#0f1424;border:1px solid rgba(245,217,122,.18);box-shadow:0 22px 44px -28px #000}
.aw-card header{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(245,217,122,.25)}
.aw-card h4{margin:0;font:700 20px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff}
.aw-card header span,.aw-card header button.lnk{margin-left:auto;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#94a3b8;white-space:nowrap;background:none;border:0;cursor:pointer;padding:0}
.aw-card header button.lnk{color:#f5d97a}
.aw-hero{position:relative;overflow:hidden;border-radius:20px;padding:18px;border:1px solid rgba(245,217,122,.35);background:radial-gradient(90% 80% at 85% 0%,rgba(245,217,122,.22),transparent 60%),#0f1424}
.aw-hero b{display:block;margin-top:4px;font:800 26px/1.05 var(--font-oswald),sans-serif;color:#fff}
.aw-hero p{margin:6px 0 14px;color:#cbd5e1;font:500 13px/1.45 var(--sans)}
.aw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:13px;border:0;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;font:800 14px var(--font-oswald),sans-serif;letter-spacing:.04em;cursor:pointer}
.aw-btn:disabled{opacity:.45;cursor:default}
.aw-btn.ghost{background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.14)}
.aw-btn.danger{background:none;color:#fca5a5;border:1px solid rgba(248,113,113,.35)}
.aw-btn.full{width:100%}
.aw-tl .r{display:grid;grid-template-columns:14px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid rgba(255,255,255,.06)}
.aw-tl .r:first-child{border-top:0}
.aw-tl .r i{width:10px;height:10px;border-radius:50%;background:#334155}
.aw-tl .r.now i{background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.25)}
.aw-tl .r.gold i{background:#f5d97a}
.aw-tl .r span{font:600 13px var(--sans);color:#e2e8f0}
.aw-tl .r em{font:700 12px var(--sans);font-style:normal;color:#f5d97a;white-space:nowrap}
.aw-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.aw-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);font:600 11.5px var(--sans);color:#cbd5e1}
.aw-chip b{color:#fff}
.aw-row{display:grid;grid-template-columns:28px 40px minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 0;border-top:1px solid rgba(255,255,255,.06)}
.aw-row:first-of-type{border-top:0}
.aw-row .mv{display:grid;gap:2px}
.aw-row .mv button{width:26px;height:18px;border:0;border-radius:5px;background:rgba(255,255,255,.05);color:#94a3b8;font-size:10px;cursor:pointer;padding:0}
.aw-row .mv button:disabled{opacity:.25}
.aw-row .ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font:800 18px var(--font-oswald),sans-serif;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.3);color:#f5d97a}
.aw-row .ic.auto{background:rgba(148,163,184,.08);border-color:rgba(148,163,184,.25);color:#cbd5e1}
.aw-row .tx{min-width:0;text-align:left;background:none;border:0;color:#fff;padding:0;cursor:pointer}
.aw-row .tx b{display:block;font:700 14.5px var(--sans)}
.aw-row .tx small{display:block;margin-top:2px;font:500 11.5px var(--sans);color:#94a3b8}
.aw-row .tx small em{font-style:normal;color:#fbbf24;font-weight:700}
.aw-row .go{color:#f5d97a;font-weight:800;background:none;border:0;font-size:16px;cursor:pointer}
.aw-add{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:10px;min-height:46px;border-radius:14px;border:1px dashed rgba(245,217,122,.5);background:rgba(245,217,122,.05);color:#f5d97a;font:800 14px var(--font-oswald),sans-serif;letter-spacing:.04em;cursor:pointer}
.aw-back{justify-self:start;display:inline-flex;align-items:center;gap:6px;padding:8px 14px 8px 10px;border-radius:12px;border:0;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;font:800 13px var(--font-oswald),sans-serif;cursor:pointer}
.aw-note{font:500 12.5px/1.45 var(--sans);color:#94a3b8;margin:0 0 12px}
.aw-dim{position:fixed;inset:0;z-index:400;background:rgba(3,5,10,.66)}
.aw-sheet{position:fixed;left:0;right:0;bottom:0;z-index:401;max-height:88vh;overflow:auto;padding:16px max(16px,env(safe-area-inset-right)) calc(26px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));border-radius:24px 24px 0 0;background:linear-gradient(180deg,#151c30,#0b0f1c);border-top:1px solid rgba(245,217,122,.3);color:#fff;box-sizing:border-box;animation:awUp .35s cubic-bezier(.2,1,.3,1) both}
@keyframes awUp{from{transform:translateY(40px);opacity:0}}
.aw-sheet .bar{width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,.2);margin:0 auto 12px}
.aw-sheet h3{margin:4px 0 12px;font:800 22px var(--font-oswald),sans-serif}
.aw-f{display:grid;gap:6px;margin-bottom:14px}
.aw-f label{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#94a3b8}
.aw-in{width:100%;box-sizing:border-box;padding:12px 13px;border-radius:12px;background:#060912;border:1px solid rgba(255,255,255,.12);font:600 15px var(--sans);color:#fff}
textarea.aw-in{min-height:64px;resize:vertical;font-weight:500;line-height:1.4}
.aw-kinds{display:grid;gap:8px}
.aw-kind{display:grid;grid-template-columns:22px 1fr;gap:10px;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);text-align:left;color:#fff;cursor:pointer}
.aw-kind i{width:18px;height:18px;border-radius:50%;border:2px solid #475569;margin-top:1px;box-sizing:border-box}
.aw-kind.on{border-color:rgba(245,217,122,.6);background:rgba(245,217,122,.07)}
.aw-kind.on i{border-color:#f5d97a;box-shadow:inset 0 0 0 3px #0f1424;background:#f5d97a}
.aw-kind:disabled{opacity:.4;cursor:default}
.aw-kind b{font:700 14px var(--sans)}.aw-kind small{display:block;margin-top:2px;font:500 12px/1.4 var(--sans);color:#94a3b8}
.aw-tog{display:flex;align-items:center;gap:12px;width:100%;padding:12px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);color:#fff;text-align:left;cursor:pointer;margin-bottom:14px}
.aw-tog span{flex:1;font:600 13.5px var(--sans)}.aw-tog span small{display:block;font-weight:500;color:#94a3b8;font-size:12px;margin-top:2px}
.aw-sw{width:44px;height:26px;border-radius:13px;background:#334155;position:relative;flex:none;transition:background .2s}.aw-sw::after{content:"";position:absolute;left:3px;top:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s}
.aw-sw.on{background:#4ade80}.aw-sw.on::after{left:21px}
.aw-tip{display:grid;gap:8px;padding:12px;border-radius:14px;background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.35);margin-bottom:14px}
.aw-tip b{font:700 13.5px var(--sans);color:#bbf7d0}.aw-tip span{font:500 12.5px/1.45 var(--sans);color:#cbd5e1}
.aw-tip .aw-btn{min-height:36px;font-size:13px;justify-self:start}
.aw-step{display:flex;align-items:center;gap:12px}.aw-step button{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:none;color:#fff;font-weight:800;cursor:pointer}.aw-step b{font:800 22px var(--font-oswald),sans-serif;min-width:26px;text-align:center}
.aw-step small{color:#94a3b8;font:500 12px var(--sans)}
.aw-ideas{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.aw-idea{padding:8px 12px;border-radius:999px;border:1px solid rgba(245,217,122,.45);background:rgba(245,217,122,.06);font:700 12.5px var(--sans);color:#f5d97a;cursor:pointer}
.aw-idea:disabled{border-color:rgba(255,255,255,.12);background:none;color:#64748b;text-decoration:line-through;cursor:default}
.aw-seg{display:flex;gap:6px;margin:0 0 12px}.aw-seg button{flex:1;padding:8px 4px;border-radius:10px;border:0;font:700 12.5px var(--sans);color:#94a3b8;background:rgba(255,255,255,.04);cursor:pointer}.aw-seg button.on{background:#f5d97a;color:#1a1405}
.aw-nom,.aw-qa{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid rgba(255,255,255,.06)}
.aw-nom:first-of-type,.aw-qa:first-of-type{border-top:0}
.aw-nom b,.aw-qa b{display:block;font:700 14px var(--sans)}.aw-nom small,.aw-qa small{display:block;margin-top:2px;font:500 11.5px/1.35 var(--sans);color:#94a3b8}
.aw-face{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#1e293b;display:grid;place-items:center;font:800 15px var(--font-oswald),sans-serif;color:#94a3b8;box-shadow:0 0 0 2px rgba(255,255,255,.12)}
.aw-big{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(245,217,122,.08);border:1px solid rgba(245,217,122,.25);font:800 15px var(--font-oswald),sans-serif;color:#f5d97a}
.aw-x{background:none;border:0;color:#64748b;font-size:18px;cursor:pointer;padding:4px 6px}
.aw-plus{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(245,217,122,.55);background:none;color:#f5d97a;font:800 18px var(--sans);cursor:pointer}
.aw-plus.on{background:#4ade80;border-color:#4ade80;color:#0b1a10;cursor:default}
.aw-sug{display:grid;gap:8px;padding:12px;border-radius:14px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.3);margin-top:8px}
.aw-sug b{font:700 14px var(--sans)}.aw-sug small{display:block;font:500 12px/1.4 var(--sans);color:#cbd5e1}
.aw-sug .by{font:700 11px var(--sans);color:#fbbf24}
.aw-sug .acts{display:flex;gap:8px}.aw-sug .acts .aw-btn{min-height:36px;font-size:13px;flex:1}
.aw-pick{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 6px}
.aw-pick button,.aw-multi button{display:grid;justify-items:center;gap:4px;font:600 11px var(--sans);color:#cbd5e1;flex:none;width:56px;background:none;border:0;padding:0;cursor:pointer;position:relative}
.aw-pick button.on,.aw-multi button.on{color:#f5d97a}
.aw-pick button.on .aw-face,.aw-multi button.on .aw-face{box-shadow:0 0 0 2px #f5d97a,0 0 14px rgba(245,217,122,.6)}
.aw-multi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 6px}
.aw-multi button{width:auto}
.aw-multi button.on::after{content:"✓";position:absolute;top:-2px;right:8px;width:18px;height:18px;border-radius:50%;background:#f5d97a;color:#1a1405;font:800 11px/18px var(--sans);text-align:center}
.aw-games{display:grid;gap:6px;max-height:180px;overflow:auto}
.aw-game{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:12px;background:#060912;border:1px solid rgba(255,255,255,.1);font:600 13px var(--sans);color:#fff;cursor:pointer;text-align:left}
.aw-game.on{border-color:rgba(245,217,122,.6);background:rgba(245,217,122,.07)}
.aw-game em{margin-left:auto;font-style:normal;font:800 13px var(--font-oswald),sans-serif;color:#cbd5e1}
.aw-turn{display:flex;align-items:baseline;gap:8px}
.aw-turn b{font:800 40px/1 var(--font-oswald),sans-serif;color:#f5d97a}.aw-turn span{font:600 14px var(--sans);color:#cbd5e1}
.aw-barr{height:10px;border-radius:5px;background:rgba(255,255,255,.08);overflow:hidden;margin:10px 0 4px}.aw-barr i{display:block;height:100%;background:linear-gradient(90deg,#b8860b,#f5d97a)}
.aw-per{display:grid;grid-template-columns:1fr auto;gap:6px 10px;margin-top:12px;font:600 13px var(--sans);color:#cbd5e1}.aw-per em{font-style:normal;color:#fff;font-weight:800}
.aw-seal{display:flex;align-items:center;gap:10px;margin-top:14px;padding:10px 12px;border-radius:12px;background:rgba(224,68,79,.08);border:1px solid rgba(224,68,79,.3);font:600 12.5px/1.4 var(--sans);color:#fecaca}
.aw-seal i{width:26px;height:26px;border-radius:50%;flex:none;background:radial-gradient(circle at 35% 30%,#e0444f,#8b0f18)}

.aw-bal{position:fixed;inset:0;z-index:420;display:flex;flex-direction:column;background:radial-gradient(90% 50% at 50% 0%,rgba(245,217,122,.12),transparent 60%),#07090f;color:#fff;padding:env(safe-area-inset-top) 0 0}
.aw-bal .top{display:flex;align-items:center;gap:10px;padding:16px 16px 10px}
.aw-bal .top .x{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.16);display:grid;place-items:center;color:#cbd5e1;font-weight:800;background:none;cursor:pointer;flex:none}
.aw-bal .top .prog{flex:1;display:flex;gap:4px}.aw-bal .top .prog i{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.12)}.aw-bal .top .prog i.on{background:#f5d97a}
.aw-bal .top small{font:600 11px var(--font-oswald),sans-serif;letter-spacing:.16em;color:#94a3b8}
.aw-bal .body{flex:1;overflow:auto;padding:4px 18px 12px;display:flex;flex-direction:column}
.aw-bal .ey{font:600 11px var(--font-oswald),sans-serif;letter-spacing:.3em;text-transform:uppercase;color:#f5d97a}
.aw-bal h2{margin:6px 0 4px;font:800 30px/1.04 var(--font-oswald),sans-serif;text-wrap:balance}
.aw-bal .sub{margin:0 0 14px;color:#a3adc2;font:500 13.5px/1.45 var(--sans)}
.aw-bal .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 6px}
.aw-bal .pf{display:grid;justify-items:center;gap:5px;text-align:center;font:600 12px var(--sans);color:#cbd5e1;background:none;border:0;padding:0;cursor:pointer;min-width:0}
.aw-bal .pf .aw-face{width:58px;height:58px;font-size:20px}
.aw-bal .pf span.n{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-bal .pf.on{color:#f5d97a}.aw-bal .pf.on .aw-face{box-shadow:0 0 0 3px #f5d97a,0 0 22px rgba(245,217,122,.6)}
.aw-bal .pf small{font-size:10.5px;color:#64748b;font-weight:500}
.aw-bal .noms{display:grid;gap:10px}
.aw-bal .nm{display:grid;grid-template-columns:52px minmax(0,1fr) 24px;gap:12px;align-items:center;padding:12px;border-radius:16px;background:#0f1424;border:1px solid rgba(255,255,255,.1);color:#fff;text-align:left;cursor:pointer}
.aw-bal .nm .aw-face,.aw-bal .nm .aw-big{width:52px;height:52px}
.aw-bal .nm b{display:block;font:700 15px var(--sans)}.aw-bal .nm small{display:block;margin-top:2px;font:500 12px/1.4 var(--sans);color:#94a3b8}
.aw-bal .nm .tick{width:22px;height:22px;border-radius:50%;border:2px solid #475569;box-sizing:border-box}
.aw-bal .nm.on{border-color:rgba(245,217,122,.7);background:linear-gradient(135deg,rgba(245,217,122,.12),#0f1424 60%)}.aw-bal .nm.on .tick{border-color:#f5d97a;background:#f5d97a;box-shadow:inset 0 0 0 4px #0f1424}
.aw-bal .foot{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:12px 18px calc(18px + env(safe-area-inset-bottom))}
.aw-bal .foot.one{grid-template-columns:1fr}
.aw-bal .btn{min-height:50px;border-radius:15px;border:0;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;font:800 16px var(--font-oswald),sans-serif;letter-spacing:.05em;cursor:pointer}
.aw-bal .btn:disabled{opacity:.5}
.aw-bal .btn.ghost{background:none;border:1px solid rgba(255,255,255,.16);color:#cbd5e1;padding:0 18px}
.aw-bal .intro{flex:1;display:flex;flex-direction:column;justify-content:center;text-align:center;align-items:center;gap:10px}
.aw-bal .intro img{width:70px}
.aw-bal .foil{background:linear-gradient(100deg,#b8860b,#f5d97a 35%,#fff6cf 50%,#f5d97a 65%,#b8860b);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:awFoil 3s linear infinite}
@keyframes awFoil{to{background-position:-250% 0}}
.aw-bal .list{display:grid;gap:6px;width:100%;max-width:300px;margin-top:6px}
.aw-bal .list span{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;border-radius:10px;background:rgba(255,255,255,.04);font:600 13px var(--sans);text-align:left}
.aw-bal .list span em{font-style:normal;color:#64748b;font-weight:500;white-space:nowrap}
.aw-bal .facts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}
.aw-bal .facts i{font-style:normal;padding:5px 10px;border-radius:999px;border:1px solid rgba(245,217,122,.35);font:600 11.5px var(--sans);color:#f5d97a}
.aw-bal .search{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:12px;background:#0f1424;border:1px solid rgba(255,255,255,.12);color:#fff;font:500 15px var(--sans);margin-bottom:12px}
.aw-paper{position:relative;margin:6px 0 30px;padding:20px 18px 16px;background:#f3eee2;color:#1b1b1b;border-radius:4px;box-shadow:0 30px 60px -30px #000;transform:rotate(-1deg)}
.aw-paper::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.035) 0 1px,transparent 1px 26px);pointer-events:none}
.aw-paper h3{margin:0 0 2px;font:800 20px var(--font-oswald),sans-serif;letter-spacing:.06em;text-align:center}
.aw-paper .s{text-align:center;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#7a6a3a;margin-bottom:12px}
.aw-paper .r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:9px 0;border-top:1px dashed rgba(0,0,0,.18)}
.aw-paper .r small{grid-column:1/-1;font:700 10px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#7a6a3a}
.aw-paper .r b{font:700 15px Georgia,serif}.aw-paper .r button{background:none;border:0;font:700 12px var(--sans);color:#a16207;cursor:pointer;align-self:center}
.aw-wax{position:absolute;right:16px;bottom:-22px;width:86px;height:86px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#e0444f,#8b0f18);display:grid;place-items:center;text-align:center;font:800 11px/1.15 var(--font-oswald),sans-serif;letter-spacing:.08em;color:#ffd7d7;box-shadow:0 8px 16px rgba(0,0,0,.5);transform:rotate(-12deg);animation:awWax .45s cubic-bezier(.3,1.5,.5,1) both}
@keyframes awWax{from{opacity:0;transform:scale(2.4) rotate(-20deg)}}
.aw-done{display:grid;justify-items:center;text-align:center;gap:8px;margin-top:30px}
@media (prefers-reduced-motion: reduce){.aw-sheet,.aw-wax,.aw-bal .foil{animation:none!important}}
`;
