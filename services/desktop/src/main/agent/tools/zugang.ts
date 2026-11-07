// L6 (docs/PLAN_LOESUNGSKARTEN.md): Zugang zu einem Dienst sicher im Chat
// erfassen. AVA zeigt eine Eingabekarte; die Werte gehen von der Karte direkt in
// den verschluesselten Speicher (dieselbe Schnittstelle wie Einstellungen →
// Verbindungen → Weitere Dienste). Das Modell sieht nur das Ergebnis.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { DIENST_ZUGANG_ARTEN, vorlageFuer, type DienstZugangArt, type ZugangAnfrage, type ZugangErgebnis } from "../../../shared/dienst-vorlagen";

const WARTEZEIT_MS = 15 * 60_000;

export function buildZugangTools(): Tool[] {
  const anfordern = defineTool({
    name: "zugang_anfordern",
    summary: "Zeigt im Chat eine sichere Eingabekarte für den Zugang zu einem Dienst (Schlüssel, Benutzer/Passwort, Client-ID/Secret) und verbindet ihn",
    category: "dienste verbinden zugang token schluessel passwort client secret oauth mcp a2a sicher",
    description:
      "Erfasst den Zugang zu einem Dienst sicher im Chat und verbindet ihn: Der Nutzer sieht eine Eingabekarte, die Werte gehen direkt in den verschlüsselten Speicher, du bekommst nur zurück, ob die Verbindung steht und wie viele Funktionen der Dienst bietet. " +
      "Nutze es, wenn der Nutzer einen Dienst verbinden will („verbinde dich mit CompLeadly“) oder einen Zugang erneuern muss. Für Close und CompLeadly ist alles vorbelegt (`dienst`), für andere Dienste gib `url` und, falls bekannt, `zugang` an: " +
      "zugangscode = Schlüssel/Token, kopfzeilen = eigene Kopfzeilen, anmeldung = Benutzername und Passwort, client = OAuth Client-ID/Secret mit Token-Adresse, keine = ohne Zugang. " +
      "Frage Zugangsdaten NIE im Chat ab und wiederhole sie nie. Nur in der Desktop-App; sonst kommt ein Hinweis zurück, dann `app_oeffnen` bzw. den Weg nennen.",
    parameters: {
      type: "object",
      properties: {
        dienst: { type: "string", description: "Name des Dienstes, z. B. CompLeadly, Close" },
        url: { type: "string", description: "Adresse der Schnittstelle, falls kein vorbereiteter Dienst" },
        art: { type: "string", enum: ["mcp", "a2a"], description: "mcp = Werkzeugdienst (Standard), a2a = Agent" },
        zugang: { type: "string", enum: [...DIENST_ZUGANG_ARTEN], description: "Art des Zugangs, falls bekannt" },
        grund: { type: "string", description: "Ein Satz, wofür du den Zugang brauchst (wird auf der Karte gezeigt)" },
      },
      required: ["dienst"],
    },
    schema: yup.object({
      dienst: yup.string().trim().min(2).max(60).required(),
      url: yup.string().trim().url().max(500).optional(),
      art: yup.string().oneOf(["mcp", "a2a"]).optional(),
      zugang: yup.string().oneOf([...DIENST_ZUGANG_ARTEN]).optional(),
      grund: yup.string().trim().max(240).optional(),
    }),
    run: async (args, ctx) => {
      if (ctx.autonomousMode || (ctx.conversationId ?? "").startsWith("telegram-")) {
        return { verbunden: false, hinweis: "Zugänge lassen sich nur in der Desktop-App sicher eingeben (Einstellungen → Verbindungen → Weitere Dienste). Nenne dem Nutzer diesen Weg; Zugangsdaten nie hier erfragen." };
      }
      const v = vorlageFuer(args.dienst);
      const anfrage: ZugangAnfrage = {
        ...(v ? { vorlage: v.id } : {}),
        name: v?.name ?? args.dienst,
        ...(args.url ? { url: args.url } : v ? { url: v.url } : {}),
        ...(args.art ? { art: args.art as "mcp" | "a2a" } : {}),
        ...(args.zugang ? { zugang: args.zugang as DienstZugangArt } : {}),
        ...(args.grund ? { grund: args.grund } : {}),
      };
      let timer: NodeJS.Timeout | null = null;
      const antwort = await Promise.race([
        ctx.ui.askZugang(anfrage, ctx.signal),
        new Promise<string>((r) => {
          timer = setTimeout(() => r("__zeit__"), WARTEZEIT_MS);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (antwort === "__zeit__") return { verbunden: false, hinweis: "Keine Eingabe innerhalb von 15 Minuten. Die Karte bleibt im Chat, der Nutzer kann sie jederzeit ausfüllen; sonst Einstellungen → Verbindungen → Weitere Dienste." };
      let e: ZugangErgebnis;
      try {
        e = JSON.parse(antwort) as ZugangErgebnis;
      } catch {
        e = { verbunden: false, abgebrochen: true };
      }
      if (e.abgebrochen) return { verbunden: false, abgebrochen: true, hinweis: "Der Nutzer hat die Eingabe abgebrochen. Nicht erneut fragen, außer er bittet darum." };
      if (!e.verbunden) return { verbunden: false, fehler: e.fehler ?? "Verbindung fehlgeschlagen" };
      return {
        verbunden: true,
        dienst: e.name,
        funktionen: e.werkzeuge ?? 0,
        hinweis: e.slug ? `Die Funktionen heißen mcp_${e.slug}_… bzw. a2a_${e.slug}_…; mit tool_search nach dem Dienstnamen laden. Dem Nutzer in einem Satz sagen, was du jetzt für ihn tun kannst.` : undefined,
      };
    },
    preview: (r: Record<string, unknown>) => (r.verbunden ? `${String(r.dienst)} verbunden` : r.abgebrochen ? "Eingabe abgebrochen" : String(r.fehler ?? r.hinweis ?? "nicht verbunden")),
  });
  return [anfordern];
}
