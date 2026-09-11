# Prompt für Replit: AVA-Produktvideo auf den Stand September 2026 bringen

Stand 2026-09-11, Desktop v0.1.632. Grundlage ist das Replit-Projekt vom
2026-05-11 (28-Sekunden-Video, 7 Szenen, Remotion). Die Prompt unten ist zum
Kopieren gedacht. Sie ändert das bestehende Projekt, statt es neu zu bauen.

Quellen für den Feature-Stand: docs/WEBSITE_PROMPT_COMPLIANCE.md,
docs/WEBSITE_PROMPT_UPDATE_2026-09-07.md, docs/WEBSITE_PROMPT_WORKFLOWS_2026-09-09.md,
docs/WEBSITE_INFO_RADAR_PLAENE.md, docs/TOOLS.md (241 Tools).

---

```
Aktualisiere das bestehende AVA-Produktvideo in diesem Projekt. Baue es
NICHT neu, sondern ändere die vorhandenen Szenen-Dateien, ergänze zwei
Szenen und passe die Gesamtlänge an. Markenfarben, Schriften, Stilregeln,
Audio-Logik und Export-Varianten bleiben exakt wie bisher.

Neue Gesamtlänge: 36 Sekunden (bisher 28). Tempo bleibt zügig.
Format bleibt MP4, 1920×1080, 30fps, Deutsch.

---

## Warum das Update

AVA hat seit Mai mehrere große Funktionen dazubekommen: Workflows,
Firmen-Radar, Teams (Organisationen), Telegram, verifizierte E-Mail-
Adressen, Datenschutz-Werkzeuge. Außerdem sind einige Aussagen im alten
Video inzwischen falsch (Tool-Anzahl, CRM-Aussage, Plattformen, CTA).

## Sprachregeln (zusätzlich zu den bestehenden Stilregeln)

- Du-Form, sachlich, keine Superlative, keine Geviertstriche.
- Nichts behaupten, was unten nicht steht. Insbesondere NICHT:
  „DSGVO-konform", „alles bleibt lokal", „Salesforce", „Linux",
  „Echtzeit", „vollautomatischer Import", „läuft ohne geöffnete App".
- Firma: eproX GmbH, Herford. Website: ava.bi.

---

## Änderungen an bestehenden Szenen

### Szene 1 (2 s) — unverändert
  „Recherche frisst deine Woche."

### Szene 2 (3 s) — eine Zeile anpassen
  „14 Tabs für eine Firma."
  „Handelsregister, Bundesanzeiger, LinkedIn, CRM."
  „Und morgen wieder von vorn."
Bleibt. (Keine Änderung, nur zur Orientierung.)

### Szene 3 (2 s) — Untertitel ändern
Schriftzug „AVA" wie bisher. Neuer Untertitel:
  „Dein Recherche-Assistent für den B2B-Vertrieb im DACH-Raum."

### Szene 4 (7 s) — Chat-Demo: Antwortzeilen und Ticker ändern
Nutzer-Frage bleibt:
  „Überblick zur Herbert Kannegiesser GmbH?"

Neue Antwortzeilen (je ~0,8 s):
  „Maschinenbau, Vlotho NRW, rund 2.400 Mitarbeitende."
  „Umsatz 540 Mio €, Kassenbestand aus dem letzten Jahresabschluss."
  „Ansprechpartner Vertrieb mit verifizierter E-Mail-Adresse."
  „HubSpot: letzter Touchpoint vor 41 Tagen."

Ticker oben rechts: statt technischer Tool-Namen jetzt deutsche
Schrittnamen als Pills (je 0,4 s):
  Handelsregister → Jahresabschluss → Website → Kontakte → CRM

### Szene 5 (7 s, bisher 6 s) — Feature-Raster: 2×3 statt 2×2
Sechs Karten, Stagger 0,12 s. Alte Texte komplett ersetzen:

  1. „241 Werkzeuge, ein Chat."
     „Firmen, Finanzen, Kontakte, CRM, Mail, aus einem Eingabefeld."

  2. „HubSpot, Notion, Obsidian."
     „Live angebunden. Dynamics 365 in Arbeit."

  3. „LinkedIn beobachten, nicht automatisieren."
     „AVA liest Signale und meldet sie. Kein Liken, kein Anschreiben."

  4. „Deine Daten bleiben bei dir."
     „Chats, Schlüssel, Logins, dein Idealkundenprofil: nur auf deinem
      Rechner. KI lokal per Ollama oder mit deinem eigenen Schlüssel."

  5. „Kontakte mit Beleg."
     „Jede Angabe mit Quelle und Datum. Herkunftsnachweis und
      Art.-14-Hinweis auf Knopfdruck."

  6. „Für Teams."
     „Recherchen teilen, zentrale KI-Schlüssel, Verbrauch je Person."

### Szene 6 (5 s, bisher 4 s) — Skills ersetzen durch Workflows
Alte Headline „Eigene Workflows in Markdown." und das Slash-Command-
Snippet komplett entfernen. Neu:

Links Headline:
  „Abläufe einmal erklären. AVA wiederholt sie."
Untertitel:
  „Sag im Chat „speicher das als Workflow". Fertig."

Rechts statt Code-Snippet ein kleines Ablaufdiagramm, das sich von links
nach rechts aufbaut (vier abgerundete Knoten, verbunden mit Linien in
#334155, aktiver Knoten mit Glow in #00c0a7, je 0,6 s):
  Radar-Treffer ab Score 70
  → Firmenprofil und Jahresabschluss laden
  → Kurzbericht per Telegram
  → HubSpot-Notiz nach Freigabe

Unter dem Diagramm eine gedämpfte Zeile:
  „Schreibende Schritte nur nach deiner Freigabe."

### Szene 7 wird Szene 9 (4 s, statisch) — CTA und Fußzeile ändern
Headline bleibt:
  „Hol dir deine Woche zurück."

Buttons:
  Primary (Aqua-zu-Cyan-Gradient): „Kostenlos starten"
  Sekundär (transparent mit Rahmen): „ava.bi"

Untertitel klein (ersetzt „Für Mac, Windows, Linux. Lokales LLM
inklusive."):
  „25 Firmen kostenlos, ohne Zeitlimit. Für Mac und Windows."

---

## Zwei neue Szenen einfügen

### Neue Szene 7 — Firmen-Radar (4 s), zwischen Workflows und Telegram
Links Headline:
  „Neue Firmen in deiner Region."
Untertitel:
  „Der Radar gleicht sie mit deinem Idealkundenprofil ab.
   Übernommen wird nur, was du freigibst."

Rechts eine stilisierte Karte: dunkler Kreis als Suchgebiet mit dünnem
Rand in #334155, darin nacheinander drei kleine Punkte in #00c0a7 mit
Score-Label daneben („92", „85", „71"), der beste Punkt bekommt einen
Glow. Keine echte Landkarte, keine Ortsnamen.

### Neue Szene 8 — Unterwegs (2 s)
Zentriert ein schmales Smartphone-Mockup (nur Rahmen, kein Foto) mit
einer Telegram-ähnlichen Nachrichtenblase in Oberfläche #1e293b:
  „Neuer Radar-Treffer: Müller Antriebstechnik GmbH, Score 88.
   Kurzprofil anzeigen?"
Darunter zwei kleine Buttons „Ja" und „Später".
Headline darüber, klein:
  „Meldungen und Freigaben per Telegram."

---

## Neue Szenenfolge und Dauer (36 s)

  1 Anrede            2 s
  2 Problem           3 s
  3 AVA Reveal        2 s
  4 Chat-Demo         7 s
  5 Sechs Features    7 s
  6 Workflows         5 s
  7 Firmen-Radar      4 s
  8 Unterwegs         2 s
  9 Schluss           4 s

Die Szenen-Auswahl-Steuerung (Scene Selector) aus dem bestehenden
Projekt um die zwei neuen Szenen erweitern.

---

## Export-Varianten anpassen

- 12-Sekunden-Mikro-Variante für LinkedIn: jetzt Szenen 3, 6 und 9 mit
  halber Dauer (Workflows statt Feature-Raster).
- Light-Mode-Variante wie bisher (Hintergrund #f8fafc, Oberflächen
  #ffffff, Text #0f172a, Akzent #00c0a7 bleibt).
- Audio-Logik unverändert. Hinweis: Wenn ein neues voiceover.mp3 kommt,
  ist es 36 s lang (max. ~90 Wörter).

## Liefere am Ende

1. Die neue MP4-Datei zum Download.
2. Eine Liste aller geänderten Dateien mit einem Satz je Datei.
3. Bestätigung, dass keiner dieser Begriffe im Video vorkommt:
   „DSGVO-konform", „Linux", „Salesforce", „Beta", „inklusive",
   „Skills", „Markdown".
```

---

## Was du Replit zusätzlich mitgeben kannst (optional)

| Datei | Zweck |
|---|---|
| `voiceover.mp3` (~36 s) | Neue Sprecherspur; die alte ist mit 28 s zu kurz |
| `workflow.png` | Screenshot Vorgänge → Workflows, falls echte UI statt Diagramm in Szene 6 |
| `radar.png` | Screenshot Firmen-Radar für Szene 7 |
| `logo.svg` | Wie bisher |

## Sprechtext-Vorschlag für 36 s (86 Wörter)

Recherche frisst deine Woche. Vierzehn Tabs für eine Firma, und morgen
wieder von vorn. AVA ist dein Recherche-Assistent für den B2B-Vertrieb.
Eine Frage im Chat, und du bekommst Profil, Zahlen, Kontakte mit Beleg
und den CRM-Stand. Zweihundertvierzig Werkzeuge, HubSpot angebunden,
deine Daten bleiben auf deinem Rechner. Abläufe erklärst du einmal, AVA
wiederholt sie als Workflow, schreibend nur nach deiner Freigabe. Der
Radar findet neue Firmen in deiner Region, Telegram meldet sie dir.
Fünfundzwanzig Firmen kostenlos. Hol dir deine Woche zurück.
