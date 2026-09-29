// Keeping the monthly Wrapped fresh: a theme for some months (the intro's
// big word, edition tag, accent and photo, plus a line that fits the
// player) and a bank of photos each card rotates through month by month.
// Photos live in public/wrapped/bank/, so adding one is a file drop plus a
// line here. December has no theme: the Season Wrapped replaces it.

export interface WrappedThemeWho {
  firstName: string;
  apps: number;
  ofGames: number;
  goals: number;
  goalsRank: number | null;
  motmWins: number;
  topTag: string | null; // most-given "Why?" tag this month
}

export interface WrappedTheme {
  word: string; // the intro's big word, e.g. "FRIGHT LIGHTS"
  edition: string; // the pill above it
  accent: string;
  introPhoto: string;
  line: (who: WrappedThemeWho) => string; // the sentence under it, after "{first}, "
}

const THEMES: Record<string, WrappedTheme> = {
  // October: Halloween, and the clocks go back so every game's under the floodlights.
  "10": {
    word: "FRIGHT LIGHTS",
    edition: "Halloween edition",
    accent: "#f59e4b",
    introPhoto: "/wrapped/bank/october-leaves.jpg",
    line: (w) =>
      w.goals >= 3 && w.goalsRank === 1 ? "scary in front of goal."
      : w.topTag === "brick_wall" ? "the brick wall of Halloween."
      : w.motmWins > 0 ? "you had the squad spooked."
      : w.apps === w.ofGames ? "you never missed a night under the lights."
      : "here's your October under the lights.",
  },
  // November: Bonfire Night. A banger is a firework and a screamer.
  "11": {
    word: "BANGERS",
    edition: "Bonfire Night edition",
    accent: "#ff7a45",
    introPhoto: "/wrapped/bank/november-bonfire.jpg",
    line: (w) =>
      w.goals >= 3 ? "your November, lit up."
      : w.motmWins > 0 ? "the squad saw the fireworks."
      : w.apps <= 2 ? "quiet on the pitch, loud in the group."
      : "here's your November, lit up.",
  },
};

export function wrappedThemeFor(periodKey: string): WrappedTheme | null {
  return THEMES[periodKey.slice(5, 7)] ?? null;
}

// Each card's photos, the original first. September 2026 (and anything
// earlier) keeps the original; each later month moves one along.
export const PHOTO_BANK = {
  intro: ["/wrapped/intro.jpg", "/wrapped/bank/intro-laces.jpg"],
  glance: ["/wrapped/glance.jpg", "/wrapped/bank/spare-sprint.jpg"],
  record: ["/wrapped/record.jpg", "/wrapped/bank/run-floodlights.jpg"],
  goals: ["/wrapped/goals.jpg", "/wrapped/bank/goals-net-rain.jpg", "/wrapped/bank/goals-daylight.jpg"],
  motm: ["/wrapped/motm.jpg", "/wrapped/bank/motm-gold-ball.jpg", "/wrapped/bank/motm-walk-off.jpg"],
  partner: ["/wrapped/partner.jpg", "/wrapped/bank/teammates-high-five.jpg", "/wrapped/bank/partner-boots.jpg"],
  best: ["/wrapped/best.jpg"],
  pred: ["/wrapped/predictions.jpg", "/wrapped/bank/predictions-spot.jpg"],
  club: ["/wrapped/club.jpg", "/wrapped/bank/squad-aerial.jpg"],
  end: ["/wrapped/next.jpg", "/wrapped/bank/month-floodlights.jpg"],
  summary: ["/wrapped/summary.jpg", "/wrapped/bank/summary-aerial.jpg"],
  nemesis: ["/wrapped/nemesis.jpg", "/wrapped/bank/nemesis-dusk.jpg"],
  records: ["/wrapped/records.jpg"],
  why: ["/wrapped/bank/partner-boots.jpg", "/wrapped/bank/playstyle-strike.jpg"],
  rated: ["/wrapped/bank/rated-thermometer.jpg"],
  weather: ["/wrapped/bank/january-frost.jpg", "/wrapped/bank/weather-boots-rain.jpg"],
} as const;

export type WrappedPhotoKey = keyof typeof PHOTO_BANK;

export function wrappedPhoto(key: WrappedPhotoKey, periodKey: string): string {
  const list = PHOTO_BANK[key];
  const [y, m] = periodKey.split("-").map(Number);
  const step = Math.max(0, (y - 2026) * 12 + (m - 9)); // Sep 2026 = 0
  return list[step % list.length];
}
