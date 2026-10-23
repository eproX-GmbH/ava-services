# Prompt für den Website-Agenten (ava.bi): Microsoft Copilot

Stand 2026-10-23. Quelle: docs/PLAN_COPILOT_MCP.md. Die Regeln aus
docs/WEBSITE_PROMPT_COMPLIANCE.md und docs/WEBSITE_PROMPT_KORREKTUR_2026-10-13.md
gelten weiter. Die Prompt unten ist zum Kopieren gedacht. Sie unterscheidet
strikt zwischen dem, was heute geht, und dem, was in Vorbereitung ist.

---

Du aktualisierst die Website ava.bi (Desktop-App und Server-Instanz der eproX
GmbH, Herford, B2B-Vertriebsrecherche für Deutschland, Österreich und das
Vereinigte Königreich). Zwei Aufgaben: Microsoft Copilot überall dort nennen,
wo MCP erklärt wird, und eine eigene Seite zum Zusammenspiel von AVA und
Copilot anlegen. Ton wie gehabt: sachlich, Du-Form, keine Geviertstriche,
keine Superlative, nichts versprechen, was nicht live ist. Keine technischen
Erklärungen, wie MCP intern funktioniert; es geht darum, was AVA und Copilot
zusammen leisten.

## 1. Copilot neben Claude und ChatGPT nennen

Überall, wo die Website sagt, dass Claude und ChatGPT AVA per MCP nutzen
(Startseite, MCP-Seite, Navigation, Feature-Übersichten, llms.txt,
Vergleichsseiten), ergänze Microsoft Copilot als dritten Namen. Formulierung:
„Claude, ChatGPT und Microsoft Copilot“. Begründung, die du nicht erklären
musst, aber kennen sollst: AVA stellt einen MCP-Server bereit; Copilot Studio
bindet MCP-Server als Werkzeuge ein, damit erreicht Microsoft 365 Copilot und
der Copilot in Dynamics 365 Sales AVA auf demselben Weg wie Claude und ChatGPT.

Ergänze auf der MCP-Seite einen kurzen Verweis auf die neue Copilot-Seite
(„Für Microsoft-Umgebungen: AVA und Copilot“).

## 2. Neue Seite „AVA und Microsoft Copilot“ (Pfad /copilot)

Zielgruppe: Vertriebsleitung und IT-Leitung in Unternehmen, die Microsoft 365
und Dynamics 365 einsetzen und KI-Agenten vorsichtig einführen. Die Seite
beantwortet drei Fragen: Was bringt es, wer macht was, was braucht man.

### Kernaussage (oben)

Dein Copilot kennt deinen Tenant. AVA kennt die Firmen. Zusammen beantwortet
der Copilot in Outlook, Teams und Dynamics Fragen zu Firmen, Ansprechpartnern
und Signalen mit Daten aus AVA, und schreibt, was du übernehmen willst, selbst
in dein CRM.

### Was AVA und Copilot zusammen leisten (Beispiele, als Dialogzeilen)

- „Was weiß AVA über die Müller GmbH in Bielefeld?“ Profil, Register,
  Status, Jahresabschluss-Kennzahlen, Ansprechpartner mit Beleg.
- „Welche meiner Firmen haben diese Woche Neuigkeiten?“ Geschäftsführer-
  wechsel, neue Stellenanzeigen, Insolvenz, neue Kunden auf der Website.
- „Nimm die Firma aus dieser Mail in AVA auf.“ Der Copilot legt den Auftrag
  an, AVA recherchiert, das Ergebnis liegt in AVA bereit.
- „Leg das Gesprächsprotokoll aus dem Teams-Meeting bei AVA ab.“ Der Copilot
  übergibt die Notiz an AVA, dort hängt sie an Firma und Person.
- „Schlag mir eine Erstansprache für Frau Rieger vor.“ AVA formuliert aus
  Anlass, Rolle und Firmenprofil, der Copilot zeigt sie in Outlook.

### Wer macht was (Tabelle)

| Aufgabe | AVA | Copilot |
|---|---|---|
| Firmen recherchieren, beobachten, melden | ja | nein |
| Fragen im Arbeitskontext beantworten (Outlook, Teams, Dynamics) | liefert die Daten | führt das Gespräch |
| Ins CRM schreiben (Leads, Kontakte, Notizen) | nie | ja, mit den Rechten des Nutzers |
| Daten im CRM ändern oder löschen | nie | nur, wenn der Nutzer es will |
| Gesprächsprotokolle und Hinweise ablegen | nimmt sie entgegen | übergibt sie |

Botschaft darunter: AVA liefert und nimmt entgegen, verändert aber nichts in
deinen Microsoft-Systemen. Das Schreiben übernimmt der Copilot mit den
Rechten, der Protokollierung und den Freigaben, die dein Tenant ohnehin hat.

### Was dein Unternehmen braucht

- Microsoft 365 Copilot und Copilot Studio (Lizenzen beim Kunden).
- Eine AVA-Organisation mit laufender AVA; für Unternehmen als Server-
  Instanz unter eigener Adresse, damit der Copilot sie jederzeit erreicht.
- Einen Tenant-Admin, der den AVA-Agenten in Copilot Studio einrichtet und
  freigibt. AVA liefert dafür einen Leitfaden.
- Die Organisation legt in der Web-Konsole fest, welche Werkzeuge der
  Copilot nutzen darf; lesende Werkzeuge sind als solche gekennzeichnet,
  jeder Aufruf steht im Audit-Protokoll.

### Stand (ehrlich)

- Heute: AVA ist per MCP aus Claude, ChatGPT und Copilot Studio nutzbar;
  Anmeldung mit dem AVA-Konto; Werkzeuge je Organisation schaltbar; Audit.
- In Vorbereitung: Anmeldung mit dem Microsoft-Konto des Unternehmens
  (Entra ID), eine auf Copilot zugeschnittene Werkzeugmenge, Ablage von
  Gesprächsprotokollen aus dem Copilot, und ein Connector, über den der
  Copilot AVA-Firmenprofile auch ohne Rückfrage kennt.
- Aufruf: Wir suchen zwei Pilotunternehmen mit Microsoft 365 und Dynamics.
  Kontakt: info@eprox-gmbh.de.

## 3. Nicht behaupten (Do-not-claim)

- Keine App im Microsoft-Marketplace oder AppSource, keine Zertifizierung
  durch Microsoft.
- Keine „Integration in Dynamics 365“ im Sinne eines Plugins oder einer
  Erweiterung in Dynamics; die Verbindung läuft über den Copilot.
- AVA schreibt nicht ins CRM, legt keine Leads an und ändert nichts in
  Microsoft-Systemen. Nie das Gegenteil andeuten.
- Anmeldung mit Microsoft-Konto, Protokoll-Ablage aus dem Copilot und der
  Connector für den Microsoft-Index sind in Vorbereitung, nicht live.
- Kein Agent-zu-Agent-Protokoll (A2A), keine „Agenten sprechen miteinander“.
- Keine Aussagen zu Preisen für die Copilot-Anbindung; verweise auf das
  Enterprise-Angebot. Microsoft-Lizenzen zahlt der Kunde.
- Keine Screenshots von Copilot oder Dynamics erfinden; nur Text und die
  Tabelle.

## 4. Weitere Stellen

- llms.txt: Copilot als dritten MCP-Client ergänzen, einen Satz zur neuen
  Seite.
- Navigation: die Seite unter „Lösungen“ oder neben der MCP-Seite
  einhängen, Titel „AVA und Microsoft Copilot“.
- Preisseite: keine Änderung.
