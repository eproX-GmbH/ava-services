# Prompt für den Website-Agenten (ava.bi): Nachtrag Organisationen, KI-Zugänge, Abrechnung

Stand 2026-09-07, Desktop v0.1.568, Gateway mit Migration 20260906_research_model.
Ergänzt docs/WEBSITE_PROMPT_COMPLIANCE.md (Stand 2026-09-05); dessen Regeln
gelten weiter. Nur was hier steht, hat sich seitdem geändert.

---

Du aktualisierst die Website ava.bi (Desktop-App der eproX GmbH, Herford,
B2B-Vertriebsrecherche im DACH-Raum). Grundlage ist die Übergabe vom
2026-09-05. Seitdem sind Funktionen live gegangen, die dort noch als „in
Arbeit" stehen, und einige Aussagen zu KI-Zugängen müssen präzisiert werden.
Ton wie gehabt: sachlich, Du-Form, keine Geviertstriche, keine Superlative,
nichts versprechen, was nicht live ist. Prüfe jede der folgenden Aussagen
gegen den aktuellen Seiteninhalt und passe an.

## 1. Jetzt live, bisher als „in Arbeit" gekennzeichnet

Streiche bei diesen Punkten das „in Arbeit" und beschreibe sie als vorhanden:

- **Recherchen mit der Organisation teilen.** Ein Mitglied gibt eine
  Recherche (einen Import-Vorgang) für die Organisation frei. Kollegen sehen
  sie lesend und können sie in ihren eigenen Bestand übernehmen. Der
  Verarbeitungsfortschritt wird dabei kopiert, die Firmen werden nicht neu
  verarbeitet; das kostet kein zusätzliches Kontingent und keine KI-Aufrufe.
  Die Freigabe lässt sich zurücknehmen.
- **Radar-Firmen an Kollegen weitergeben.** Aus dem Firmen-Radar können
  Kandidaten an die Organisation geteilt werden; sie erscheinen bei den
  Kollegen in einem eigenen Block „Von der Organisation geteilt" mit einer
  Sammelmeldung. Ebenfalls per Chat auslösbar.
- **Mitgliederliste mit Name und E-Mail** statt technischer Nutzer-IDs.

Weiterhin **in Arbeit** (nicht als vorhanden schreiben): Server-Worker für
Beobachtung und Radar ohne aufgeklappten Laptop, Dynamics-365-Anbindung,
Festlegung je Organisation, welche Datenklasse an welche Modellklasse darf,
Intune- und Jamf-Pakete.

## 2. Personenbezogene Daten: neue Nachweis- und Löschfunktionen (live)

Für die Seiten Datenschutz und Datenqualität, sachlich formuliert:

- **Herkunftsnachweis je Person** (Art. 15 DSGVO): Zu jeder erfassten
  Kontaktperson zeigt AVA, aus welcher öffentlichen Quelle, wann und durch
  welche Organisation die Angabe erhoben wurde. Der Nachweis lässt sich als
  Text exportieren.
- **Informationstext nach Art. 14 DSGVO**: AVA stellt je Person einen
  vorformulierten Hinweistext bereit, den der Nutzer der Person zusenden
  kann, und merkt sich das Datum „informiert am".
- **Löschung einer Person im gesamten Bestand** durch die erhebende
  Organisation, mit Sperre gegen erneute automatische Erfassung
  (Tombstone). Bei Altbestand ohne Zuordnung darf jeder Nutzer löschen.
- **Aufbewahrungsfrist**: Personen ohne neue Beobachtung werden nach 180
  Tagen automatisch entfernt; Organisationen können die Frist zwischen 30
  und 3650 Tagen festlegen. Der Tilgungslauf läuft täglich.

Formuliere das als Werkzeuge, mit denen der Kunde seinen Pflichten nachkommt,
nicht als „AVA ist DSGVO-konform".

## 3. KI-Zugänge: die Regeln, die auf der Website stehen müssen

Die Seite „KI-Modelle" und die FAQ „KI-Modellkosten" beschreiben heute
„Ollama lokal, Cloud-Provider mit deinem Vertrag oder ein eigener
Modellserver". Ergänze und präzisiere:

**Drei Wege für die Hintergrund-Verarbeitung** (Firmenprofile,
Jahresabschlüsse, Publikationen, Kontakte, Bewertung):
1. Eigener API-Schlüssel bei OpenAI, Anthropic, Google, Mistral, DeepSeek,
   xAI oder Qwen. Abrechnung direkt beim Anbieter.
2. Lokales Modell über Ollama auf dem eigenen Rechner. Kostenlos, Daten
   bleiben offline, Qualität unter den Cloud-Modellen.
3. Schlüssel der Organisation: Ein Admin hinterlegt den Schlüssel einmal
   zentral, Mitglieder nutzen ihn über den AVA-Stellvertreter (Frankfurt,
   EU), ohne den Schlüssel je zu sehen. Verbrauch und Limits werden je
   Mitglied gezählt.

**ChatGPT-Abo ist kein vierter Weg.** Ein verbundenes ChatGPT-Plus-, Pro-
oder Team-Abo deckt ausschließlich den Chat mit AVA ab. Die Hintergrund-
Verarbeitung braucht zusätzlich einen der drei Wege oben. Grund: Das Abo
liefert keinen API-Zugang, sondern denselben Endpunkt wie OpenAIs Codex-
Werkzeug; dieser ist von OpenAI nicht offiziell dokumentiert und für
interaktive Nutzung ausgelegt, nicht für tausende Textblöcke je Firma. Im
Abo-Modus wählt OpenAI das Chat-Modell aus den für das Konto freigeschalteten
Modellen; eine eigene Modellwahl greift dort nicht. Kennzeichne das Abo als
optionalen Zusatz und als experimentell.

**Vorrangregeln in Organisationen**, exakt so:
- Erlaubt die Organisation eigene Zugänge, gewinnt der eigene Schlüssel
  oder das eigene Abo automatisch gegen den Organisationsschlüssel. Das
  Mitglied kann in den Einstellungen bewusst den Organisationsschlüssel
  bevorzugen. Modellvorgaben der Organisation sind dann Empfehlung.
- Mit Anbieter-Sperre laufen Chat und Hintergrund ausschließlich über den
  Organisationsschlüssel mit den vorgegebenen Modellen. Eigene Schlüssel und
  Abos werden ignoriert, die entsprechenden Einstellungen sind ausgeblendet.
  Die Sperre wirkt nur, wenn die Organisation einen Schlüssel hinterlegt hat.
- Im Abo-Modus läuft die Hintergrund-Verarbeitung über den
  Organisationsschlüssel, falls vorhanden, sonst ist ein eigener Schlüssel
  oder ein lokales Modell nötig. Die App zeigt beide Kanäle getrennt an
  („Chat über", „Hintergrund über").

**Deep Research** (Ausschreibungen und Expansion, Stellenanzeigen) läuft
ausschließlich über OpenAI und kann über den Organisationsschlüssel laufen.
Die Organisation kann das Deep-Research-Modell vorgeben (o4-mini Deep
Research als Standard, o3 Deep Research als gründlichere, teurere Option).
Kosten grob 1 bis 5 Euro je Firma, nur wenn der Nutzer Deep Research
ausdrücklich einschaltet.

**Abgeschaltet heißt unsichtbar.** Schaltet die Organisation ein Modul ab
oder sperrt Anbieter, verschwinden die zugehörigen Menüpunkte, Reiter,
Einstellungen, Links und Hinweise vollständig aus der App. Nichts ist
ausgegraut. Das gilt für LinkedIn-Beobachter, Watchlist, Personen-Radar,
Bildanalyse, Kontakt-Recherche, Mail und Telegram.

## 4. Preise und Abrechnung

Die Preistabelle bleibt: Kostenlos 25 Firmen lebenslang, Starter 49 Euro für
500 Firmen je Monat, Pro 149 Euro für 2000 Firmen je Monat, Enterprise
individuell, jeweils zzgl. 19 % MwSt., Abrechnung über Stripe, jederzeit
kündbar. Ergänze:

- **Kontingent je Kalendermonat, Abrechnung am Vertragstag.** Ehrlich
  benennen, das läuft heute auseinander.
- **Sammelabrechnung für Organisationen** (Kennzeichnung: „in Einführung").
  Eine Organisation kann ein Tier für alle Mitglieder wählen (Starter oder
  Pro) und erhält eine Sammelrechnung nach Belegungsmonat: Gezählt wird je
  Person und angebrochenem Monat, Upgrades gelten sofort, Downgrades ab dem
  Folgemonat. Das Kontingent ist gemeinsam. Zahlung per Karte oder
  SEPA-Lastschrift, Rechnung mit Zahlungsziel nach Absprache. Persönliche
  Abos von Mitgliedern enden beim Beitritt zur Sammelabrechnung zum
  Periodenende. Verspricht keine automatische Rechnungsstellung; sie ist
  noch nicht produktiv.
- **Zahlungsstörung**: 14 Tage Karenz mit Hinweis, danach keine neuen
  Importe und Radar-Läufe, Lesen bleibt möglich, nach Zahlung sofort wieder
  aktiv.
- Enterprise wie bisher ohne Feature-Liste und Preis.

## 5. Betrieb und Verlässlichkeit (Systemanforderungen, FAQ)

- Hintergrunddienste starten sich nach einem Absturz selbst neu, mit
  wachsendem Abstand; ein Fehler bleibt nicht bis zum nächsten App-Start
  liegen.
- Anmeldung bleibt bei Netzausfall erhalten; die App verliert den Login
  nicht mehr, wenn der Server kurz nicht erreichbar ist.
- Windows: bekannte Eingabe- und Fokusprobleme sind behoben. Signierung der
  Windows-Pakete steht weiterhin aus; weiterhin ehrlich nennen.

## 6. Aussagen auf ava.bi, die du gezielt prüfen und anpassen musst

- „Datenklassen-/Modellrichtlinien je Tenant sind in Arbeit": Trenne.
  Funktions-Vorgaben, Anbieter-Sperre, Modellvorgaben und Limits je
  Organisation sind live. Die Zuordnung Datenklasse zu Modellklasse bleibt in
  Arbeit.
- „Ollama lokal, Cloud-Provider mit deinem Vertrag oder ein eigener
  Modellserver": Organisationsschlüssel ergänzen, ChatGPT-Abo wie in
  Abschnitt 3 einordnen. Der „eigene Modellserver" ist über Ollama-URL
  weiterhin möglich.
- FAQ „KI-Modellkosten": Antwort nach Abschnitt 3 aufbauen, Deep Research
  gesondert nennen.
- FAQ „DSGVO-Konformität" und „Profil-Datenschutz": Werkzeuge aus Abschnitt
  2 nennen, keine Konformitätszusage.
- Lösungen-Seiten für Vertriebsleitung und SDR/BDR-Teams: Teilen von
  Recherchen und Radar-Firmen, zentrale Schlüssel, Limits, Sammelabrechnung
  als Team-Funktionen aufnehmen.
- Die Sätze zu LinkedIn, Bildanalyse lokal, Frankfurt/EU und „liked,
  kommentiert oder schreibt nicht automatisch" sind weiterhin korrekt.

## 7. Arbeitsregeln

Wie in der Übergabe vom 2026-09-05: Nichts als vorhanden schreiben, was
hier oder dort als „in Arbeit" steht. Beträge zu KI-Kosten sind Schätzungen.
Eigene Schlüssel der Mitglieder sind für die Organisation nicht messbar.
Keine Vergleiche mit Wettbewerbern, die du nicht belegen kannst.
