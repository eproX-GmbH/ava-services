// Phase T3 — chat-history agent tools.
//
// Thin wrappers around the per-conversation MemoryStore owned by
// main/index.ts (same object the `agent:listConversations`,
// `agent:loadConversation` and `agent:deleteConversation` IPC
// handlers call). Lets the agent answer "wovon haben wir letztes Mal
// geredet?" / "lösch den alten Chat" from chat instead of from the
// renderer dropdown.
//
// Tools intentionally NOT exposed:
//
// - `chat_history_search`: the underlying MemoryStore.search() exists
//   (powers the renderer's /search palette via
//   `agent:searchConversations`), but full-text agent-side search is
//   deferred. The list + load tools below cover the canonical "open
//   the previous chat" flow; search is a separate Phase TODO.
//
// - `interest:record`: implicit interest tracking is a renderer-side
//   concern (telemetry tied to the visible UI), not an
//   agent-callable action.
//
// - `auth:signIn` / `auth:signOut`: sensitive credential flow stays
//   UI-only. The agent does not drive auth.
//
// - `app:getConfig`: read-only metadata; the agent doesn't need it
//   through chat.
//
// - `billing:openCheckout` / `billing:openPortal`: pending in T4
//   (CRM connect consolidation).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { MemoryStore } from "../memory";

export interface ChatHistoryToolDeps {
  memory: MemoryStore;
}

export function buildChatHistoryTools(deps: ChatHistoryToolDeps): Tool[] {
  const { memory } = deps;

  const listTool = defineTool({
    name: "chat_history_list",
    description:
      "Listet vergangene Chat-Sitzungen (Konversationen) sortiert nach " +
      "Aktualität, neueste zuerst. Pro Eintrag: konversationsId, Label " +
      "(erste Nutzer-Zeile, gekürzt), Zeitpunkt der letzten Änderung und " +
      "Dateigröße. Nutze das Tool, wenn der Nutzer einen früheren Chat " +
      "öffnen oder den Verlauf einsehen will. Anschließend " +
      "`chat_history_load` mit der gewünschten ID aufrufen.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximale Anzahl Einträge. Default 20.",
        },
      },
    },
    schema: yup
      .object({
        limit: yup.number().integer().min(1).max(100).optional(),
      })
      .noUnknown(true),
    run: async (args) => {
      if (!memory.isWritable()) {
        return {
          ok: false as const,
          error:
            "Speicher für Chat-Verläufe ist aktuell nicht beschreibbar. " +
            "Bitte App-Berechtigungen prüfen.",
          conversations: [] as Array<{
            conversationId: string;
            label: string;
            modifiedAt: string;
            sizeBytes: number;
          }>,
        };
      }
      const limit = args.limit ?? 20;
      const all = memory.list();
      const slice = all.slice(0, limit);
      return {
        ok: true as const,
        count: slice.length,
        total: all.length,
        conversations: slice.map((c) => ({
          conversationId: c.conversationId,
          label: c.label || "(kein Titel)",
          modifiedAt: new Date(c.modifiedAt).toISOString(),
          sizeBytes: c.sizeBytes,
        })),
      };
    },
    preview: (r) =>
      r.ok
        ? `${r.count} Chat-Sitzung(en) gelistet (gesamt ${r.total})`
        : `Verlauf nicht verfügbar: ${r.error}`,
  });

  const loadTool = defineTool({
    name: "chat_history_load",
    description:
      "Lädt das Transkript einer früheren Chat-Sitzung anhand ihrer ID. " +
      "Liefert die Nachrichtenliste mit Rolle (user / assistant / tool / " +
      "system) und Inhalt. Nutze das Tool, nachdem `chat_history_list` " +
      "die passende konversationsId geliefert hat. Unbekannte oder nicht " +
      "lesbare IDs ergeben eine leere Nachrichtenliste.",
    parameters: {
      type: "object",
      required: ["conversationId"],
      properties: {
        conversationId: {
          type: "string",
          description:
            "Die ID einer Konversation aus `chat_history_list` " +
            "(Datei-Stamm ohne `.md`).",
        },
      },
    },
    schema: yup
      .object({
        conversationId: yup.string().required(),
      })
      .noUnknown(true),
    run: async (args) => {
      const messages = memory.load(args.conversationId);
      return {
        ok: true as const,
        conversationId: args.conversationId,
        count: messages.length,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };
    },
    preview: (r) =>
      `${r.count} Nachricht(en) aus Sitzung ${r.conversationId.slice(0, 8)}…`,
  });

  const deleteTool = defineTool({
    name: "chat_history_delete",
    description:
      "Löscht eine frühere Chat-Sitzung dauerhaft anhand ihrer ID. " +
      "Nutze das Tool nur, wenn der Nutzer es ausdrücklich verlangt " +
      "(„lösch den Chat von gestern“). Die Aktion ist nicht umkehrbar. " +
      "Bestätige vorher kurz, welche Sitzung du löschst.",
    parameters: {
      type: "object",
      required: ["conversationId"],
      properties: {
        conversationId: {
          type: "string",
          description:
            "Die ID der zu löschenden Konversation aus `chat_history_list`.",
        },
      },
    },
    schema: yup
      .object({
        conversationId: yup.string().required(),
      })
      .noUnknown(true),
    run: async (args) => {
      const deleted = memory.delete(args.conversationId);
      if (!deleted) {
        return {
          ok: false as const,
          conversationId: args.conversationId,
          error:
            "Konversation nicht gefunden oder Speicher nicht beschreibbar.",
        };
      }
      return {
        ok: true as const,
        conversationId: args.conversationId,
      };
    },
    preview: (r) =>
      r.ok
        ? `Sitzung ${r.conversationId.slice(0, 8)}… gelöscht`
        : `Löschen abgelehnt: ${r.error}`,
  });

  return [listTool, loadTool, deleteTool];
}
