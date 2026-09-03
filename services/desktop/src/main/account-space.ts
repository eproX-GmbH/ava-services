// T1 (PLAN_TENANT_MULTI_ACCOUNT.md) — Account-Spaces: ein lokales
// Datenverzeichnis je angemeldetem Keycloak-User.
//
// Grundidee: Der Account-Space IST das `userData` der laufenden
// Instanz. `initAccountSpace()` laeuft beim Modul-Load, BEVOR irgendein
// Store konstruiert wird (dasselbe Muster wie der Werksreset), und setzt
// `app.setPath("userData", …)`. Alle bestehenden `app.getPath("userData")`-
// Aufrufer bleiben damit unveraendert korrekt; auch die Chromium-Session
// haengt am selben Pfad und ist pro Account getrennt.
//
// Layout unter dem Basis-userData (Electron-Default, z. B.
// ~/Library/Application Support/@ava/desktop):
//   accounts.json             Registry: bekannte Accounts + aktiver
//   shared/                   geraetweit: ollama-managed, whisper
//   accounts/<sub>/           Space eines Users (sub = Keycloak-UUID)
//   accounts/_pending/        Space vor der ersten Anmeldung; wird beim
//                             ersten Login per Rename dem User zugeordnet
//
// Kontowechsel = Neustart. PGlite, Producer, AMQP-Queues, Telegram-
// Polling und LinkedIn-Browser haengen alle am Account; ein Laufzeit-
// Wechsel waere der teuerste und fehleranfaelligste Weg.
//
// Migration (einmalig): existiert noch kein accounts/, wandert der
// komplette bisherige userData-Inhalt per Rename nach accounts/_pending
// (Sekundenbruchteile, keine Kopie) und wird beim naechsten Login dem
// angemeldeten User zugeordnet. Entscheidungen 2026-09-03: ein Tenant je
// User; _pending wird vom ERSTEN Login uebernommen; ein Login mit einem
// anderen sub im Space eines Users bekommt einen frischen Space (der
// fremde Space bleibt unangetastet, wird aber nie sichtbar).

import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface AccountIdentity {
  sub: string;
  email: string | null;
  name: string | null;
  tenantId: string | null;
  tenantName?: string | null;
}

export interface AccountRecord extends AccountIdentity {
  lastUsedAt: string;
}

interface Registry {
  version: 1;
  active: string | null;
  accounts: Record<string, AccountRecord>;
}

const PENDING = "_pending";
const SHARED_DIRS = ["ollama-managed", "whisper"] as const;
const MIGRATION_MARKER = ".accounts-migrated";
/** Eigene Dateien/Verzeichnisse im Basis-userData, die NICHT verschoben werden. */
const BASE_OWN = new Set(["accounts", "shared", "accounts.json", MIGRATION_MARKER]);

let baseDir = "";
let activeId = PENDING;
let initialized = false;

function log(msg: string): void {
  console.log(`[account-space] ${msg}`);
}

function registryPath(): string {
  return join(baseDir, "accounts.json");
}

function readRegistry(): Registry {
  try {
    if (existsSync(registryPath())) {
      const raw = JSON.parse(readFileSync(registryPath(), "utf8")) as Partial<Registry>;
      return {
        version: 1,
        active: typeof raw.active === "string" ? raw.active : null,
        accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {},
      };
    }
  } catch (err) {
    console.warn("[account-space] accounts.json unlesbar, Defaults:", err);
  }
  return { version: 1, active: null, accounts: {} };
}

function writeRegistry(r: Registry): void {
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  renameSync(tmp, registryPath());
}

function spaceDir(id: string): string {
  return join(baseDir, "accounts", id);
}

/** Einmalige Migration des flachen Alt-Layouts nach accounts/_pending. */
function migrateLegacyLayout(): void {
  if (existsSync(join(baseDir, MIGRATION_MARKER))) return;
  if (existsSync(join(baseDir, "accounts"))) {
    writeFileSync(join(baseDir, MIGRATION_MARKER), new Date().toISOString());
    return;
  }
  const entries = existsSync(baseDir) ? readdirSync(baseDir) : [];
  const zuVerschieben = entries.filter((e) => !BASE_OWN.has(e));
  mkdirSync(join(baseDir, "shared"), { recursive: true });
  mkdirSync(spaceDir(PENDING), { recursive: true });
  let moved = 0;
  let sharedMoved = 0;
  for (const e of zuVerschieben) {
    const from = join(baseDir, e);
    const to = (SHARED_DIRS as readonly string[]).includes(e)
      ? join(baseDir, "shared", e)
      : join(spaceDir(PENDING), e);
    try {
      renameSync(from, to);
      if ((SHARED_DIRS as readonly string[]).includes(e)) sharedMoved++;
      else moved++;
    } catch (err) {
      console.warn(`[account-space] Migration: ${e} konnte nicht verschoben werden:`, err);
    }
  }
  writeFileSync(join(baseDir, MIGRATION_MARKER), new Date().toISOString());
  log(
    `Alt-Layout migriert: ${moved} Eintraege → accounts/_pending, ${sharedMoved} → shared (Zuordnung zum Konto beim naechsten Login)`,
  );
}

/**
 * BEIM MODUL-LOAD aufrufen, vor jedem Store. Waehlt den Space und
 * biegt userData/sessionData darauf um.
 */
export function initAccountSpace(): void {
  if (initialized) return;
  initialized = true;
  baseDir = app.getPath("userData");
  try {
    mkdirSync(baseDir, { recursive: true });
    migrateLegacyLayout();
    const reg = readRegistry();
    if (reg.active && existsSync(spaceDir(reg.active))) {
      activeId = reg.active;
    } else {
      activeId = PENDING;
      if (reg.active) {
        log(`aktiver Account ${reg.active} hat keinen Space mehr → _pending`);
        reg.active = null;
        writeRegistry(reg);
      }
    }
    mkdirSync(spaceDir(activeId), { recursive: true });
    for (const s of SHARED_DIRS) mkdirSync(join(baseDir, "shared", s), { recursive: true });
  } catch (err) {
    console.warn("[account-space] Init fehlgeschlagen, bleibe im Basis-userData:", err);
    return;
  }
  const dir = spaceDir(activeId);
  app.setPath("userData", dir);
  app.setPath("sessionData", dir);
  log(`aktiver Space: ${activeId === PENDING ? "_pending (nicht angemeldet)" : activeId} → ${dir}`);
}

/** Space-Verzeichnis eines Kontos (auch wenn es nicht aktiv ist). */
export function spaceDirFor(sub: string): string {
  return spaceDir(sub);
}

/** Basis-userData (Electron-Default), unabhaengig vom aktiven Space. */
export function getBaseUserData(): string {
  return baseDir || app.getPath("userData");
}

/** Geraeteweites Verzeichnis (ollama-managed, whisper). */
export function getSharedDir(name: (typeof SHARED_DIRS)[number]): string {
  return join(getBaseUserData(), "shared", name);
}

export function getActiveSpaceId(): string {
  return activeId;
}

export function isPendingSpace(): boolean {
  return activeId === PENDING;
}

export function listAccounts(): { active: string | null; accounts: AccountRecord[] } {
  const reg = readRegistry();
  return {
    active: activeId === PENDING ? null : activeId,
    accounts: Object.values(reg.accounts).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
  };
}

function writeIdentity(id: AccountIdentity): void {
  try {
    writeFileSync(
      join(spaceDir(id.sub), "identity.json"),
      JSON.stringify({ ...id, lastSignInAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
  } catch (err) {
    console.warn("[account-space] identity.json nicht schreibbar:", err);
  }
}

export function readIdentity(): (AccountIdentity & { lastSignInAt?: string }) | null {
  if (activeId === PENDING) return null;
  try {
    const p = join(spaceDir(activeId), "identity.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as AccountIdentity & { lastSignInAt?: string };
  } catch {
    return null;
  }
}

function relaunch(): void {
  app.relaunch();
  app.exit(0);
}

/**
 * Nach erfolgreicher Anmeldung aufrufen. Entscheidet:
 *   - aktiver Space ist _pending      → per Rename dem User zuordnen, Neustart
 *   - aktiver Space gehoert diesem sub → Identitaet/Registry aktualisieren
 *   - aktiver Space gehoert einem ANDEREN sub → Identitaets-Sperre: neuen
 *     Space registrieren, Neustart hinein (fremder Space bleibt unberuehrt)
 * Liefert "relaunching", wenn ein Neustart ausgeloest wird (Aufrufer
 * sollte dann nichts mehr tun).
 */
export function handleSignedIn(id: AccountIdentity, opts: { relaunchDelayMs?: number } = {}): "ok" | "relaunching" {
  const reg = readRegistry();
  const now = new Date().toISOString();
  reg.accounts[id.sub] = { ...id, lastUsedAt: now };

  if (activeId === id.sub) {
    reg.active = id.sub;
    writeRegistry(reg);
    writeIdentity(id);
    return "ok";
  }

  if (activeId === PENDING) {
    const ziel = spaceDir(id.sub);
    if (!existsSync(ziel)) {
      try {
        renameSync(spaceDir(PENDING), ziel);
        log(`_pending → accounts/${id.sub} zugeordnet (${id.email ?? "ohne E-Mail"})`);
      } catch (err) {
        console.warn("[account-space] Zuordnung von _pending fehlgeschlagen:", err);
        mkdirSync(ziel, { recursive: true });
      }
    } else {
      // Der User hat schon einen Space (z. B. nach "Konto hinzufuegen"
      // doch das alte gewaehlt): _pending bleibt liegen, ist nur
      // Onboarding-Zustand.
      log(`accounts/${id.sub} existiert bereits, _pending bleibt unbenutzt`);
    }
  } else {
    log(`Identitaets-Sperre: Space ${activeId} gehoert nicht zu ${id.sub} → eigener Space, Neustart`);
    mkdirSync(spaceDir(id.sub), { recursive: true });
    // v0.1.535 — ein fremdes Token darf im Space des anderen Kontos nicht
    // liegen bleiben (sonst Endlosschleife: Wechsel → stille Anmeldung
    // als falsches Konto → Sperre → zurueck). Der Space meldet sich beim
    // naechsten Wechsel einmal ueber das vorbefuellte Formular neu an.
    try {
      rmSync(join(spaceDir(activeId), "auth.bin"), { force: true });
      log(`fremdes auth.bin aus Space ${activeId} entfernt`);
    } catch {
      /* best-effort */
    }
  }
  reg.active = id.sub;
  writeRegistry(reg);
  // identity.json in den ZIEL-Space schreiben (activeId zeigt noch auf den alten).
  try {
    writeFileSync(
      join(spaceDir(id.sub), "identity.json"),
      JSON.stringify({ ...id, lastSignInAt: now }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
  setTimeout(relaunch, opts.relaunchDelayMs ?? 800);
  return "relaunching";
}

/** Zu einem bekannten Account wechseln (Neustart). */
export function switchAccount(sub: string): boolean {
  const reg = readRegistry();
  if (!reg.accounts[sub] || !existsSync(spaceDir(sub))) return false;
  if (sub === activeId) return true;
  reg.active = sub;
  reg.accounts[sub] = { ...reg.accounts[sub], lastUsedAt: new Date().toISOString() };
  writeRegistry(reg);
  log(`Wechsel zu ${sub} → Neustart`);
  setTimeout(relaunch, 300);
  return true;
}

/** "Anderes Konto hinzufuegen": frischen _pending-Space aktivieren und
 *  neu starten; die Anmeldung dort ordnet ihn dem neuen User zu. */
export function startNewAccount(): void {
  const reg = readRegistry();
  reg.active = null;
  writeRegistry(reg);
  mkdirSync(spaceDir(PENDING), { recursive: true });
  // Merker fuer auth: beim naechsten Login prompt=login erzwingen, damit
  // Keycloak nicht stillschweigend die bestehende SSO-Session nimmt.
  try {
    writeFileSync(join(spaceDir(PENDING), ".force-login-prompt"), "1");
  } catch {
    /* best-effort */
  }
  log("neues Konto: _pending aktiviert → Neustart");
  setTimeout(relaunch, 300);
}

/**
 * T2 — Konto samt lokalem Space vom Geraet entfernen. Nur fuer NICHT
 * aktive Konten (der aktive Space hat offene PGlite-/Datei-Handles).
 * Loescht Keys, Chats, Profil, Integrationen dieses Kontos endgueltig;
 * Remote-Daten bleiben unberuehrt.
 */
export function removeAccount(sub: string): { ok: boolean; grund?: string } {
  if (sub === activeId) return { ok: false, grund: "aktives Konto kann nicht entfernt werden" };
  if (sub === PENDING || !/^[A-Za-z0-9._-]+$/.test(sub)) return { ok: false, grund: "ungueltige Konto-ID" };
  const reg = readRegistry();
  try {
    if (existsSync(spaceDir(sub))) rmSync(spaceDir(sub), { recursive: true, force: true });
  } catch (err) {
    return { ok: false, grund: err instanceof Error ? err.message : String(err) };
  }
  delete reg.accounts[sub];
  if (reg.active === sub) reg.active = null;
  writeRegistry(reg);
  log(`Konto ${sub} vom Geraet entfernt`);
  return { ok: true };
}

export function consumeForceLoginPrompt(): boolean {
  const p = join(spaceDir(activeId), ".force-login-prompt");
  if (!existsSync(p)) return false;
  try {
    renameSync(p, `${p}.used`);
  } catch {
    /* ignore */
  }
  return true;
}
