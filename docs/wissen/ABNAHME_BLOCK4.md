# Abnahme Block 4: Verbindungen, Mail, Telegram

Stand 2026-11-07. Je Karte: Titel, Beispielfragen, Knöpfe (erscheinen unter AVAs Antwort), Text so, wie AVA ihn liest.
Rückmeldung am einfachsten im Chat: „ok“ für den ganzen Ast oder je Karte die id mit dem, was falsch ist.

## verbindungen (26 Karten)

### Einen fremden KI-Agenten an AVA anbinden
`agent-verbinden` · gilt für: [desktop] · Knöpfe: Agent verbinden (öffnet Seite)

> Fragen: kann ava einem anderen agenten aufträge geben · agent2agent agent verbinden · externen agenten hinzufügen · agentenkarte url eintragen · gib meinem anderen agenten einen auftrag

Ich kann fremden Agenten Aufträge geben, wenn sie das Agent2Agent-Verfahren beherrschen. Unter Einstellungen → Verbindungen → Weitere Dienste klickst du auf „Dienst verbinden“, wählst bei „Art des Dienstes“ „Agent (nimmt Aufträge in Textform an)“ und trägst Name, die Adresse des Agenten oder seiner Agentenkarte und den Zugang ein. Steht die Verbindung, zeigt die Karte „Agent erreichbar“.

Danach sagst du mir, was der Agent erledigen soll. Ich formuliere den Auftrag vollständig, denn der Agent kennt unser Gespräch nicht, und zeige ihn dir vor dem Senden. Auf das Ergebnis warte ich bis zu zwei Minuten. Dauert es länger, frage ich den Stand später für dich ab.

Den umgekehrten Weg, dass fremde Agenten mir Aufträge geben, schaltet deine Organisation frei.

### Claude oder ChatGPT findet keine AVA-Funktionen
`ava-claude-findet-nichts` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: claude zeigt keine ava tools · connector ist verbunden aber es kommen keine werkzeuge · chatgpt sagt ava ist nicht erreichbar · ava antwortet in claude nicht · mcp liefert keine tools

Ist die Verbindung angelegt, aber Claude oder ChatGPT sieht keine Funktionen von AVA, hat deine Organisation den Zugang für Claude, ChatGPT und Copilot noch nicht freigeschaltet. Das macht ein Admin in der AVA Konsole unter admin.ava.bi → Funktionen & Vorgaben. Dort legt er auch fest, was erlaubt ist: Lesen, Aufträge wie Importe und Verarbeitungen, Ansprechpartner mit Personendaten (standardmäßig aus) und die Funktionen deiner laufenden AVA.

Fehlen nur Antworten, für die deine AVA selbst arbeiten muss, ist gerade keine AVA von dir online. Unter Einstellungen → Konto → Deine AVAs siehst du, welches Gerät Anfragen aus Claude und ChatGPT beantwortet. Dort muss „Dieses Gerät darf Anfragen aus Claude und ChatGPT beantworten“ an sein.

Aufträge aus Claude oder ChatGPT werden wie jede Verarbeitung abgerechnet.

### Fremde Agenten sollen AVA Aufträge geben (Agent2Agent)
`ava-fuer-fremde-agenten` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: kann n8n ava aufträge geben · ava als a2a agent nutzen · wo finde ich die agentenkarte von ava · azure ai foundry mit ava verbinden · agent to agent zugriff auf ava

Andere Agenten, etwa aus Copilot Studio, Azure AI Foundry oder n8n, können mir Aufgaben über das Agent2Agent-Verfahren geben. Sie bekommen dieselben Funktionen wie Claude und ChatGPT: Firmen suchen und lesen, Meldungen, Importe und Recherchen anstoßen. Lesende Anfragen beantworte ich sofort; Importe und Recherchen melden sich beim Agenten, sobald sie fertig sind.

Dafür muss ein Admin deiner Organisation in der AVA Konsole unter admin.ava.bi zwei Schalter setzen: den Zugang für Claude, ChatGPT und Copilot und zusätzlich den Agent-zu-Agent-Zugang. Beide sind standardmäßig aus. Die Verbindungsdaten zum Kopieren stehen in der Konsole unter „Agenten-Zugang“.

Soll umgekehrt ich einem fremden Agenten Aufträge geben, verbindest du ihn unter Einstellungen → Verbindungen → Weitere Dienste.

### AVA aus Claude oder ChatGPT heraus nutzen
`ava-in-claude-chatgpt` · gilt für: alle Kanäle · Knöpfe: Bereitschaft prüfen (Chat-Vorschlag), Verbundene Apps öffnen (öffnet Seite)

> Fragen: kann ich ava in claude nutzen · ava als connector in chatgpt einrichten · ava in claude desktop einbinden · claude code mit ava verbinden · gibt es einen mcp server von ava

Du kannst mich auch aus Claude, ChatGPT oder Claude Code heraus nutzen: Firmen suchen und lesen, Meldungen abrufen, Importe und Recherchen anstoßen. Jede App sieht dabei nur deine Daten.

So verbindest du sie: Leg in der App einen eigenen Connector mit der Adresse https://mcp.ava.bi an, in Claude zum Beispiel unter Einstellungen → Connectors. Beim ersten Aufruf meldest du dich mit deinem AVA-Konto an und gibst den Zugriff frei. In Claude Code trägst du dieselbe Adresse als Server ein.

Voraussetzung: Deine Organisation hat den Zugang für Claude, ChatGPT und Copilot freigeschaltet, standardmäßig ist er aus. Verarbeitet wird weiter in deiner AVA, auf diesem Rechner oder deinem Server. Was du abfragst, geht dabei an das Modell des jeweiligen Anbieters.

Welche Apps verbunden sind, siehst und trennst du unter Einstellungen → Konto → Verbundene Apps.

### AVA in Microsoft Copilot nutzen (Outlook, Teams, Dynamics)
`ava-in-copilot` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: geht ava mit microsoft copilot · kann ich ava in teams nutzen · ava als agent in copilot studio · kann copilot auf ava zugreifen · ava im dynamics sales copilot

Über Copilot Studio kann der Copilot deines Unternehmens AVA nutzen, auf demselben Weg wie Claude und ChatGPT. Der Copilot fragt dann in Outlook, Teams oder Dynamics Firmen und Meldungen bei mir ab, auf Wunsch auch Ansprechpartner, und kann eine Firma bei mir aufnehmen lassen.

Einrichten muss das die IT: Ein Admin deines Microsoft-Tenants richtet AVA in Copilot Studio ein. Ein Admin deiner AVA-Organisation schaltet in der AVA Konsole unter admin.ava.bi den Zugang frei und kann dort die kleine Funktionsliste für Copilot wählen. Die Verbindungsdaten zum Kopieren stehen in der Konsole unter „Agenten-Zugang“.

Wichtig: Ich schreibe nichts in deine Microsoft-Systeme und lege dort keine Leads an. Ins CRM schreibt, wenn überhaupt, der Copilot mit deinen Rechten. Die Anmeldung mit dem Microsoft-Konto ist noch in Vorbereitung, heute meldest du dich mit dem AVA-Konto an.

### Was AVA in Close lesen und ändern kann
`close-nutzen` · gilt für: [desktop] · Knöpfe: Close verbinden (öffnet Seite)

> Fragen: was kannst du in close machen · leg eine aufgabe in close an · schreib eine notiz an den lead in close · warum kannst du in close nichts löschen · zeig mir die chancen in close

Ist Close unter „Weitere Dienste“ verbunden, arbeite ich mit dem, was Close dort anbietet: Kontakte, Aktivitäten, Chancen und Aufgaben lesen, Notizen und Aufgaben anlegen. Vor jeder Änderung in Close zeige ich dir, was ich vorhabe, und du bestätigst.

Vorbelegt ist Lesen und sicheres Schreiben, Löschen geht damit bewusst nicht. Brauchst du es, trägst du in der Kopfzeile „Close-Scope“ den Zugriffsbereich für destruktives Schreiben ein, wie ihn Close beschreibt. Ändern lässt sich der Zugang an der bestehenden Karte nicht: Dienst entfernen und mit der Vorlage neu verbinden.

Über die CRM-Karte von Close übernehme ich außerdem Leads als Firmen in deine Firmenliste und verknüpfe Firmen mit ihrem Lead. Sag mir einfach, was in Close passieren soll.

### Close CRM mit AVA verbinden
`close-verbinden` · gilt für: [desktop] · Knöpfe: Close verbinden (Eingabekarte), Close als CRM verbinden (öffnet Seite)

> Fragen: verbinde dich mit close · close crm anbinden · wo trage ich den close api key ein · close.com mit ava verbinden · warum gibt es close zweimal in den einstellungen

Close verbindest du an zwei Stellen, jeweils mit demselben persönlichen Schlüssel. Den erzeugst du in Close unter Einstellungen → Entwickler (API-Schlüssel).

1. Für die Arbeit in Close (Kontakte, Aktivitäten, Chancen, Aufgaben) zeige ich dir hier im Chat eine sichere Eingabekarte „Close verbinden“. Du trägst den Schlüssel ins Feld „Close-API-Key“ ein und klickst auf „Verbinden“. Er geht direkt in den geschützten Speicher dieses Rechners, ich bekomme ihn nicht zu sehen.
2. Damit ich Leads aus Close als Firmen übernehme und deine AVA-Firmen mit dem passenden Lead verknüpfe, trägst du den Schlüssel zusätzlich unter Einstellungen → Verbindungen → CRM an der Karte Close ein.

Schick den Schlüssel bitte nie als normale Nachricht. Eine Anmeldung bei Close über ein Anmeldefenster statt Schlüssel gibt es noch nicht. Die Eingabekarte gibt es nur in der Desktop-App und wenn deine Organisation „Weitere Dienste“ erlaubt.

### Was AVA mit CompLeadly für mich tun kann
`compleadly-nutzen` · gilt für: alle Kanäle · Knöpfe: Vorlagen zeigen (Chat-Vorschlag), CompLeadly verbinden (öffnet Seite)

> Fragen: was kannst du mit compleadly machen · übergib die kontakte von firma x an compleadly · linkedin ansprache über compleadly starten · leads in meine compleadly zielgruppe · wie weit sind meine compleadly sequenzen

Mit verbundenem CompLeadly arbeite ich direkt in deinem CompLeadly-Konto, zum Beispiel: Kontakte mit LinkedIn-Profil in eine Zielgruppe legen oder den Stand deiner Sequenzen abfragen. Welche Funktionen es genau gibt, bestimmt CompLeadly; ich nutze, was der Dienst anbietet.

Für die Ansprache je Firma gibt es die Workflow-Vorlage „LinkedIn-Ansprache über CompLeadly“: Ich hole die Kontakte der Firma mit LinkedIn-Profil, du gibst frei, wer an CompLeadly geht, und ich lege sie in deine Zielgruppe. Kontaktanfragen und Nachfassen laufen in CompLeadly und werden dort freigegeben. Ich selbst schicke nichts über LinkedIn.

Was in CompLeadly etwas anlegt oder ändert, bestätigst du vorher. Workflows gibt es, wenn deine Organisation sie freigeschaltet hat. Ist CompLeadly noch nicht verbunden, öffne ich dir die Seite dafür.

### Rückmeldungen aus CompLeadly in AVA bekommen (Lead hat geantwortet)
`compleadly-rueckmeldungen` · gilt für: [desktop] · Knöpfe: Letzte Ereignisse zeigen (Chat-Vorschlag), Rückkanal einrichten (öffnet Seite)

> Fragen: sagst du mir wenn ein lead in compleadly antwortet · compleadly webhook einrichten · rückkanal für compleadly · hat jemand auf meine linkedin nachricht geantwortet · compleadly antworten als notiz nach close

CompLeadly kann mir melden, was in deinen Sequenzen passiert: Kontaktanfrage gesendet oder angenommen, Nachricht gesendet, Lead hat geantwortet. Dafür richtest du einmal den Rückkanal ein.

Unter Einstellungen → Verbindungen → Weitere Dienste klickst du an der Karte von CompLeadly bei „Rückkanal“ auf „Adresse anlegen“ und dann auf „Kopieren“. In CompLeadly trägst du die Adresse unter Einstellungen → Webhooks ein. Das gibt es bei CompLeadly ab dem Premium-Tarif.

Danach schaue ich alle drei Minuten nach neuen Ereignissen und melde sie dir als Benachrichtigung, etwa „CompLeadly: Lead hat geantwortet“ mit Name und Firma. Kenne ich die Person aus deinem Bestand, ordne ich das Ereignis über ihr LinkedIn-Profil zu. Mit der Workflow-Vorlage „CompLeadly-Rückmeldung als Notiz in Close“ schreibe ich daraus eine Notiz an den Lead in Close, bei einer Antwort zusätzlich eine Aufgabe zum Nachfassen.

Ohne Rückkanal frage ich den Stand bei Bedarf direkt in CompLeadly ab.

### CompLeadly mit AVA verbinden
`compleadly-verbinden` · gilt für: [desktop] · Knöpfe: CompLeadly verbinden (Eingabekarte), Weitere Dienste öffnen (öffnet Seite)

> Fragen: verbinde dich mit compleadly · wie bekomme ich complead.ly in ava · wo trage ich den compleadly zugangscode ein · compleadly anbinden geht das · connect compleadly

Ich zeige dir hier im Chat eine sichere Eingabekarte „CompLeadly verbinden“. Adresse und Art des Zugangs sind schon ausgefüllt, du brauchst nur deinen Zugangscode.

So bekommst du ihn: Melde dich bei CompLeadly an, geh zu Einstellungen → Eigene KI verbinden und leg dort einen neuen Zugangscode an. Kopier ihn in das Feld „Zugangscode für CompLeadly“ auf der Karte und klick auf „Verbinden“. Der Code geht direkt in den geschützten Speicher dieses Rechners, ich bekomme ihn nicht zu sehen. Schick ihn bitte nie als normale Nachricht.

Steht die Verbindung, sage ich dir, was ich jetzt in CompLeadly für dich tun kann, zum Beispiel die Kontakte einer Firma mit LinkedIn-Profil in eine Zielgruppe legen. Alles, was in CompLeadly etwas ändert, bestätigst du vorher. Dasselbe geht auch unter Einstellungen → Verbindungen → Weitere Dienste mit der Vorlage CompLeadly.

Das geht nur in der Desktop-App und nur, wenn deine Organisation „Weitere Dienste“ erlaubt.

### Das CRM mit AVA verbinden (HubSpot oder Close)
`crm-verbinden` · gilt für: [desktop] · Knöpfe: CRM verbinden (öffnet Seite)

> Fragen: verbinde mein CRM · HubSpot anbinden · wie bekomme ich Close in AVA · kann AVA in mein CRM schreiben · CRM verknüpfen

Mit verbundenem CRM gleiche ich deine Firmen ab, lese Kontakte, Deals und Notizen und lege auf deinen Wunsch Einträge an. Vor jeder Änderung im CRM fragst du kurz zu.

HubSpot verbindest du über ein Anmeldefenster: Ich öffne dir die Seite, du meldest dich bei HubSpot an und gibst AVA frei. Close verbindest du mit deinem Schlüssel aus den Entwickler-Einstellungen von Close. Den trägst du auf derselben Seite ein, nicht im Chat.

Danach kann ich zum Beispiel deine Firmen aus dem CRM übernehmen und anreichern oder dir zu jeder Firma zeigen, was im CRM dazu steht.

### Warum AVA vor Aktionen in einem verbundenen Dienst nachfragt
`dienst-bestaetigen` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: warum fragst du jedes mal ob du das ausführen sollst · kann ich die rückfrage bei close abschalten · schreib ohne bestätigung in compleadly · geht das auch automatisch im workflow · was bedeutet ausführen oder abbrechen

Alles, was in einem verbundenen Dienst etwas anlegt, ändert, löscht oder sendet, zeige ich dir vorher mit den genauen Angaben, und du klickst „Ausführen“ oder „Abbrechen“. Bei Agenten heißt der Knopf „Senden“. Reines Lesen und Suchen läuft ohne Rückfrage. Ob eine Funktion schreibt, erkenne ich an den Angaben des Dienstes oder an ihrem Namen; im Zweifel frage ich lieber nach.

Das ist Absicht, denn was ich dort tue, wirkt bei Kunden und Kollegen. Auch in Workflows sind schreibende Schritte erst aktiv, wenn du sie freigibst.

Auf Telegram gehen solche Aktionen nur, wenn du dort „Rückfragen aufs Handy erlauben“ eingeschaltet hast. Sonst sage ich dir, dass du es am Rechner erledigen musst.

### Einen externen Dienst mit AVA verbinden (z. B. CompLeadly oder Close)
`dienst-verbinden` · gilt für: [desktop] · Knöpfe: Zugang eingeben (Eingabekarte), Zu den Diensten (öffnet Seite)

> Fragen: verbinde dich mit CompLeadly · verbinde dich mit dem Service · wie schließe ich ein anderes Tool an AVA an · MCP Server hinzufügen · kannst du mit Close arbeiten

Andere Dienste verbindest du einmal in der App, danach arbeite ich direkt mit ihnen: Kontakte und Aktivitäten in Close, LinkedIn-Sequenzen in CompLeadly oder jeder andere Dienst mit eigener Schnittstelle für KI-Assistenten.

So geht es: Ich zeige dir hier im Chat eine sichere Eingabekarte, für CompLeadly und Close ist alles vorausgefüllt. Du trägst nur deinen Zugang ein: bei CompLeadly den Zugangscode aus „Eigene KI verbinden“, bei Close deinen Schlüssel aus den Entwickler-Einstellungen. Andere Dienste gehen genauso, mit Schlüssel, Benutzername und Passwort oder Client-ID und Secret. Deine Angaben landen direkt im geschützten Speicher deines Rechners, nicht im Chatverlauf. Schreib sie bitte nie als normale Nachricht.

Sobald die Verbindung steht, sag mir einfach, was ich tun soll. Aktionen, die etwas im Dienst ändern, bestätigst du vorher. Läuft ein Zugang ab, siehst du es oben in der App.

### Zugang zu einem verbundenen Dienst abgelaufen oder abgelehnt
`dienst-zugang-abgelaufen` · gilt für: [desktop] · Knöpfe: CompLeadly neu verbinden (Eingabekarte), Close neu verbinden (Eingabekarte), Weitere Dienste öffnen (öffnet Seite)

> Fragen: compleadly zugang abgelaufen · der dienst lehnt den zugang ab · zugang erneuern · close geht plötzlich nicht mehr · dienst meldet 401

Lehnt ein Dienst deinen Zugang ab, siehst du oben in der App einen Hinweis mit dem Namen des Dienstes, und an seiner Karte unter Einstellungen → Verbindungen → Weitere Dienste steht der Fehler. Seine Funktionen stehen mir dann nicht zur Verfügung, ich versuche es auch nicht weiter.

So erneuerst du den Zugang: Leg beim Anbieter einen neuen Zugangscode oder Schlüssel an und trag ihn einfach neu ein, bei CompLeadly und Close über die sichere Eingabekarte hier im Chat, sonst unter Weitere Dienste mit „Dienst verbinden“ und derselben Adresse. Der bisherige Eintrag wird dabei ersetzt, entfernen musst du nichts. Klappt der neue Zugang nicht, bleibt der alte Eintrag, wie er war.

Steht an der Karte nur „nicht verbunden“ ohne Zugangsfehler, war der Dienst kurz nicht erreichbar. Dann reicht „Neu verbinden“ an der Karte.

### Einen eigenen Dienst ohne Vorlage verbinden
`eigenen-dienst-verbinden` · gilt für: [desktop] · Knöpfe: Zugang eingeben (Eingabekarte), Weitere Dienste öffnen (öffnet Seite)

> Fragen: wie verbinde ich einen dienst der nicht in der liste ist · eigenen mcp server hinzufügen · custom mcp server url eintragen · dienst mit api key im header verbinden · kann ich jedes beliebige tool anschließen

Jeden Dienst, der eine Schnittstelle für KI-Assistenten anbietet, kannst du selbst verbinden. Du brauchst vom Anbieter die Adresse dieser Schnittstelle (beginnt mit https://) und den Zugang. Nenn mir den Dienst und die Adresse, dann zeige ich dir hier im Chat eine sichere Eingabekarte dafür.

Oder du machst es selbst unter Einstellungen → Verbindungen → Weitere Dienste mit „Dienst verbinden“ und der Vorlage „Eigener Dienst“:
- Art des Dienstes: die erste Auswahl für Dienste mit einzelnen Funktionen, „Agent“ für einen fremden Agenten.
- Name und Adresse.
- Zugang: „Schlüssel oder Zugangscode“, „Eigene Kopfzeilen“ (bis zu vier benannte Felder), „Benutzername und Passwort“, „Client-ID und Client-Secret“ mit der Adresse für die Anmeldung, oder „Ohne Zugang“.

Nach „Verbinden“ siehst du, ob es geklappt hat und wie viele Funktionen ich nutzen kann. Dienste, bei denen du dich nur in einem Anmeldefenster im Browser anmelden kannst, lassen sich so noch nicht verbinden.

### Eine Firma aus AVA nach HubSpot übernehmen
`hubspot-firma-uebernehmen` · gilt für: alle Kanäle · Knöpfe: Nach HubSpot übernehmen (Chat-Vorschlag)

> Fragen: leg die firma in hubspot an · übertrag die firma mit allen daten nach hubspot · hubspot mit den ava daten anreichern · sync company to hubspot · leg die ansprechpartner auch in hubspot an

Nenn mir die Firma, dann übernehme ich sie in einem Schritt nach HubSpot. Ich lege sie an oder aktualisiere den vorhandenen Eintrag und fülle die Felder aus meinen Daten: Adresse, Telefon, Website, Branche, Gründungsjahr, Mitarbeiterzahl und Umsatz aus dem jüngsten Jahresabschluss, das Firmenprofil als Beschreibung und den Unternehmensgegenstand aus dem Handelsregister. Geschäftsführer und Ansprechpartner lege ich als Kontakte an und verknüpfe sie mit der Firma.

Bevor etwas in HubSpot geschrieben wird, siehst du alles in einer Übersicht und bestätigst einmal. Einzelne Felder musst du nicht nennen.

Voraussetzung ist ein verbundenes HubSpot. Ist die Firma bei mir noch nicht vollständig aufbereitet, sage ich dir das und hole es nach.

### Was AVA in HubSpot lesen, anlegen und verknüpfen kann
`hubspot-nutzen` · gilt für: alle Kanäle · Knöpfe: Offene Aufgaben zeigen (Chat-Vorschlag)

> Fragen: was kannst du in hubspot machen · welche deals hat die firma in hubspot · leg einen kontakt in hubspot an · trag den anruf in hubspot ein · erstell mir eine aufgabe in hubspot

Mit verbundenem HubSpot kann ich:

- lesen: Firmen, Kontakte und Deals suchen, zu einer Firma alle verknüpften Ansprechpartner und Deals zeigen, dazu Zuständige, Notizen und Aufgaben,
- anlegen: Firmen, Kontakte, Deals, Notizen, Aufgaben und Aktivitäten wie Anruf, Meeting oder E-Mail, gleich verknüpft mit Firma, Kontakt oder Deal,
- ändern: Felder einer Firma aktualisieren, Aufgaben erledigen, Verknüpfungen setzen oder lösen,
- zuordnen: eine AVA-Firma mit ihrem HubSpot-Eintrag verknüpfen, damit ich bei der Firma zeige, was im CRM steht.

Vor jeder Änderung zeige ich dir, was ich vorhabe, und du bestätigst. Löschen kann ich in HubSpot nichts. Sag einfach, was du brauchst, etwa „Welche offenen Deals hat die Müller GmbH?“

### HubSpot mit AVA verbinden
`hubspot-verbinden` · gilt für: [desktop] · Knöpfe: HubSpot verbinden (Chat-Vorschlag), CRM-Seite öffnen (öffnet Seite)

> Fragen: verbinde mein hubspot-konto · wie melde ich ava bei hubspot an · hubspot login für ava · connect hubspot · brauche ich für hubspot einen api key

HubSpot verbinde ich direkt aus dem Chat: Sag „Verbinde mein HubSpot-Konto“, dann öffnet sich dein Browser mit der Anmeldung bei HubSpot. Du meldest dich an und gibst AVA frei. Danach steht unter Einstellungen → Verbindungen → CRM bei HubSpot „verbunden“ und dein Konto.

Alternativ klickst du dort an der Karte von HubSpot auf „Verbinden“, das führt zur selben Anmeldung. Einen Schlüssel brauchst du nicht.

AVA bekommt dabei Lese- und Schreibrechte für Kontakte, Firmen und Deals. Geschrieben wird trotzdem nur, wenn du es willst: Vor jeder Änderung in HubSpot zeige ich dir, was ich vorhabe, und du bestätigst.

### HubSpot-Verbindung gestört oder abgelaufen
`hubspot-verbindung-gestoert` · gilt für: [desktop] · Knöpfe: Neu verbinden (Chat-Vorschlag), CRM-Seite öffnen (öffnet Seite)

> Fragen: hubspot verbindung gestört · hubspot geht nicht mehr · du kannst nicht mehr in hubspot schreiben · hubspot fehler beim speichern · hubspot neu verbinden

Steht oben in der App „HubSpot-Verbindung gestört“, klick dort auf „Neu verbinden“. Es öffnet sich die Anmeldung bei HubSpot im Browser, du meldest dich an und gibst AVA wieder frei. Danach klappen Lesen und Schreiben wieder. Die Verknüpfungen zwischen deinen AVA-Firmen und HubSpot-Einträgen bleiben dabei erhalten.

Du kannst auch einfach „Verbinde mein HubSpot-Konto neu“ sagen, dann starte ich die Anmeldung. Den letzten Fehler siehst du unter Einstellungen → Verbindungen → CRM an der Karte von HubSpot.

Schlägt nur eine einzelne Änderung fehl, liegt es meist an einem Feld oder einer Auswahl, die es in deinem HubSpot so nicht gibt. Das sage ich dir dann konkret und versuche es mit dem richtigen Namen.

### Mit AVA in Notion suchen und Einträge pflegen
`notion-nutzen` · gilt für: alle Kanäle · Knöpfe: Datenbanken zeigen (Chat-Vorschlag)

> Fragen: trag das in meine notion datenbank ein · setz den status in notion auf angebot · such in notion nach der firma · leg eine neue notion seite an · notion crm aktualisieren

Ist Notion verbunden, kann ich darin suchen, Seiten lesen, neue Seiten und Datenbankeinträge anlegen und bestehende Einträge ändern, etwa den Status einer Firma in deiner Vertriebsliste in Notion. Sag es so, wie du es meinst: „Setz bei der Müller GmbH den Status auf Angebot“. Die passende Datenbank, die Felder und die Auswahlwerte suche ich mir selbst heraus und frage nur, wenn es wirklich mehrdeutig ist.

Löschen heißt in Notion archivieren: Die Seite liegt danach 30 Tage im Papierkorb von Notion und lässt sich dort wiederherstellen. Vorher zeige ich dir, welche Seite es ist, und du bestätigst.

Ich sehe nur, was in Notion für die AVA-Integration freigegeben ist.

### Notion mit AVA verbinden
`notion-verbinden` · gilt für: [desktop] · Knöpfe: Notion verbinden (öffnet Seite)

> Fragen: verbinde dich mit notion · notion anbinden · wo bekomme ich den notion zugangscode · notion integration token einrichten · du findest meine notion seite nicht

Notion verbindest du unter Einstellungen → Verbindungen → Notizen, Karte Notion, „Verbinden“. Die Schritte stehen dort auch:

1. Auf notion.so/profile/integrations eine neue Integration anlegen, Name zum Beispiel „AVA“, Art „Internal integration“, mindestens Inhalte lesen, aktualisieren und einfügen erlauben.
2. Den Zugangscode der Integration kopieren (beginnt mit ntn_ oder secret_) und in AVA einfügen.
3. Wichtig: In Notion jede Seite oder Datenbank, mit der ich arbeiten soll, über „…“ → Connections für AVA freigeben. Bei Datenbanken die Datenbank selbst, nicht nur einzelne Einträge.

Der Zugangscode liegt verschlüsselt im Schlüsselbund dieses Rechners, schick ihn mir bitte nicht in den Chat. Finde ich eine Seite nicht oder ändert sich beim Schreiben nichts, fehlt fast immer Schritt 3.

### Obsidian mit AVA verbinden
`obsidian-verbinden` · gilt für: [desktop] · Knöpfe: Notizen zeigen (Chat-Vorschlag), Obsidian verbinden (öffnet Seite)

> Fragen: verbinde mein obsidian vault · obsidian anbinden · obsidian local rest api einrichten · verbindung zu obsidian verweigert · kannst du in meine obsidian notizen schreiben

Obsidian verbinde ich über das Plugin „Local REST API“. So geht es:

1. In Obsidian unter Settings → Community plugins das Plugin „Local REST API“ (von coddingtonbear) installieren und aktivieren. Falls nötig vorher den „Restricted mode“ ausschalten.
2. In den Einstellungen des Plugins den Schlüssel („API Key“) kopieren.
3. In AVA unter Einstellungen → Verbindungen → Notizen bei Obsidian auf „Verbinden“ klicken und den Schlüssel einfügen. Die Base-URL http://127.0.0.1:27123 ist vorbelegt und passt meist.

Danach kann ich deine Notizen lesen, durchsuchen, nach Tags finden, neue anlegen und bestehende ergänzen. Obsidian muss dafür auf diesem Rechner laufen. Meldet die Verbindung „verweigert“, ist Obsidian zu oder das Plugin aus.

### Salesforce oder Microsoft Dynamics mit AVA verbinden
`salesforce-dynamics` · gilt für: alle Kanäle · Knöpfe: Liste importieren (Chat-Vorschlag)

> Fragen: salesforce anbinden · geht dynamics 365 · verbinde mein salesforce · microsoft crm verbinden · warum steht bei salesforce demnächst verfügbar

Salesforce und Microsoft Dynamics 365 stehen in den Einstellungen unter Verbindungen → CRM, sind aber noch nicht freigeschaltet. Dort steht „Demnächst verfügbar“, und auch ich kann die Verbindung noch nicht herstellen. Heute direkt verbinden lassen sich HubSpot und Close.

Was du stattdessen tun kannst: Exportier deine Firmen aus Salesforce oder Dynamics als Excel- oder CSV-Datei und zieh sie in den Chat. Ich nehme sie auf und bereite sie auf. Was ich herausfinde, gebe ich dir als Übersicht oder Mail-Entwurf; ins CRM überträgst du es dann selbst.

Wenn du Salesforce oder Dynamics einsetzt, gib dem AVA-Team kurz Bescheid. Dann kommst du zuerst in die Testphase.

### Telegram, E-Mail oder Weitere Dienste fehlen in den Einstellungen
`verbindung-abschnitt-fehlt` · gilt für: [desktop] · Knöpfe: keine

> Fragen: ich sehe telegram nicht in den einstellungen · wo ist weitere dienste · das postfach für ava fehlt bei e-mail · mail-triage fehlt im menü · warum kann ich keinen dienst verbinden

Fehlt unter Einstellungen → Verbindungen ein Abschnitt wie „Weitere Dienste“, „Telegram“, „LinkedIn“ oder bei „E-Mail“ das „Postfach für AVA“, hat deine Organisation diese Funktion abgeschaltet. Abgeschaltetes blendet AVA ganz aus, auch im Menü und im Chat. Ohne Mail-Anbindung fehlen zum Beispiel auch „Mail-Triage“ unter Meldungen und die wiederkehrenden Mail-Aufgaben.

Freischalten kann das nur ein Admin deiner Organisation in der AVA Konsole unter admin.ava.bi → Funktionen & Vorgaben. Die AVAs der Mitglieder übernehmen eine Änderung spätestens nach zehn Minuten.

Die Entwürfe bei „E-Mail“ bleiben übrigens immer da, auch ohne eigenes Postfach für AVA.

### Eine Verbindung wieder trennen (CRM, Dienst, Notizen, Telegram, Apps)
`verbindung-trennen` · gilt für: [desktop] · Knöpfe: Verbindungen öffnen (öffnet Seite)

> Fragen: trenn hubspot · compleadly wieder entfernen · notion verbindung löschen · claude den zugriff auf ava entziehen · disconnect telegram

HubSpot, Close, Notion, Obsidian und Telegram trenne ich auf deinen Wunsch selbst, sag einfach „Trenn HubSpot“. In den Einstellungen geht es so:

- CRM: Verbindungen → CRM, an der Karte „Verbindung trennen“. Die Verknüpfungen zwischen AVA-Firmen und CRM-Einträgen bleiben erhalten.
- Weitere Dienste: an der Karte „Entfernen“. Die Funktionen des Dienstes verschwinden sofort.
- Notion und Obsidian: Verbindungen → Notizen, „Trennen“.
- Telegram: Verbindungen → Telegram, „Trennen“. Der Zugangscode des Bots wird gelöscht.
- Claude, ChatGPT und andere Apps: Konto → Verbundene Apps, „Trennen“.

Die bei mir gespeicherten Zugangsdaten werden beim Trennen gelöscht. Beim Anbieter selbst, etwa den Zugangscode in CompLeadly oder die Integration in Notion, löschst du sie dort.

### Was kann ich alles mit AVA verbinden?
`verbindungen-ueberblick` · gilt für: [desktop] · Knöpfe: Verbindungen öffnen (öffnet Seite), Verbundene Apps öffnen (öffnet Seite)

> Fragen: was kann ich alles mit ava verbinden · welche integrationen gibt es · mit welchen programmen arbeitest du zusammen · kannst du dich mit meinen anderen apps verbinden · which tools can you connect to

Unter Einstellungen → Verbindungen hängst du alles an, womit ich für dich arbeiten soll:

- CRM: HubSpot mit Anmeldung im Browser, Close mit deinem Schlüssel aus Close. Salesforce und Microsoft Dynamics sind noch nicht freigeschaltet.
- LinkedIn, damit ich Signale aus deinem Feed erkenne.
- E-Mail: ein eigenes Postfach für mich und Entwürfe, die du selbst verschickst.
- Telegram, damit du mich unterwegs erreichst.
- Notizen: Notion und Obsidian.
- Weitere Dienste: zum Beispiel CompLeadly oder Close mit allen Funktionen, dazu fremde Agenten.

Umgekehrt kannst du mich aus Claude, ChatGPT oder Microsoft Copilot heraus nutzen, wenn deine Organisation das freigeschaltet hat. Das findest du unter Konto → Verbundene Apps.

Sag mir einfach, was du verbinden willst. Für Weitere Dienste zeige ich dir eine sichere Eingabekarte im Chat, für alles andere öffne ich dir die richtige Stelle. Zugangsdaten schickst du nie als normale Nachricht. Fehlt ein Abschnitt, hat deine Organisation ihn abgeschaltet.

## mail (10 Karten)

### Wie oft AVA das Postfach abruft und wie viel Verlauf sie liest
`mail-abruf-und-verlauf` · gilt für: alle Kanäle · Knöpfe: Einstellungen zeigen (Chat-Vorschlag)

> Fragen: wie oft rufst du meine mails ab · abrufintervall ändern · berücksichtige mehr vom mail verlauf · mails kommen bei ava verspätet an · mail kontext erhöhen

Neue Mails kommen in der Regel sofort bei mir an, weil das Postfach mich direkt benachrichtigt. Zusätzlich frage ich es in festen Abständen ab, standardmäßig alle 15 Minuten. Das zählt nur, wenn dein Anbieter keine sofortige Benachrichtigung kann. Der Abstand lässt sich zwischen 1 und 120 Minuten wählen.

Beim Bearbeiten einer Mail lese ich standardmäßig die zehn vorherigen Nachrichten im selben Gesprächsfaden mit, je bis zu 1.200 Zeichen. Möglich sind 0 bis 50 Nachrichten. Mehr Verlauf heißt besseres Verständnis, kostet aber mehr bei deinem KI-Anbieter.

Beides stelle ich im Chat für dich um, sag mir einfach die Werte. In den Einstellungen gibt es dafür keinen eigenen Regler. Ich zeige dir auch, wann zuletzt abgerufen wurde und ob es einen Fehler gab.

### AVA soll auf Mails bestimmter Absender selbst antworten
`mail-auto-antwort` · gilt für: [desktop] · Knöpfe: Mail-Einstellungen öffnen (öffnet Seite)

> Fragen: antworte automatisch auf mails von meinem kunden · vertrauenswürdige absender hinzufügen · wie schalte ich die auto antwort ein · nur mails von firma x sollst du beantworten · mail allowlist pflegen

Selbstständig antworte ich nur Absendern, denen du vertraust. Dafür braucht es drei Dinge unter Einstellungen → Verbindungen → E-Mail:

1. „AVA darf Mails verschicken“ ist an.
2. „Vertrauenswürdigen Absendern automatisch antworten“ ist an.
3. Der Absender steht bei „Vertrauenswürdige Absender“, als einzelne Adresse wie max@kunde.de oder als ganze Firma mit *@kunde.de. Ich nehme Absender auch selbst auf, wenn du es mir sagst, oder du klickst im Posteingang auf „Absender als trusted“.

Alle anderen Mails bleiben bei dir, ich sortiere sie nur vor. Je Gesprächsfaden antworte ich höchstens fünfmal, mit mindestens fünf Minuten Pause dazwischen. Ob die automatische Antwort gerade läuft, zeigt der Posteingang oben: „Auto-Antwort aktiv“ oder „Auto-Antwort aus“.

### Einen Mail-Entwurf von AVA im eigenen Mail-Programm öffnen
`mail-entwurf-oeffnen` · gilt für: [desktop, app] · Knöpfe: Öffnen-Weg einstellen (öffnet Seite), Entwurf schreiben (Chat-Vorschlag)

> Fragen: schreib mir eine mail die ich selbst verschicke · öffne den entwurf in outlook · wie bekomme ich die mail in mein mailprogramm · entwurf in gmail öffnen · der knopf unter dem mail entwurf geht nicht

Schreibe ich eine Mail, die du selbst verschickst, steht sie im Chat als „E-Mail-Entwurf“ mit Empfänger, Betreff und Text. Darunter öffnet ein Knopf sie fertig in deinem Mail-Programm. Mit „Kopieren“ nimmst du den Text mit, „Anders öffnen“ bietet die übrigen Wege.

Wohin der Knopf führt, stellst du unter Einstellungen → Verbindungen → E-Mail → Entwürfe bei „Öffnen in“ ein, oder ich stelle es für dich um. „Automatisch (empfohlen)“ heißt: Outlook bekommt einen fertigen Entwurf mit Anhängen, andere Mail-Programme öffnen die Mail ohne Anhänge, ohne Mail-Programm geht es zu Gmail oder Outlook im Web. Fest wählen kannst du auch Gmail, Outlook im Web, Outlook.com oder den Outlook-Entwurf als Datei.

Öffnet sich die Mail nur zum Lesen, wähle dort „Erneut senden“ oder „Als neu bearbeiten“. Kenne ich die Adresse nicht, sage ich es dir vorher.

### Entwürfe direkt in den Entwürfe-Ordner meines Postfachs legen
`mail-entwurfs-postfach` · gilt für: [desktop] · Knöpfe: Entwurfs-Postfach einrichten (öffnet Seite), Entwürfe einstellen (öffnet Seite)

> Fragen: leg mir die mails in die entwürfe · entwürfe ordner per imap einrichten · der entwurf soll auf dem handy auftauchen · schreib mir zehn entwürfe auf einmal · entwurfs-postfach einrichten

Auf Wunsch lege ich Entwürfe mit Anhängen direkt in den Entwürfe-Ordner deines eigenen Postfachs. Dort findest du sie in jedem Mail-Programm, im Webmail und auf dem Handy. Das lohnt sich vor allem, wenn ich mehrere Entwürfe auf einmal schreibe. Ich schreibe nur in diesen Ordner und lese keine Mails.

Einrichten: Einstellungen → Verbindungen → E-Mail → Entwürfe, Abschnitt „Entwurfs-Postfach“. Wähle deinen Anbieter, etwa IONOS, STRATO, GMX, WEB.DE, Telekom, Gmail, iCloud oder einen anderen mit IMAP, trag Adresse und Passwort ein und klick „Verbinden und speichern“. Bei Gmail und iCloud brauchst du ein App-Passwort, bei GMX und WEB.DE musst du dort den IMAP-Abruf erlauben.

Microsoft 365 und Outlook.com gehen hier nicht per Passwort. Nimm dort beim Öffnen „Outlook-Entwurf (.eml)“, das bringt die Anhänge auch mit.

### Feste Anhänge wie Firmenprofil oder Preisliste für Mails hinterlegen
`mail-feste-anhaenge` · gilt für: [desktop] · Knöpfe: Anhänge hinterlegen (öffnet Seite)

> Fragen: häng das firmenprofil immer an die mail · feste anhänge hinterlegen · referenzliste automatisch mitschicken · preisliste bei outreach anhängen · warum fehlt der anhang im entwurf

Dateien, die du immer wieder mitschickst, hinterlegst du einmal: Einstellungen → Verbindungen → E-Mail → Entwürfe, Abschnitt „Feste Anhänge“, Knopf „Datei hinzufügen“. Bis zu zehn Dateien, je höchstens 10 MB. Eine Datei mit gleichem Namen ersetzt die alte Fassung.

Schreib zu jeder Datei kurz, wofür sie ist, etwa „Firmenprofil für Erstkontakt“. Dann hänge ich sie passend an meine Entwürfe. Setzt du den Haken „An jede Outreach-Mail“, kommt sie immer mit.

Anhänge reisen nicht auf jedem Weg mit: Outlook, das Entwurfs-Postfach und der Outlook-Entwurf als Datei nehmen sie mit, einfache Mail-Programme und Webmail nicht. Dann bietet dir der Entwurf an, die Anhänge im Ordner zu zeigen oder die Mail mit Anhängen als Datei zu öffnen.

### Den Posteingang von AVA ansehen (Mail-Triage)
`mail-posteingang` · gilt für: [desktop] · Knöpfe: Posteingang öffnen (öffnet Seite), Ungelesene Mails zeigen (Chat-Vorschlag)

> Fragen: wo sehe ich die mails von ava · mail triage öffnen · welche mails sind neu gekommen · posteingang anzeigen · zeig mir die ungelesenen mails

Den Posteingang meines Postfachs findest du im Menü unter Meldungen → Mail-Triage. Oben stehen Adresse, Verbindungszustand und ob die automatische Antwort an ist. Filter: Ungelesen, Alle, Trusted, Bekannt, Unbekannt und Archiviert.

Zu jeder Mail siehst du meine Einstufung und eine kurze Zusammenfassung. Mit „Im Chat öffnen“ holst du die Mail in den Chat, und wir bearbeiten sie zusammen. Außerdem kannst du den Absender als vertrauenswürdig aufnehmen („Absender als trusted“) oder die Mail archivieren.

Du musst aber nicht hineinschauen: Frag einfach „Was ist heute an Mails gekommen?“, dann fasse ich es dir zusammen.

### Ein eigenes E-Mail-Postfach für AVA einrichten
`mail-postfach-einrichten` · gilt für: [desktop] · Knöpfe: Postfach einrichten (öffnet Seite)

> Fragen: mail konto mit ava verbinden · wie richte ich das postfach für ava ein · imap einrichten · ava soll mails lesen und beantworten · email account hinzufügen

Ich arbeite mit einem eigenen Postfach, am besten einer eigenen Adresse wie ava@deinefirma.de. Darin lese ich eingehende Mails, sortiere sie vor und antworte auf Wunsch.

Einrichten: Einstellungen → Verbindungen → E-Mail, Abschnitt „Postfach für AVA“. Trag Mail-Adresse und Anzeigename ein, dazu Server und Port für den Posteingang (IMAP, meist 993) und den Postausgang (SMTP, meist 465) und das Passwort. Bei Gmail und iCloud brauchst du ein App-Passwort. Mit „Verbindung testen“ prüfst du alles, bevor du speicherst. Das Passwort liegt verschlüsselt auf diesem Rechner.

Zwei Schalter sind am Anfang aus: „AVA darf Mails verschicken“ und „Vertrauenswürdigen Absendern automatisch antworten“. Ohne den ersten verschicke ich gar nichts.

Microsoft 365 und Outlook.com erlauben keine Anmeldung per Passwort mehr, damit geht es leider nicht.

### AVA hat auf eine Mail nicht reagiert
`mail-reagiert-nicht` · gilt für: alle Kanäle · Knöpfe: Ursache prüfen (Chat-Vorschlag)

> Fragen: warum hast du auf die mail nicht geantwortet · ava reagiert nicht auf meine mails · die mail vom kunden wurde ignoriert · es kam keine automatische antwort · auto reply funktioniert nicht

Sag mir, um welche Mail es geht, dann sehe ich nach, warum ich sie nicht bearbeitet habe. Die häufigsten Gründe:

- Die automatische Antwort oder „AVA darf Mails verschicken“ ist aus.
- Der Absender steht nicht bei den vertrauenswürdigen Absendern, die Prüfung des Absenders (SPF oder DKIM) ist fehlgeschlagen, oder von der Adresse kamen mehr als 20 Mails in einer Stunde.
- Die Mail wurde als Spam eingestuft oder als Versuch, mir Anweisungen unterzuschieben.
- Im Betreff stehen sehr viele Re: oder AW:, das sieht nach Ping-Pong aus.
- Im Gesprächsfaden habe ich schon fünfmal geantwortet. Dann hilft ein neuer Faden.
- Die Mail ist archiviert oder kam an, während die Verbindung getrennt war.

Je nach Grund nehme ich den Absender auf oder sage dir, was du umstellen musst.

### Mails über AVA beantworten, weiterleiten oder verschicken
`mail-senden-antworten` · gilt für: alle Kanäle · Knöpfe: Neueste Mails zeigen (Chat-Vorschlag)

> Fragen: antworte auf die mail von herrn müller · leite die mail an meine kollegin weiter · schick die datei per mail · verschick eine mail an den kunden · mail mit anhang weiterleiten

Aus meinem Postfach kann ich für dich Mails lesen, beantworten, weiterleiten, neue Mails schreiben, als gelesen markieren und archivieren. Dateien, die du in den Chat ziehst, hänge ich auf Wunsch an. Beim Weiterleiten kann ich auch die Anhänge der Originalmail mitschicken.

Versendet wird von meiner Adresse, nicht von deiner. Dafür muss „AVA darf Mails verschicken“ an sein. Stehen alle Empfänger bei den vertrauenswürdigen Absendern, sende ich direkt; sonst zeige ich dir die Mail vorher, und du bestätigst mit „Senden“.

Soll die Mail von deiner eigenen Adresse kommen, schreibe ich dir einen Entwurf, den du mit einem Klick in deinem Mail-Programm öffnest.

### Eine Mail regelmäßig automatisch verschicken lassen
`mail-wiederkehrend` · gilt für: alle Kanäle · Knöpfe: Geplante Mails zeigen (Chat-Vorschlag), Wiederkehrende öffnen (öffnet Seite)

> Fragen: schick jeden morgen eine statusmail an mein team · wiederkehrende mail einrichten · jede stunde eine mail an · stopp die mail schleife · welche mails hast du geplant

Ich kann eine Mail in festen Abständen verschicken, zum Beispiel einen Status an dein Team. Sag mir Empfänger, Betreff, Text und Abstand, ich zeige dir alles, und du bestätigst. Dabei gilt:

- Die Empfänger müssen bei den vertrauenswürdigen Absendern deines Postfachs stehen, und „AVA darf Mails verschicken“ muss an sein.
- Frühestens jede Minute, höchstens sieben Tage lang. Ohne Angabe endet die Aufgabe nach 24 Stunden.
- Höchstens zehn solcher Aufgaben gleichzeitig.

Sag „stopp“, dann beende ich sie sofort. In den Einstellungen findest du alle unter Erweitert → Wiederkehrende Aufgaben, dort kannst du sie auch pausieren oder selbst anlegen.

Für Abläufe mit Firmendaten, etwa ein Kurzprofil jeden Montag, sind Workflows besser geeignet.

## telegram (14 Karten)

### Der Telegram-Bot antwortet nicht oder schickt nichts
`telegram-antwortet-nicht` · gilt für: alle Kanäle · Knöpfe: Telegram prüfen (öffnet Seite)

> Fragen: der telegram bot reagiert nicht · die testnachricht kommt nicht an · bei telegram steht chat fehlt noch · ich bekomme keine meldungen auf telegram · telegram geht nicht

Geh die Punkte unter Einstellungen → Verbindungen → Telegram durch:

- Steht dort „Chat fehlt noch“, schick dem Bot „/start“ und klick „Chat verknüpfen“.
- Für Antworten muss „Auf meine Nachrichten antworten (Gegenrichtung)“ an sein, für Meldungen „Meldungen an Telegram senden“.
- Kommt die Testnachricht nicht an, steht dort der letzte Fehler, und wann zuletzt etwas zugestellt oder wegen Ruhezeit zurückgehalten wurde.
- Deine AVA muss laufen. Ist der Rechner aus, beantworte ich deine Nachrichten, sobald er wieder an ist.
- Hängt derselbe Bot an einer zweiten AVA, etwa auf einem Server, holt diese die Nachrichten ab. Dann braucht jede AVA einen eigenen Bot.

Ich schreibe nur in den verknüpften Chat. Nachrichten aus einem anderen Konto oder einer Gruppe verwerfe ich.

### Befehle im Telegram-Chat mit AVA
`telegram-befehle` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: welche befehle gibt es im telegram bot · was macht /start · neuen faden anfangen auf telegram · telegram commands · wie fange ich auf telegram von vorne an

Im Telegram-Chat mit mir gibt es ein paar feste Befehle:

- /start: prüft, ob ich verbunden bin. Beim Einrichten brauchst du ihn, damit ich den Chat verknüpfen kann.
- /neu oder /reset: fängt einen neuen Gesprächsfaden an. Den bisherigen Verlauf dieses Gesprächs nehme ich dann nicht mehr mit.
- /freigaben: zeigt die offenen Freigaben deiner Workflows.
- /ja oder /nein mit der Kennung aus dieser Liste: gibt frei oder lehnt ab.
- abbrechen: bricht eine offene Rückfrage ab.

Alles andere schreibst oder sprichst du ganz normal, wie im Chat der App. Ohne eingeschaltete Gegenrichtung reagiere ich in Telegram auf nichts davon.

### AVA auf Telegram Bilder oder Fotos schicken
`telegram-bilder` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: kann ich dir ein foto von einer visitenkarte schicken · bild per telegram an ava · screenshot über telegram auswerten lassen · foto vom messestand schicken · du reagierst nicht auf mein bild

Schick mir Fotos einfach in den Telegram-Chat, zum Beispiel eine Visitenkarte, ein Messeschild oder einen Screenshot. Schreib am besten gleich dazu, was ich damit tun soll, als Bildunterschrift oder als Text oder Sprachnachricht danach.

Ohne Erklärung warte ich bis zu fünf Minuten auf deine nächste Nachricht und schaue mir die Bilder dann allein an. Mehrere Bilder hintereinander sammle ich und werte sie zusammen mit deiner Erklärung aus.

Das klappt nur, wenn dein KI-Modell Bilder versteht. Einige günstige Modelle können das nicht; dann wechselst du in der Desktop-App unter Einstellungen → KI & Kosten das Modell. Voraussetzung ist außerdem die eingeschaltete Gegenrichtung bei Telegram.

### Mit AVA über Telegram chatten
`telegram-chatten` · gilt für: alle Kanäle · Knöpfe: Gegenrichtung einschalten (öffnet Seite)

> Fragen: kann ich dir auf telegram fragen stellen · gegenrichtung bei telegram einschalten · mit ava unterwegs chatten · telegram als chat mit ava nutzen · du antwortest nicht auf meine telegram nachricht

Schalte unter Einstellungen → Verbindungen → Telegram „Auf meine Nachrichten antworten (Gegenrichtung)“ ein. Dann kannst du mir in Telegram schreiben wie im Chat der App: Firmen nachschlagen, Meldungen abfragen, Notizen festhalten, Aufgaben anstoßen. Ich antworte kurz und ohne Formatierung, so liest es sich auf dem Handy gut.

Ein Gespräch läuft weiter, bis sechs Stunden Ruhe war oder es sehr lang wird. Mit /neu fängst du selbst einen neuen Faden an. Schickst du mehrere Nachrichten schnell hintereinander oder kamen sie, während ich offline war, arbeite ich sie der Reihe nach ab.

Ich antworte nur, solange deine AVA läuft, auf diesem Rechner oder auf deinem Server. Aktionen, die eine Bestätigung brauchen, gehen nur, wenn du zusätzlich „Rückfragen aufs Handy erlauben“ einschaltest.

### Telegram mit AVA verbinden
`telegram-einrichten` · gilt für: [desktop] · Knöpfe: Telegram verbinden (öffnet Seite)

> Fragen: wie richte ich telegram ein · kann ich ava aufs handy bekommen · telegram bot verbinden · wo trage ich den botfather token ein · telegarm einrichten

Für Telegram legst du einen eigenen Bot an, über den wir schreiben. Das dauert zwei Minuten:

1. Öffne in Telegram den Chat mit @BotFather und schick /newbot. Vergib einen Namen, BotFather antwortet mit einem Zugangscode.
2. Trag ihn unter Einstellungen → Verbindungen → Telegram ein und klick „Verbinden“. Bitte nicht in den Chat, dort ist er nicht geschützt.
3. Schick deinem neuen Bot in Telegram „/start“ und klick in AVA auf „Chat verknüpfen“. Die Chat-ID lese ich selbst aus.
4. Mit „Testnachricht senden“ prüfst du, ob alles ankommt.

Danach entscheidest du: „Meldungen an Telegram senden“ schickt dir meine Meldungen aufs Handy, „Auf meine Nachrichten antworten (Gegenrichtung)“ macht Telegram zu einem Chat mit mir. Beides ist am Anfang aus. Ich antworte nur im verknüpften Chat, Nachrichten aus anderen Chats verwerfe ich.

### Workflow-Freigaben über Telegram erteilen
`telegram-freigaben` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: workflow freigabe auf dem handy erteilen · der workflow wartet auf freigabe · per telegram freigeben · wie lehne ich eine freigabe ab · offene freigaben anzeigen

Wartet ein Workflow auf deine Freigabe, kannst du sie auch in Telegram erteilen. Schick /freigaben, dann zeige ich dir bis zu zehn offene Freigaben mit Workflow, Schritt und Frage. Darunter steht jeweils, was du antwortest:

- /ja gefolgt von der Kennung gibt frei, der Workflow läuft weiter.
- /nein mit der Kennung lehnt ab, der Lauf wird abgebrochen.

Hinter die Kennung kannst du noch eine kurze Begründung schreiben.

Telegram muss dafür verbunden und die Gegenrichtung eingeschaltet sein. Dieselben Freigaben findest du auch in der App bei den Workflows.

### Firmen-Kurzprofile automatisch per Telegram bekommen
`telegram-kurzprofile` · gilt für: alle Kanäle · Knöpfe: Workflow einrichten (Chat-Vorschlag)

> Fragen: schick mir kurzprofile neuer radar treffer aufs handy · kurzprofil einer firma per telegram · heiße radar kandidaten auf telegram · schick mir das auf telegram · firmenzusammenfassung aufs handy

Dafür gibt es fertige Workflow-Vorlagen:

- „Neuer heißer Radar-Treffer: Kurzprofil per Telegram“: Sobald das Firmen-Radar einen neuen heißen Kandidaten meldet, kommt sofort ein Kurzprofil aufs Handy.
- „Firmen-Kurzprofil per Telegram“: schickt eine Kurzübersicht einer Firma, auch als Teil größerer Abläufe, etwa nachdem Radar-Treffer aufgenommen und aufbereitet sind.

Sag mir, welche du willst, dann lege ich sie für dich an. Du kannst mich auch jederzeit direkt bitten: „Schick mir das Kurzprofil der Müller GmbH auf Telegram.“

Telegram muss verbunden und der Chat verknüpft sein. Workflows gibt es, wenn deine Organisation sie freigeschaltet hat.

### Telegram mit mehreren AVAs nutzen (Rechner und Server)
`telegram-mehrere-avas` · gilt für: alle Kanäle · Knöpfe: AVAs prüfen (Chat-Vorschlag), Deine AVAs öffnen (öffnet Seite)

> Fragen: telegram auf laptop und server · seit dem server antwortet telegram nicht mehr · zwei avas mit einem bot · wird von einer anderen stelle abgeholt · welcher rechner beantwortet telegram

Telegram erlaubt je Bot nur eine Stelle, die die Nachrichten abholt. Läuft AVA bei dir auf dem Rechner und auf einem Server, braucht jede AVA ihren eigenen Bot. Hängt derselbe Bot an zwei AVAs, kommen deine Nachrichten nur bei einer an.

Unter Einstellungen → Konto → Deine AVAs siehst du je Gerät, welcher Bot dort hängt. Steht dort „auch an einer anderen Instanz, eigenen Bot anlegen“ oder „wird von einer anderen Stelle abgeholt“, leg bei @BotFather einen zweiten Bot an und verbinde ihn mit einer der beiden AVAs.

Beim Umzug zwischen Rechner und Server bleibt der Telegram-Bot je Gerät, wie er ist. Ich kann dir auch sagen, welche deiner AVAs gerade Telegram übernimmt.

### Welche Meldungen AVA auf Telegram schickt
`telegram-meldungen` · gilt für: alle Kanäle · Knöpfe: Meldungen einschalten (Chat-Vorschlag), Telegram einstellen (öffnet Seite)

> Fragen: schick mir meldungen per telegram · nur dringende meldungen aufs handy · telegram soll nachts still sein · zu viele telegram nachrichten · keine telegram meldungen mehr

Mit „Meldungen an Telegram senden“ kommen meine Meldungen zusätzlich aufs Handy, auch wenn die Desktop-Benachrichtigungen aus sind. Bei „Ab welcher Wichtigkeit?“ wählst du „Alle“, „Ab wichtig“ (Standard) oder „Nur dringend“.

„Ruhezeiten auch für Telegram beachten“ ist standardmäßig an, dann halte ich in deinen Ruhezeiten zurück. Dringende Meldungen wie Insolvenz oder Löschung gehen immer raus, auch nachts. Kommen viele Meldungen auf einmal, bündle ich sie zu einer Sammelnachricht.

Ein- und ausschalten kann ich das auch selbst, sag einfach „Schick mir Meldungen per Telegram“ oder „Keine Telegram-Meldungen mehr“. Welche Meldungen es überhaupt gibt, stellst du unter Einstellungen → Meldungen ein. Gesendet wird direkt aus deiner AVA, sie muss also laufen; ist das Netz kurz weg, schicke ich später nach.

### Aktionen mit Bestätigung auch über Telegram erledigen
`telegram-rueckfragen` · gilt für: alle Kanäle · Knöpfe: Rückfragen erlauben (öffnet Seite)

> Fragen: auf telegram sagst du das muss am rechner erledigt werden · kann ich per telegram bestätigen · rückfragen aufs handy erlauben · warum kannst du das über telegram nicht machen · auswahl per nummer in telegram

Standardmäßig führe ich über Telegram nichts aus, was eine Bestätigung braucht, etwa eine Änderung im CRM oder eine Aktion in einem verbundenen Dienst. Dann sage ich dir, dass es am Rechner erledigt werden muss. Das schützt dich vor Nachrichten, die mir etwas unterschieben wollen.

Willst du es trotzdem vom Handy aus: Schalte unter Einstellungen → Verbindungen → Telegram „Rückfragen aufs Handy erlauben“ ein. Dann stelle ich die Rückfrage direkt im Telegram-Chat. Du antwortest mit der Nummer der Option oder mit Text, „abbrechen“ bricht ab. Kommt innerhalb von drei Minuten keine Antwort, breche ich die Aktion ab.

Wie viel ich ganz ohne Rückfrage erledigen darf, steuert der Modus-Schalter am Chat-Eingabefeld der App. Er gilt auch für Telegram.

### AVAs Antworten auf Telegram als Sprachnachricht bekommen
`telegram-sprachantwort` · gilt für: alle Kanäle · Knöpfe: Sprachantwort einstellen (Chat-Vorschlag)

> Fragen: antworte mir per sprachnachricht · lies mir das auf telegram vor · antworte immer als sprachnachricht · bitte wieder als text antworten · kannst du mit stimme antworten

Ich kann dir auf Telegram auch mit meiner Stimme antworten. Sag es einfach in deiner Nachricht:

- „gerne per Sprachnachricht“ gilt für die nächste Antwort,
- „gerne immer per Sprachnachricht“ stellt den Standard um,
- „gerne per Textnachricht“ oder „gerne immer per Textnachricht“ geht zurück zu Text.

Freier gesagt verstehe ich es meist auch, etwa „ich kann gerade nicht lesen“. Den Standard findest du außerdem unter Einstellungen → Verbindungen → Telegram: „Standardmäßig als Sprachnachricht antworten“.

Die Stimme kommt von OpenAI und braucht einen OpenAI-Zugang, deinen eigenen Schlüssel oder den deiner Organisation. Die Kosten rechnet OpenAI über diesen Zugang ab. Ohne Zugang antworte ich als Text und sage dir, warum. Gesprochene Antworten halte ich kurz.

### AVA auf Telegram Sprachnachrichten schicken
`telegram-sprachnachrichten` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: kann ich dir sprachnachrichten schicken · über telegram diktieren · verstehst du voice messages · meine sprachnachricht wird nicht verstanden · spracherkennung nicht bereit telegram

Ja, schick mir einfach eine Sprachnachricht. Ich schreibe sie mit der lokalen Spracherkennung in deiner AVA ab, ohne Umweg über einen Cloud-Dienst. Bevor ich handle, schicke ich dir zurück, was ich verstanden habe („Verstanden: …“). So siehst du sofort, wenn ich einen Namen oder eine Zahl falsch gehört habe.

Schreibe ich, dass die Spracherkennung nicht bereit ist, richte sie in der Desktop-App unter Einstellungen → KI & Kosten → Spracherkennung ein. Am Rechner kann ich das Sprachmodell auch selbst für dich installieren.

Voraussetzung ist, dass bei Telegram die Gegenrichtung eingeschaltet ist. Du kannst Sprachnachrichten auch mit Fotos kombinieren: erst die Bilder, dann die Erklärung als Sprachnachricht.

### Was über Telegram nicht geht (Einstellungen, Zugangsdaten)
`telegram-was-geht-nicht` · gilt für: [telegram] · Knöpfe: keine

> Fragen: kannst du hier die einstellungen öffnen · ich schick dir meinen api key per telegram · verbinde compleadly über telegram · richte mir hier hubspot ein · öffne mir die firmenseite

Hier in Telegram kann ich keine Seiten der App öffnen. Was du auf einer Seite einstellst, und vor allem Zugangsdaten erledigst du in der Desktop-App: Schlüssel für KI-Anbieter, den Zugangscode für CompLeadly oder Close, Postfach-Passwörter, die Anmeldung bei HubSpot oder LinkedIn. Schick mir solche Daten bitte nie in einen Chat, auch nicht hier.

Ich sage dir dann, wo du es in der App findest, zum Beispiel Einstellungen → Verbindungen → Weitere Dienste. Vieles andere stelle ich dir hier direkt um, etwa Meldungen an oder aus.

Aktionen mit Bestätigung gehen hier nur, wenn du in der App „Rückfragen aufs Handy erlauben“ eingeschaltet hast. Mail-Entwürfe mit Knopf zum Öffnen gibt es nur in der App.

### AVA über WhatsApp, Slack, Teams oder Signal erreichen
`whatsapp-und-andere-messenger` · gilt für: alle Kanäle · Knöpfe: Telegram verbinden (öffnet Seite)

> Fragen: geht ava auch über whatsapp · kannst du mir bei whatsapp nachrichten schicken · gibt es ava in slack · ava in microsoft teams einbinden · signal statt telegram

Über WhatsApp, Slack, Microsoft Teams oder Signal kann ich dir heute nicht schreiben, und du erreichst mich dort auch nicht. Diese Verbindungen gibt es in AVA nicht.

Unterwegs geht das hier:

- Telegram: Du chattest mit mir wie hier, schickst Sprachnachrichten und Bilder und bekommst Meldungen aufs Handy. Einrichten dauert ein paar Minuten unter Einstellungen → Verbindungen → Telegram.
- Die AVA-App unter app.ava.bi im Browser oder als App auf dem Home-Bildschirm, mit Chat und Mitteilungen.

Wenn dir WhatsApp oder Teams wichtig ist, sag es mir; ich nehme den Wunsch gern als Rückmeldung über „Problem melden“ auf.
