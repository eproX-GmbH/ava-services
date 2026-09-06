# Verzeichnis von Verarbeitungstaetigkeiten (Art. 30 DSGVO) — Vorlage fuer AVA-Betreiber

Stand 2026-09-06. Diese Vorlage beschreibt die Verarbeitung, die AVA im Auftrag
bzw. in der Verantwortung der nutzenden Organisation ausfuehrt. Die Datenklassen
entsprechen der Datenfluss-Tabelle in `docs/PLAN_COMPLIANCE_ENTERPRISE.md` §0.
Felder in eckigen Klammern ergaenzt die Organisation.

## 1. Verantwortlicher

[Organisation, Anschrift, Vertretung, Datenschutzbeauftragte/r]

## 2. Zwecke der Verarbeitung

B2B-Recherche und Anlass-Erkennung: Identifikation und Qualifizierung von
Zielunternehmen, Ermittlung beruflicher Ansprechpartner, Beobachtung
oeffentlicher Unternehmens- und Personensignale zur Vertriebsansprache.

## 3. Kategorien betroffener Personen und Daten

| Betroffene | Datenkategorien | Quelle | Rechtsgrundlage |
|---|---|---|---|
| Beschaeftigte von Zielunternehmen (berufliche Rolle) | Name, Position, Abteilung, berufliches Profil (LinkedIn/XING-URL), berufliche E-Mail/Telefon | Firmenwebsites, Register, berufliche Netzwerke, Suchmaschinen | Art. 6 Abs. 1 lit. f (berechtigtes Interesse an B2B-Kommunikation) |
| Beobachtete Personen (Personen-Watchlist, Personen-Radar) | Name, Profil-URL, oeffentliche Beitragstexte/-reaktionen | LinkedIn (oeffentlich sichtbar, eigener Zugang des Nutzers) | Art. 6 Abs. 1 lit. f; Modul abschaltbar je Organisation |
| Nutzer der Organisation | Konto (E-Mail, Name, Nutzer-ID), Verbrauchszaehler, Audit (Methode/Pfad/Zeit) | Anmeldung, Nutzung | Art. 6 Abs. 1 lit. b |

Keine besonderen Kategorien (Art. 9). Keine Daten Minderjaehriger beabsichtigt.

## 4. Empfaenger

- AVA-Substrat (Gateway, Datenbanken, Nachrichtenbus): [Betreiber, Frankfurt/EU]
  oder eigene Infrastruktur (souveraener Betrieb).
- KI-Anbieter (nur bei Cloud-Modellen; Vertrag des Nutzers/der Organisation):
  [OpenAI/Anthropic/Google/Mistral/…] — erhalten Website-Texte, Registerauszuege,
  ggf. Beitragstexte; bei zentralen Organisationsschluesseln laeuft der Aufruf
  ueber das AVA-Gateway (Transit, keine Speicherung ohne Prompt-Audit).
- Apify (nur bei Nutzung, LinkedIn-Firmenprofile/Mitarbeiterlisten).
- CRM des Verantwortlichen (HubSpot/Salesforce/Dynamics) bei Export.

## 5. Drittlandtransfer

Nur bei Cloud-KI-Anbietern ausserhalb der EU; Absicherung ueber deren
Standardvertragsklauseln/DPF. Lokale Modelle (Ollama) und EU-Endpunkte
vermeiden den Transfer.

## 6. Loeschfristen

- Beschaeftigungen: 120 Tage ohne erneute Beobachtung (automatisch).
- Personen: [180] Tage ohne erneute Beobachtung (automatisch, je Organisation
  einstellbar unter Einstellungen → Organisation → Vorgaben).
- Loeschwunsch: sofortige globale Loeschung mit Sperre gegen Wiedererfassung
  (Funktion „Loeschen" an der Person, Chat-Tool `person_delete`).
- Nutzerkonto und lokale Daten: beim Entfernen des Kontos auf dem Geraet;
  Serverdaten auf Anfrage.

## 7. Technische und organisatorische Massnahmen

- Lokale Verarbeitung (LLM, Scraping) auf Nutzergeraeten; Schluessel
  verschluesselt im OS-Schluesselbund je Konto.
- Zentrale Organisationsschluessel verschluesselt (AES-256-GCM) im Gateway,
  nie auslesbar.
- Audit-Log je Gateway-Aufruf (Tenant, Nutzer, Methode, Pfad, Zeit).
- Herkunftsnachweis je Person (Quelle, Beleg-URL, Zeitpunkt, erhebende
  Organisation) — Route `/v1/persons/{id}/herkunft`, Chat-Tool `person_herkunft`.
- Transportverschluesselung, Zugriff nur mit Nutzer-Token (Keycloak).

## 8. Betroffenenrechte — Ablauf

| Recht | Umsetzung in AVA |
|---|---|
| Auskunft (Art. 15) | Herkunftsnachweis als Markdown/PDF-Druck, in einer Minute |
| Information (Art. 14) | Vorformulierter Hinweistext (`person_hinweis`), Vermerk „Informiert am" |
| Loeschung (Art. 17) / Widerspruch (Art. 21) | Globale Loeschung + Tombstone (`person_delete`) |
| Berichtigung (Art. 16) | [manuell ueber den Betreiber; Fakten mit Belegen sichtbar] |
