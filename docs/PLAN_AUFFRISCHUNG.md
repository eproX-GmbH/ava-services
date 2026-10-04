# Auffrischung der Firmenliste (Heartbeat), Stand 2026-10-04

Anlass: Ein Nutzer vermisste Neuverarbeitungen seiner Firmen. Befund an
seinen Daten: Der Frische-Planer (`main/agent/freshness-scheduler.ts`) las
seine Kandidaten nur aus den 25 neuesten Transaktionen. Bei 70 Transaktionen
sah er 11 von 43 Firmen; bei den übrigen 32 waren Website, Profil, Kontakte
und Bewertung ausnahmslos überfällig.

## Umsetzung (v0.1.748)

- **Kandidaten aus der ganzen Firmenliste:** `GET /v1/companies/matrix`
  seitenweise (200 je Seite, bis 10.000 Firmen). Angehaltene (`held`) und im
  Register geschlossene Firmen sind ausgenommen. Für den Retry genügt jede
  Transaktion der Firma.
- **Priorität:** Überfälligkeit in Takten × Relevanzfaktor × Merkliste ×
  frisches Interesse. Relevanzfaktor aus dem Rang (0–10): ab 9 ×3, ab 7 ×2,
  ab 4 ×1,5, sonst ×1. Die Überfälligkeit wächst täglich, deshalb kommen auch
  kalte Firmen sicher an die Reihe; heiße nur früher. Nie gelaufene Stufen
  zählen wie drei Takte überfällig, damit nicht laufbare Zellen nicht die
  Spitze blockieren.
- **Fehlversuch:** Schlägt ein Retry fehl (z. B. Profil ohne Website), ruht
  die Zelle 24 Stunden.
- **Takte (Standard):** Website, Profil, Kontakte 7 Tage; Bewertung 14;
  Registerauszug 30; Jahresabschluss **30** (vorher 75, passend zur
  30-Tage-Sperre der Producer). Gespeicherte 75 werden auf 30 umgestellt,
  eigene Werte bleiben.
- **Drossel unverändert:** 3 Neuanstöße je Stufe und 10 insgesamt pro Stunde,
  5 je Takt (30 Minuten).

## Grenzen

- Im Worker-Modus ruht die Auffrischung bewusst; auf einem reinen
  Worker-Rechner werden eigene Firmen erst wieder aufgefrischt, wenn AVA
  normal läuft.
- Ohne Relevanz-Erfassung (Opt-out) zählt nur die Überfälligkeit.
