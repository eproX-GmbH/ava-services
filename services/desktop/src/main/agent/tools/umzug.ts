// Umzug zwischen AVA-Instanzen (docs/PLAN_AVA_CLOUD.md §13.3): den kompletten
// lokalen Stand einer Instanz auf eine andere übertragen; das Ziel wird
// überschrieben. Destruktiv, deshalb immer mit Bestätigung durch den Menschen.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { Umzug } from "../../../core/umzug/umzug";
import type { RelaisInstanz } from "../../../core/relais/kopf-relais";

export function buildUmzugTools(deps: { umzug: Umzug; liste: () => RelaisInstanz[]; eigeneId: () => string }): Tool[] {
  const finde = (wer: string): RelaisInstanz | undefined => {
    const l = deps.liste().filter((i) => i.id !== deps.eigeneId());
    const w = wer.trim().toLowerCase();
    return l.find((i) => i.id === wer) ?? l.find((i) => i.name.toLowerCase() === w) ?? l.find((i) => i.name.toLowerCase().includes(w) || i.art === w);
  };
  const umzug = defineTool({
    name: "ava_umzug",
    summary: "Kompletten AVA-Stand zwischen Desktop und Server uebertragen (Ziel wird ueberschrieben, mit Bestaetigung); ohne Argumente: Stand.",
    category: "instanzen umzug server desktop uebertragen import export betrieb",
    description:
      "Uebertraegt, was AVA lokal haelt (Gedaechtnis, Chats, Profil, ICP, Radar, Alarme, Workflows, Skills, Mail-Speicher, Audit, " +
      "Watchlist, API-Schluessel), von einer AVA-Instanz auf eine andere desselben Kontos. Das Ziel wird ueberschrieben und startet neu; " +
      "sein vorheriger Stand bleibt dort unter .umzug-alt. Nicht uebertragen und auf dem Ziel unveraendert: Anmeldung, Instanz-ID, " +
      "Telegram-Bot, ChatGPT-/Claude-Abo-Anmeldung, LinkedIn-Beobachter (Archiv, Sitzung, Einstellungen), Screenshots, Producer-Logs, " +
      "Browser-Sitzungen. richtung 'holen' = diese Instanz holt den Stand von `instanz`; " +
      "'senden' = diese Instanz schickt ihren Stand an `instanz`. `instanz` = Name, ID oder 'server'/'desktop' (siehe ava_instanzen). " +
      "Ohne Argumente: aktueller Stand eines laufenden Umzugs.",
    parameters: {
      type: "object",
      properties: {
        richtung: { type: "string", enum: ["holen", "senden"] },
        instanz: { type: "string", description: "Andere Instanz: Name, ID, 'server' oder 'desktop'" },
      },
    },
    schema: yup.object({ richtung: yup.string().oneOf(["holen", "senden"]).optional(), instanz: yup.string().trim().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.gestartet ? "Umzug gestartet" : `Umzug: ${r.stand?.phase ?? "?"}`),
    run: async (args, c) => {
      if (!args.richtung) return { stand: deps.umzug.getStand() };
      if (!args.instanz) return { error: "instanz fehlt (Name, ID, 'server' oder 'desktop')." };
      const andere = finde(args.instanz);
      if (!andere) return { error: `Keine andere verbundene Instanz „${args.instanz}“ gefunden.`, instanzen: deps.liste().map((i) => ({ id: i.id, name: i.name, art: i.art, verbunden: i.verbunden })) };
      if (!andere.verbunden) return { error: `${andere.name} ist gerade nicht verbunden.` };
      const ziel = args.richtung === "holen" ? "DIESE Instanz" : andere.name;
      const quelle = args.richtung === "holen" ? andere.name : "dieser Instanz";
      const v = await c.ui.confirmAction(
        {
          kind: "destructive",
          prompt: `Kompletten AVA-Stand von ${quelle} auf ${ziel} übertragen? ${ziel} wird überschrieben und startet neu (vorheriger Stand bleibt unter .umzug-alt).`,
          confirmValue: "ja",
          options: [{ value: "ja", label: "Übertragen und überschreiben" }, { value: "nein", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (v !== "ja") return { gestartet: false, abgebrochen: true };
      const r = args.richtung === "holen" ? deps.umzug.holen(andere.id) : deps.umzug.senden(andere.id);
      if (!r.ok) return { error: r.grund ?? "Umzug nicht gestartet." };
      return { gestartet: true, stand: deps.umzug.getStand(), hinweis: "Fortschritt mit ava_umzug ohne Argumente abfragen; das Ziel startet am Ende neu." };
    },
  });
  return [umzug];
}
