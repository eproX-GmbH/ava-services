// Register-Land einer Firma aus ihrer master-data-ID. Die IDs tragen das Land
// als Präfix (UK_00077570, AT_FN56247T, CH_CHE123456789, NO_916627939); deutsche IDs
// beginnen mit dem Registergericht und haben kein Länderpräfix.

export type RegisterLand = "DE" | "AT" | "CH" | "UK" | "NO" | "FI";

export function landAusCompanyId(companyId: string | null | undefined): RegisterLand {
  const m = /^(UK|AT|CH|NO|FI)_/.exec(companyId ?? "");
  return (m?.[1] as RegisterLand | undefined) ?? "DE";
}

/** Länder, deren Firmen sich heute importieren lassen (master-data data-care). */
export const IMPORTIERBAR: readonly RegisterLand[] = ["DE", "AT", "CH", "UK", "NO", "FI"];
