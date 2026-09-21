// Telegram ist eine Textnachricht: Was Markdown ist, wird Text.
// Rein, ohne Electron — damit scripts/test-telegram-text.mjs es prueft.

/** v0.1.522 — Meldungs-Beschreibungen sind Markdown (Meldungs-Seite);
 *  Telegram bekommt lesbaren Text: Links als "Label: URL", Listen mit
 *  Punkt, Fettung entfernt.
 *
 *  Befund 2026-09-21: Auch Agent-Antworten kamen mit **Fettung** und
 *  Zwischenueberschriften aufs Handy. Das Sicherheitsnetz gilt deshalb
 *  fuer JEDEN Text, der den Kanal verlaesst (Antworten, Werkzeug,
 *  Meldungen) — der Prompt bittet zusaetzlich um kurzen, formatfreien
 *  Text, aber ein Modell haelt sich nicht immer daran. */
export function markdownZuText(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, c: string) => c.trim()) // Codezaeune: Inhalt behalten
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "$1") // Ueberschriften → Zeile
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/gm, "$1$2") // *kursiv*
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/gm, "$1$2")     // _kursiv_
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*\n?/gm, "") // Tabellen-Trennzeilen
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, z: string) => z.split("|").map((t) => t.trim()).filter(Boolean).join(" · "))
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "")                // Trennlinien
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
