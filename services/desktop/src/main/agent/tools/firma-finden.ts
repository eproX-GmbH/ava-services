// firma_finden (docs/PLAN_FIRMEN_OHNE_REGISTER.md, F4): letzter Rueckfall, wenn
// Stammdaten und Handelsregister nichts liefern. Google-Eintrag (Places) mit
// eigener Website → hartes Website-Gate → lokales KI-Urteil → WEB-Firma anlegen
// → Import. Firmen ohne eigene, erreichbare Website werden NICHT aufgenommen.
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";
import { pruefeFirmenDomain, type GateErgebnis } from "../../firmen-web/domain-gate";
import { LAND_PROFILE, type RadarLand } from "../../discovery/land";
import { buildMessages, parseJsonObject, streamToText } from "../../link-monitor/llm";

const MAX_PLACES = 5;
const MAX_URTEILE = 3;
export const MINDEST_KONFIDENZ = 0.8;

interface PlacesTreffer {
  title?: string;
  address?: string;
  category?: string;
  rating?: number;
  reviews?: number;
  phone?: string;
  gps_coordinates?: { latitude?: number; longitude?: number };
  website?: string;
  link?: string;
}

interface Kandidat {
  id: string;
  quelle: "google-places" | "nutzer";
  name: string;
  website: string;
  adresse: string | null;
  kategorie: string | null;
  telefon: string | null;
  bewertung: number | null;
  bewertungen: number | null;
  lat: number | null;
  lon: number | null;
  gate: GateErgebnis;
}

/** "Musterstraße 12, 32052 Herford" → Strasse, PLZ, Ort (best effort). */
export function adresseZerlegen(adresse: string | null | undefined): { strasse: string | null; plz: string | null; ort: string | null } {
  if (!adresse) return { strasse: null, plz: null, ort: null };
  const teile = adresse.split(",").map((t) => t.trim()).filter(Boolean);
  let plz: string | null = null;
  let ort: string | null = null;
  let strasse: string | null = null;
  for (const t of teile) {
    const m = /^(\d{4,5})\s+(.+)$/.exec(t);
    if (m && !plz) {
      plz = m[1]!;
      ort = m[2]!.replace(/\s*\(.*\)$/, "").trim();
    } else if (!strasse && /\d/.test(t) && !/^(deutschland|germany|österreich|austria|schweiz|switzerland|united kingdom)$/i.test(t)) strasse = t;
  }
  if (!ort && teile.length >= 2) ort = teile[teile.length - 2] ?? null;
  return { strasse, plz, ort };
}

const urteilSchema = yup.array().of(
  yup.object({
    id: yup.string().trim().required(),
    istFirma: yup.boolean().required(),
    eigeneWebsite: yup.boolean().required(),
    konfidenz: yup.number().min(0).max(1).required(),
    begruendung: yup.string().trim().min(3).max(400).required(),
  }),
);

export async function firmenUrteil(
  providers: LlmProviderManager,
  gesucht: { name: string; ort: string | null },
  kandidaten: Kandidat[],
): Promise<Map<string, { istFirma: boolean; eigeneWebsite: boolean; konfidenz: number; begruendung: string }>> {
  const out = new Map<string, { istFirma: boolean; eigeneWebsite: boolean; konfidenz: number; begruendung: string }>();
  const system =
    "Du pruefst, ob ein Google-Eintrag mit Website die gesuchte Firma ist. Zwei Fragen je Kandidat: " +
    "istFirma = ist das die gesuchte Firma (Name, Ort, Branche passen; nicht nur aehnlich)? " +
    "eigeneWebsite = gehoert die Website dieser Firma selbst (nicht Verband, Haendler, Portal, Franchise-Mutter, Konzern, Vermieter, Privatseite)? " +
    "konfidenz 0-1 fuer beides zusammen, im Zweifel niedrig. Begruendung ein deutscher Satz. " +
    'Antworte NUR als JSON: {"urteile": [{"id": "...", "istFirma": true, "eigeneWebsite": true, "konfidenz": 0.0, "begruendung": "..."}]}';
  const user =
    `Gesucht: ${gesucht.name}${gesucht.ort ? ` in ${gesucht.ort}` : ""}\n\nKandidaten:\n` +
    kandidaten
      .map(
        (k) =>
          `- id: ${k.id}\n  Google-Eintrag: ${k.name}${k.adresse ? `, ${k.adresse}` : ""}${k.kategorie ? ` (${k.kategorie})` : ""}${k.telefon ? `, Tel. ${k.telefon}` : ""}\n` +
          `  Website: ${k.gate.url ?? k.website}\n  Seitentitel: ${k.gate.titel ?? "-"}\n  Seitentext: ${(k.gate.text ?? "").slice(0, 1500)}`,
      )
      .join("\n");
  try {
    const raw = await streamToText(providers, buildMessages(system, user, "firmafinden"), {
      timeoutMs: 90_000,
      ...(providers.getProducerModelOverride() ? { modelOverride: providers.getProducerModelOverride() } : {}),
    });
    const parsed = parseJsonObject(raw) as { urteile?: unknown } | null;
    const rows = urteilSchema.validateSync(parsed?.urteile ?? [], { abortEarly: true });
    for (const r of rows ?? []) out.set(r.id, { istFirma: r.istFirma, eigeneWebsite: r.eigeneWebsite, konfidenz: r.konfidenz, begruendung: r.begruendung });
  } catch (err) {
    console.warn("[firma-finden] KI-Urteil fehlgeschlagen:", err);
  }
  return out;
}

export function buildFirmaFindenTools(deps: { gateway: GatewayClient; providers: LlmProviderManager }): Tool[] {
  const finden = defineTool({
    name: "firma_finden",
    summary: "Letzter Rueckfall, wenn Stammdaten und Handelsregister eine Firma nicht kennen: Google-Eintrag mit eigener Website pruefen, Firma anlegen und verarbeiten.",
    category: "firma finden nicht gefunden google eintrag website einzelunternehmer anlegen",
    description:
      "Nur wenn company_search UND register_live_suche nichts Passendes liefern. Sucht den Google-Eintrag (Places) der Firma, prueft die dort hinterlegte Website hart " +
      "(eigene, erreichbare Domain mit echtem Inhalt — keine Social-Seite, kein Linktree, kein Verzeichnis, keine Baukasten-Subdomain, keine Parkseite), laesst das lokale Modell " +
      "beurteilen, ob das die gesuchte Firma und ihre eigene Website ist, legt sie bei Konfidenz >= 0,8 als Firma ohne Registereintrag an (ID = Domain) und startet die Verarbeitung " +
      "(Website, Profil, Kontakte, E-Mail; keine Register- und Abschlussstufen). Liefert transactionId → die Aufgabe wird automatisch beobachtet. " +
      "Unter der Schwelle: Kandidaten mit Urteil zurueck — dann per ask_user_choice klaeren und mit `website` erneut aufrufen. " +
      "Firmen ohne eigene Website werden nicht aufgenommen; das dem Nutzer in einem Satz sagen.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Firmenname, wie der Nutzer ihn nennt." },
        ort: { type: "string", description: "Stadt/Ort, wenn bekannt — verbessert die Google-Suche deutlich." },
        land: { type: "string", enum: ["DE", "AT", "CH", "UK"], description: "Standard DE." },
        website: { type: "string", description: "Vom Nutzer bestaetigte Website: ueberspringt die Google-Suche, prueft nur diese Domain." },
      },
      required: ["name"],
    },
    schema: yup.object({
      name: yup.string().trim().min(2).max(200).required(),
      ort: yup.string().trim().max(120).optional(),
      land: yup.string().oneOf(["DE", "AT", "CH", "UK"]).optional(),
      website: yup.string().trim().max(500).optional(),
    }),
    preview: (r) => {
      const x = r as { companyId?: string; transactionId?: string; kandidaten?: unknown[]; gefunden?: boolean; error?: string };
      if (x.error) return `Fehler: ${x.error.slice(0, 60)}`;
      if (x.transactionId) return `Firma angelegt und Verarbeitung gestartet (${x.companyId})`;
      if (x.kandidaten?.length) return `${x.kandidaten.length} Kandidat(en), Rueckfrage noetig`;
      return "keine Firma mit eigener Website gefunden";
    },
    run: async (args, c) => {
      const land = (args.land ?? "DE") as RadarLand;
      const abgelehnt: Array<{ name: string; website: string | null; grund: string }> = [];
      const kandidaten: Kandidat[] = [];
      // 1. Kandidaten: bestaetigte Website des Nutzers oder Google-Eintraege.
      if (args.website) {
        const gate = await pruefeFirmenDomain(args.website);
        if (!gate.ok) return { gefunden: false, abgelehnt: [{ name: args.name, website: args.website, grund: gate.grund ?? "abgelehnt" }], hinweis: gateHinweis(gate.grund) };
        kandidaten.push({ id: "k1", quelle: "nutzer", name: args.name, website: args.website, adresse: args.ort ?? null, kategorie: null, telefon: null, bewertung: null, bewertungen: null, lat: null, lon: null, gate });
      } else {
        let places: PlacesTreffer[] = [];
        try {
          const body = await deps.gateway.request<{ places_results?: PlacesTreffer[] }>("/v1/proxy/valueserp", {
            method: "POST",
            body: { q: [args.name, args.ort].filter(Boolean).join(" "), search_type: "places", num: MAX_PLACES, ...LAND_PROFILE[land].serp },
            signal: c.signal,
          });
          places = (body.places_results ?? []).slice(0, MAX_PLACES);
        } catch (err) {
          return { error: `Google-Suche nicht moeglich: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (places.length === 0) return { gefunden: false, abgelehnt: [], hinweis: "Kein Google-Eintrag zu diesem Namen. Ohne Eintrag mit eigener Website nimmt AVA die Firma nicht auf." };
        let n = 0;
        for (const p of places) {
          const name = p.title?.trim();
          if (!name) continue;
          const url = p.website ?? p.link ?? null;
          if (!url) {
            abgelehnt.push({ name, website: null, grund: "keine Website im Google-Eintrag" });
            continue;
          }
          const gate = await pruefeFirmenDomain(url);
          if (!gate.ok) {
            abgelehnt.push({ name, website: url, grund: gate.grund ?? "abgelehnt" });
            continue;
          }
          n++;
          kandidaten.push({
            id: `k${n}`,
            quelle: "google-places",
            name,
            website: url,
            adresse: p.address ?? null,
            kategorie: p.category ?? null,
            telefon: p.phone ?? null,
            bewertung: p.rating ?? null,
            bewertungen: p.reviews ?? null,
            lat: p.gps_coordinates?.latitude ?? null,
            lon: p.gps_coordinates?.longitude ?? null,
            gate,
          });
          if (kandidaten.length >= MAX_URTEILE) break;
        }
      }
      if (kandidaten.length === 0) {
        return { gefunden: false, abgelehnt, hinweis: "Google-Eintraege gefunden, aber keiner mit eigener, erreichbarer Website (siehe abgelehnt). Solche Firmen nimmt AVA nicht auf — dem Nutzer in einem Satz sagen." };
      }
      // 2. KI-Urteil.
      const urteile = await firmenUrteil(deps.providers, { name: args.name, ort: args.ort ?? null }, kandidaten);
      if (urteile.size === 0) return { error: "KI-Urteil fehlgeschlagen (kein Modell bereit oder unparsbare Antwort)." };
      const bewertet = kandidaten
        .map((k) => ({ k, u: urteile.get(k.id) }))
        .filter((x): x is { k: Kandidat; u: NonNullable<typeof x.u> } => Boolean(x.u))
        .sort((a, b) => b.u.konfidenz - a.u.konfidenz);
      const bester = bewertet.find((x) => x.u.istFirma && x.u.eigeneWebsite && x.u.konfidenz >= MINDEST_KONFIDENZ);
      const kandidatenAusgabe = bewertet.map(({ k, u }) => ({ name: k.name, website: k.gate.url ?? k.website, domain: k.gate.domain, adresse: k.adresse, kategorie: k.kategorie, urteil: u }));
      if (!bester) {
        return {
          gefunden: false,
          kandidaten: kandidatenAusgabe,
          abgelehnt,
          hinweis: "Kein Kandidat sicher genug (Konfidenz < 0,8 oder nicht die eigene Website). Dem Nutzer die Kandidaten mit Begruendung zeigen (ask_user_choice); bestaetigt er einen, firma_finden mit website=<URL> erneut aufrufen.",
        };
      }
      // 3. Anlegen (Gateway prueft Sperrliste und Doppelanlage erneut).
      const { k, u } = bester;
      const adr = adresseZerlegen(k.adresse);
      const ort = adr.ort ?? args.ort ?? "";
      if (!ort) return { gefunden: false, kandidaten: kandidatenAusgabe, hinweis: "Ort unbekannt — Nutzer nach dem Sitz fragen und mit ort erneut aufrufen." };
      let angelegt: { companyId: string; domain: string; neu: boolean; konflikt?: Array<{ companyId: string; name: string | null }> };
      try {
        angelegt = await deps.gateway.request("/v1/companies/web", {
          method: "POST",
          body: {
            name: k.name,
            website: k.gate.url ?? k.website,
            ort,
            ...(adr.plz ? { plz: adr.plz } : {}),
            ...(adr.strasse ? { strasse: adr.strasse } : {}),
            land: land === "UK" ? "UK" : land,
            ...(k.telefon ? { telefon: k.telefon } : {}),
            ...(k.kategorie ? { kategorie: k.kategorie } : {}),
            ...(k.adresse ? { adresse: k.adresse } : {}),
            ...(k.bewertung != null ? { bewertung: k.bewertung } : {}),
            ...(k.bewertungen != null ? { bewertungen: k.bewertungen } : {}),
            ...(k.lat != null ? { lat: k.lat } : {}),
            ...(k.lon != null ? { lon: k.lon } : {}),
            quelle: k.quelle === "nutzer" ? "nutzer-website" : "google-places",
            urteil: { konfidenz: u.konfidenz, begruendung: u.begruendung },
          },
          signal: c.signal,
        });
      } catch (err) {
        return { error: `Anlage fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, kandidaten: kandidatenAusgabe };
      }
      if (angelegt.konflikt && angelegt.konflikt.length > 0) {
        return {
          gefunden: true,
          konflikt: angelegt.konflikt,
          domain: angelegt.domain,
          hinweis: `Diese Website gehoert schon zur Register-Firma ${angelegt.konflikt[0]!.name ?? angelegt.konflikt[0]!.companyId} (${angelegt.konflikt[0]!.companyId}). Keine neue Firma angelegt — company_get fuer diese companyId, bei Bedarf import_companies.`,
        };
      }
      // 4. Verarbeitung starten.
      let transactionId: string | null = null;
      try {
        const imp = await deps.gateway.request<{ transactionId: string }>("/v1/imports/by-ids", {
          method: "POST",
          body: { companyIds: [angelegt.companyId], transactionName: `${k.name} (Website)` },
          signal: c.signal,
        });
        transactionId = imp.transactionId;
      } catch (err) {
        return { gefunden: true, companyId: angelegt.companyId, domain: angelegt.domain, neu: angelegt.neu, error: `Firma angelegt, Verarbeitung nicht gestartet: ${err instanceof Error ? err.message : String(err)}. import_companies mit companyIds nachholen.` };
      }
      return {
        gefunden: true,
        companyId: angelegt.companyId,
        domain: angelegt.domain,
        neu: angelegt.neu,
        transactionId,
        firma: { name: k.name, website: k.gate.url ?? k.website, adresse: k.adresse, kategorie: k.kategorie, telefon: k.telefon },
        urteil: u,
        abgelehnt,
        hinweis: "Firma ohne Registereintrag angelegt (ID = Domain) und Verarbeitung gestartet: Website, Profil, Kontakte, E-Mail. Register- und Abschlussstufen gibt es fuer diese Firma nicht. Dem Nutzer kurz sagen, dass die Firma jetzt aufbereitet wird.",
      };
    },
  });
  return [finden];
}

function gateHinweis(grund: string | null): string {
  switch (grund) {
    case "social": return "Die angegebene Adresse ist eine Social-Media-Seite, keine eigene Website — AVA nimmt die Firma so nicht auf.";
    case "linkseite": return "Die Adresse ist eine Link-Sammelseite (Linktree o. ae.), keine eigene Website.";
    case "baukasten": return "Die Adresse liegt auf einer Baukasten-Subdomain, die dem Anbieter gehoert — keine eigene Domain.";
    case "verzeichnis": return "Die Adresse ist ein Verzeichnis-/Portaleintrag, keine eigene Website.";
    case "nicht_erreichbar": return "Die Website ist nicht erreichbar.";
    case "fremde_domain_nach_redirect": return "Die Adresse leitet auf eine fremde Domain weiter.";
    case "parkseite": return "Die Domain ist geparkt oder im Aufbau.";
    case "zu_wenig_inhalt": return "Die Website hat keinen verarbeitbaren Inhalt.";
    default: return "Die Website besteht das Website-Gate nicht.";
  }
}
