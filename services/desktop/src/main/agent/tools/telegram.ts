import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { TelegramStore } from "../../telegram/store";
import type { TelegramChannel } from "../../telegram/channel";
import { getMe, getUpdates } from "../../telegram/client";

// v0.1.412 — Telegram-Tools für den Chat-Agenten.
//
// Zwei Zwecke:
//   1. Einrichtung per Chat („verbinde mein Telegram") — analog zu den
//      Notion-Connect-Tools.
//   2. `telegram_send_message` — DAS Tool, das eigene Skills möglich
//      macht: „Schick mir jeden Morgen die Top-Signale per Telegram".
//      Der Kanal selbst bleibt nativ/deterministisch, die Nutzung
//      darüber darf Skill-getrieben sein.
//
// Sicherheit: Der Bot-Token kommt im Klartext durch den Chat (wie beim
// Notion-Token). Er wird sofort verschlüsselt abgelegt und NIE
// zurückgegeben — die Tool-Beschreibungen sagen das dem Modell explizit.

export interface TelegramToolDeps {
  /** Lazy — der Store existiert erst nach dem Boot der Main-Module. */
  getStore: () => TelegramStore | null;
  getChannel: () => TelegramChannel | null;
}

export function buildTelegramTools(deps: TelegramToolDeps): Tool[] {
  const requireStore = (): TelegramStore => {
    const s = deps.getStore();
    if (!s) throw new Error("Telegram ist noch nicht bereit.");
    return s;
  };

  const connectStart = defineTool({
    name: "telegram_connect_start",
    description:
      "Explain how the user sets up Telegram notifications. Returns the exact German setup steps (create a bot via @BotFather, copy the token). Call this FIRST when the user wants Telegram notifications and no bot token is stored yet. Does not require any argument.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const store = requireStore();
      const cfg = store.getConfig();
      return {
        alreadyConnected: store.hasToken(),
        botUsername: cfg.botUsername,
        chatLinked: cfg.chatId !== null,
        steps: [
          "Öffne in Telegram den Chat mit @BotFather.",
          "Schicke /newbot und vergib einen Namen.",
          "BotFather antwortet mit einem Token (Format 123456789:ABC...).",
          "Gib mir den Token hier im Chat — ich speichere ihn verschlüsselt.",
          "Danach schickst du deinem neuen Bot einmal /start, damit ich den Chat verknüpfen kann.",
        ],
      };
    },
    preview: (r) =>
      r.alreadyConnected
        ? `Telegram bereits verbunden${r.botUsername ? ` (@${r.botUsername})` : ""}`
        : "Telegram-Einrichtung erklärt",
  });

  const saveToken = defineTool({
    name: "telegram_connect_save_token",
    description:
      "Persist the Telegram bot token the user just pasted in chat, then validate it with a getMe call. The token is stored encrypted in the OS keychain. Returns the bot username on success. Never echo the token back in your reply. After success, tell the user to send /start to their bot, then call telegram_link_chat.",
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description:
            "The Telegram bot token exactly as BotFather issued it, e.g. 123456789:AAG...",
        },
      },
      required: ["token"],
    },
    schema: yup.object({
      token: yup
        .string()
        .trim()
        .min(20, "Telegram-Token wirkt zu kurz")
        .required(),
    }),
    run: async (args) => {
      try {
        const store = requireStore();
        const info = await getMe(args.token);
        await store.saveToken(args.token);
        store.setConfig({ botUsername: info.username });
        return { ok: true, botUsername: info.username };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? `Telegram-Bot verbunden: @${r.botUsername}`
        : "Telegram-Verbindung fehlgeschlagen",
  });

  const linkChat = defineTool({
    name: "telegram_link_chat",
    description:
      "Discover and store the Telegram chat id by reading the bot's pending updates. The user must have sent the bot a message (e.g. /start) beforehand. Call this after telegram_connect_save_token. Returns an error asking the user to message the bot if no update is pending.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      try {
        const store = requireStore();
        const token = await store.getToken();
        if (!token) return { ok: false, error: "Kein Bot-Token hinterlegt." };
        const updates = await getUpdates(token);
        const last = updates[updates.length - 1];
        if (!last) {
          return {
            ok: false,
            error:
              "Noch keine Nachricht vom Nutzer empfangen — bitte dem Bot in Telegram /start schicken.",
          };
        }
        store.setConfig({ chatId: last.chat.chatId });
        return { ok: true, chatTitle: last.chat.title };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok ? `Telegram-Chat verknüpft: ${r.chatTitle}` : "Chat nicht verknüpft",
  });

  const setEnabled = defineTool({
    name: "telegram_set_enabled",
    description:
      "Turn Telegram alert delivery on or off. Requires a stored token and a linked chat. Use when the user says things like 'schick mir Meldungen per Telegram' / 'keine Telegram-Meldungen mehr'.",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true = an, false = aus" },
      },
      required: ["enabled"],
    },
    schema: yup.object({ enabled: yup.boolean().required() }),
    run: async (args) => {
      const store = requireStore();
      const cfg = store.setConfig({ enabled: args.enabled });
      return { enabled: cfg.enabled, chatLinked: cfg.chatId !== null };
    },
    preview: (r) =>
      r.enabled
        ? "Telegram-Meldungen aktiviert"
        : r.chatLinked
          ? "Telegram-Meldungen deaktiviert"
          : "Telegram-Meldungen aus (kein Chat verknüpft)",
  });

  const status = defineTool({
    name: "telegram_status",
    description:
      "Read the current Telegram configuration: whether a bot token is stored, whether a chat is linked, whether delivery is enabled, and the severity threshold. Never returns the token itself.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const store = requireStore();
      const cfg = store.getConfig();
      return {
        hasToken: store.hasToken(),
        chatLinked: cfg.chatId !== null,
        enabled: cfg.enabled,
        botUsername: cfg.botUsername,
        severityThreshold: cfg.severityThreshold,
      };
    },
    preview: (r) =>
      r.hasToken
        ? `Telegram: ${r.enabled ? "aktiv" : "inaktiv"}${r.botUsername ? ` (@${r.botUsername})` : ""}`
        : "Telegram nicht verbunden",
  });

  const sendMessageTool = defineTool({
    name: "telegram_send_message",
    description:
      "Send a free-form message to the user's connected Telegram chat. Use this when the user explicitly asks to be sent something via Telegram, or inside a skill that delivers a digest/summary to Telegram. Plain text only — keep it short and readable on a phone. Requires a connected bot and linked chat.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message body as plain text (max ~3500 characters).",
        },
      },
      required: ["text"],
    },
    schema: yup.object({
      text: yup.string().trim().min(1).max(3500).required(),
    }),
    run: async (args) => {
      const channel = deps.getChannel();
      if (!channel) return { ok: false, error: "Telegram ist nicht bereit." };
      try {
        await channel.sendRaw(args.text);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok ? "Telegram-Nachricht gesendet" : `Nicht gesendet: ${r.error ?? ""}`,
  });

  const disconnect = defineTool({
    name: "telegram_disconnect",
    description:
      "Remove the stored Telegram bot token and chat configuration. Use when the user wants to disconnect Telegram.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const store = requireStore();
      await store.clear();
      return { ok: true };
    },
    preview: () => "Telegram-Verbindung getrennt",
  });

  return [
    connectStart,
    saveToken,
    linkChat,
    setEnabled,
    status,
    sendMessageTool,
    disconnect,
  ];
}
