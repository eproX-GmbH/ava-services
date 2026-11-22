// Server-Posten am Stripe-Abo: was zu tun ist (reine Funktion, ohne Stripe/Env; Test test:cloud).

export type PostenAktion =
  | { art: "nichts" }
  | { art: "anlegen"; menge: number }
  | { art: "menge"; itemId: string; menge: number; hoch: boolean }
  | { art: "entfernen"; itemId: string };

/** Was am Abo zu tun ist, damit der Server-Posten `menge` hat. */
export function postenAktion(items: Array<{ id: string; priceId: string | null; quantity: number | null }>, priceId: string, menge: number): PostenAktion {
  const item = items.find((i) => i.priceId === priceId);
  if (!item) return menge > 0 ? { art: "anlegen", menge } : { art: "nichts" };
  const ist = item.quantity ?? 0;
  if (ist === menge) return { art: "nichts" };
  if (menge === 0) return { art: "entfernen", itemId: item.id };
  return { art: "menge", itemId: item.id, menge, hoch: menge > ist };
}
