// docs/PLAN_PROBLEM_MELDEN.md M2 — Meldung absenden: Snapshot packen, mit den
// Dateien des Nutzers ans Gateway laden; scheitert das (offline, zu gross, kein
// Gateway), Mail-Entwurf an info@eprox-gmbh.de mit allem als ZIP-Anhang.
import { randomUUID } from "node:crypto";
import type { EmlAnhang } from "../mail-entwurf/eml";
import { problemMailOeffnen } from "../mail-entwurf/oeffnen";
import { snapshotErstellen, type SnapshotDeps, type SnapshotOptionen } from "./snapshot";

export const PROBLEM_EMPFAENGER = "info@eprox-gmbh.de";

export interface MeldungEingabe {
  kategorie: string;
  titel: string;
  beschreibung: string;
  quelle: "dialog" | "chat";
  conversationId?: string | null;
  companyId?: string | null;
  dateien: Array<{ name: string; mime: string; base64: string }>;
  chatAuszug?: SnapshotOptionen["chatAuszug"];
  bildschirmfoto?: boolean;
  /** true = direkt als E-Mail vorbereiten statt hochladen. */
  alsMail?: boolean;
}

export type MeldungErgebnis =
  | { weg: "gateway"; kennung: string; id: string }
  | { weg: "mail"; programm: string | null; hinweis: string }
  | { weg: "fehler"; fehler: string };

interface GatewayWieClient { request<T>(path: string, init?: Record<string, unknown>): Promise<T> }

export async function problemMelden(deps: SnapshotDeps & { gateway: GatewayWieClient }, e: MeldungEingabe): Promise<MeldungErgebnis> {
  const snap = await snapshotErstellen(deps, { chatAuszug: e.chatAuszug ?? null, bildschirmfoto: e.bildschirmfoto !== false, conversationId: e.conversationId ?? null });
  const dateien = e.dateien.slice(0, 3).map((d) => ({ name: d.name.slice(0, 120), mime: d.mime || "application/octet-stream", bytes: Buffer.from(d.base64, "base64") }));

  if (!e.alsMail) {
    try {
      const fd = new FormData();
      fd.append("kategorie", e.kategorie);
      fd.append("titel", e.titel);
      fd.append("beschreibung", e.beschreibung);
      fd.append("quelle", e.quelle);
      fd.append("appVersion", snap.appVersion);
      fd.append("plattform", snap.plattform);
      if (e.conversationId) fd.append("conversationId", e.conversationId);
      if (e.companyId) fd.append("companyId", e.companyId);
      fd.append("snapshot", new Blob([new Uint8Array(snap.zip)], { type: "application/zip" }), snap.dateiname);
      for (const d of dateien) fd.append("datei", new Blob([new Uint8Array(d.bytes)], { type: d.mime }), d.name);
      const r = await deps.gateway.request<{ id: string; kennung: string }>("/v1/meldungen", { method: "POST", multipart: fd, idempotencyKey: randomUUID() });
      return { weg: "gateway", kennung: r.kennung, id: r.id };
    } catch (err) {
      // Rueckfall Mail (unten); den Grund mitgeben.
      const grund = err instanceof Error ? err.message : String(err);
      const m = await alsMail(e, snap, dateien, `Direktes Senden nicht möglich (${grund.slice(0, 120)}).`);
      return m;
    }
  }
  return alsMail(e, snap, dateien, null);
}

async function alsMail(e: MeldungEingabe, snap: Awaited<ReturnType<typeof snapshotErstellen>>, dateien: Array<{ name: string; mime: string; bytes: Buffer }>, grund: string | null): Promise<MeldungErgebnis> {
  const anhaenge: EmlAnhang[] = [
    { filename: snap.dateiname, content: snap.zip, contentType: "application/zip" },
    ...dateien.map((d) => ({ filename: d.name, content: d.bytes, contentType: d.mime })),
  ];
  const text = [
    "Hallo AVA-Team,",
    "",
    `Kategorie: ${e.kategorie}`,
    `Titel: ${e.titel}`,
    "",
    e.beschreibung,
    "",
    `AVA ${snap.appVersion}, ${snap.plattform}`,
    "Im Anhang: Protokolle und Angaben zum Gerät (Schlüssel maskiert).",
    "",
    "Viele Grüße",
  ].join("\n");
  try {
    const r = await problemMailOeffnen({ an: [PROBLEM_EMPFAENGER], cc: [], betreff: `AVA Problem: ${e.titel.slice(0, 80)}`, text, anhaenge: [] }, anhaenge);
    const hinweis = r.weg === "eml"
      ? `${grund ? `${grund} ` : ""}Die E-Mail liegt in deinem Mailprogramm${r.programm ? ` (${r.programm})` : ""} bereit, nur noch Senden klicken.`
      : `${grund ? `${grund} ` : ""}Die Protokolle liegen als ZIP im Ordner ${r.ordner}; die E-Mail an ${PROBLEM_EMPFAENGER} ist geöffnet, bitte die ZIP anhängen.`;
    return { weg: "mail", programm: r.programm, hinweis };
  } catch (err) {
    return { weg: "fehler", fehler: `${grund ? `${grund} ` : ""}Auch die E-Mail konnte nicht vorbereitet werden: ${err instanceof Error ? err.message : String(err)}` };
  }
}
