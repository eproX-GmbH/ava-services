// Chat-Werkzeuge fuer das Buying Center (docs/PLAN_BUYING_CENTER.md, BC1).
//
// So erarbeitet man sich im Gespraech eine Power Map: anlegen, ansehen,
// setzen, Personen aufnehmen, Beziehungen ziehen, abschliessen. Alles
// laeuft ueber das Gateway; die Zugriffsregel (nur der Eigentuemer
// schreibt) wird DORT erzwungen, hier nur verstaendlich weitergegeben.
//
// Die Karte selbst zeichnet der Renderer: Das Werkzeug gibt ein
// `anzeigen`-Feld mit der Kennung zurueck, und der Prompt weist das Modell
// an, daraus einen ```buying-center-Zaun zu machen. Der Zaun traegt nur
// die Kennung — beim Anzeigen wird frisch geladen, damit ein alter Verlauf
// den heutigen Stand zeigt.

import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { WatchlistStore } from "../../linkedin/watchlist/store";
import { gleicherName } from "../../buying-center/interaktionen";
import { fokusVergessen } from "../../buying-center/fokus";

const ROLLEN = ["E", "B", "N", "R", "S", "EK", "GK"];
const ROLLEN_TEXT: Record<string, string> = {
  E: "Entscheider", B: "Beeinflusser", N: "Nutzer/Anwender", R: "Ratifizierer",
  S: "Spezifizierer", EK: "Einkaeufer", GK: "Gatekeeper",
};
const EINSTELLUNG_TEXT: Record<string, string> = { C: "Coach", "+": "positiv", "=": "neutral", "-": "negativ", F: "Feind" };
const KONTAKT_TEXT: Record<string, string> = { "0": "kein Kontakt", S: "selten", R: "regelmaessig", I: "intensiv" };
const EINFLUSS_TEXT: Record<string, string> = { G: "gering", M: "mittel", H: "hoch" };

interface Mitglied {
  id: string; personId: string | null; name: string; funktion: string | null;
  rollen: string[]; einstellung: string | null; kontakt: string | null; einfluss: string | null;
  angaben: Array<{ id: string; dimension: string; wert: string | null; herkunft: string; grund: string; entschieden: string | null; erfasstAt: string }>;
}
interface BuyingCenter {
  id: string; companyId: string; anlass: string; status: string; eigenes: boolean;
  mitglieder: Mitglied[];
  kanten: Array<{ id: string; vonMitgliedId: string; nachMitgliedId: string; art: string; staerke: string | null; grund: string | null }>;
}

/** Kurzfassung fuers Modell: eine Zeile je Person, Fragezeichen bleiben sichtbar. */
function zusammenfassung(bc: BuyingCenter): string {
  const zeilen = bc.mitglieder.map((m) => {
    const rollen = m.rollen.length ? m.rollen.map((r) => ROLLEN_TEXT[r] ?? r).join("/") : "Rolle ?";
    const e = m.einstellung ? EINSTELLUNG_TEXT[m.einstellung] ?? m.einstellung : "Einstellung ?";
    const k = m.kontakt ? KONTAKT_TEXT[m.kontakt] ?? m.kontakt : "Kontakt ?";
    const f = m.einfluss ? EINFLUSS_TEXT[m.einfluss] ?? m.einfluss : "Einfluss ?";
    const offen = m.angaben.filter((a) => a.herkunft.startsWith("ava:") && a.entschieden === null).length;
    return `- ${m.name}${m.funktion ? ` (${m.funktion})` : ""} [${m.id}]: ${rollen} · ${e} · ${k} · ${f}${offen ? ` · ${offen} offene Vorschlaege` : ""}`;
  });
  const kanten = bc.kanten.map((k) => {
    const von = bc.mitglieder.find((m) => m.id === k.vonMitgliedId)?.name ?? k.vonMitgliedId;
    const nach = bc.mitglieder.find((m) => m.id === k.nachMitgliedId)?.name ?? k.nachMitgliedId;
    return `- ${von} → ${nach}: ${k.art}${k.staerke ? ` (${EINFLUSS_TEXT[k.staerke] ?? k.staerke})` : ""}`;
  });
  return [`Personen (${bc.mitglieder.length}):`, ...zeilen, kanten.length ? "Beziehungen:" : "", ...kanten].filter(Boolean).join("\n");
}

function fehlertext(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BuyingCenterToolDeps {
  gateway: GatewayClient;
  /** BC4 — Watchlist-Aufnahme; lazy, weil der Store erst im App-Boot entsteht. */
  getWatchlistStore?: () => WatchlistStore | null;
  /** BC4 — false, wenn die Organisation die Personen-Watchlist abgeschaltet hat. */
  watchlistErlaubt?: () => boolean;
}

export function buildBuyingCenterTools(deps: BuyingCenterToolDeps): Tool[] {
  const { gateway } = deps;

  /** Das eigene Buying Center zu einer Firma finden — oder null. */
  async function eigenesZu(companyId: string, anlass?: string): Promise<{ id: string; anlass: string; status: string } | null> {
    const r = await gateway.request<{ items: Array<{ id: string; anlass: string; status: string }> }>("/v1/buying-center", { query: { companyId } });
    const aktive = r.items.filter((i) => i.status === "aktiv");
    if (anlass !== undefined) return aktive.find((i) => i.anlass === anlass) ?? null;
    return aktive[0] ?? null;
  }

  const anlegen = defineTool({
    name: "buying_center_anlegen",
    description:
      "Legt fuer eine Firma ein Buying Center (Power Map nach Sieck) an und macht sie damit zum Fokuskunden des Nutzers. Zieht die bekannten Kontakte der Firma als Entwurf hinein, mit Vorschlaegen fuer Rolle und Einfluss aus dem Titel — als OFFENE Vorschlaege, nicht als Fakten. Nutze das, wenn der Nutzer sagt 'lass uns ein Buying Center machen', 'Power Map', 'wer entscheidet bei X'. Gibt es schon eines, wird es zurueckgegeben statt verdoppelt. Fragt vorher nach. Zeige danach die Karte (anzeigen-Feld) und nenne die offenen Punkte.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Firmen-ID aus einer vorherigen Suche." },
        name: { type: "string", description: "Firmenname, fuer die Rueckfrage." },
        anlass: { type: "string", description: "Nur bei einem zweiten Buying Center fuer einen eigenen Kaufprozess ('Angebot Lager 2026'). Sonst weglassen." },
      },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required(), name: yup.string().trim().max(200).optional(), anlass: yup.string().trim().max(200).optional() }).noUnknown(true),
    run: async (args, c) => {
      const bestehend = await eigenesZu(args.companyId, args.anlass);
      if (bestehend) {
        const bc = await gateway.request<BuyingCenter>(`/v1/buying-center/${encodeURIComponent(bestehend.id)}`);
        return { bereitsVorhanden: true, buyingCenterId: bc.id, anzeigen: bc.id, stand: zusammenfassung(bc) };
      }
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `Buying Center fuer ${args.name ?? args.companyId} anlegen?\n\n` +
            `Die Firma wird damit zu deinem Fokuskunden: AVA darf fuer sie mehr Aufwand treiben (Website gezielt nach Personen lesen, LinkedIn, CRM-Protokolle). ` +
            `Das Buying Center gehoert nur dir; Einschaetzungen darin sieht niemand sonst.`,
          confirmValue: "anlegen",
          options: [{ value: "anlegen", label: "Anlegen", description: "Firma wird Fokuskunde" }, { value: "cancel", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "anlegen") return { abgebrochen: true };
      const bc = await gateway.request<BuyingCenter>("/v1/buying-center", { method: "POST", body: { companyId: args.companyId, anlass: args.anlass }, signal: c.signal });
      const vs = await gateway.request<{ offen: unknown[]; unbesetzteRollen: string[]; ohneKontakt: string[] }>(`/v1/buying-center/${encodeURIComponent(bc.id)}/vorschlaege`);
      return {
        buyingCenterId: bc.id,
        anzeigen: bc.id,
        stand: zusammenfassung(bc),
        offeneVorschlaege: vs.offen.length,
        unbesetzteRollen: vs.unbesetzteRollen.map((r) => ROLLEN_TEXT[r] ?? r),
        ohneKontakt: vs.ohneKontakt,
        hinweis:
          "Alle Rollen und Einfluesse sind Vorschlaege aus Titeln. Frage den Nutzer, was er ueber diese Personen weiss, und trage es mit buying_center_setzen ein. Einstellung (Coach bis Feind) kann NUR der Nutzer sagen.",
      };
    },
    preview: (r) => ("buyingCenterId" in r ? `Buying Center ${r.bereitsVorhanden ? "vorhanden" : "angelegt"}` : "abgebrochen"),
  });

  const anzeigen = defineTool({
    name: "buying_center_anzeigen",
    description:
      "Zeigt das Buying Center zu einer Firma: die Karte im Chat (anzeigen-Feld → ```buying-center-Zaun) und den Stand je Person. Nutze das bei 'zeig mir das Buying Center', 'wie steht es bei X', oder vor jeder Aenderung, um Mitglieds-IDs zu bekommen. Ohne buyingCenterId wird das eigene aktive zur Firma genommen.",
    parameters: { type: "object", properties: { companyId: { type: "string" }, buyingCenterId: { type: "string" } } },
    schema: yup.object({ companyId: yup.string().trim().optional(), buyingCenterId: yup.string().trim().optional() }).noUnknown(true),
    run: async (args) => {
      let id = args.buyingCenterId;
      if (!id && args.companyId) id = (await eigenesZu(args.companyId))?.id;
      if (!id) return { error: "Zu dieser Firma gibt es noch kein Buying Center. Mit buying_center_anlegen anlegen." };
      const bc = await gateway.request<BuyingCenter>(`/v1/buying-center/${encodeURIComponent(id)}`);
      const vs = await gateway.request<{ offen: Array<{ vorschlagId: string; name: string; dimension: string; wert: string | null; grund: string }>; unbesetzteRollen: string[]; ohneKontakt: string[] }>(`/v1/buying-center/${encodeURIComponent(id)}/vorschlaege`);
      return {
        buyingCenterId: bc.id, anzeigen: bc.id, eigenes: bc.eigenes, status: bc.status,
        stand: zusammenfassung(bc),
        offeneVorschlaege: vs.offen,
        unbesetzteRollen: vs.unbesetzteRollen.map((r) => ROLLEN_TEXT[r] ?? r),
        ohneKontakt: vs.ohneKontakt,
        ...(bc.eigenes ? {} : { hinweis: "Dieses Buying Center gehoert jemand anderem — nur ansehen, nicht aendern." }),
      };
    },
    preview: (r) => ("stand" in r ? "Buying Center angezeigt" : "kein Buying Center"),
  });

  const setzen = defineTool({
    name: "buying_center_setzen",
    description:
      "Traegt ein, was der Nutzer ueber eine Person im Buying Center weiss: rolle (E Entscheider, B Beeinflusser, N Nutzer, R Ratifizierer, S Spezifizierer, EK Einkaeufer, GK Gatekeeper; '-B' nimmt eine Rolle weg), einstellung (C Coach, + positiv, = neutral, - negativ, F Feind), kontakt (0 keiner, S selten, R regelmaessig, I intensiv), einfluss (G gering, M mittel, H hoch), oder notiz. Der GRUND ist Pflicht und soll SACHLICH das wiedergeben, was der Nutzer gesagt hat ('hat im Termin gesagt, dass …'), keine Charakterurteile. Alternativ einen offenen AVA-Vorschlag beantworten (vorschlagId + entscheidung). Nicht nachfragen — der Nutzer hat es gerade gesagt.",
    parameters: {
      type: "object",
      properties: {
        buyingCenterId: { type: "string" },
        mitgliedId: { type: "string", description: "Aus buying_center_anzeigen (in eckigen Klammern)." },
        dimension: { type: "string", enum: ["rolle", "einstellung", "kontakt", "einfluss", "notiz"] },
        wert: { type: "string", description: "Kuerzel; null loescht. Bei notiz weglassen." },
        grund: { type: "string" },
        vorschlagId: { type: "string" },
        entscheidung: { type: "string", enum: ["angenommen", "verworfen"] },
      },
      required: ["buyingCenterId", "mitgliedId", "dimension", "grund"],
    },
    schema: yup.object({
      buyingCenterId: yup.string().trim().required(), mitgliedId: yup.string().trim().required(),
      dimension: yup.string().oneOf(["rolle", "einstellung", "kontakt", "einfluss", "notiz"]).required(),
      wert: yup.string().trim().max(200).nullable().optional(), grund: yup.string().trim().min(1).max(500).required(),
      vorschlagId: yup.string().trim().optional(), entscheidung: yup.string().oneOf(["angenommen", "verworfen"]).optional(),
    }).noUnknown(true),
    run: async (args, c) => {
      try {
        const m = await gateway.request<Mitglied>(
          `/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}/mitglieder/${encodeURIComponent(args.mitgliedId)}/angaben`,
          { method: "POST", body: { dimension: args.dimension, wert: args.wert ?? null, grund: args.grund, vorschlagId: args.vorschlagId, entscheidung: args.entscheidung }, signal: c.signal },
        );
        return { gesetzt: true, name: m.name, rollen: m.rollen, einstellung: m.einstellung, kontakt: m.kontakt, einfluss: m.einfluss, anzeigen: args.buyingCenterId };
      } catch (err) {
        return { error: fehlertext(err) };
      }
    },
    preview: (r) => ("gesetzt" in r ? `${r.name}: ${String(r.rollen)}` : "nicht gesetzt"),
  });

  const aufnehmen = defineTool({
    name: "buying_center_person_aufnehmen",
    description:
      "Nimmt eine Person ins Buying Center auf — aus dem Kontakt-Bestand (personId) oder frei mit Name und Funktion, wenn AVA sie nicht kennt ('die Assistentin des GF, Frau Kowalski'). Aus der Funktion werden Rollen vorgeschlagen. Danach mit buying_center_setzen eintragen, was der Nutzer weiss.",
    parameters: {
      type: "object",
      properties: { buyingCenterId: { type: "string" }, name: { type: "string" }, funktion: { type: "string" }, personId: { type: "string" }, grund: { type: "string" } },
      required: ["buyingCenterId", "name"],
    },
    schema: yup.object({ buyingCenterId: yup.string().trim().required(), name: yup.string().trim().min(2).max(200).required(), funktion: yup.string().trim().max(200).optional(), personId: yup.string().trim().optional(), grund: yup.string().trim().max(500).optional() }).noUnknown(true),
    run: async (args, c) => {
      try {
        const m = await gateway.request<Mitglied>(`/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}/mitglieder`, { method: "POST", body: { name: args.name, funktion: args.funktion, personId: args.personId, grund: args.grund }, signal: c.signal });
        const offen = m.angaben.filter((a) => a.herkunft.startsWith("ava:") && a.entschieden === null).map((a) => ({ vorschlagId: a.id, dimension: a.dimension, wert: a.wert, grund: a.grund }));
        return { aufgenommen: true, mitgliedId: m.id, name: m.name, offeneVorschlaege: offen, anzeigen: args.buyingCenterId };
      } catch (err) {
        return { error: fehlertext(err) };
      }
    },
    preview: (r) => ("aufgenommen" in r ? `${r.name} aufgenommen` : "nicht aufgenommen"),
  });

  const kante = defineTool({
    name: "buying_center_kante",
    description:
      "Traegt eine Beziehung zwischen zwei Personen ein: EINFLUSS ('der IT-Leiter hat beim GF das letzte Wort' → von IT-Leiter nach GF, staerke H), VERTRAUT ('die beiden sind eng'), ANIMOSITAET ('die koennen nicht miteinander'). Ersetzt eine bestehende Beziehung derselben Art zwischen denselben Personen.",
    parameters: {
      type: "object",
      properties: {
        buyingCenterId: { type: "string" }, vonMitgliedId: { type: "string" }, nachMitgliedId: { type: "string" },
        art: { type: "string", enum: ["EINFLUSS", "VERTRAUT", "ANIMOSITAET"] }, staerke: { type: "string", enum: ["G", "M", "H"] }, grund: { type: "string" },
      },
      required: ["buyingCenterId", "vonMitgliedId", "nachMitgliedId", "art"],
    },
    schema: yup.object({ buyingCenterId: yup.string().trim().required(), vonMitgliedId: yup.string().trim().required(), nachMitgliedId: yup.string().trim().required(), art: yup.string().oneOf(["EINFLUSS", "VERTRAUT", "ANIMOSITAET"]).required(), staerke: yup.string().oneOf(["G", "M", "H"]).optional(), grund: yup.string().trim().max(500).optional() }).noUnknown(true),
    run: async (args, c) => {
      try {
        const k = await gateway.request<{ id: string; art: string }>(`/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}/kanten`, { method: "POST", body: { vonMitgliedId: args.vonMitgliedId, nachMitgliedId: args.nachMitgliedId, art: args.art, staerke: args.staerke, grund: args.grund }, signal: c.signal });
        return { eingetragen: true, kanteId: k.id, art: k.art, anzeigen: args.buyingCenterId };
      } catch (err) {
        return { error: fehlertext(err) };
      }
    },
    preview: (r) => ("eingetragen" in r ? `Beziehung ${r.art}` : "nicht eingetragen"),
  });

  const vorschlaege = defineTool({
    name: "buying_center_vorschlaege",
    description:
      "Listet, was AVA zum Buying Center vermutet und der Nutzer noch nicht entschieden hat, sowie die Leitfragen: unbesetzte Rollen und Personen ohne Kontakt. Dazu `verknuepfbar`: frei aufgenommene Mitglieder, zu denen im Kontakt-Bestand eine gleichnamige Person liegt (dann buying_center_verknuepfen anbieten). Nutze das, um das Gespraech weiterzufuehren ('Ein Einkaeufer fehlt noch — wer verhandelt den Vertrag?').",
    parameters: { type: "object", properties: { buyingCenterId: { type: "string" } }, required: ["buyingCenterId"] },
    schema: yup.object({ buyingCenterId: yup.string().trim().required() }).noUnknown(true),
    run: async (args) => {
      const vs = await gateway.request<{ offen: unknown[]; unbesetzteRollen: string[]; ohneKontakt: string[]; verknuepfbar: Array<{ mitgliedId: string; name: string; personId: string; fullName: string; title: string | null }> }>(`/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}/vorschlaege`);
      return {
        offen: vs.offen,
        unbesetzteRollen: vs.unbesetzteRollen.map((r) => ROLLEN_TEXT[r] ?? r),
        ohneKontakt: vs.ohneKontakt,
        // BC5: frei aufgenommene Mitglieder, zu denen es eine gleichnamige
        // Person im Bestand gibt — Verbinden mit buying_center_verknuepfen.
        verknuepfbar: vs.verknuepfbar ?? [],
      };
    },
    preview: (r) => `${(r.offen as unknown[]).length} offene Vorschlaege`,
  });

  const abschliessen = defineTool({
    name: "buying_center_abschliessen",
    description:
      "Setzt den Status eines Buying Centers: 'abgeschlossen' (Kaufprozess vorbei) oder 'archiviert' nimmt der Firma den Fokus, 'aktiv' setzt ihn wieder. Die Daten bleiben. Fragt vorher nach.",
    parameters: { type: "object", properties: { buyingCenterId: { type: "string" }, status: { type: "string", enum: ["aktiv", "abgeschlossen", "archiviert"] } }, required: ["buyingCenterId", "status"] },
    schema: yup.object({ buyingCenterId: yup.string().trim().required(), status: yup.string().oneOf(["aktiv", "abgeschlossen", "archiviert"]).required() }).noUnknown(true),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: args.status === "aktiv" ? "additive" : "destructive",
          prompt: args.status === "aktiv"
            ? "Buying Center wieder aktiv setzen? Die Firma wird damit wieder Fokuskunde."
            : `Buying Center auf "${args.status}" setzen? Die Firma verliert den Fokus, die Einschaetzungen bleiben erhalten.`,
          confirmValue: "ja",
          options: [{ value: "ja", label: "Ja" }, { value: "cancel", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      try {
        const r = await gateway.request<{ ok: boolean; fokus: boolean }>(`/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}/status`, { method: "POST", body: { status: args.status }, signal: c.signal });
        fokusVergessen();
        return { status: args.status, fokuskunde: r.fokus };
      } catch (err) {
        return { error: fehlertext(err) };
      }
    },
    preview: (r) => ("status" in r ? `Status ${r.status}` : "unveraendert"),
  });

  // BC4 — Fokuskunden-Aufwand: die LinkedIn-Checkliste je Mitglied und die
  // Aufnahme in die Personen-Watchlist. Die Watchlist ist gedeckelt, deshalb
  // eine Rueckfrage mit der vollstaendigen Liste, nicht je Person eine.
  // Mitglieder ohne Profil-URL werden benannt, damit das Modell
  // contact_linkedin_lookup anbieten kann — nicht stillschweigend suchen,
  // das kostet SERP-Abfragen.
  const beobachten = defineTool({
    name: "buying_center_beobachten",
    summary: "Buying-Center-Mitglieder auf die LinkedIn-Watchlist setzen (mit Rueckfrage); zeigt je Person, ob ein Profil bekannt ist.",
    category: "buying center linkedin watchlist",
    description:
      "LinkedIn-Checkliste zum Buying Center: Welche Mitglieder haben eine bekannte Profil-URL, wer ist schon auf der Personen-Watchlist, wer fehlt? Mit aufnehmen=true werden alle Mitglieder mit Profil-URL nach Rueckfrage auf die Watchlist gesetzt (Firma zugeordnet; fokus=true macht sie zu Fokus-Personen). Fuer Mitglieder ohne Profil-URL biete contact_linkedin_lookup an.",
    parameters: {
      type: "object",
      properties: {
        buyingCenterId: { type: "string" },
        aufnehmen: { type: "boolean", description: "Fehlende Mitglieder mit Profil-URL auf die Watchlist setzen (Rueckfrage)." },
        fokus: { type: "boolean", description: "Als Fokus-Personen aufnehmen (jeder Lauf, Meldungen mind. warn)." },
      },
      required: ["buyingCenterId"],
    },
    schema: yup.object({ buyingCenterId: yup.string().trim().required(), aufnehmen: yup.boolean().optional(), fokus: yup.boolean().optional() }).noUnknown(true),
    run: async (args, c) => {
      if (deps.watchlistErlaubt && !deps.watchlistErlaubt()) return { error: "Die Personen-Watchlist ist in deiner Organisation nicht freigeschaltet." };
      const bc = await gateway.request<BuyingCenter>(`/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}`, { signal: c.signal });
      const profile = await gateway.request<{ items: Array<{ personId: string; fullName: string; linkedinUrl: string }> }>(
        "/v1/contacts/linkedin-profiles",
        { method: "POST", body: { companyIds: [bc.companyId] }, signal: c.signal },
      );
      const store = deps.getWatchlistStore?.() ?? null;
      const eintraege = store ? await store.list() : [];
      const aufListe = new Map(eintraege.map((e) => [e.profileUrl.toLowerCase().replace(/\/+$/, ""), e]));
      const kanon = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "https://www.").replace(/\/+$/, "");

      const checkliste = bc.mitglieder.map((m) => {
        const treffer =
          (m.personId ? profile.items.find((p) => p.personId === m.personId) : undefined) ??
          profile.items.find((p) => gleicherName(p.fullName, m.name));
        const url = treffer?.linkedinUrl ?? null;
        const eintrag = url ? aufListe.get(kanon(url)) ?? null : null;
        return {
          mitgliedId: m.id, name: m.name, funktion: m.funktion,
          linkedinUrl: url,
          stand: !url ? "ohne-profil" : eintrag ? (eintrag.fokus ? "fokus" : "beobachtet") : "aufnehmbar",
        } as const;
      });
      const aufnehmbar = checkliste.filter((z) => z.stand === "aufnehmbar");
      const ohneProfil = checkliste.filter((z) => z.stand === "ohne-profil").map((z) => z.name);

      if (!args.aufnehmen || aufnehmbar.length === 0) {
        return { checkliste, ohneProfil, aufnehmbar: aufnehmbar.length, hinweis: !store && args.aufnehmen ? "Watchlist nicht initialisiert." : undefined };
      }
      if (!store) return { checkliste, ohneProfil, error: "Watchlist nicht initialisiert." };
      if (!bc.eigenes) return { checkliste, ohneProfil, error: "Nur der Eigentuemer des Buying Centers nimmt Personen auf." };

      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `${aufnehmbar.length} ${aufnehmbar.length === 1 ? "Person" : "Personen"} aus dem Buying Center auf die LinkedIn-Watchlist setzen?\n\n` +
            aufnehmbar.map((z) => `- ${z.name}${z.funktion ? ` (${z.funktion})` : ""}\n  ${z.linkedinUrl}`).join("\n") +
            (args.fokus ? "\n\nAls FOKUS-Personen (jeder Lauf, Meldungen mind. warn)." : "") +
            (ohneProfil.length ? `\n\nOhne bekanntes Profil (nicht dabei): ${ohneProfil.join(", ")}` : ""),
          confirmValue: "add",
          options: [{ value: "add", label: "Aufnehmen" }, { value: "cancel", label: "Verwerfen" }],
        },
        c.signal,
      );
      if (value !== "add") return userDeclined("Watchlist-Aufnahme");

      const aufgenommen: string[] = [];
      const fehler: Array<{ name: string; error: string }> = [];
      for (const z of aufnehmbar) {
        const r = await store.add({ profileUrl: z.linkedinUrl!, label: z.name, companyId: bc.companyId, fokus: args.fokus, quelle: "manuell" });
        if ("error" in r) fehler.push({ name: z.name, error: r.error });
        else aufgenommen.push(z.name);
      }
      return { aufgenommen, fehler, ohneProfil, anzeigen: bc.id };
    },
    preview: (r) => {
      const res = r as { aufgenommen?: string[]; aufnehmbar?: number; error?: string; checkliste?: unknown[] };
      if (res.error) return res.error;
      if (res.aufgenommen) return `${res.aufgenommen.length} auf der Watchlist`;
      return `${res.checkliste?.length ?? 0} Mitglieder, ${res.aufnehmbar ?? 0} aufnehmbar`;
    },
  });

  // BC5 — freies Mitglied an eine Person aus dem Bestand binden. Danach
  // gibt es Personensignale, Watchlist und Herkunftsnachweis. Bewusst mit
  // Rueckfrage: Gleicher Name ist ein Indiz, kein Beweis.
  const verknuepfen = defineTool({
    name: "buying_center_verknuepfen",
    summary: "Ein frei aufgenommenes Buying-Center-Mitglied mit einer Person aus dem Kontakt-Bestand verbinden.",
    category: "buying center kontakte",
    description:
      "Verbindet ein frei (nur mit Namen) aufgenommenes Mitglied mit einer Person aus dem Kontakt-Bestand (personId, z. B. aus `verknuepfbar` von buying_center_vorschlaege). Fragt vorher nach. Danach zaehlen Personensignale, Watchlist und Herkunftsnachweis fuer dieses Mitglied.",
    parameters: {
      type: "object",
      properties: { buyingCenterId: { type: "string" }, mitgliedId: { type: "string" }, personId: { type: "string" }, name: { type: "string", description: "Name der Bestandsperson, fuer die Rueckfrage." } },
      required: ["buyingCenterId", "mitgliedId", "personId"],
    },
    schema: yup.object({ buyingCenterId: yup.string().trim().required(), mitgliedId: yup.string().trim().required(), personId: yup.string().trim().required(), name: yup.string().trim().max(200).optional() }).noUnknown(true),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Mitglied mit der Bestandsperson${args.name ? ` "${args.name}"` : ""} verbinden? Ab dann zaehlen ihre Signale und Nachweise fuer das Buying Center.`,
          confirmValue: "ja",
          options: [{ value: "ja", label: "Verbinden" }, { value: "cancel", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "ja") return userDeclined("Verknuepfen");
      try {
        const m = await gateway.request<Mitglied>(`/v1/buying-center/${encodeURIComponent(args.buyingCenterId)}/mitglieder/${encodeURIComponent(args.mitgliedId)}/verknuepfen`, { method: "POST", body: { personId: args.personId }, signal: c.signal });
        return { verbunden: true, name: m.name, personId: m.personId, anzeigen: args.buyingCenterId };
      } catch (err) {
        return { error: fehlertext(err) };
      }
    },
    preview: (r) => ("verbunden" in r ? `verbunden: ${r.name}` : "nicht verbunden"),
  });

  return [anlegen, anzeigen, setzen, aufnehmen, kante, vorschlaege, abschliessen, beobachten, verknuepfen];
}

export { ROLLEN };
