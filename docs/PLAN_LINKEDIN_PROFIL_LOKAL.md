# LinkedIn-Profile lokal lesen (JSON-LD ohne Anmeldung)

Stand 2026-11-03. Vorschlag Patrick (2026-11-02): Die Apify-Actors lesen zu einem
großen Teil nur, was LinkedIn ohnehin jedem Besucher ohne Anmeldung zeigt, so wie
Google es indexiert. Für die Frage „arbeitet die Person noch dort, in welcher
Position?“ reicht das. Entscheidung Joyce (2026-11-03): lokal im Hintergrund-Chrome
des Nutzers bauen, kein Server-Worker (Rechenzentrums-Adressen bekommen die
Anmeldewand; Messung mit nacktem HTTP von einem Privatanschluss: 3 von 4 gesperrt,
das gelieferte Profil trug JSON-LD mit `worksFor` und den Positionstext im
Meta-Text, `jobTitle` war maskiert).

## Was es ersetzt und was nicht

| Zweck | vorher | jetzt |
|---|---|---|
| Positions-/Arbeitgeberwechsel bekannter Ansprechpartner | Apify Profil-Actor (0,4 ct je Profil + 2 ct je Lauf), praktisch nur Watchlist | lokal, 0 Kosten, alle Ansprechpartner aktiver Firmen |
| Mitarbeiterliste einer Firma finden | Apify Mitarbeiter-Actor (~0,40 USD je Firma) | unverändert (ohne Anmeldung nicht erreichbar) |
| Post-Signale (Reaktionen, Kommentare) | Apify | unverändert |

## Ablauf (Kontakt-Producer, 14-Tage-Lauf je Firma)

1. `GET /v1/companies/{id}/contacts/linkedin-profile`: aktuelle Ansprechpartner
   mit LinkedIn-Adresse (Fakt `linkedinUrl`) und letzter Prüfung
   (Beobachtung `linkedin:pruefung`), älteste Prüfung zuerst.
2. Fällig = nie geprüft oder älter als 7 Tage (`LINKEDIN_PROFIL_ABSTAND_TAGE`);
   höchstens 40 je Lauf (`LINKEDIN_PROFIL_MAX_JE_LAUF`), 2,5 bis 6 s Pause.
3. Abruf im Hintergrund-Chrome (`browser-fetch.ts`), Auswertung in
   `linkedin-profil.ts`: JSON-LD Person (`name`, `worksFor`, `jobTitle` falls
   nicht maskiert), Meta-Text „Position · Berufserfahrung: Firma · …“, Titel-Tag.
4. Urteil: `gesperrt` (Anmeldewand), `nicht_gefunden` (Name passt nicht, kein
   Arbeitgeber), `bestaetigt` (Arbeitgeber ≙ Firma, tolerant gegen Rechtsform
   und Zusätze), `gewechselt` (Name passt, Arbeitgeber eindeutig anders).
4b. Kein Halbwissen (Joyce 2026-11-03): Zeigt die Seite eine Änderung, aber
   unvollständig (Wechsel ohne lesbare Position; Name passt, aber kein
   Arbeitgeber lesbar), geht die Person zusätzlich an den Apify-Profil-Actor,
   dessen Ergebnis das lokale Urteil ersetzt. Ist Apify nicht verfügbar, wird
   ein unvollständiger Wechsel nicht gemeldet, sondern als `nicht_gefunden`
   vermerkt und beim nächsten Lauf erneut geprüft.
5. Drei Anmeldewände in Folge: Abbruch des lokalen Wegs; der Rest geht in EINEM
   Lauf an den Apify-Profil-Actor (`harvestapi~linkedin-profile-scraper`, bis
   25 Adressen), wenn Apify verfügbar ist. Was dann noch offen ist, wird als
   `gesperrt` vermerkt (steht beim nächsten Lauf nicht sofort wieder oben).
6. Persist `result.profilPruefungen` (Quelle `linkedin:oeffentlich` oder
   `apify:profil`), Verarbeitung im Gateway `lib/contact-extraction/profil-pruefung.ts`:
   - bestaetigt → voller Kandidaten-Pfad (`applySingleEmployeeCandidate`): Titel,
     Beschäftigung, Reconcile wie ein Website-Fund.
   - gewechselt → Beschäftigung bei der Firma schließen, Fakt
     `employmentCompanyId` deaktivieren, Beobachtungen `linkedin:arbeitgeber`
     (alt mit Zeitpunkt der letzten Bestätigung, neu mit Fundstelle), Signal
     `PERSON_EMPLOYER_CHANGED` → Meldung „Arbeitgeberwechsel“ mit Fundstelle
     (`alerts-neuheiten`, Desktop-Text nennt den neuen Arbeitgeber).
   - jedes Ergebnis → Beobachtung `linkedin:pruefung` („bestaetigt 2026-11-03 · Firma“).
7. Statistik `GET /v1/contacts/linkedin-profile/statistik` (30 Tage je Nutzer),
   Desktop Einstellungen → Erweitert → Dienste auf diesem Rechner.

Schalter: `LINKEDIN_PROFIL_PRUEFUNG=0` am Producer schaltet den Schritt ab.

## Offen

- Sperrquote auf Nutzer-Rechnern beobachten (Statistik); liegt sie hoch, Pausen
  verlängern oder Tageslimit je Rechner.
- Firmenseite lokal lesen (Mitarbeiter-Spanne, Beschreibung) statt Details-Actor
  beim 14-Tage-Delta.
- Rechtlicher Hinweis je Organisation (Abruf von der IP des Kunden), Schalter in
  der Konsole, wenn Enterprise-Kunden danach fragen.
