import type { ReactNode } from "react";

// The "Why?" tags on a Man of the Match vote - one optional tap, anonymous,
// becoming each player's nickname in the end-of-season Wrapped.
export const MOTM_TAGS: { key: string; label: string; icon: ReactNode }[] = [
  { key: "clinical", label: "Clinical", icon: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></> },
  { key: "brick_wall", label: "Brick wall", icon: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /> },
  { key: "engine", label: "Engine", icon: <path d="M13 2L4 14h7l-1 8 9-12h-7z" /> },
  { key: "magician", label: "Magician", icon: <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" /> },
  { key: "leader", label: "Leader", icon: <path d="M4 21V4M4 4h13l-2 4 2 4H4" /> },
  { key: "workhorse", label: "Workhorse", icon: <><path d="M20 12a8 8 0 1 1-8-8" /><path d="M20 4v6h-6" /></> },
];
