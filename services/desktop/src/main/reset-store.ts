// v0.1.409 — „Alles zurücksetzen außer KI-Modelle" (echter Werksreset).
//
// Der Nutzer kann in Einstellungen → System sämtliche lokal gespeicherten
// Daten löschen — Chats, Profil, Verbräuche, Alerts, Memory, Automationen,
// sowie ALLE Fremd-Integrationen (HubSpot/LinkedIn/Mail inkl. deren Auth).
// ERHALTEN bleiben ausschließlich:
//   - die LLM-Provider-Konfiguration (agent/provider.json — gewählte
//     Modelle + Auth-Modus + Token-Limit),
//   - die LLM-Provider-Credentials (agent/*.enc, inkl. *-subscription.enc),
//   - agent/anthropic-tier.json (aus dem Anthropic-Key abgeleitet),
//   - heruntergeladene Ollama-Modelle (~/.ollama, LIEGT AUSSERHALB userData),
//   - die verwaltete Ollama-Binary (userData/ollama-managed) + Whisper-
//     Sprachmodelle (userData/whisper),
//   - der AVA-Account-Login (auth.bin) und der Updater-Zustand.
//
// Umsetzung: Der IPC-Handler schreibt eine Marker-Datei und startet die App
// neu (`requestResetExceptModels`). GANZ FRÜH im Boot — BEVOR irgendein
// Store seine Dateien öffnet — löscht `performBootResetIfRequested` die
// unten gelisteten Ziele und entfernt den Marker. Das umgeht offene
// PGlite-/Datei-Handles komplett und garantiert, dass wirklich alles außer
// der Keep-Liste weg ist.

import { app } from "electron";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER_NAME = ".reset-except-models";

/** Absoluter Pfad der Marker-Datei im userData-Verzeichnis. */
function markerPath(userDataDir: string): string {
  return join(userDataDir, MARKER_NAME);
}

/**
 * Vom IPC-Handler aufgerufen: Marker setzen und App neu starten. Die
 * eigentliche Löschung passiert beim nächsten Boot (vor Store-Init).
 */
export function requestResetExceptModels(): void {
  const userDataDir = app.getPath("userData");
  writeFileSync(markerPath(userDataDir), new Date().toISOString(), "utf8");
  app.relaunch();
  app.exit(0);
}

/**
 * Wird als ERSTES im Boot aufgerufen. Existiert der Marker, werden alle
 * DELETE-Ziele entfernt (Keep-Liste bleibt unberührt), dann der Marker
 * gelöscht. Gibt `true` zurück, wenn ein Reset durchgeführt wurde.
 */
export function performBootResetIfRequested(): boolean {
  const userDataDir = app.getPath("userData");
  const marker = markerPath(userDataDir);
  if (!existsSync(marker)) return false;

  console.log("[reset] marker found — performing factory reset (except models)");

  const rm = (rel: string): void => {
    const abs = join(userDataDir, rel);
    try {
      rmSync(abs, { recursive: true, force: true });
    } catch (err) {
      // Best-effort: ein einzelner fehlgeschlagener Löschvorgang darf den
      // Boot nicht verhindern.
      console.warn(`[reset] could not remove ${rel}:`, err);
    }
  };

  // --- Ganze Verzeichnisse / Dateien löschen (kein Keep-Inhalt darin) ---
  const topLevelTargets = [
    "pglite", // Usage, Audit, Self-Corrections, Scheduler, Link-Monitor,
    //            Mail, sowie alle Producer-DBs (company_* / CRM-Cache).
    "linkedin", // Session-Cookies (session.enc) + DB + Settings + Medien +
    //             Runs + Kalibrierung — vollständige LinkedIn-Trennung.
    "crm", // HubSpot-OAuth-Tokens + Cache.
    "mail-cache", // zwischengespeicherte Mail-Anhänge/Inhalte.
    "mail-creds.bin", // IMAP/SMTP-Passwörter (Mail-Trennung).
    "telegram", // v0.1.412 — Bot-Token + Chat-Konfiguration.
    "discovery", // v0.1.455 — Radar: Automatik-Konfig, Alert-Dedup,
    //              Match-Scores, Top-Kunden-Profile. Die ZENTRALEN
    //              Ignoriert/Importiert-Entscheidungen loescht der
    //              IPC-Handler vor dem Neustart (siehe index.ts —
    //              braucht Auth, die es beim Boot nicht mehr gibt).
    "research", // Research-Feature-Zustand/Tiers.
    "skills", // benutzerdefinierte Skills.
    "skills-prefs.json",
    "skills-trust.json",
    "logs",
    "producer-logs",
    "screenshots",
    "pending",
    "processing-control.json",
  ];
  for (const t of topLevelTargets) rm(t);

  // Electron-Partition der LinkedIn-Sitzung (Cookies/Storage) — liegt unter
  // Partitions/persist%3Alinkedin. Wir löschen alles, was mit dieser
  // Partition beginnt, damit die LinkedIn-Anmeldung wirklich weg ist.
  const partitionsDir = join(userDataDir, "Partitions");
  if (existsSync(partitionsDir)) {
    try {
      for (const name of readdirSync(partitionsDir)) {
        if (name.startsWith("persist%3Alinkedin")) {
          rm(join("Partitions", name));
        }
      }
    } catch (err) {
      console.warn("[reset] could not scan Partitions:", err);
    }
  }

  // --- agent/ ist ein GEMISCHTES Verzeichnis: nur die Nicht-Modell-Dateien
  //     löschen, die LLM-Credentials + provider.json BEHALTEN. ---
  const agentDeletes = [
    "user-profile.json",
    "general-memory.jsonl",
    "alerts.jsonl",
    "alert-prefs.json",
    "freshness-prefs.json",
    "freshness-cursor.json",
    "watches.jsonl",
    "icp.json", // v0.1.455 — Idealkundenprofil (Radar-Grundlage).
    "autonomy.json", // v0.1.468 — globaler Autonomie-Modus.
    "memory", // Chat-Transkripte (Verzeichnis).
    "knowledge", // Notion/Obsidian-Status + Tokens.
  ];
  for (const f of agentDeletes) rm(join("agent", f));

  // Marker zuletzt entfernen — schlägt vorher etwas fehl, wird beim
  // nächsten Boot erneut versucht.
  try {
    rmSync(marker, { force: true });
  } catch (err) {
    console.warn("[reset] could not remove marker:", err);
  }

  // Sanity-Log: bestätigen, dass die Keep-Dateien noch da sind.
  const providerJson = join(userDataDir, "agent", "provider.json");
  console.log(
    `[reset] done — provider.json ${existsSync(providerJson) ? "preserved" : "MISSING(!)"}` +
      `, ollama-managed ${existsSync(join(userDataDir, "ollama-managed")) ? "preserved" : "absent"}`,
  );
  return true;
}
