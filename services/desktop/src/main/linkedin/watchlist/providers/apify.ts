// WL1 — Apify-Adapter (PLAN_LINKEDIN_WATCHLIST.md W4/W5).
//
// Apify ist ein Actor-MARKTPLATZ: die Actor-IDs sind KONFIGURIERBAR,
// die harvestapi-Actors sind nur Vorbelegung (live geprueft 2026-08-31:
// Input {profiles: string[], maxItems}, cookielos, PAY_PER_EVENT pro
// Dataset-Item). Aufruf synchron via run-sync-get-dataset-items (W5) —
// der Supervisor haelt die Batches klein.
//
// Ehrliche Grenzen (W6):
//   * Nur OEFFENTLICHE Aktivitaet; private/leere Profile liefern
//     schlicht keine Items → wird als "fehlgeschlagen: keine Daten"
//     gemeldet, nicht verschwiegen.
//   * Die Actors liefern das POST-Datum, nicht den Reaktions-
//     Zeitpunkt (siehe types.ts observedAt*-Kommentar).
//
// Mapping bewusst TOLERANT (Muster ICP-Schema v0.1.471): mehrere
// Kandidaten-Pfade pro Feld, kaputte Items werden uebersprungen statt
// den Lauf zu kippen. Actor-Schemata aendern sich — die Feld-Pfade
// hier sind gegen den Live-Stand 2026-08-31 gebaut.

import { normalizeLinkedInProfileUrl } from "../normalize";
import type {
  ProfileActivityProvider,
  ProfileActivitySignal,
  ProviderFetchResult,
} from "../types";

const APIFY_API = "https://api.apify.com/v2";
const RUN_TIMEOUT_MS = 5 * 60_000;

export interface ApifyActorConfig {
  /** Actor fuer Profil-Reaktionen (Tilde-Form, z. B. "harvestapi~linkedin-profile-reactions"). */
  reactionsActorId: string;
  /** Actor fuer Profil-Kommentare. Leer = Kommentare ueberspringen. */
  commentsActorId: string;
}

export const APIFY_DEFAULT_ACTORS: ApifyActorConfig = {
  reactionsActorId: "harvestapi~linkedin-profile-reactions",
  commentsActorId: "harvestapi~linkedin-profile-comments",
};

// ---- tolerante Feld-Zugriffe ------------------------------------------------

type Raw = Record<string, unknown>;

function asObj(v: unknown): Raw | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function pickStr(o: Raw | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const s = asStr(o[k]);
    if (s) return s;
  }
  return null;
}

/** Post-URL: shareUrl (/posts/…) bevorzugen, sonst Feed-Update-URL. */
function pickPostUrl(item: Raw, post: Raw | null): string | null {
  return (
    pickStr(post, "shareUrl", "url", "linkedinUrl") ??
    pickStr(item, "shareUrl", "linkedinUrl", "postUrl", "url")
  );
}

function pickTimestamps(post: Raw | null): {
  raw: string | null;
  iso: string | null;
} {
  const postedAt = asObj(post?.postedAt);
  const raw =
    pickStr(postedAt, "postedAgoText", "postedAgoShort", "date") ?? null;
  const ts = postedAt?.timestamp;
  let iso: string | null = null;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    try {
      iso = new Date(ts).toISOString();
    } catch {
      iso = null;
    }
  }
  if (!iso) {
    const d = pickStr(postedAt, "date");
    if (d && !Number.isNaN(Date.parse(d))) iso = new Date(d).toISOString();
  }
  return { raw, iso };
}

const SNIPPET_CAP = 500;
const COMMENT_CAP = 1000;

/**
 * Ein Actor-Item → normiertes Signal. `queriedProfile` ist die
 * kanonische URL des ABGEFRAGTEN Profils — die Person, deren
 * Aktivitaet wir lesen (Items tragen den Reactor teils nur als
 * actor-Objekt; das abgefragte Profil ist die verlaessliche Quelle).
 */
export function mapApifyItem(
  item: unknown,
  kind: "reaction" | "comment",
  queriedProfile: string,
  actorId: string,
): ProfileActivitySignal | null {
  const o = asObj(item);
  if (!o) return null;
  const post = asObj(o.post) ?? asObj(o.targetPost);
  const author = asObj(post?.author) ?? asObj(o.author);
  const actorObj = asObj(o.actor);

  const targetPostUrl = pickPostUrl(o, post);
  if (!targetPostUrl) return null; // ohne Ziel-Post kein Dedupe-Schluessel

  const { raw, iso } = pickTimestamps(post);
  const commentText =
    kind === "comment"
      ? (pickStr(o, "commentText", "text", "comment") ??
         pickStr(asObj(o.comment), "text", "content"))
      : null;

  return {
    personProfileUrl: queriedProfile,
    personName: pickStr(actorObj, "name", "fullName"),
    activityType: kind,
    reactionType: kind === "reaction" ? pickStr(o, "action", "reactionType", "type") : null,
    commentText: commentText ? commentText.slice(0, COMMENT_CAP) : null,
    targetPostUrl,
    targetAuthorName: pickStr(author, "name", "fullName"),
    targetAuthorProfileUrl: normalizeLinkedInProfileUrl(
      pickStr(author, "linkedinUrl", "profileUrl", "url"),
    ),
    targetSnippet: (pickStr(post, "content", "text") ?? null)?.slice(0, SNIPPET_CAP) ?? null,
    observedAtRaw: raw,
    observedAtIso: iso,
    providerId: "apify",
    actorId,
  };
}

// ---- Provider ---------------------------------------------------------------

export function buildApifyProvider(
  actors: ApifyActorConfig = APIFY_DEFAULT_ACTORS,
): ProfileActivityProvider {
  async function runActor(
    key: string,
    actorId: string,
    profiles: string[],
    maxItems: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown[]> {
    const url =
      `${APIFY_API}/acts/${encodeURIComponent(actorId)}` +
      `/run-sync-get-dataset-items?token=${encodeURIComponent(key)}&format=json`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles, maxItems }),
      signal: signal ?? AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("APIFY_AUTH: Token ungueltig oder abgelaufen.");
    }
    if (res.status === 402) {
      throw new Error("APIFY_CREDITS: Apify-Guthaben aufgebraucht.");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Apify ${actorId}: HTTP ${res.status} ${body.slice(0, 160)}`,
      );
    }
    const json: unknown = await res.json();
    return Array.isArray(json) ? json : [];
  }

  return {
    id: "apify",
    label: "Apify (Actor-Marktplatz)",

    async verify(key: string): Promise<{ ok: boolean; detail?: string }> {
      try {
        const res = await fetch(
          `${APIFY_API}/users/me?token=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (res.status === 401) return { ok: false, detail: "Token ungueltig." };
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        const data = (await res.json()) as { data?: { username?: string } };
        return {
          ok: true,
          detail: data.data?.username
            ? `Verbunden als ${data.data.username}`
            : "Verbunden",
        };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchActivity(key, profiles, opts): Promise<ProviderFetchResult> {
      // Kanonisieren + Nicht-Profile ehrlich aussortieren.
      const canonical = new Map<string, string>(); // kanonisch → wie angefragt
      const fehlgeschlagen: Array<{ profileUrl: string; grund: string }> = [];
      for (const p of profiles) {
        const norm = normalizeLinkedInProfileUrl(p);
        if (norm) canonical.set(norm, p);
        else fehlgeschlagen.push({ profileUrl: p, grund: "keine LinkedIn-Profil-URL (/in/)" });
      }
      const list = [...canonical.keys()];
      if (list.length === 0) {
        return { signals: [], fehlgeschlagen, kosteneinheiten: 0 };
      }

      const signals: ProfileActivitySignal[] = [];
      let kosteneinheiten = 0;
      const gesehenProProfil = new Map<string, number>();

      const laeufe: Array<{ actorId: string; kind: "reaction" | "comment" }> = [
        { actorId: actors.reactionsActorId, kind: "reaction" },
      ];
      if (actors.commentsActorId.trim()) {
        laeufe.push({ actorId: actors.commentsActorId, kind: "comment" });
      }

      for (const lauf of laeufe) {
        let items: unknown[];
        try {
          items = await runActor(
            key,
            lauf.actorId,
            list,
            opts.maxItemsPerProfile,
            opts.signal,
          );
        } catch (err) {
          // Ein Actor-Fehler kippt nicht den ganzen Fetch — aber er
          // wird fuer ALLE angefragten Profile ehrlich gemeldet.
          const grund = err instanceof Error ? err.message : String(err);
          for (const p of list) {
            fehlgeschlagen.push({ profileUrl: p, grund: `${lauf.kind}: ${grund}` });
          }
          if (grund.startsWith("APIFY_AUTH") || grund.startsWith("APIFY_CREDITS")) {
            throw err; // Key-Probleme sofort hochreichen (Supervisor stoppt).
          }
          continue;
        }
        kosteneinheiten += items.length;
        // Items tragen das abgefragte Profil nicht immer explizit —
        // bei EINEM Profil pro Batch ist die Zuordnung trivial, bei
        // mehreren versuchen wir actor.linkedinUrl, sonst faellt das
        // Item auf das erste Profil zurueck (Supervisor batcht deshalb
        // konservativ; TODO WL3: Batches auf 1 Profil, wenn der Actor
        // keine Zuordnung liefert).
        for (const item of items) {
          const actorUrl = normalizeLinkedInProfileUrl(
            pickStr(asObj(asObj(item)?.actor), "linkedinUrl", "profileUrl"),
          );
          const queried =
            (actorUrl && canonical.has(actorUrl) ? actorUrl : null) ??
            (list.length === 1 ? list[0]! : (actorUrl ?? list[0]!));
          const sig = mapApifyItem(item, lauf.kind, queried, lauf.actorId);
          if (sig) {
            signals.push(sig);
            gesehenProProfil.set(queried, (gesehenProProfil.get(queried) ?? 0) + 1);
          }
        }
      }

      // Profile ganz ohne Items: ehrlich melden (privat/leer/gekuerzt).
      for (const p of list) {
        if (!gesehenProProfil.has(p) && !fehlgeschlagen.some((f) => f.profileUrl === p)) {
          fehlgeschlagen.push({
            profileUrl: p,
            grund: "keine oeffentliche Aktivitaet gefunden (privat, leer oder von LinkedIn gekuerzt)",
          });
        }
      }
      return { signals, fehlgeschlagen, kosteneinheiten };
    },
  };
}
