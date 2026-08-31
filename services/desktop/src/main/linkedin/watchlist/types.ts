// WL1 (PLAN_LINKEDIN_WATCHLIST.md §3/§4.1) — Capability-Vertrag.
//
// Das NORMIERTE Signal-Schema ist der Vertrag zwischen Anbieter-
// Adaptern und allem dahinter (Dedupe, Linker, Klassifikation,
// Alerts). Adapter uebersetzen ihre Anbieter-API hierauf — nichts
// stromabwaerts kennt Apify & Co.

import { createHash } from "node:crypto";

export interface ProfileActivitySignal {
  /** Beobachtete Person (Watchlist-Eintrag), kanonische Profil-URL. */
  personProfileUrl: string;
  personName: string | null;
  activityType: "reaction" | "comment";
  /** like | celebrate | insightful | … (roh vom Anbieter). */
  reactionType?: string | null;
  /** Nur bei activityType=comment. */
  commentText?: string | null;
  /** Worauf reagiert wurde. */
  targetPostUrl: string;
  targetAuthorName: string | null;
  targetAuthorProfileUrl: string | null;
  targetSnippet: string | null;
  /**
   * Zeitpunkt — EHRLICHE Einschraenkung: Die bekannten Actors liefern
   * das POST-Datum, nicht den Zeitpunkt der Reaktion/des Kommentars.
   * observedAt* ist also eine untere Schranke ("fruehestens") und darf
   * NIE als Dedupe-Schluessel dienen (LinkedIn-Zeiten sind oft nur
   * relativ).
   */
  observedAtRaw: string | null;
  observedAtIso: string | null;
  /** Herkunft. */
  providerId: string;
  actorId?: string | null;
}

/** Dedupe-Schluessel: Person + Ziel-Post + Art — stabil, weil
 *  Zeitstempel unbrauchbar sind (PLAN §3). */
export function activityDedupeKey(s: ProfileActivitySignal): string {
  return createHash("sha256")
    .update(`${s.personProfileUrl}|${s.targetPostUrl}|${s.activityType}`)
    .digest("hex");
}

export interface ProviderFetchResult {
  signals: ProfileActivitySignal[];
  /** W6 — ehrliche Luecken: was kam NICHT (Profil privat/leer/Fehler)? */
  fehlgeschlagen: Array<{ profileUrl: string; grund: string }>;
  /** Gelieferte Items (Kosten-Transparenz — der Nutzer zahlt). */
  kosteneinheiten: number;
}

export interface ProfileActivityProvider {
  id: string;
  label: string;
  /** Key-/Health-Check fuer die Settings-UI. */
  verify(key: string): Promise<{ ok: boolean; detail?: string }>;
  fetchActivity(
    key: string,
    /** Wenige pro Call (W5 — synchron); der Supervisor batcht. */
    profiles: string[],
    opts: { maxItemsPerProfile: number; signal?: AbortSignal },
  ): Promise<ProviderFetchResult>;
}
