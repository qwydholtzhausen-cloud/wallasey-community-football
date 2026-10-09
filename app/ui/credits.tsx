import { createContext, useContext } from "react";
import { creditLabel, type CreditRow } from "../../lib/credits";

// Game credits, shared with every screen that shows money: the Fixtures
// chip, Use credit on the pay strip and To pay sheet, the drop-out wording,
// and the admin checks and player menu. Empty (and every action a no-op)
// while GAME_CREDITS_LIVE is off, so nothing changes for anyone.
export interface CreditsApi {
  live: boolean;
  all: CreditRow[];
  myAvailable: number;
  byBooking: Map<string, CreditRow>;
  spendCredit: (bookingId: string) => Promise<void>;
  addCredit: (playerId: string, note: string) => Promise<void>;
  cancelCredit: (playerId: string) => Promise<void>;
  resolveCheck: (creditId: string, arrived: boolean) => Promise<void>;
}

const noop = async () => {};
export const CreditsContext = createContext<CreditsApi>({
  live: false,
  all: [],
  myAvailable: 0,
  byBooking: new Map(),
  spendCredit: noop,
  addCredit: noop,
  cancelCredit: noop,
  resolveCheck: noop,
});
export const useCredits = () => useContext(CreditsContext);

export function CreditChip() {
  const { live, myAvailable } = useCredits();
  if (!live || myAvailable === 0) return null;
  return (
    <div className="wcf-credit-chip">
      <i>✓</i>
      {creditLabel(myAvailable)}
      <span>· use on any game</span>
    </div>
  );
}

// What happens to your money if you drop out, said before you confirm.
export function dropOutNote(status: string, paidWithCredit: boolean, live: boolean): { tone: "good" | "wait" | "none"; text: string } | null {
  if (!live) return null;
  if (paidWithCredit) return { tone: "good", text: "You paid for this game with a credit, so the credit comes back to you." };
  if (status === "confirmed") return { tone: "good", text: "You've paid for this game, so you'll get a game credit to use on any other game." };
  if (status === "pending") return { tone: "wait", text: "You said you'd paid. Once an admin confirms your money arrived, you'll get a game credit." };
  return null;
}
