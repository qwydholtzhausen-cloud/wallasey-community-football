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
  push: { title: string; body: string }; // the release-day notification
  special?: "trickOrTreat"; // a card only this month has
  // A two-row card that replaces "Your best night": your best win and your
  // heaviest defeat, in the month's words (October's trick or treat).
  pair?: {
    label: string;
    best: string;
    worst: string;
    heads: [both: string, bestOnly: string, worstOnly: string];
    lines: { unbeaten: [string, string]; winless: string; mixed: string };
  };
  // The month's own photos for some cards (falls back to the rotating
  // bank), a wider photo for the Fixtures banner, and an effect over the
  // intro drawn in code (fog and bats for Halloween).
  photos?: Partial<Record<WrappedPhotoKey | "treat", string>>;
  bannerPhoto?: string;
  effect?: "fog" | "sparks"; // over the story intro and the release-day takeover
  // Themed copy: card labels by card key, the intro's tap line, and the
  // closing card's headline and line.
  copy?: { labels?: Partial<Record<string, string>>; quips?: Partial<Record<string, string>>; tap?: string; endTitle?: [string, string]; endLine?: string };
}

const THEMES: Record<string, WrappedTheme> = {
  // October: Halloween, and the clocks go back so every game's under the floodlights.
  "10": {
    word: "FRIGHT LIGHTS",
    edition: "Halloween edition",
    accent: "#f59e4b",
    introPhoto: "/wrapped/halloween/intro.jpg",
    bannerPhoto: "/wrapped/halloween/banner.jpg",
    effect: "fog",
    special: "trickOrTreat",
    pair: {
      label: "Trick or treat",
      best: "Treat",
      worst: "Trick",
      heads: ["The treat, and the trick.", "All treats, no tricks.", "All tricks, no treats."],
      lines: { unbeaten: ["You didn't lose once in {month}.", "Spooky."], winless: "No wins this time. November owes you one.", mixed: "Some nights you get the sweets. Some nights you get egged." },
    },
    photos: {
      glance: "/wrapped/halloween/month.jpg",
      motm: "/wrapped/halloween/motm.jpg",
      partner: "/wrapped/halloween/coven.jpg",
      club: "/wrapped/halloween/coven.jpg",
      nemesis: "/wrapped/halloween/nemesis.jpg",
      weather: "/wrapped/halloween/weather.jpg",
      summary: "/wrapped/halloween/ending.jpg",
      end: "/wrapped/halloween/ending.jpg",
      treat: "/wrapped/halloween/trick-or-treat.jpg",
    },
    copy: {
      labels: {
        glance: "At a glance, if you dare",
        record: "The body count",
        month: "Nights under the lights",
        goals: "Ghoals",
        motm: "Monster of the Match",
        why: "What the ghouls saw",
        partner: "Partner in crime",
        circle: "Your coven",
        nemesis: "Your nightmare",
        best: "Your best night",
        rated: "Most spooktacular night",
        weather: "Dark and stormy nights",
        records: "The book of spells",
        pred: "The crystal ball",
        club: "The haunted house",
        summary: "Your final scare",
      },
      quips: {
        glance: "Your month, back from the dead.",
        record: "Wins, draws, and the ones that haunt you.",
        month: "Every game night, lit up like a jack-o'-lantern.",
        goals: "Frightening finishing.",
        motm: "It's alive! The squad picked you.",
        why: "Spirits don't lie.",
        partner: "Two peas in a pumpkin.",
        circle: "Everyone who haunted the pitch with you.",
        nemesis: "The stuff of nightmares.",
        rated: "Frighteningly good.",
        weather: "Perfect weather for a haunting.",
        records: "Written in blood. Well, biro.",
        pred: "Double, double, toil and trouble.",
        club: "The whole squad, raised from the grave.",
        summary: "Boo-tiful.",
      },
      tap: "Tap if you dare",
      endTitle: ["Don't ghost us.", "Book your next game."],
      endLine: "November's Bonfire edition is already brewing.",
    },
    push: { title: "Fright Lights: your October Wrapped", body: "A month under the floodlights: your goals, your votes, the weather and who you win with. Tap to watch." },
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
    effect: "sparks",
    pair: {
      label: "Rockets and damp squibs",
      best: "Rocket",
      worst: "Damp squib",
      heads: ["The rocket, and the damp squib.", "All rockets, no damp squibs.", "All damp squibs, no rockets."],
      lines: { unbeaten: ["You didn't lose once in {month}.", "Bang on."], winless: "No rockets this time. The new year owes you one.", mixed: "Some nights go off with a bang. Some nights fizzle out." },
    },
    copy: {
      labels: {
        glance: "At a glance, lit up",
        record: "Bangs and fizzles",
        month: "Remember, remember",
        goals: "Bangers",
        motm: "Star of the show",
        why: "What lit them up",
        partner: "Your spark",
        circle: "Round the bonfire",
        nemesis: "Handle with care",
        rated: "The best display",
        weather: "Bonfire weather",
        records: "The big bangs",
        pred: "Saw it coming",
        club: "The whole display",
        summary: "Your grand finale",
      },
      quips: {
        glance: "Your month, in lights.",
        record: "Wins, draws, and the ones that fizzled out.",
        month: "Every night you lit up the pitch.",
        goals: "Light the touchpaper, stand well back.",
        motm: "The squad lit a sparkler for you.",
        why: "Why the squad voted for you.",
        partner: "You two light each other up.",
        circle: "Everyone who stood by the fire with you.",
        nemesis: "The one who keeps blowing up your night.",
        rated: "The squad's pick of the fireworks.",
        weather: "Wrap up warm.",
        records: "November's loudest moments.",
        pred: "Who saw the fireworks coming.",
        club: "Every game, every goal, every bang.",
        summary: "Save the best till last.",
      },
      tap: "Light the fuse",
      endTitle: ["That's the last", "monthly Wrapped."],
      endLine: "Season 1 Wrapped is next. Book your next game.",
    },
    push: { title: "Bangers: your November Wrapped", body: "Your November, lit up: goals, votes, best nights and who you win with. Tap to watch." },
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
  club: ["/wrapped/club.jpg"],
  end: ["/wrapped/next.jpg", "/wrapped/bank/month-floodlights.jpg"],
  summary: ["/wrapped/summary.jpg", "/wrapped/bank/summary-aerial.jpg"],
  nemesis: ["/wrapped/nemesis.jpg", "/wrapped/bank/nemesis-dusk.jpg"],
  records: ["/wrapped/records.jpg"],
  why: ["/wrapped/bank/partner-boots.jpg", "/wrapped/bank/playstyle-strike.jpg"],
  rated: ["/wrapped/bank/squad-aerial.jpg"],
  weather: ["/wrapped/bank/january-frost.jpg", "/wrapped/bank/weather-boots-rain.jpg"],
} as const;

export type WrappedPhotoKey = keyof typeof PHOTO_BANK;

export function wrappedPhoto(key: WrappedPhotoKey, periodKey: string): string {
  const list = PHOTO_BANK[key];
  const [y, m] = periodKey.split("-").map(Number);
  const step = Math.max(0, (y - 2026) * 12 + (m - 9)); // Sep 2026 = 0
  return list[step % list.length];
}
