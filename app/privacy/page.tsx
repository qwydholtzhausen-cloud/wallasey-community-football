import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · Wirral Community Football",
  description: "How Wirral Community Football looks after your information.",
};

// The club's privacy notice. A plain page (no sign-in needed) so it can be
// linked from the sign-in screen. Written from what the app actually does -
// if a feature starts collecting or sharing something new, update this too.
const css = `
.pv{min-height:100vh;background:#0d0d1a;color:#f5f6f8;font-family:var(--font-inter),-apple-system,'Segoe UI',Roboto,sans-serif;padding:28px 16px 64px}
.pv-wrap{max-width:720px;margin:0 auto}
.pv-back{display:inline-block;margin-bottom:18px;font-size:13px;font-weight:700;color:#f5d97a;text-decoration:none}
.pv h1{font-family:var(--font-sora),-apple-system,sans-serif;font-weight:800;font-size:28px;line-height:1.15;margin:0}
.pv-upd{font-size:12px;color:#64748b;margin-top:6px}
.pv-intro{font-size:15px;line-height:1.65;color:#d7dde8;margin:14px 0 0}
.pv h2{font-family:var(--font-sora),-apple-system,sans-serif;font-size:15px;margin:26px 0 8px;color:#fff}
.pv p,.pv li{font-size:14px;line-height:1.65;color:#cbd5e1}
.pv p{margin:0 0 10px}
.pv ul{margin:0 0 10px;padding-left:20px}
.pv li{margin-bottom:5px}
.pv b{color:#fff;font-weight:700}
.pv-tw{overflow-x:auto;border-radius:14px;border:1px solid rgba(148,163,184,.16);margin:8px 0 12px}
.pv table{border-collapse:collapse;width:100%;min-width:520px;font-size:13px}
.pv th,.pv td{text-align:left;padding:9px 11px;border-bottom:1px solid rgba(148,163,184,.16);vertical-align:top;line-height:1.45}
.pv th{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;background:#161a2b}
.pv td{color:#cbd5e1}
.pv tr:last-child td{border-bottom:0}
.pv-callout{border-left:3px solid #f5d97a;background:rgba(245,217,122,.06);border-radius:10px;padding:10px 12px;font-size:13.5px;line-height:1.55;color:#d7dde8;margin:10px 0 12px}
`;

const ROWS: [string, string, string][] = [
  ["Your name and profile photo", "So people know who's playing", "All members"],
  ["Your email address", "To sign you in", "You and admins. Never shown to other members"],
  ["Your bookings, waiting-list place and whether you've paid", "To run each game", "Members can see who's booked on a game and whether a booking is paid"],
  [
    "Payments: amounts, your payment reference, and bank transfers we match to your bookings (via the club's Monzo account)",
    "To confirm payments and keep the club's accounts",
    "You and admins",
  ],
  ["Emergency contact (optional): a name and phone number", "To call someone if you're hurt at a game", "You and admins"],
  ["Date of birth (optional)", "Birthday free games and squad planning", "You and admins"],
  ["Ability ratings: your own and the admins', and how they change over time", "To pick fair teams", "You and admins"],
  [
    "Goals, results, Man of the Match votes and score predictions",
    "Stats, awards, Records and Wrapped",
    "All members. Votes stay secret until voting closes, then who voted for whom is shown. Predictions stay hidden until kickoff",
  ],
  ["Feed reactions and Boot Room listings (your business name and, if you add it, a WhatsApp number)", "The club feed and members' directory", "All members"],
  ["Messages from admins", "To get in touch about games and payments", "You and admins"],
  [
    "How you use the app: when you last opened it, which notifications you tapped, games you pulled out of or didn't turn up to, and whether you opened your Wrapped",
    "To see what's working, spot people we haven't seen in a while, and keep games reliable",
    "Admins only, and never shown in the app",
  ],
  ["Notification settings for your device", "To send you notifications", "No one. It's only used to deliver them"],
];

export default function PrivacyPage() {
  return (
    <main className="pv">
      <style>{css}</style>
      <div className="pv-wrap">
        <a className="pv-back" href="/">‹ Back to the app</a>
        <h1>Your privacy</h1>
        <div className="pv-upd">Last updated 28 September 2026</div>
        <p className="pv-intro">
          Wirral Community Football is run by volunteers for the people who play. We only use your information to organise games, take payments and keep the
          club running. We never sell it, and we don&apos;t use advertising or tracking.
        </p>

        <h2>Who looks after your data</h2>
        <p>
          The club&apos;s admins, the volunteers who run the app and the games. For anything about your data, just <b>WhatsApp one of the admins</b>.
        </p>

        <h2>What we keep, and who can see it</h2>
        <div className="pv-tw">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Why</th>
                <th>Who can see it</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([what, why, who]) => (
                <tr key={what}>
                  <td>
                    <b>{what}</b>
                  </td>
                  <td>{why}</td>
                  <td>{who}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Anything marked optional you can add, change or remove yourself in <b>Account</b>.
        </p>

        <h2>Services we use</h2>
        <p>A few trusted companies help run the app. They only handle your data to provide their service to us:</p>
        <ul>
          <li>
            <b>Supabase</b> stores the club&apos;s data, in London.
          </li>
          <li>
            <b>Vercel</b> hosts the app.
          </li>
          <li>
            <b>Monzo</b> holds the club&apos;s bank account, which we use to match payments.
          </li>
          <li>
            <b>Apple and Google</b> deliver notifications to your phone.
          </li>
          <li>
            <b>Anthropic</b> (a US company) provides <b>GaffAI</b>, the admins&apos; assistant.
          </li>
        </ul>
        <div className="pv-callout">
          <b>About GaffAI.</b> When an admin asks GaffAI a question (for example &quot;who&apos;s unpaid for Monday?&quot;), the club information needed to answer
          it, which can include members&apos; names, bookings, payments and ratings, is sent to Anthropic to produce the answer. Anthropic doesn&apos;t use it to
          train its AI. GaffAI can only read information or suggest a change; an admin has to confirm anything it changes.
        </div>
        <p>Weather forecasts come from Open-Meteo, which receives no information about you.</p>

        <h2>On your phone</h2>
        <p>The app stores your sign-in and a few preferences (like banners you&apos;ve dismissed) on your device. There are no advertising or tracking cookies.</p>

        <h2>How long we keep it</h2>
        <ul>
          <li>
            <b>Payment records:</b> 6 years, so the club&apos;s accounts are complete.
          </li>
          <li>
            <b>How you use the app</b> (last opened, notifications tapped, Wrapped views, games you pulled out of or didn&apos;t turn up to): 12 months.
          </li>
          <li>
            <b>Everything else:</b> while you play with us. If you haven&apos;t played or used the app for 2 years, we remove your personal details (your
            photo, emergency contact, date of birth and ratings). Your name stays against past games and payments so results and the club&apos;s accounts stay
            correct.
          </li>
        </ul>
        <p>You can remove optional details (your emergency contact, date of birth and photo) at any time, and ask us to delete your account sooner.</p>

        <h2>Your rights</h2>
        <p>You can ask us to:</p>
        <ul>
          <li>give you a copy of the information we hold about you</li>
          <li>correct anything that&apos;s wrong</li>
          <li>delete your account and information</li>
          <li>stop using your information for something you object to</li>
        </ul>
        <p>
          To do any of these, <b>WhatsApp one of the admins</b>. We&apos;ll sort it as soon as we can, and within a month.
        </p>
        <p>If you&apos;re unhappy with how we&apos;ve handled your information, you can complain to the Information Commissioner&apos;s Office (ICO) at ico.org.uk.</p>

        <h2>Changes</h2>
        <p>If we change how we use your information, we&apos;ll update this page and let members know in the app.</p>
      </div>
    </main>
  );
}
