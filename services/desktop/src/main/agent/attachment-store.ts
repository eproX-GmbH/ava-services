import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// AttachmentStore (Phase 8.e — Excel-in-chat Scope C bridge).
//
// Haelt Bytes + Metadaten der Dateien, die der Nutzer in den Chat gelegt
// hat. Das Modell sieht nur den Marker `[attachment: …, id: att-…]` und
// arbeitet ueber Werkzeuge mit dem Handle (import_excel, datei_*, Mail-
// Anhaenge). Bytes gehen nie in den Prompt.
//
// 2026-09-30 (docs/PLAN_CHAT_DATEIEN_KONTEXT.md, D1/D3): alle Dateitypen,
// Text als Seitenliste fuer datei_lesen/datei_suchen, Ablage auf Platte
// (userData/anhaenge), Zuordnung zur Unterhaltung, Aufloesen nach Name.
// Vorher: nur Tabellen, nur RAM, 30 Minuten; PDF-Text stand komplett im
// Prompt (Betzemeier-Test: 100k Tokens je Zug).
export interface StagedSheetSummary {
  name: string;
  headers: string[];
  totalRows: number;
}
export type AnhangTyp = "tabelle" | "pdf" | "text" | "docx" | "bild" | "sonstige";
export interface StagedAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  bytes: Uint8Array;
  sheets: StagedSheetSummary[];
  stagedAt: number;
  typ: AnhangTyp;
  mimeType: string;
  conversationId?: string;
  /** Extrahierter Text je Seite (PDF/DOCX) bzw. eine "Seite" fuer Textdateien. */
  seiten?: string[];
  /** Erste ~600 Zeichen, fuer Marker und datei_info. */
  kurzansicht?: string;
}
export interface StageAttachmentInput {
  filename: string;
  /** Raw file bytes — Electron's structured-clone IPC handles Uint8Array. */
  bytes: Uint8Array;
  sheets: StagedSheetSummary[];
  conversationId?: string;
  seiten?: string[];
  typ?: AnhangTyp;
}
/** Auf Platte: 7 Tage nach dem Staging. Handles ueberleben Neustarts. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KURZANSICHT_ZEICHEN = 600;

export function typAusDateiname(filename: string): AnhangTyp {
  const n = filename.toLowerCase();
  if (/\.(xlsx|xls|csv|tsv)$/.test(n)) return "tabelle";
  if (n.endsWith(".pdf")) return "pdf";
  if (/\.(txt|md|markdown|json|xml|html?)$/.test(n)) return "text";
  if (n.endsWith(".docx")) return "docx";
  if (/\.(png|jpe?g|webp|gif)$/.test(n)) return "bild";
  return "sonstige";
}
export function mimeAusDateiname(filename: string): string {
  const n = filename.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/\.pdf$/, "application/pdf"], [/\.xlsx$/, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [/\.xls$/, "application/vnd.ms-excel"], [/\.csv$/, "text/csv"], [/\.tsv$/, "text/tab-separated-values"],
    [/\.txt$/, "text/plain"], [/\.md$/, "text/markdown"], [/\.json$/, "application/json"],
    [/\.docx$/, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [/\.png$/, "image/png"], [/\.jpe?g$/, "image/jpeg"], [/\.webp$/, "image/webp"], [/\.gif$/, "image/gif"],
  ];
  for (const [re, m] of map) if (re.test(n)) return m;
  return "application/octet-stream";
}

type Meta = Omit<StagedAttachment, "bytes">;

export class AttachmentStore {
  private readonly entries = new Map<string, StagedAttachment>();
  private sweepTimer?: NodeJS.Timeout;
  /** Ordner fuer die Ablage; ohne Ordner nur RAM (Tests). */
  constructor(private readonly ordner?: string) {
    if (ordner) {
      try { mkdirSync(ordner, { recursive: true }); this.ladeVonPlatte(); } catch { /* RAM-Betrieb */ }
    }
  }
  stage(input: StageAttachmentInput): StagedAttachment {
    this.sweepExpired();
    const id = `att-${randomUUID()}`;
    const seiten = input.seiten?.map((s) => s ?? "");
    const kurz = seiten?.find((s) => s.trim())?.replace(/\s+/g, " ").trim().slice(0, KURZANSICHT_ZEICHEN);
    const entry: StagedAttachment = {
      id,
      filename: input.filename,
      sizeBytes: input.bytes.byteLength,
      bytes: input.bytes,
      sheets: input.sheets,
      stagedAt: Date.now(),
      typ: input.typ ?? typAusDateiname(input.filename),
      mimeType: mimeAusDateiname(input.filename),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(seiten ? { seiten } : {}),
      ...(kurz ? { kurzansicht: kurz } : {}),
    };
    this.entries.set(id, entry);
    this.schreibeAufPlatte(entry);
    this.armSweeper();
    return entry;
  }
  get(id: string): StagedAttachment | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.stagedAt > TTL_MS) {
      this.discard(id);
      return undefined;
    }
    return entry;
  }
  /** Alle Dateien einer Unterhaltung, neueste zuletzt. */
  listeFuer(conversationId: string | undefined): StagedAttachment[] {
    this.sweepExpired();
    return [...this.entries.values()]
      .filter((e) => !conversationId || e.conversationId === conversationId)
      .sort((a, b) => a.stagedAt - b.stagedAt);
  }
  /**
   * D3 — Handle, exakter Dateiname oder eindeutiger Namensteil. Ohne
   * Unterhaltung wird ueber alle Dateien gesucht.
   */
  aufloesen(conversationId: string | undefined, angabe: string): { datei: StagedAttachment } | { fehler: string; kandidaten: string[] } {
    const a = angabe.trim();
    const direkt = a.startsWith("att-") ? this.get(a) : undefined;
    if (direkt) return { datei: direkt };
    const liste = this.listeFuer(conversationId);
    const exakt = liste.filter((e) => e.filename.toLowerCase() === a.toLowerCase());
    if (exakt.length === 1) return { datei: exakt[0]! };
    const teil = liste.filter((e) => e.filename.toLowerCase().includes(a.toLowerCase()));
    if (teil.length === 1) return { datei: teil[0]! };
    if (teil.length > 1) {
      return { fehler: `"${angabe}" ist nicht eindeutig. Nenne den vollen Dateinamen oder das Handle.`, kandidaten: teil.map((e) => `${e.filename} (${e.id})`) };
    }
    return { fehler: `Keine Datei "${angabe}" in dieser Unterhaltung.`, kandidaten: liste.map((e) => `${e.filename} (${e.id})`) };
  }
  discard(id: string): boolean {
    const ok = this.entries.delete(id);
    if (this.ordner) {
      for (const ext of ["bin", "json"]) { try { rmSync(join(this.ordner, `${id}.${ext}`), { force: true }); } catch { /* egal */ } }
    }
    return ok;
  }
  /** Drop everything — used on app shutdown (Platte bleibt). */
  clear(): void {
    this.entries.clear();
  }
  /** Visible for tests. */
  size(): number {
    return this.entries.size;
  }
  private schreibeAufPlatte(entry: StagedAttachment): void {
    if (!this.ordner) return;
    try {
      const { bytes, ...meta } = entry;
      writeFileSync(join(this.ordner, `${entry.id}.bin`), bytes);
      writeFileSync(join(this.ordner, `${entry.id}.json`), JSON.stringify(meta satisfies Meta));
    } catch (err) {
      console.warn(`[anhaenge] Ablage fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  private ladeVonPlatte(): void {
    if (!this.ordner || !existsSync(this.ordner)) return;
    for (const f of readdirSync(this.ordner)) {
      if (!f.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.ordner, f), "utf8")) as Meta;
        const bin = join(this.ordner, `${meta.id}.bin`);
        if (!existsSync(bin) || Date.now() - meta.stagedAt > TTL_MS) { this.discard(meta.id); continue; }
        if (statSync(bin).size !== meta.sizeBytes) { this.discard(meta.id); continue; }
        this.entries.set(meta.id, { ...meta, bytes: new Uint8Array(readFileSync(bin)) });
      } catch { /* kaputte Datei ignorieren */ }
    }
  }
  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.stagedAt > TTL_MS) this.discard(id);
    }
  }
  private armSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), 60 * 60 * 1000);
    this.sweepTimer.unref?.();
  }
}
