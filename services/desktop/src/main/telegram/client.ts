// v0.1.412 — Minimaler Client für die Telegram-Bot-API.
//
// Nur die drei Aufrufe, die AVA braucht:
//   getMe        — Token validieren + Bot-Namen anzeigen
//   sendMessage  — Meldung zustellen
//   getUpdates   — Chat-ID bei der Einrichtung automatisch ermitteln
//
// Bewusst ohne SDK: drei REST-Aufrufe rechtfertigen keine Abhängigkeit.
// Timeout/Retry-Form ist an main/auth.ts angelehnt (pro Versuch ein
// eigener AbortSignal.timeout, Backoff zwischen den Versuchen).
//
// WICHTIG: Der Token steht in der URL. Er darf deshalb NIE in Logs oder
// Fehlermeldungen auftauchen — `redactToken()` putzt jede Meldung, die
// nach außen geht.

const API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 20_000;

export interface TelegramApiError extends Error {
  /** HTTP-Status, falls vorhanden. */
  status?: number;
  /** Bei 429: Sekunden, die Telegram zu warten verlangt. */
  retryAfter?: number;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramIncomingChat {
  chatId: string;
  chatType: string;
  title: string;
  text: string;
  /** v0.1.419 — Foto (groesste angebotene Aufloesung). */
  photoFileId?: string;
  /** v0.1.419 — Sprachnachricht bzw. Audio (OGG/Opus). */
  voiceFileId?: string;
  /** Bildunterschrift bei Fotos. */
  caption?: string;
}

/** Entfernt einen Bot-Token aus beliebigem Text (Logs, Fehlermeldungen). */
export function redactToken(text: string): string {
  return text.replace(/bot\d{6,}:[A-Za-z0-9_-]+/g, "bot<REDACTED>");
}

async function call<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  let lastErr: TelegramApiError | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const json = (await res.json().catch(() => null)) as
        | TelegramResponse<T>
        | null;

      if (res.ok && json?.ok === true && json.result !== undefined) {
        return json.result;
      }

      const err = new Error(
        json?.description
          ? redactToken(json.description)
          : `Telegram-API: HTTP ${res.status}`,
      ) as TelegramApiError;
      err.status = res.status;
      if (json?.parameters?.retry_after) {
        err.retryAfter = json.parameters.retry_after;
      }

      // 401/403/400 sind endgültig — nicht erneut versuchen.
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        throw err;
      }
      // 429: so lange warten, wie Telegram verlangt (gedeckelt).
      if (res.status === 429 && err.retryAfter) {
        await sleep(Math.min(err.retryAfter * 1000, 30_000));
        lastErr = err;
        continue;
      }
      lastErr = err;
    } catch (raw) {
      const err = raw as TelegramApiError;
      // Endgültige Fehler direkt hochreichen.
      if (err.status === 401 || err.status === 403 || err.status === 400) {
        throw err;
      }
      lastErr =
        raw instanceof Error
          ? ((): TelegramApiError => {
              const e = new Error(redactToken(raw.message)) as TelegramApiError;
              e.status = err.status;
              return e;
            })()
          : (new Error("Unbekannter Telegram-Fehler") as TelegramApiError);
    }
    // Backoff vor dem nächsten Versuch.
    if (attempt < 2) await sleep(500 * 2 ** attempt);
  }
  throw lastErr ?? new Error("Telegram-Aufruf fehlgeschlagen.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Token validieren + Bot-Identität abrufen. Wirft bei ungültigem Token. */
export async function getMe(token: string): Promise<TelegramBotInfo> {
  const r = await call<{ id: number; username?: string; first_name?: string }>(
    token,
    "getMe",
  );
  return {
    id: r.id,
    username: r.username ?? "",
    firstName: r.first_name ?? "",
  };
}

/** Nachricht senden. `text` ist bereits HTML-escaped. */
export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  opts?: { disablePreview?: boolean; silent?: boolean },
): Promise<void> {
  await call(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: opts?.disablePreview !== false },
    disable_notification: opts?.silent === true,
  });
}

/**
 * Eingehende Nachrichten abholen — nur für die Chat-ID-Ermittlung bei der
 * Einrichtung. `offset` überspringt bereits gesehene Updates.
 *
 * Hinweis: `getUpdates` kollidiert mit einem gesetzten Webhook und mit
 * parallelen Pollern (Telegram antwortet dann mit 409). Wir pollen nur
 * kurz während der Einrichtung.
 */
export async function getUpdates(
  token: string,
  offset?: number,
  longPollSeconds = 0,
): Promise<{ updateId: number; chat: TelegramIncomingChat }[]> {
  const raw = await call<
    {
      update_id: number;
      message?: {
        text?: string;
        caption?: string;
        photo?: { file_id: string; file_size?: number; width?: number }[];
        voice?: { file_id: string; file_size?: number };
        audio?: { file_id: string; file_size?: number };
        chat?: { id: number; type?: string; title?: string; username?: string; first_name?: string };
      };
    }[]
  >(token, "getUpdates", {
    ...(offset !== undefined ? { offset } : {}),
    timeout: longPollSeconds,
    allowed_updates: ["message"],
  });

  const out: { updateId: number; chat: TelegramIncomingChat }[] = [];
  for (const u of raw) {
    const chat = u.message?.chat;
    if (!chat) continue;
    // Telegram liefert Fotos in mehreren Aufloesungen — die groesste nehmen.
    const photos = u.message?.photo ?? [];
    const biggest = photos.length
      ? photos.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a))
      : undefined;
    const voice = u.message?.voice ?? u.message?.audio;
    out.push({
      updateId: u.update_id,
      chat: {
        chatId: String(chat.id),
        chatType: chat.type ?? "private",
        title:
          chat.title ??
          chat.username ??
          chat.first_name ??
          String(chat.id),
        text: u.message?.text ?? "",
        ...(biggest ? { photoFileId: biggest.file_id } : {}),
        ...(voice ? { voiceFileId: voice.file_id } : {}),
        ...(u.message?.caption ? { caption: u.message.caption } : {}),
      },
    });
  }
  return out;
}

/** Obergrenze fuer heruntergeladene Anhaenge (Bilder/Sprachnachrichten). */
const MAX_FILE_BYTES = 12 * 1024 * 1024;

/**
 * v0.1.419 — Eine Telegram-Datei herunterladen (Foto oder Sprachnachricht).
 * Zwei Schritte laut Bot-API: erst `getFile` fuer den Pfad, dann der
 * Datei-Endpunkt. Der Token steckt auch hier in der URL — Fehlermeldungen
 * laufen deshalb durch `redactToken`.
 */
export async function downloadFile(
  token: string,
  fileId: string,
): Promise<{ bytes: Buffer; mimeHint: string } | null> {
  try {
    const info = await call<{ file_path?: string; file_size?: number }>(
      token,
      "getFile",
      { file_id: fileId },
    );
    if (!info.file_path) return null;
    if ((info.file_size ?? 0) > MAX_FILE_BYTES) {
      throw new Error("Datei ist zu gross (max. 12 MB).");
    }
    const res = await fetch(
      `${API_BASE}/file/bot${token}/${info.file_path}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_FILE_BYTES) {
      throw new Error("Datei ist zu gross (max. 12 MB).");
    }
    const ext = info.file_path.split(".").pop()?.toLowerCase() ?? "";
    const mimeHint =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : ext === "oga" || ext === "ogg"
              ? "audio/ogg"
              : "application/octet-stream";
    return { bytes: buf, mimeHint };
  } catch (err) {
    const msg = err instanceof Error ? redactToken(err.message) : String(err);
    console.warn("[telegram] Datei-Download:", msg);
    return null;
  }
}

/** HTML-Escaping für Telegram (parse_mode=HTML erlaubt nur wenige Tags). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
