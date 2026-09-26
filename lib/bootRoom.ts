// The Boot Room: members' own trades and businesses, shown in the Feed tab
// in place of the old Clips page. Shared between the client
// (app/WirralCommunityFootball.tsx) and GaffAI's find_boot_room_listings
// tool, so the category list and the phone format can't drift apart.
//
// Four categories, one rendered boot each. Six was tried and on a 360px
// phone it pushed everything useful below the fold; adding a category
// means new artwork, which is why the database pins these keys with a
// check constraint (supabase/schema.sql, boot_room_listings.category).

export type BootCategory = "trade" | "fitness" | "business" | "home";

export interface BootCategoryInfo {
  key: BootCategory;
  label: string;
  full: string;
  // Matches the boot artwork's own neon, and drives the CSS glow - the
  // halo isn't baked into the images, so it can dim and take this tint.
  colour: string;
  img: string;
  line: string;
  blurb: string;
  // Preset tags, shown only for the chosen category so the picker is a
  // short list rather than a wall of every tag in the club.
  tags: string[];
}

export const BOOT_CATEGORIES: BootCategoryInfo[] = [
  {
    key: "trade", label: "TRADES", full: "Trades & Motors", colour: "#f0ab3d", img: "/boot-room/amber.webp",
    line: "Get it fixed properly.",
    blurb: "Plumbing, electrics, roofing and joinery — plus MOTs, repairs, tyres and valeting.",
    tags: ["Boilers & heating", "Electrics", "Roofing", "Carpentry", "Painting", "Plastering", "Tiling", "Building", "Locksmith", "MOT & servicing", "Car repair", "Tyres", "Valeting", "Removals"],
  },
  {
    key: "fitness", label: "FITNESS", full: "Health & Fitness", colour: "#34c78a", img: "/boot-room/emerald.webp",
    line: "Get yourself right.",
    blurb: "Coaching, sports massage, rehab, nutrition and mobility.",
    tags: ["PT & coaching", "Strength", "Sports massage", "Physio & rehab", "Nutrition", "Yoga & mobility"],
  },
  {
    key: "business", label: "BUSINESS", full: "Business & Creative", colour: "#9a7bf0", img: "/boot-room/violet.webp",
    line: "Sort the serious stuff.",
    blurb: "Accounts, mortgages and legal — plus design, photography, websites and DJs.",
    tags: ["Accounts & tax", "Self-employed", "Mortgages", "Insurance", "Legal", "Conveyancing", "Design & logos", "Kit design", "Photography", "Web & apps", "DJ & events", "Printing"],
  },
  {
    key: "home", label: "HOME", full: "Home & Personal", colour: "#e34b4b", img: "/boot-room/coral.webp",
    line: "Everything else.",
    blurb: "Cleaning, gardening, barber, baking, lessons and pet care.",
    tags: ["Cleaning", "Gardening", "Barber", "Beauty", "Baking", "Driving lessons", "Tutoring", "Childcare", "Pet care"],
  },
];

export const BOOT_CATEGORY: Record<BootCategory, BootCategoryInfo> = Object.fromEntries(
  BOOT_CATEGORIES.map((c) => [c.key, c])
) as Record<BootCategory, BootCategoryInfo>;

// People type numbers the way they say them ("07700 900123", "+44 (0)7700
// 900123"), but a wa.me link only works with the bare international form -
// 447700900123, no plus, no leading zero. Returns null for anything that
// still isn't a number afterwards, so it's caught on the form rather than
// becoming a WhatsApp button that opens a dead chat. The database enforces
// the same shape (boot_room_listings.phone check constraint).
export function normaliseUkPhone(raw: string): string | null {
  let d = raw.replace(/\(0\)/g, "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "44" + d.slice(1);
  d = d.replace(/\D/g, "");
  return /^\d{10,15}$/.test(d) ? d : null;
}

// For showing a stored number back in the edit form the way people
// recognise it, rather than as 447700900123.
export function displayUkPhone(stored: string): string {
  if (stored.startsWith("44") && stored.length === 12) {
    const local = "0" + stored.slice(2);
    return `${local.slice(0, 5)} ${local.slice(5)}`;
  }
  return "+" + stored;
}
