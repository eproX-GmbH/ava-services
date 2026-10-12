// Verarbeitung eines Triggers companyContact.createEmailVerification
// (docs/PLAN_EMAIL_VERIFIZIERUNG.md, V2): auf den Persist des Contact-Laufs
// warten, Kontakte vom Gateway lesen, Adressen ableiten + einmal je Domain
// verifizieren (ermittleFirmenAdressen), Fortschritt melden.
//
// Fehler bleiben in dieser Stufe (eigenes failed/skipped); die Kontakte sind
// davon unberuehrt. Prefetch=1 auf der Queue: nie zwei Firmen parallel gegen
// denselben MX.

import * as yup from "yup";
import { ermittleFirmenAdressen, kontakteAusAntwort, type Urteil } from "@ava/email-muster";
import type { GatewayClient } from "./gateway";
import type { NetzStatus } from "./netz";
import type { ProgressEingabe } from "./progress";
import type { Einstellungen } from "./einstellungen";
import { audit, logger } from "./log";

export const LEBENSZEICHEN_MS = 5 * 60_000;
const POLL_MS = 10_000;
/** Uhrabweichung Desktop ↔ Gateway beim Vergleich mit contactRunAt. */
const UHR_TOLERANZ_MS = 5_000;

export interface TriggerEreignis {
  subject?: string;
  transaction?: string;
  source?: string;
  data?: {
    companyName?: string;
    url?: string;
    kontakteGeaendert?: boolean;
    contactRunAt?: string;
  };
}

export interface WorkerDeps {
  gateway: GatewayClient;
  netz: Pick<NetzStatus, "ok" | "aktualisiere" | "gesperrt"> & Partial<Pick<NetzStatus, "pruefeErneut">>;
  urteil: Urteil | null;
  progress: (p: ProgressEingabe) => Promise<void>;
  persistWartenMs: number;
  /** Schalter der Person/Organisation, je Trigger frisch gelesen. */
  einstellungen?: () => Einstellungen;
  ableiten?: typeof ermittleFirmenAdressen;
  schlafe?: (ms: number) => Promise<void>;
  jetzt?: () => number;
  lebenszeichenMs?: number;
}

export type Ausgang = "completed" | "skipped" | "failed" | "duplikat" | "ungueltig";

/** Nutzdaten des Triggers (AMQP ist extern: pruefen statt vertrauen). */
const DATEN_SCHEMA = yup
  .object({
    companyName: yup.string().max(500).optional(),
    url: yup.string().max(2000).optional(),
    kontakteGeaendert: yup.boolean().optional(),
    contactRunAt: yup.string().max(64).optional(),
  })
  .noUnknown(false);

export function makeWorker(deps: WorkerDeps): (ereignis: TriggerEreignis) => Promise<Ausgang> {
  const laufendeRuns = new Set<string>();
  const ableiten = deps.ableiten ?? ermittleFirmenAdressen;
  const schlafe = deps.schlafe ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jetzt = deps.jetzt ?? (() => Date.now());

  const melde = (p: ProgressEingabe): Promise<void> =>
    deps.progress(p).catch((e: unknown) => logger.info(`progress (${p.state}) nicht publiziert: ${e instanceof Error ? e.message : String(e)}`));

  /** Bis das Gateway den Contact-Lauf verarbeitet hat (ContentFreshness), hoechstens persistWartenMs. */
  async function warteAufKontakte(companyId: string, contactRunAt: string | undefined): Promise<boolean> {
    const ziel = Date.parse(contactRunAt ?? "") - UHR_TOLERANZ_MS;
    if (!Number.isFinite(ziel)) return false;
    const ende = jetzt() + deps.persistWartenMs;
    for (;;) {
      const stand = await deps.gateway.holeStand(companyId).catch(() => null);
      const t = Date.parse(stand?.["company-contact"]?.updatedAt ?? "");
      if (Number.isFinite(t) && t >= ziel) return true;
      if (jetzt() >= ende) return false;
      await schlafe(POLL_MS);
    }
  }

  return async function verarbeite(ereignis: TriggerEreignis): Promise<Ausgang> {
    const companyId = ereignis.subject;
    const transactionId = ereignis.transaction;
    if (!companyId || !transactionId) {
      logger.error(`Trigger ohne subject/transaction verworfen`);
      return "ungueltig";
    }
    const runId = `${transactionId}:${companyId}`;
    // Idempotenz wie im Contact Producer: Doppel-Dispatch nie parallel.
    if (laufendeRuns.has(runId)) {
      logger.info(`runId=${runId} laeuft bereits — Duplikat verworfen`);
      return "duplikat";
    }
    laufendeRuns.add(runId);
    let data: NonNullable<TriggerEreignis["data"]>;
    try {
      data = DATEN_SCHEMA.validateSync(ereignis.data ?? {}, { stripUnknown: true }) as NonNullable<TriggerEreignis["data"]>;
    } catch (e) {
      laufendeRuns.delete(runId);
      logger.error(`runId=${runId} Trigger mit ungueltigen Nutzdaten verworfen: ${e instanceof Error ? e.message : String(e)}`);
      return "ungueltig";
    }
    const schalter = deps.einstellungen?.() ?? { aktiv: true, zuordnungAktiv: true, ungeprueftSpeichern: true };
    if (!schalter.aktiv) {
      laufendeRuns.delete(runId);
      logger.info(`runId=${runId} uebersprungen — E-Mail-Ableitung ist ausgeschaltet`);
      await melde({ transactionId, companyId, state: "skipped", errorMessage: "E-Mail-Ableitung ist ausgeschaltet (Einstellungen oder Organisation)." });
      return "skipped";
    }
    logger.info(`received runId=${runId} firma=${data.companyName ?? "?"} kontakteGeaendert=${data.kontakteGeaendert !== false}`);
    await melde({ transactionId, companyId, state: "in_progress" });
    const timer = setInterval(() => void melde({ transactionId, companyId, state: "in_progress" }), deps.lebenszeichenMs ?? LEBENSZEICHEN_MS);
    (timer as { unref?: () => void }).unref?.();
    try {
      if (data.kontakteGeaendert !== false) {
        const da = await warteAufKontakte(companyId, data.contactRunAt);
        if (!da) logger.info(`runId=${runId} Contact-Persist nach ${Math.round(deps.persistWartenMs / 1000)} s nicht bestaetigt — arbeite mit dem aktuellen Stand`);
      }
      const k = kontakteAusAntwort(companyId, await deps.gateway.holeKontakte(companyId));
      if (!k.websiteUrl && data.url) k.websiteUrl = data.url;
      if (k.name === companyId && data.companyName) k.name = data.companyName;
      await deps.netz.aktualisiere();
      const r = await ableiten(companyId, k, {
        netzOk: () => deps.netz.ok(),
        netzGesperrt: (grund) => deps.netz.gesperrt(grund),
        ...(deps.netz.pruefeErneut ? { netzPruefe: () => deps.netz.pruefeErneut!() } : {}),
        urteil: deps.urteil,
        holeMuster: (domain) => deps.gateway.holeMuster(domain),
        speichereMuster: (domain, body) => deps.gateway.speichereMuster(domain, body),
        speichereAdresse: (a) => deps.gateway.speichereAdresse(companyId, a),
        log: (m) => logger.info(`runId=${runId} ${m}`),
        zuordnungAktiv: schalter.zuordnungAktiv,
        ungeprueftSpeichern: schalter.ungeprueftSpeichern,
      });
      logger.info(`runId=${runId} done — ${r.zusammenfassung}`);
      if (r.status === "fehler") {
        await melde({ transactionId, companyId, state: "failed", errorMessage: r.zusammenfassung.slice(0, 500) });
        return "failed";
      }
      if (r.status !== "fertig") {
        await melde({ transactionId, companyId, state: "skipped", errorMessage: r.zusammenfassung.slice(0, 500) });
        return "skipped";
      }
      if (r.gespeichert > 0) {
        audit({
          action: "email.ableitung",
          subjectId: companyId,
          summary: `E-Mail-Ableitung — ${r.zusammenfassung}`,
          metadata: { companyId, domain: r.domain, muster: r.muster, musterHerkunft: r.musterHerkunft, urteil: r.urteil, baseline: r.baseline, arten: r.arten, smtpAnfragen: r.smtpAnfragen },
        });
      }
      await melde({ transactionId, companyId, state: "completed" });
      return "completed";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`runId=${runId} failed: ${msg}`);
      await melde({ transactionId, companyId, state: "failed", errorMessage: msg.slice(0, 500) });
      return "failed";
    } finally {
      clearInterval(timer);
      laufendeRuns.delete(runId);
    }
  };
}
