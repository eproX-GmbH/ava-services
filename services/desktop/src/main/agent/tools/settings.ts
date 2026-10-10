import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";
import type { ChatgptPlanStand } from "../../../shared/types";
import { MAIL_ENTWURF_ZIELE, ZIEL_TEXT, type MailEntwurfZiel } from "../../../shared/mail-entwurf";
import { mailEntwurfZiel, mailEntwurfZielSetzen } from "../../mail-entwurf/einstellung";
import type { FesteAnhaenge } from "../../mail-entwurf/feste-anhaenge";
import { postfachEntfernen, postfachStand } from "../../mail-entwurf/postfach";
import type { AttachmentStore } from "../attachment-store";
import type {
  HostedProviderKind,
  LlmProviderKind,
} from "../../../shared/types";

// Settings tools (Phase 8.j, expanded in 8.k1).
//
// These are the agent's self-service surface for the provider switch.
// They map onto the LlmProviderManager 1:1, and exist as tools (not
// only IPC) because the user can request "switch me to OpenAI, here is
// my key" in chat — the model needs callable functions that perform the
// change atomically and report the resulting status.
//
// 8.k1: tools generalised across all five hosted-or-local providers
// (ollama, openai, anthropic, google, mistral). The api-key tools take
// `{provider, apiKey}` so a single tool surface handles every vendor.
//
// Security: the key arrives in chat as plaintext. We accept that risk
// because it's the same channel where the user typed it; once stored
// it's encrypted via safeStorage. The Settings → Agent panel (8.g) is
// the recommended UX, but the chat path stays open as the fallback.

const ALL_KINDS: readonly LlmProviderKind[] = [
  "ollama",
  "openai",
  "anthropic",
  "google",
  "mistral",
];

const HOSTED_KINDS: readonly HostedProviderKind[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
];

// v0.1.216 — Provider, für die der Chat-Agent neue API-Keys speichern
// darf. Anthropic ist hier raus: API-Key-Anmeldung wurde wegen zu
// hoher API-Kosten eingestellt, Anmeldung läuft ausschließlich über
// das Pro/Max-Abo. Das Clear-Tool kennt weiterhin alle vier Kinds
// (Bestandsnutzer müssen ihre Anthropic-Keys über den Chat oder die
// Settings entfernen können).
const SETTABLE_KEY_KINDS: readonly HostedProviderKind[] = HOSTED_KINDS.filter(
  (k) => k !== "anthropic",
);

/**
 * Per-vendor key-format hint. Kept loose on purpose — vendors rotate
 * formats and we'd rather store an unrecognised-but-valid key than
 * reject a legitimate one. The substring/prefix checks below catch the
 * obvious "user pasted the wrong thing" mistake without being strict
 * about exact length.
 */
function validateApiKey(provider: HostedProviderKind, key: string): void {
  if (key.length < 16) {
    throw new Error(`${provider} key looks too short`);
  }
  switch (provider) {
    case "openai":
      if (!/^sk-/i.test(key)) {
        throw new Error("OpenAI keys start with 'sk-'");
      }
      break;
    case "anthropic":
      if (!/^sk-ant-/i.test(key)) {
        throw new Error("Anthropic keys start with 'sk-ant-'");
      }
      break;
    case "google":
      // Google AI Studio keys typically start with "AIza" but the SDK
      // also accepts service-account tokens — leave the prefix as a
      // soft hint via the message rather than a hard reject.
      if (!/^[A-Za-z0-9_\-]{20,}$/.test(key)) {
        throw new Error("Google API key looks malformed");
      }
      break;
    case "mistral":
      // Mistral keys are opaque hex-ish tokens; just check shape.
      if (!/^[A-Za-z0-9_\-]{20,}$/.test(key)) {
        throw new Error("Mistral API key looks malformed");
      }
      break;
  }
}

export interface SettingsToolDeps {
  providers: LlmProviderManager;
  /** v0.1.491 — Publikations-Analysemodus (lazy/eager) per Chat. */
  getPublicationMode?: () => "lazy" | "eager";
  setPublicationMode?: (mode: "lazy" | "eager") => "lazy" | "eager";
  /** Feste Anhänge für Mail-Entwürfe (docs/PLAN_MAIL_ENTWURF.md E8). */
  festeAnhaenge?: FesteAnhaenge;
  /** Chat-Uploads, aus denen feste Anhänge übernommen werden. */
  chatAnhaenge?: AttachmentStore;
}

export function buildSettingsTools(deps: SettingsToolDeps): Tool[] {
  const { providers } = deps;

  const getProvider = defineTool({
    name: "settings_get_provider",
    description:
      "Read the active LLM provider configuration plus per-provider key presence. Use this BEFORE proposing a switch so you can confirm what's currently set and which providers are usable.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const bundle = providers.getConfigBundle();
      return {
        kind: bundle.config.kind,
        models: bundle.config.models,
        ready: bundle.status.ready,
        model: bundle.status.model,
        hasKey: bundle.hasKey,
        encryptionAvailable: bundle.encryptionAvailable,
        errorMessage: bundle.status.errorMessage,
        keySource: bundle.keySource,
        orgProviders: bundle.orgProviders,
        providerLock: bundle.providerLock,
      };
    },
    preview: (r) => {
      const missing = HOSTED_KINDS.filter((k) => !r.hasKey[k]);
      const missingNote = missing.length > 0
        ? `, missing keys: ${missing.join(", ")}`
        : "";
      return `provider: ${r.kind}${r.ready ? "" : " (not ready)"}${missingNote}`;
    },
  });

  const setProvider = defineTool({
    name: "settings_set_provider",
    description:
      "Switch the active LLM provider. `kind` is one of 'ollama', 'openai', 'anthropic', 'google', 'mistral'. Hosted providers require their API key to be stored first via `settings_set_api_key`. Optionally override the model tag for the chosen provider.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...ALL_KINDS],
          description: "Provider to make active.",
        },
        model: {
          type: "string",
          description:
            "Optional model id for this provider (e.g. 'llama3.2:3b', 'gpt-6-luna', 'claude-sonnet-5-5', 'gemini-3.8-flash', 'mistral-large-latest').",
        },
      },
      required: ["kind"],
    },
    schema: yup.object({
      kind: yup.string().oneOf([...ALL_KINDS]).required(),
      model: yup.string().trim().optional(),
    }),
    run: async (args) => {
      const next = providers.setProvider(args.kind as LlmProviderKind, {
        model: args.model,
      });
      const status = providers.getStatus();
      return {
        kind: next.kind,
        model: status.model,
        ready: status.ready,
        errorMessage: status.errorMessage,
      };
    },
    preview: (r) =>
      `switched to ${r.kind}${r.model ? ` (${r.model})` : ""}${
        r.ready ? "" : " (not ready)"
      }`,
  });

  const setKey = defineTool({
    name: "settings_set_api_key",
    description:
      "Store the user's API key for a hosted provider. Encrypted at rest via the OS keychain (safeStorage). Call this BEFORE switching to that provider. Never echo the key back in your reply. NOTE: Anthropic is intentionally NOT supported here — the user should connect via the Pro/Max subscription (Settings → Modelle → Anthropic).",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...SETTABLE_KEY_KINDS],
          description:
            "Hosted provider to store the key for. Anthropic is excluded — use the subscription flow instead.",
        },
        apiKey: {
          type: "string",
          description: "The user's API key for the chosen provider.",
        },
      },
      required: ["provider", "apiKey"],
    },
    schema: yup.object({
      provider: yup.string().oneOf([...SETTABLE_KEY_KINDS]).required(),
      apiKey: yup.string().trim().min(16, "API key looks too short").required(),
    }),
    run: async (args) => {
      const provider = args.provider as HostedProviderKind;
      validateApiKey(provider, args.apiKey);
      await providers.setApiKey(provider, args.apiKey);
      return {
        ok: true,
        provider,
        encryptionAvailable: providers.isEncryptionAvailable(),
      };
    },
    // Mask the value entirely in the timeline preview — the args toggle
    // would still expose it, but `summarizeArgs` truncates at 80 chars
    // and the key is longer; either way the preview itself never carries it.
    preview: (r) =>
      `${r.provider} key stored (${
        r.encryptionAvailable ? "OS keychain" : "basic cipher, keychain unavailable"
      })`,
  });

  const clearKey = defineTool({
    name: "settings_clear_api_key",
    description:
      "Forget the stored API key for a hosted provider. If that provider was active it auto-falls-back to the local Ollama model.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...HOSTED_KINDS],
          description: "Hosted provider whose key should be cleared.",
        },
      },
      required: ["provider"],
    },
    schema: yup.object({
      provider: yup.string().oneOf([...HOSTED_KINDS]).required(),
    }),
    run: async (args) => {
      const provider = args.provider as HostedProviderKind;
      providers.clearApiKey(provider);
      return { provider, kind: providers.getConfig().kind };
    },
    preview: (r) => `${r.provider} key cleared, now using ${r.kind}`,
  });

  // Claude-Abo-OAuth wurde entfernt — keine Abo-Token-Tools mehr.

  // v0.1.405 — Tages-Token-Limit (Chat + Agent) per Chat setzen/entfernen.
  const setDailyTokenLimit = defineTool({
    name: "settings_set_daily_token_limit",
    description:
      "Set or remove the daily token limit that applies to BOTH chat and " +
      "the agent (shared per-day counter, UTC calendar day, counting " +
      "input+output+cache tokens). Pass a positive integer to set it, or " +
      "null/0 to remove the limit entirely (default = no limit). When the " +
      "day's usage reaches the limit, the in-flight request still finishes " +
      "and the NEXT request is paused until the user raises or removes the " +
      "limit. Use this when the user asks to cap, change, or lift their " +
      "daily token budget.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: ["integer", "null"],
          description:
            "Daily token limit as a positive whole number (e.g. 200000), " +
            "or null/0 to remove the limit.",
        },
      },
      required: ["limit"],
    },
    schema: yup.object({
      limit: yup
        .number()
        .typeError("Limit muss eine ganze Zahl sein")
        .integer("Limit muss eine ganze Zahl sein (keine Kommazahl)")
        .min(0, "Limit darf nicht negativ sein")
        .nullable()
        .defined(),
    }),
    run: async (args) => {
      const raw = args.limit;
      const limit =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0
          ? Math.floor(raw)
          : null;
      const applied = providers.setDailyTokenLimit(limit);
      return { limit: applied };
    },
    preview: (r) =>
      r.limit === null
        ? "Tägliches Token-Limit entfernt"
        : `Tägliches Token-Limit: ${r.limit.toLocaleString("de-DE")} Tokens/Tag`,
  });

  // v0.1.491 — Self-Service: Publikations-Analysemodus.
  const publicationAnalysis = defineTool({
    name: "publication_analysis_config",
    description:
      "Ohne Parameter: aktueller Publikations-Analysemodus. Mit `mode`: " +
      "umstellen (mutating). 'lazy' (Default) analysiert nur " +
      "trend-relevante Bloecke per LLM, 'eager' JEDEN Block — " +
      "gruendlicher, aber deutlich mehr LLM-Kosten/Laufzeit. Die " +
      "Umstellung recycelt den company-publication-Producer automatisch.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["lazy", "eager"] },
      },
    },
    schema: yup.object({
      mode: yup.string().oneOf(["lazy", "eager"]).optional(),
    }),
    preview: (r) => JSON.stringify(r).slice(0, 80),
    run: async (args, c) => {
      if (!deps.getPublicationMode || !deps.setPublicationMode) {
        return "Publikations-Analyse nicht initialisiert.";
      }
      const aktuell = deps.getPublicationMode();
      if (!args.mode) return { mode: aktuell };
      if (args.mode === aktuell) return { mode: aktuell, hinweis: "unveraendert" };
      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt:
            args.mode === "eager"
              ? "Publikations-Analyse auf VOLLSTAENDIG (eager) stellen? Jeder Block wird per LLM analysiert — mehr Kosten und Laufzeit."
              : "Publikations-Analyse auf SPARSAM (lazy) stellen? Nur trend-relevante Bloecke werden analysiert.",
          confirmValue: "save",
          options: [
            { value: "save", label: "Umstellen" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "save") return userDeclined();
      return { mode: deps.setPublicationMode(args.mode as "lazy" | "eager") };
    },
  });

  // O5 — Schluesselquelle je Anbieter (eigen | organisation).
  const setKeySource = defineTool({
    name: "settings_set_key_source",
    description:
      "Schluesselquelle eines Anbieters umschalten: 'organisation' = Aufrufe laufen ueber den Organisationsschluessel im AVA-Gateway (Verbrauch der Organisation, Gateway sieht Prompts), 'eigen' = eigener Schluessel/Abo, alles lokal. Nur moeglich, wenn die Organisation fuer den Anbieter einen Schluessel hinterlegt hat und die Vorgabe lokales Ueberschreiben erlaubt.",
    parameters: {
      type: "object",
      required: ["kind", "source"],
      properties: {
        kind: { type: "string", enum: [...ALL_KINDS] },
        source: { type: "string", enum: ["eigen", "organisation"] },
      },
    },
    schema: yup
      .object({
        kind: yup.string().oneOf([...ALL_KINDS]).required(),
        source: yup.string().oneOf(["eigen", "organisation"]).required(),
      })
      .noUnknown(true),
    preview: (r: { kind: string; source: string }) => `${r.kind}: Schluessel ${r.source === "organisation" ? "der Organisation" : "eigen"}`,
    run: async (args) => {
      providers.setKeySource(args.kind as LlmProviderKind, args.source as "eigen" | "organisation");
      return { kind: args.kind, source: args.source, ready: providers.getStatus().ready };
    },
  });

  // docs/PLAN_SIGN_IN_WITH_CHATGPT.md — Stand der ChatGPT-Verbindung lesen,
  // Modelle des Kontos laden, Modell waehlen. Die Anmeldung selbst ist
  // Erst-Consent und bleibt in den Einstellungen (Fenster von OpenAI).
  const chatgptPlan = defineTool({
    name: "settings_chatgpt_plan",
    summary: "ChatGPT-Abo (Sign in with ChatGPT): Stand ansehen, freigegebene Modelle laden, Modell waehlen, Firmenverarbeitung ueber das Abo an/aus.",
    category: "einstellungen anbieter",
    description:
      "ChatGPT-Abo des Nutzers (Sign in with ChatGPT, Plan-Nutzung). `aktion` 'stand' liefert Verbindung, Konto, gewaehltes Modell " +
      "und die fuer das Konto freigegebenen Modelle; 'modelle' laedt die Liste frisch von OpenAI; 'modell' setzt das Modell " +
      "(`modell` = Slug aus der Liste, leer = Standard des Kontos; gilt fuer Chat, Hintergrund-KI und Firmenverarbeitung). " +
      "'firmenverarbeitung' schaltet mit `an`, ob auch die Firmenverarbeitung (Profile, Jahresabschluesse, Kontakte, Bewertung, Recherche Standard) " +
      "ueber das Abo laeuft; Sprachmodus und Deep Research brauchen immer einen Schluessel. Die Anmeldung selbst macht der Nutzer in den Einstellungen " +
      "(Knopf 'Continue with ChatGPT'); verweise dorthin, wenn keine Verbindung besteht. Nutzungslimits verwaltet der Nutzer unter " +
      "chatgpt.com/settings/usage.",
    parameters: {
      type: "object",
      properties: {
        aktion: { type: "string", enum: ["stand", "modelle", "modell", "firmenverarbeitung"] },
        modell: { type: "string", description: "Modell-Slug fuer aktion 'modell'; leer = Standard" },
        an: { type: "boolean", description: "Fuer aktion 'firmenverarbeitung': true = Producer ueber das Abo" },
      },
      required: ["aktion"],
    },
    schema: yup
      .object({
        aktion: yup.string().oneOf(["stand", "modelle", "modell", "firmenverarbeitung"]).required(),
        modell: yup.string().trim().max(120).optional(),
        an: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: ChatgptPlanStand | ReturnType<typeof userDeclined>) =>
      "verbunden" in r
        ? r.verbunden
          ? `ChatGPT-Abo verbunden${r.modell ? ` · ${r.modell}` : ""}${r.firmenverarbeitung === false ? " · Firmenverarbeitung per Schluessel" : ""}`
          : "ChatGPT-Abo nicht verbunden"
        : "abgebrochen",
    run: async (args, c): Promise<ChatgptPlanStand | ReturnType<typeof userDeclined>> => {
      if (args.aktion === "modell") return providers.setChatgptPlanModell(args.modell ?? null);
      if (args.aktion === "modelle") return providers.ladeChatgptPlanModelle();
      if (args.aktion === "firmenverarbeitung") {
        if (typeof args.an !== "boolean") throw new Error("aktion 'firmenverarbeitung' braucht `an` (true/false).");
        const value = await c.ui.confirmAction(
          {
            kind: "mutating",
            prompt: args.an
              ? "Firmenverarbeitung (Profile, Jahresabschluesse, Kontakte, Bewertung, Recherche Standard) ueber dein ChatGPT-Abo laufen lassen? Das verbraucht dein Wochenkontingent."
              : "Firmenverarbeitung nicht mehr ueber das ChatGPT-Abo laufen lassen? Dann braucht es einen Schluessel oder ein lokales Modell.",
            confirmValue: "save",
            options: [
              { value: "save", label: "Umstellen" },
              { value: "cancel", label: "Abbrechen" },
            ],
          },
          c.signal,
        );
        if (value !== "save") return userDeclined();
        providers.setChatgptPlanProducer(args.an);
        return providers.chatgptPlanStand();
      }
      return providers.chatgptPlanStand();
    },
  });

  // Azure OpenAI fuer den eigenen OpenAI-Schluessel (shared/azure-openai.ts).
  const openaiAzure = defineTool({
    name: "settings_openai_azure",
    summary: "Azure OpenAI statt OpenAI direkt: Endpunkt und Deployments ansehen, setzen, Verbindung pruefen oder ausschalten.",
    category: "einstellungen anbieter azure openai microsoft deployment",
    description:
      "Der eigene OpenAI-Schluessel kann ein Azure-OpenAI-Schluessel sein. `aktion` 'stand' zeigt Endpunkt, Deployments und ob Azure aktiv ist; " +
      "'setzen' traegt `endpunkt` (z. B. https://firma.openai.azure.com) und `deployments` ein (Objekt Katalog-Modell-ID → Deployment-Name, " +
      "'*' = alle uebrigen Modelle; ohne Eintrag nutzt AVA ein gleichnamiges Deployment); 'pruefen' testet den gespeicherten Schluessel gegen den Endpunkt; " +
      "'aus' schaltet zurueck auf OpenAI direkt. Den Schluessel selbst setzt settings_set_api_key mit provider 'openai'. Mit Azure ist der Sprachmodus nicht verfuegbar.",
    parameters: {
      type: "object",
      required: ["aktion"],
      properties: {
        aktion: { type: "string", enum: ["stand", "setzen", "pruefen", "aus"] },
        endpunkt: { type: "string", description: "https://<ressource>.openai.azure.com" },
        deployments: { type: "object", description: "Katalog-Modell-ID → Deployment-Name, '*' fuer alle uebrigen", additionalProperties: { type: "string" } },
      },
    },
    schema: yup
      .object({
        aktion: yup.string().oneOf(["stand", "setzen", "pruefen", "aus"]).required(),
        endpunkt: yup.string().trim().max(300).optional(),
        deployments: yup.object().optional(),
      })
      .noUnknown(true),
    preview: (r: { error?: string; aktiv?: boolean; azure?: { endpoint?: string } | null } | ReturnType<typeof userDeclined>) =>
      !("aktiv" in r) && !("error" in r)
        ? "abgebrochen"
        : "error" in r && r.error
          ? String(r.error)
          : "aktiv" in r && r.aktiv
            ? `Azure OpenAI aktiv · ${r.azure?.endpoint ?? ""}`
            : "azure" in r && r.azure
              ? "Azure eingetragen, nicht aktiv"
              : "OpenAI direkt",
    run: async (args, c) => {
      const stand = () => ({ azure: providers.getAzureConfig(), aktiv: providers.azureAktiv() });
      if (args.aktion === "stand") return stand();
      if (args.aktion === "pruefen") return { ...stand(), pruefung: await providers.azurePruefen() };
      if (args.aktion === "setzen" && !args.endpunkt) return { error: "Fuer 'setzen' fehlt `endpunkt`." };
      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt:
            args.aktion === "aus"
              ? "Azure OpenAI ausschalten? Der gespeicherte OpenAI-Schluessel geht dann wieder direkt an OpenAI."
              : `OpenAI-Aufrufe ueber Azure OpenAI (${args.endpunkt}) laufen lassen? Der gespeicherte OpenAI-Schluessel muss dann der Azure-Schluessel sein.`,
          confirmValue: "save",
          options: [
            { value: "save", label: args.aktion === "aus" ? "Ausschalten" : "Speichern" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "save") return userDeclined();
      if (args.aktion === "aus") providers.setAzureConfig(null);
      else providers.setAzureConfig({ endpoint: args.endpunkt!, deployments: (args.deployments ?? {}) as Record<string, string> });
      return stand();
    },
  });

  // Mail-Entwuerfe (docs/PLAN_MAIL_ENTWURF.md): Ziel des Knopfs, feste Anhaenge,
  // Stand des Entwurfs-Postfachs. Das Postfach-Passwort gibt es nur in den Einstellungen.
  const AKTIONEN = ["stand", "setzen", "anhang_uebernehmen", "anhang_aendern", "anhang_entfernen", "postfach_entfernen"] as const;
  const mailEntwurf = defineTool({
    name: "settings_mail_entwurf",
    summary: "Mail-Entwürfe: wohin der Knopf öffnet, feste Anhänge (Firmenprofil, Referenzen) und das Entwurfs-Postfach.",
    category: "einstellungen mail entwurf outlook gmail mailto mail-programm anhang anhaenge firmenprofil postfach entwuerfe imap",
    description:
      "Unter jedem ```mail-entwurf steht ein Knopf, der den Entwurf öffnet. `aktion`:\n" +
      "- 'stand': Ziel, Entwurfs-Postfach und feste Anhänge anzeigen.\n" +
      "- 'setzen' mit `ziel`: 'auto' (Standard: Outlook → .eml mit Anhängen; mit Anhängen und Entwurfs-Postfach → Entwürfe-Ordner; sonst mailto:), " +
      "'programm' (mailto:, ohne Anhänge), 'eml', 'postfach' (immer in den Entwürfe-Ordner), 'gmail', 'outlook-web', 'outlook-live'.\n" +
      "- 'anhang_uebernehmen' mit `datei` (Chat-Upload: Handle att-… oder Dateiname), optional `immer` (an jede Outreach-Mail) und `beschreibung`: " +
      "macht daraus einen festen Anhang (Handle fix-…), der dauerhaft bleibt. Gleicher Dateiname ersetzt die alte Fassung.\n" +
      "- 'anhang_aendern' mit `id` (fix-…) und `immer` und/oder `beschreibung`; 'anhang_entfernen' mit `id`.\n" +
      "- 'postfach_entfernen': Verbindung zum Entwurfs-Postfach löschen.\n" +
      "Das Entwurfs-Postfach (Zugangsdaten) richtet der Nutzer in den Einstellungen unter „Mail-Entwürfe“ ein, nie im Chat.",
    parameters: {
      type: "object",
      required: ["aktion"],
      properties: {
        aktion: { type: "string", enum: [...AKTIONEN] },
        ziel: { type: "string", enum: [...MAIL_ENTWURF_ZIELE] },
        datei: { type: "string", description: "Chat-Upload (att-… oder Dateiname) für anhang_uebernehmen" },
        id: { type: "string", description: "fester Anhang (fix-…)" },
        immer: { type: "boolean" },
        beschreibung: { type: "string", description: "wofür die Datei gedacht ist, z. B. „Firmenprofil für Erstkontakt“" },
      },
    },
    schema: yup
      .object({
        aktion: yup.string().oneOf([...AKTIONEN]).required(),
        ziel: yup.string().oneOf([...MAIL_ENTWURF_ZIELE]).optional(),
        datei: yup.string().trim().max(200).optional(),
        id: yup.string().trim().max(40).optional(),
        immer: yup.boolean().optional(),
        beschreibung: yup.string().trim().max(200).optional(),
      })
      .noUnknown(true),
    preview: (r: { ziel?: string; error?: string; text?: string } | ReturnType<typeof userDeclined>) =>
      "error" in r && r.error ? String(r.error) : "text" in r && r.text ? String(r.text) : "ziel" in r && r.ziel ? `Mail-Entwürfe: ${ZIEL_TEXT[r.ziel as MailEntwurfZiel] ?? r.ziel}` : "abgebrochen",
    run: async (args, c) => {
      const fest = deps.festeAnhaenge;
      const stand = () => {
        const p = postfachStand();
        return {
          ziel: mailEntwurfZiel(),
          zielText: ZIEL_TEXT[mailEntwurfZiel()],
          postfach: p.eingerichtet ? { absender: p.absender, server: p.host, ordner: p.ordner } : "nicht eingerichtet (Einstellungen → Mail-Entwürfe)",
          festeAnhaenge: (fest?.liste() ?? []).map((a) => ({ id: a.id, name: a.name, immer: a.immer, beschreibung: a.beschreibung, kb: Math.round(a.sizeBytes / 1024) })),
        };
      };
      if (args.aktion === "stand") return stand();
      const bestaetigen = async (prompt: string, label: string) =>
        (await c.ui.confirmAction(
          { kind: "mutating", prompt, confirmValue: "save", options: [{ value: "save", label }, { value: "cancel", label: "Abbrechen" }] },
          c.signal,
        )) === "save";

      if (args.aktion === "setzen") {
        if (!args.ziel) return { error: "Fuer 'setzen' fehlt `ziel`." };
        const ziel = args.ziel as MailEntwurfZiel;
        if (ziel === "postfach" && !postfachStand().eingerichtet) return { error: "Erst ein Entwurfs-Postfach in den Einstellungen unter „Mail-Entwürfe“ einrichten." };
        if (!(await bestaetigen(`Mail-Entwürfe künftig öffnen in: ${ZIEL_TEXT[ziel]}?`, "Speichern"))) return userDeclined();
        mailEntwurfZielSetzen(ziel);
        return { ziel, text: `Mail-Entwürfe: ${ZIEL_TEXT[ziel]}` };
      }
      if (args.aktion === "postfach_entfernen") {
        if (!postfachStand().eingerichtet) return { text: "Es ist kein Entwurfs-Postfach eingerichtet." };
        if (!(await bestaetigen("Verbindung zum Entwurfs-Postfach löschen (Zugangsdaten werden entfernt)?", "Löschen"))) return userDeclined();
        postfachEntfernen();
        if (mailEntwurfZiel() === "postfach") mailEntwurfZielSetzen("auto");
        return { text: "Entwurfs-Postfach entfernt." };
      }
      if (!fest) return { error: "Feste Anhänge sind hier nicht verfügbar." };
      if (args.aktion === "anhang_uebernehmen") {
        if (!args.datei) return { error: "`datei` fehlt (Handle att-… oder Dateiname eines Chat-Uploads)." };
        if (!deps.chatAnhaenge) return { error: "Chat-Uploads sind hier nicht verfügbar." };
        const r = deps.chatAnhaenge.aufloesen(c.conversationId, args.datei);
        if ("fehler" in r) return { error: r.fehler, kandidaten: r.kandidaten };
        if (!(await bestaetigen(`„${r.datei.filename}“ als festen Anhang für Mail-Entwürfe speichern${args.immer ? " (an jede Outreach-Mail)" : ""}?`, "Speichern"))) return userDeclined();
        try {
          const a = fest.hinzufuegen({ name: r.datei.filename, mimeType: r.datei.mimeType, bytes: r.datei.bytes, immer: args.immer, beschreibung: args.beschreibung });
          return { text: `Fester Anhang ${a.name} (${a.id})`, anhang: a };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (!args.id) return { error: "`id` (fix-…) fehlt." };
      if (args.aktion === "anhang_entfernen") {
        if (!(await bestaetigen(`Festen Anhang ${args.id} entfernen?`, "Entfernen"))) return userDeclined();
        return fest.entfernen(args.id) ? { text: `${args.id} entfernt.` } : { error: `Kein fester Anhang ${args.id}.` };
      }
      const a = fest.aendern(args.id, { ...(args.immer !== undefined ? { immer: args.immer } : {}), ...(args.beschreibung !== undefined ? { beschreibung: args.beschreibung } : {}) });
      return a ? { text: `${a.name}: ${a.immer ? "an jede Outreach-Mail" : "nur bei Bedarf"}`, anhang: a } : { error: `Kein fester Anhang ${args.id}.` };
    },
  });

  return [
    getProvider,
    setProvider,
    mailEntwurf,
    setKey,
    clearKey,
    setDailyTokenLimit,
    publicationAnalysis,
    setKeySource,
    chatgptPlan,
    openaiAzure,
  ];
}
