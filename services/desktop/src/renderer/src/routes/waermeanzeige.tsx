// Waermeanzeige: wie nah der Nutzer an dieser Firma dran ist
// (docs/PLAN_RELEVANZ.md, Abschnitt 7).
//
// Eine Zahl zwischen 1 und 10 ohne Erklaerung ist eine Zumutung — der
// Nutzer soll nachlesen koennen, warum AVA eine Firma fuer heiss haelt.
// Deshalb steht die Begruendung im Titel, und deshalb nennt sie die
// Handlungen beim Namen ("4-mal geoeffnet", "Kontakt ins CRM
// uebernommen") statt Punkte zu zeigen.
//
// Bewusst klein und unaufdringlich: Der Wert ist eine Hilfe beim Sortieren,
// keine Bewertung der Firma. Wer ihn ignoriert, verliert nichts.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RelevanzWert } from "../../../shared/types";

/** Klartext je Signalart — dieselbe Sprache wie im Katalog. */
const TEXTE: Record<string, string> = {
  "firma.ansicht": "angesehen",
  "firma.verweildauer": "laenger gelesen",
  "firma.chatlink": "aus dem Chat geoeffnet",
  "firma.chat": "im Chat behandelt",
  "firma.uebernommen": "in Meine Firmen uebernommen",
  "firma.import": "Import gestartet",
  "firma.workflow": "in einem Workflow",
  "firma.watchlist": "auf der Watchlist",
  "firma.crm": "Kontakt ins CRM uebernommen",
  "firma.alarm.geoeffnet": "Meldung geoeffnet",
  "firma.alarm.weggewischt": "Meldungen weggewischt",
  "person.profil": "Profil geoeffnet",
  "person.hinweis": "DSGVO-Hinweis kopiert",
  "person.crm": "ins CRM uebernommen",
  "person.mail": "Mailentwurf begonnen",
  "person.gesucht": "ueber die Suche geoeffnet",
  "person.chat": "im Chat behandelt",
  "person.watchlist": "auf der Personen-Watchlist",
  wiederkehr: "mehrfach zurueckgekommen",
};

function stufe(naehe: number): string {
  if (naehe >= 8.5) return "heiß";
  if (naehe >= 6) return "warm";
  if (naehe >= 4) return "lauwarm";
  return "kalt";
}

export function begruendungsText(wert: RelevanzWert): string {
  const teile = wert.begruendung
    .filter((b) => b.anteil !== 0)
    .map((b) => {
      const text = TEXTE[b.art] ?? b.art;
      // Mehrfaches beim Namen nennen: "4-mal angesehen" sagt mehr als
      // "angesehen", und es ist genau das, was den Wert hochtreibt.
      return b.anzahl > 1 && b.art !== "wiederkehr" ? `${b.anzahl}-mal ${text}` : text;
    });
  if (teile.length === 0) return "Noch keine Anhaltspunkte.";
  return `Du hast diese Firma ${teile.join(", ")}.`;
}

export function Waermeanzeige({
  zielArt,
  zielId,
}: {
  zielArt: "firma" | "person";
  zielId: string | undefined;
}) {
  const [wert, setWert] = useState<RelevanzWert | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    if (!zielId) return;
    void window.api.relevanz
      .werte(zielArt, [zielId])
      .then((m) => {
        if (!abgebrochen) setWert(m[zielId] ?? null);
      })
      .catch(() => {
        /* Ohne Wert zeigen wir nichts — das ist richtiger als eine 1. */
      });
    return () => {
      abgebrochen = true;
    };
  }, [zielArt, zielId]);

  // Nichts anzeigen, solange nichts bekannt ist: Eine frische Firma mit
  // "1 von 10" saehe aus wie ein Urteil, ist aber nur fehlendes Wissen.
  if (!wert || wert.naehe < 2) return null;

  const naehe = Math.round(wert.naehe);
  return (
    <span
      className="waerme"
      title={`${begruendungsText(wert)} Daraus ergibt sich ${naehe} von 10 (${stufe(wert.naehe)}). Der Wert steuert, wie genau AVA diese Firma im Blick behaelt.`}
      aria-label={`Naehe ${naehe} von 10, ${stufe(wert.naehe)}`}
    >
      <span className="waerme__punkte" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={i < Math.round(naehe / 2) ? "waerme__punkt waerme__punkt--voll" : "waerme__punkt"}
          />
        ))}
      </span>
      {stufe(wert.naehe)}
    </span>
  );
}

/**
 * "Bei 3 Kolleginnen und Kollegen gerade Thema."
 *
 * Der Teil, der Kollegen zusammenbringt (docs/PLAN_RELEVANZ.md, 10): Zwei
 * Leute, die unabhaengig voneinander an derselben Firma arbeiten, erfahren
 * sonst nie voneinander.
 *
 * Nur eine Anzahl, nie Namen. Die eigene Person ist mitgezaehlt — sonst
 * waere sie durch Differenzbildung sichtbar, und aus einer Uebersicht
 * wuerde eine Auswertung.
 */
export function ThemaHinweis({ companyId }: { companyId: string | undefined }) {
  const [anzahl, setAnzahl] = useState<number | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    if (!companyId) return;
    void window.api.relevanz
      .thema(200)
      .then((r) => {
        if (abgebrochen || !r.verfuegbar) return;
        const treffer = r.firmen.find((f) => f.companyId === companyId);
        setAnzahl(treffer?.anzahl ?? null);
      })
      .catch(() => {
        /* Ohne Uebersicht kein Hinweis — das ist kein Fehler. */
      });
    return () => {
      abgebrochen = true;
    };
  }, [companyId]);

  // Unter zwei zeigt das Gateway ohnehin nichts; die Pruefung hier ist die
  // zweite Schranke, falls sich das je aendert.
  if (anzahl === null || anzahl < 2) return null;

  return (
    <Link to="/thema" className="thema-hinweis" title="Übersicht: was im Team gerade Thema ist">
      Bei {anzahl} Kolleginnen und Kollegen gerade Thema
    </Link>
  );
}
