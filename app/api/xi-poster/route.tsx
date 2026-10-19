import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

// The First XI full-time poster (1080x1350, the shape WhatsApp and Instagram
// show best). The app sends what it already knows - score, scorers, the two
// XIs, Man of the Match once the vote's closed - and gets a PNG back to
// share. Drawn on the server so it looks the same on every phone.

export const runtime = "nodejs";

type Person = { name: string; avatar?: string | null; captain?: boolean; goals?: number; motm?: boolean };
type Scorer = { name: string; goals: number };
type Body = {
  red: number;
  white: number;
  redScorers: Scorer[];
  whiteScorers: Scorer[];
  reds: Person[];
  whites: Person[];
  motm: { name: string; avatar?: string | null } | null;
  voteCloses: string | null; // "4pm", while the vote is open
  dateLabel: string; // "SUN 25 OCT 2026"
  venue: string;
  stamp: string; // "25.10.26"
};

const dir = join(process.cwd(), "app/api/xi-poster");
let assets: Promise<{ fonts: { name: string; data: Buffer; weight: 600 | 700 | 800 }[]; crest: string }> | null = null;
function loadAssets() {
  assets ??= (async () => {
    const f = (n: string) => readFile(join(dir, "fonts", n));
    const [o6, o7, i6, i8, crest] = await Promise.all([f("oswald-600.ttf"), f("oswald-700.ttf"), f("inter-600.ttf"), f("inter-800.ttf"), readFile(join(dir, "crest.png"))]);
    return {
      fonts: [
        { name: "Oswald", data: o6, weight: 600 },
        { name: "Oswald", data: o7, weight: 700 },
        { name: "Inter", data: i6, weight: 600 },
        { name: "Inter", data: i8, weight: 800 },
      ],
      crest: `data:image/png;base64,${crest.toString("base64")}`,
    };
  })();
  return assets;
}

const str = (v: unknown, max = 60) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(99, Math.round(v))) : 0);

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return new Response("Not authenticated", { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const { data: who } = await createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!).auth.getUser(token);
  if (!who.user) return new Response("Not authenticated", { status: 401 });

  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // Photos only from our own storage.
  const okImg = (u: unknown) => (typeof u === "string" && u.startsWith(`${url}/storage/v1/object/public/`) ? u : null);
  const people = (a: unknown): Person[] =>
    (Array.isArray(a) ? a : []).slice(0, 16).map((p) => ({ name: str(p?.name, 40), avatar: okImg(p?.avatar), captain: !!p?.captain, goals: num(p?.goals), motm: !!p?.motm }));
  const scorers = (a: unknown): Scorer[] => (Array.isArray(a) ? a : []).slice(0, 12).map((s) => ({ name: str(s?.name, 40), goals: num(s?.goals) }));
  const reds = people(b.reds);
  const whites = people(b.whites);
  const redScorers = scorers(b.redScorers);
  const whiteScorers = scorers(b.whiteScorers);
  const motm = b.motm ? { name: str(b.motm.name, 60), avatar: okImg(b.motm.avatar) } : null;

  const { fonts, crest } = await loadAssets();

  // First names, with an initial where two share one.
  const all = [...reds, ...whites];
  const first = (n: string) => {
    const f = n.split(" ")[0];
    const parts = n.split(" ");
    return all.filter((p) => p.name.split(" ")[0] === f).length > 1 && parts.length > 1 ? `${f} ${parts[parts.length - 1][0]}.` : f;
  };
  const GOLD = "#f5d97a";
  const ball = (s: number) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="#fff" />
      <path d="M12 7.5l3 2.2-1.1 3.6h-3.8L9 9.7z" fill="#111" />
      <path d="M12 2v5.5M2.6 9l6.4 1M21.4 9l-6.4 1M6 20l3-4.5M18 20l-3-4.5" stroke="#111" strokeWidth="1.2" fill="none" />
    </svg>
  );
  const face = (p: { name: string; avatar?: string | null }, size: number, ring: string, glow = false) => (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#334155",
        border: `4px solid ${ring}`,
        boxShadow: glow ? `0 0 18px ${GOLD}` : "none",
        overflow: "hidden",
      }}
    >
      {p.avatar ? (
        <img src={p.avatar} width={size} height={size} style={{ objectFit: "cover" }} />
      ) : (
        <span style={{ fontFamily: "Oswald", fontWeight: 700, fontSize: size * 0.4, color: "#fff" }}>{(p.name.trim()[0] || "?").toUpperCase()}</span>
      )}
    </div>
  );
  const player = (p: Person, ring: string) => (
    <div key={p.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 100, marginBottom: 12 }}>
      <div style={{ display: "flex", position: "relative" }}>
        {face(p, 70, p.captain ? GOLD : ring, p.captain)}
        {p.captain && (
          <div
            style={{ position: "absolute", right: -6, top: -6, width: 28, height: 28, borderRadius: 28, background: GOLD, border: "2px solid #07080d", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Oswald", fontWeight: 700, fontSize: 16, color: "#1a1405" }}
          >
            C
          </div>
        )}
        {(p.goals ?? 0) > 0 && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: -8, display: "flex", justifyContent: "center" }}>
            <div style={{ display: "flex", gap: 1, padding: "1px 4px", borderRadius: 20, background: "#07080d" }}>{Array.from({ length: Math.min(4, p.goals ?? 0) }, () => ball(15))}</div>
          </div>
        )}
      </div>
      <div style={{ display: "flex", marginTop: 7, fontFamily: "Inter", fontWeight: 600, fontSize: 17, color: p.motm ? GOLD : "rgba(255,255,255,.9)" }}>{first(p.name)}</div>
    </div>
  );
  const side = (label: string, list: Person[], ring: string, labelColor: string) => (
    <div style={{ display: "flex", flexDirection: "column", width: 420 }}>
      <div style={{ display: "flex", fontFamily: "Oswald", fontWeight: 700, fontSize: 20, letterSpacing: 7, color: labelColor, marginBottom: 12 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap" }}>{list.map((p) => player(p, ring))}</div>
    </div>
  );
  const scorerList = (list: Scorer[]) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 14 }}>
      {list.map((s) => (
        <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontFamily: "Inter", fontWeight: 600, fontSize: 22, color: "rgba(255,255,255,.88)" }}>
          {ball(20)}
          <span>{s.name}</span>
          {s.goals > 1 && <span style={{ color: GOLD, fontWeight: 800 }}>×{s.goals}</span>}
        </div>
      ))}
    </div>
  );

  return new ImageResponse(
    (
      <div style={{ width: 1080, height: 1350, display: "flex", position: "relative", background: "#07080d", color: "#fff", fontFamily: "Inter" }}>
        {/* Red and white halves, floodlights, the seam */}
        <div style={{ position: "absolute", left: 0, top: 0, width: 540, height: 1350, display: "flex", background: "linear-gradient(180deg,#6b1220,#22070c 55%,#0b0306)" }} />
        <div style={{ position: "absolute", left: 540, top: 0, width: 540, height: 1350, display: "flex", background: "linear-gradient(180deg,#575b68,#16171d 55%,#08090c)" }} />
        <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1350, display: "flex", background: "radial-gradient(ellipse 430px 400px at 190px 0px,rgba(255,240,200,.22),transparent)" }} />
        <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1350, display: "flex", background: "radial-gradient(ellipse 430px 400px at 890px 0px,rgba(255,240,200,.22),transparent)" }} />
        <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1350, display: "flex", background: "radial-gradient(ellipse 760px 540px at 540px 480px,rgba(245,217,122,.16),transparent)" }} />
        <div style={{ position: "absolute", left: 539, top: 0, width: 2, height: 950, display: "flex", background: "linear-gradient(180deg,transparent,rgba(245,217,122,.7) 25%,rgba(245,217,122,.7) 75%,transparent)" }} />
        <img src={crest} width={520} height={562} style={{ position: "absolute", left: 280, top: 300, opacity: 0.06 }} />
        {/* Double gold frame */}
        <div style={{ position: "absolute", left: 28, top: 28, width: 1024, height: 1294, display: "flex", border: `3px solid ${GOLD}`, borderRadius: 34 }} />
        <div style={{ position: "absolute", left: 40, top: 40, width: 1000, height: 1270, display: "flex", border: "1px solid rgba(245,217,122,.35)", borderRadius: 26 }} />
        {/* Nº1 stamp */}
        <div
          style={{ position: "absolute", right: 70, top: 290, display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 14px", border: "3px solid rgba(245,217,122,.7)", borderRadius: 12, transform: "rotate(12deg)", fontFamily: "Oswald", fontWeight: 700, fontSize: 22, letterSpacing: 4, color: "rgba(245,217,122,.85)" }}
        >
          <span>Nº</span>
          <span style={{ fontSize: 34, lineHeight: 1 }}>1</span>
          <span>11-A-SIDE</span>
        </div>

        <div style={{ position: "absolute", left: 0, top: 74, width: 1080, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "Oswald", fontWeight: 600, fontSize: 24, letterSpacing: 8, color: GOLD }}>
            <img src={crest} width={60} height={65} />
            WIRRAL COMMUNITY FOOTBALL
          </div>
          <div style={{ display: "flex", marginTop: 14, fontFamily: "Oswald", fontWeight: 700, fontSize: 92, lineHeight: 1 }}>
            THE&nbsp;<span style={{ color: GOLD }}>FIRST</span>&nbsp;XI
          </div>
          <div style={{ display: "flex", marginTop: 24, padding: "9px 28px", borderRadius: 999, background: "linear-gradient(180deg,#fff3c4,#f5d97a)", color: "#1a1405", fontFamily: "Oswald", fontWeight: 700, fontSize: 28, letterSpacing: 9 }}>
            FULL TIME
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", marginTop: 22, width: 1080 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 300 }}>
              <div style={{ display: "flex", marginTop: 40, fontFamily: "Oswald", fontWeight: 700, fontSize: 30, letterSpacing: 9, color: "#ff8a92" }}>REDS</div>
              {scorerList(redScorers)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 22, fontFamily: "Oswald", fontWeight: 700, fontSize: 220, lineHeight: 1 }}>
              <span style={{ color: "#ff5a66" }}>{num(b.red)}</span>
              <span style={{ fontSize: 90, color: "rgba(245,217,122,.6)" }}>–</span>
              <span>{num(b.white)}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 300 }}>
              <div style={{ display: "flex", marginTop: 40, fontFamily: "Oswald", fontWeight: 700, fontSize: 30, letterSpacing: 9 }}>WHITES</div>
              {scorerList(whiteScorers)}
            </div>
          </div>
          {/* Man of the Match */}
          <div
            style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 26, padding: "16px 44px 16px 16px", borderRadius: 100, background: "linear-gradient(90deg,rgba(245,217,122,.2),rgba(245,217,122,.06))", border: "2px solid rgba(245,217,122,.65)" }}
          >
            <div style={{ width: 118, height: 118, borderRadius: 118, display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 35% 28%,#fff6d1,#f5d97a 50%,#b8902a)", boxShadow: "0 0 40px rgba(245,217,122,.7)" }}>
              {motm ? face(motm, 104, "#f5d97a") : <span style={{ fontFamily: "Oswald", fontWeight: 700, fontSize: 64, color: "#3a2a08" }}>?</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontFamily: "Oswald", fontWeight: 600, fontSize: 21, letterSpacing: 6, color: GOLD }}>MAN OF THE MATCH</span>
              <span style={{ fontFamily: "Inter", fontWeight: 800, fontSize: 46, lineHeight: 1.1 }}>{motm ? motm.name : "Vote now in the app"}</span>
              <span style={{ fontFamily: "Inter", fontWeight: 600, fontSize: 19, color: "rgba(255,255,255,.7)", marginTop: 4 }}>
                {motm ? `The First XI medal · ${str(b.stamp, 12)}` : b.voteCloses ? `Voting closes at ${str(b.voteCloses, 12)}` : "Voting is open"}
              </span>
            </div>
          </div>
        </div>

        <div style={{ position: "absolute", left: 62, bottom: 128, width: 956, display: "flex", justifyContent: "space-between" }}>
          {side("REDS XI", reds, "#e63946", "#ff8a92")}
          {side("WHITES XI", whites, "#e2e8f0", "#e2e8f0")}
        </div>
        <div style={{ position: "absolute", left: 0, bottom: 62, width: 1080, display: "flex", justifyContent: "center", gap: 26, fontFamily: "Oswald", fontWeight: 600, fontSize: 22, letterSpacing: 7, color: "rgba(245,217,122,.9)" }}>
          <span>{str(b.dateLabel, 30)}</span>
          <span>·</span>
          <span>{str(b.venue, 40).toUpperCase()}</span>
        </div>
      </div>
    ),
    { width: 1080, height: 1350, fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: "normal" as const })) },
  );
}
