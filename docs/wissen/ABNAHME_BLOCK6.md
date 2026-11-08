# Abnahme Block 6: KI, Chat

Stand 2026-11-07. Je Karte: Titel, Beispielfragen, Knöpfe (erscheinen unter AVAs Antwort), Text so, wie AVA ihn liest.
Rückmeldung am einfachsten im Chat: „ok“ für den ganzen Ast oder je Karte die id mit dem, was falsch ist.

## ki (20 Karten)

**Zuerst ansehen:**

### Mit AVA sprechen statt tippen (Sprachmodus)
`ki-sprachmodus` · gilt für: [desktop] · Knöpfe: Sprachmodus einschalten (Chat-Vorschlag), OpenAI-Schlüssel eintragen (öffnet Seite), Sprachmodus öffnen (öffnet Seite)

> Fragen: kann ich mit ava sprechen · sprachmodus einschalten · mit ava telefonieren reden · voice mode · was kostet der sprachmodus

Im Sprachmodus redest du mit mir, ich antworte mit Stimme und kann dabei alles, was ich im Chat kann. Diagramme und Buying-Center-Karten erscheinen unter der Sprachkugel. Falls deine Organisation den Sprachmodus freigeschaltet hat, schalte ich ihn dir ein, du bestätigst kurz.

Voraussetzung ist ein OpenAI-Schlüssel, dein eigener oder der deiner Organisation. Das ChatGPT-Abo reicht dafür nicht, und mit Azure OpenAI geht der Sprachmodus nicht. Selbst einschalten: Einstellungen → KI & Kosten → Mit AVA sprechen → „Sprachmodus aktivieren“.

Danach erscheint im Chat neben dem Mikrofon ein Wellen-Knopf „Mit AVA sprechen“. Tippe auf die Kugel oder drück die Leertaste, um mich zu aktivieren. Nach einer Weile Stille gehe ich in den Ruhezustand. Kosten: Gesprächsminuten kosten laut App mehr als Chat, grob 0,20 bis 0,40 Euro je Minute, und gehen über deinen OpenAI-Zugang.

### Eine Tages-Obergrenze für den KI-Verbrauch setzen
`ki-tageslimit` · gilt für: [desktop] · Knöpfe: Obergrenze setzen (Chat-Vorschlag), Verbrauch öffnen (öffnet Seite), Tageslimit öffnen (öffnet Seite)

> Fragen: token limit pro tag setzen · kann ich den verbrauch begrenzen · tägliches token-limit aufgebraucht · limit entfernen · max 200000 tokens am tag

Du kannst festlegen, wie viel KI ich pro Tag höchstens verbrauche. Gezählt wird in Textbausteinen, so wie die Anbieter abrechnen. Sag mir einfach eine Zahl, etwa „höchstens 200.000 am Tag“, dann setze ich die Grenze. „Limit entfernen“ hebt sie wieder auf. Standard ist: keine Grenze.

Selbst geht es unter Einstellungen → KI & Kosten → Verbrauch → Tages-Obergrenze. Dort siehst du auch, wie viel heute schon verbraucht ist.

Ist die Grenze erreicht, wird die laufende Anfrage noch fertig, danach pausiere ich neue Anfragen. Oben in der App erscheint dann ein Hinweis mit „Limit anpassen“. Es geht weiter, sobald du die Grenze erhöhst oder entfernst. Diese Grenze betrifft nur die KI-Nutzung über deinen Zugang. Dein Monatskontingent für Firmen ist etwas anderes und steht unter Konto → Plan & Abrechnung.

### Ein eigenes, günstiges Modell für die Hintergrund-Verarbeitung festlegen
`ki-hintergrund-modell` · gilt für: [desktop] · Knöpfe: Hintergrund-Modell wählen (öffnet Seite)

> Fragen: günstigeres modell für hintergrund · modell für hintergrund-verarbeitung · hinweis die hintergrund-verarbeitung läuft auf einem starken modell · kosten im hintergrund senken · anderes modell für radar als für chat

Du kannst im Chat ein starkes Modell behalten und für die Arbeit im Hintergrund ein günstigeres nehmen. Das stellst du unter Einstellungen → KI & Kosten → Anbieter & Modell im Feld „Modell für Hintergrund-Verarbeitung“ ein. Steht dort „Wie oben (Standard)“, nutze ich auch im Hintergrund dein Chat-Modell. Die Auswahl umfasst die Modelle des aktiven Anbieters.

Im Hintergrund arbeite ich zum Beispiel für das Radar, für Workflows und beim Suchen neuer Firmen. Dort geht es meist um Heraussuchen statt um komplexes Denken, ein schnelles, günstiges Modell reicht oft. Läuft der Hintergrund auf einem sehr starken oder teuren Modell, zeigt die App einen Hinweis mit „Modell wählen“, den du für dieses Modell ausblenden kannst.

Ausnahme: Für Firmen-Verflechtungen braucht das Hintergrund-Modell mindestens Stufe A und muss Bilder verstehen. Legt deine Organisation das Hintergrund-Modell fest, steht es in der Karte „Organisationsvorgabe“.

---

**Offen:**

### KI-Anbieter oder Modell wechseln
`ki-anbieter-wechseln` · gilt für: [desktop] · Knöpfe: Auf Claude umstellen (Chat-Vorschlag), Anbieter & Modell öffnen (öffnet Seite)

> Fragen: stell mich auf claude um · wechsel auf openai · nimm gemini als modell · wie ändere ich das modell · switch to gpt

Sag mir einfach, welches Modell du willst, zum Beispiel „nimm Claude“ oder „stell auf Gemini um“. Für OpenAI, Anthropic, Google, Mistral und das lokale Modell stelle ich das direkt für dich um, sofern der Schlüssel dafür schon hinterlegt ist. DeepSeek, xAI (Grok) und Qwen wählst du selbst in der Liste.

Selbst geht es unter Einstellungen → KI & Kosten → Anbieter & Modell: erst den Anbieter, dann das Modell. Anbieter ohne hinterlegten Schlüssel sind ausgegraut und tragen den Zusatz „kein Schlüssel“. Oben in der Karte siehst du immer, welches Modell aktiv ist, worüber abgerechnet wird und ob es bereit ist.

Läuft dein Chat über das ChatGPT-Abo, wählst du das Chat-Modell in der Karte „ChatGPT-Abo“ aus den Modellen, die dein Konto freigibt. Legt deine Organisation Anbieter und Modell fest, gibt es hier nichts zu wählen.

### OpenAI über die eigene Azure-OpenAI-Ressource nutzen
`ki-azure-openai` · gilt für: [desktop] · Knöpfe: OpenAI-Karte öffnen (öffnet Seite), Azure-Verbindung prüfen (Chat-Vorschlag)

> Fragen: azure openai einrichten · wir haben openai nur über azure · deployment namen eintragen · microsoft azure statt openai · azure endpunkt hinterlegen

Nutzt ihr OpenAI über eine eigene Azure-Ressource, geht das mit deinem OpenAI-Schlüssel als Azure-Schlüssel. Endpunkt und Zuordnung der Modelle kann ich dir eintragen, prüfen oder wieder ausschalten, du bestätigst vorher.

Selbst geht es unter Einstellungen → KI & Kosten → Anbieter & Modell → API-Schlüssel → OpenAI. Dort den Haken „Über Azure OpenAI (eigene Azure-Ressource)“ setzen, den Endpunkt eintragen (etwa https://firma.openai.azure.com) und unter „Modell → Name bei Azure“ angeben, wie die Modelle bei euch heißen. Ohne Eintrag nimmt AVA denselben Namen wie das Modell, „Alle übrigen Modelle“ fängt den Rest auf. Dann „Azure speichern“ und „Verbindung prüfen“. Den Azure-Schlüssel trägst du oben in der OpenAI-Karte ein.

Grenzen: Der Sprachmodus geht mit Azure nicht, er braucht einen Schlüssel direkt bei OpenAI. Websuche und Deep Research klappen nur, wenn eure Azure-Ressource die passenden Modelle anbietet.

### ChatGPT-Abo verbunden, aber ohne Plan-Freigabe oder Limit erreicht
`ki-chatgpt-abo-probleme` · gilt für: [desktop] · Knöpfe: ChatGPT-Abo öffnen (öffnet Seite), Anderes Modell wählen (öffnet Seite)

> Fragen: chatgpt abo ohne plan freigabe · nutzungslimit deines chatgpt abos erreicht · chatgpt team konto geht nicht · chatgpt verbindung abgelaufen · abo trennen

Steht in der Karte „ChatGPT-Abo“ der Hinweis „ohne Plan-Freigabe“, ist die Anmeldung gültig, aber ChatGPT erlaubt AVA nicht, dein Abo zu nutzen. Das passiert bei Team-, Business- und Free-Konten, denn nur Plus und Pro können ihr Abo teilen, oder wenn du die Freigabe im Anmeldefenster abgelehnt hast. Prüfe die Freigabe in ChatGPT unter Settings → Usage und klick danach erneut „Continue with ChatGPT“. Bis dahin nutze ich deinen Schlüssel oder den deiner Organisation.

Meldet der Chat „Nutzungslimit deines ChatGPT-Abos erreicht“, ist dein Kontingent für AVA aufgebraucht. Es setzt sich erst nach einem festen Zeitfenster zurück, die Restzeit siehst du in ChatGPT. Solange kannst du auf einen eigenen Schlüssel oder ein lokales Modell umstellen.

Ist die Verbindung abgelaufen, meldest du dich einfach neu an. Mit „Trennen“ beendest du sie, in ChatGPT kannst du AVA zusätzlich entfernen.

### ChatGPT-Abo mit AVA nutzen (Sign in with ChatGPT)
`ki-chatgpt-abo-verbinden` · gilt für: [desktop] · Knöpfe: ChatGPT-Abo verbinden (öffnet Seite), Abo-Stand zeigen (Chat-Vorschlag)

> Fragen: kann ich mein chatgpt abo nutzen · chatgpt plus verbinden · continue with chatgpt · ohne api key mit chatgpt pro · sign in with chatgpt

Mit einem persönlichen ChatGPT-Abo (Plus oder Pro) brauchst du keinen Schlüssel. Unter meiner Antwort findest du den Knopf zur Karte „ChatGPT-Abo“. Dort klickst du „Continue with ChatGPT“, liest den kurzen Hinweis und meldest dich im Fenster von OpenAI an.

Danach laufen Chat, Radar, Alarme, Recherche und Workflows über dein Abo, mit einem Modell deiner Wahl aus den Modellen, die dein Konto freigibt. Das Modell kann ich dir auch im Chat umstellen. Die Firmenverarbeitung läuft weiter über AVAs eigenes Modell.

Gut zu wissen: AVA verbraucht dein wöchentliches Kontingent, das du mit allen verbundenen Apps teilst. Setze deshalb in ChatGPT unter Settings → Usage ein Limit für AVA, zum Beispiel 30 Prozent. Sprachmodus und Deep Research laufen nicht über das Abo, dafür braucht es einen OpenAI-Schlüssel. Hat deine Organisation das Abo nicht freigegeben, siehst du die Karte nicht.

### Nachrichten diktieren statt tippen (Spracheingabe)
`ki-diktat` · gilt für: [desktop] · Knöpfe: Spracherkennung einrichten (Chat-Vorschlag), Spracherkennung öffnen (öffnet Seite)

> Fragen: kann ich diktieren · mikrofon im chat geht nicht · spracherkennung einrichten · sprachmodell herunterladen · whisper installieren

Mit dem Mikrofon-Knopf im Chat diktierst du deine Nachricht, sie erscheint als Text im Eingabefeld und du kannst sie vor dem Senden noch ändern. Beenden geht mit „Diktat beenden“ oder Cmd+D (Windows Ctrl+D), Esc bricht ab. Die Erkennung läuft lokal auf deinem Rechner, die Aufnahme verlässt das Gerät nicht.

Dafür braucht es einmal das lokale Sprachmodell, einige hundert MB. Ich kann es dir einrichten: Status prüfen, die Spracherkennung installieren und das Modell herunterladen. Selbst geht es unter Einstellungen → KI & Kosten → Spracherkennung → „Sprachmodell herunterladen“. Solange es fehlt, ist der Mikrofon-Knopf ausgegraut und führt dich per Klick dorthin.

Mit „Sprachmodell entfernen“ gibst du den Speicher wieder frei. Das lokale Modell braucht auch das Aktivierungswort „Hey AVA“ im Sprachmodus.

### Fehler beim Anbieter (Minutenlimit überschritten oder kein Guthaben)
`ki-limit-und-guthaben` · gilt für: [desktop] · Knöpfe: Anderes Modell wählen (öffnet Seite)

> Fragen: anfrage-limit pro minute überschritten · rate limit fehler · kein guthaben mehr auf dem api-konto · anthropic minutenlimit erreicht · error 429

„Anfrage-Limit pro Minute überschritten“ heißt: Dein Konto beim Anbieter erlaubt nur eine bestimmte Menge pro Minute, und lange Recherchen erreichen das schnell. Warte 30 bis 60 Sekunden und schick die Nachricht noch einmal. Passiert das oft, hebst du das Limit in deinem Konto beim Anbieter an, meist durch Guthaben-Aufladen. Bei Anthropic verdoppelt sich das Limit automatisch, sobald 5 US-Dollar verbraucht oder vorab eingezahlt sind.

„Kein Guthaben mehr auf dem API-Konto“ heißt: Das Guthaben beim Anbieter ist leer. Lade es im Konto des Anbieters auf und versuch es erneut. An AVA liegt es in beiden Fällen nicht.

Bis dahin kann ich dich auf einen anderen Anbieter, dein ChatGPT-Abo oder ein lokales Modell umstellen, wenn du dafür einen Zugang hast. Kommt die Meldung über das ChatGPT-Abo oder über deine Organisation, gelten eigene Regeln, frag mich dann einfach.

### Lokale KI hängt oder ein lokales Modell stürzt ab
`ki-lokale-ki-reparieren` · gilt für: [desktop] · Knöpfe: Lokale KI neu starten (Chat-Vorschlag), Lokale KI prüfen (Chat-Vorschlag), Lokale KI öffnen (öffnet Seite)

> Fragen: ollama hängt · internal server error im chat mit lokalem modell · ollama neu starten · lokales modell reparieren · warte auf das lokale modell

Hängt der Chat mit einem lokalen Modell, etwa mit „Internal Server Error“, starte ich die lokale KI für dich neu. Das geht auch selbst: Einstellungen → KI & Kosten → Anbieter & Modell → „Lokal installierte Modelle (Ollama)“ → „Laufzeit neu starten“.

Bringt ein Modell die lokale KI immer wieder zum Absturz, klick dort beim Modell auf „reparieren“. Es wird gelöscht und frisch heruntergeladen, das hilft nach einem abgebrochenen Download. Mit „löschen“ gibst du Speicherplatz frei. Das Modell „embeddinggemma“ ist ein Pflichtmodell für die Ähnlichkeitssuche und lässt sich nicht entfernen.

Unter „Lokale KI“ siehst du, welche Version läuft und welche AVA vorsieht. Der Abgleich läuft beim Start von selbst. Passt etwas nicht, bringt „Neu installieren“ die vorgesehene Version zurück.

### Ein lokales KI-Modell auf dem eigenen Rechner nutzen (Ollama)
`ki-lokales-modell` · gilt für: [desktop] · Knöpfe: Lokales Modell wählen (öffnet Seite), Qwen 3 8B laden (Chat-Vorschlag), Lokale Modelle öffnen (öffnet Seite)

> Fragen: kann ava offline ohne cloud laufen · lokales modell installieren · ollama modell laden · welches lokale modell für 16 gb ram · ki auf meinem rechner statt cloud

AVA bringt eine lokale KI (Ollama) mit. Ein lokales Modell kostet nichts und deine Chat-Anfragen bleiben auf dem Rechner. Dafür ist die Qualität merklich schwächer als bei Cloud-Modellen, vor allem bei mehrstufigen Aufgaben, und du brauchst genug Arbeitsspeicher.

Ich kann ein Modell für dich herunterladen, den Stand zeigen oder ein Modell wieder löschen. Selbst wählst du unter Einstellungen → KI & Kosten → Anbieter & Modell den Anbieter „Ollama (lokal)“ und dann ein Modell. Ist es noch nicht auf der Festplatte, klickst du „Modell herunterladen“. Der Download läuft im Hintergrund, den Fortschritt siehst du unten rechts.

Orientierung nach Arbeitsspeicher: Qwen 3 8B ab 16 GB als Einstieg, Qwen 3 14B ab 16 GB für mehrstufige Recherchen, Gemma 4 26B ab 24 GB, Qwen 3 30B ab 32 GB, Llama 3.3 70B ab 48 GB. Der Bedarf steht auch im Namen in der Liste. Hat deine Organisation Anbieter und Modell festgelegt, gibt es die lokale Auswahl nicht.

### Die KI antwortet nicht, ist nicht bereit oder meldet einen Fehler
`ki-modell-antwortet-nicht` · gilt für: [desktop] · Knöpfe: Anbieter & Modell prüfen (öffnet Seite)

> Fragen: ava antwortet nicht · authentifizierung fehlgeschlagen · modell ist nicht bereit · server überlastet fehler · das gewählte modell ist mit deinem konto nicht verfügbar

Unter Einstellungen → KI & Kosten → Anbieter & Modell zeigt „Status“, ob dein Modell bereit ist, und nennt sonst den Grund. Die häufigsten Meldungen:

- „Authentifizierung fehlgeschlagen“: Der Schlüssel ist falsch, abgelaufen oder widerrufen. Trag ihn in der Karte des Anbieters neu ein.
- „Die KI-Server sind gerade kurzzeitig überlastet“: Ein Engpass beim Anbieter, nicht bei dir. Ich habe es schon mehrfach versucht, schick die Nachricht in ein paar Sekunden einfach noch einmal.
- „Das gewählte Modell ist mit deinem Konto nicht verfügbar“: Wähle ein anderes Modell desselben Anbieters.
- Mit lokalem Modell steht im Eingabefeld „Warte auf das lokale Modell…“: Die lokale KI startet noch oder hängt. Ich kann sie neu starten.

Bleibt es dabei, kann ich dich auf einen anderen Anbieter umstellen, für den du einen Zugang hast.

### Welches KI-Modell soll ich in AVA nehmen?
`ki-modell-waehlen` · gilt für: [desktop] · Knöpfe: Modell auswählen (öffnet Seite), Aktuelles Modell zeigen (Chat-Vorschlag)

> Fragen: welches modell soll ich nehmen · welches KI modell ist das beste für ava · gpt oder claude was ist besser · welches model empfiehlst du · lohnt sich ein teures modell

Für die Aufbereitung deiner Firmen (Profile, Kontakte, Jahresabschlüsse) brauchst du kein eigenes Modell: Das läuft über AVAs eigenes Modell und ist im Plan enthalten. Dein Modell bestimmt, wie gut ich im Chat, im Radar, bei Meldungen, Recherchen und Workflows arbeite.

Unter Einstellungen → KI & Kosten → Anbieter & Modell wählst du Anbieter und Modell. Das empfohlene Modell je Anbieter ist mit einem Stern markiert, zum Beispiel GPT-6 Luna bei OpenAI, Claude Sonnet 5.5 bei Anthropic oder Gemini 3.8 Flash bei Google. In der Liste steht auch, wie viel Text das Modell auf einmal fassen kann, ob es günstig ist und ob es Bilder versteht.

Faustregel: Ein starkes Modell lohnt sich im Chat, für die Hintergrund-Verarbeitung reicht oft ein günstiges. Manche Funktionen brauchen eine Mindeststufe, etwa Workflows per Chat anlegen. Hast du ein ChatGPT-Abo (Plus oder Pro), kannst du ganz ohne Schlüssel starten.

### Budget der Organisation für KI aufgebraucht
`ki-organisation-budget` · gilt für: [desktop] · Knöpfe: Eigenen Schlüssel nutzen (öffnet Seite)

> Fragen: monatsbudget deiner organisation ist aufgebraucht · tagesbudget über den organisationsschlüssel aufgebraucht · chat über organisationsschlüssel pausiert · org limit erreicht was jetzt · wer kann das ki budget erhöhen

Läuft deine KI über den Schlüssel deiner Organisation, kann die Organisation ein Budget setzen: je Mitglied pro Tag oder für alle zusammen pro Monat, manchmal getrennt für Chat und Hintergrund. Ist es aufgebraucht, siehst du oben in der App einen Hinweis, zum Beispiel „Der Chat über den Organisationsschlüssel ist pausiert, die Hintergrund-Verarbeitung läuft weiter“. In der Meldung steht auch, wann das Budget zurückgesetzt wird.

Das Budget erhöhen kann nur ein Admin deiner Organisation in der Konsole unter admin.ava.bi bei „Limits & Verbrauch“. Bis dahin geht es mit einem eigenen Schlüssel weiter, falls deine Organisation eigene Schlüssel erlaubt: Einstellungen → KI & Kosten → Anbieter & Modell, beim Anbieter „Eigener Schlüssel / Abo“ wählen.

### Meine Organisation gibt KI-Anbieter, Modell oder Schlüssel vor
`ki-organisation-vorgaben` · gilt für: [desktop] · Knöpfe: Anbieter & Modell öffnen (öffnet Seite), Organisationsschlüssel nutzen (Chat-Vorschlag)

> Fragen: warum kann ich das modell nicht ändern · organisationsvorgabe modell · schlüssel der organisation nutzen · wo ist die modellauswahl hin · eigener schlüssel oder organisation

Deine Organisation kann die KI für alle Mitglieder festlegen. Dann steht unter Einstellungen → KI & Kosten → Anbieter & Modell die Karte „Organisationsvorgabe: Anbieter, Schlüssel und Modell legt deine Organisation fest“, oft mit dem Chat- und dem Hintergrund-Modell. Auswahl, eigene Schlüssel und die lokale Modellverwaltung sind dann ausgeblendet. Ändern kann das nur ein Admin deiner Organisation in der Konsole unter admin.ava.bi.

Hat die Organisation nur einen Schlüssel hinterlegt, ohne ihn vorzuschreiben, wählst du in der Karte des Anbieters zwischen „Schlüssel der Organisation“ und „Eigener Schlüssel / Abo“. Das kann ich dir auch umstellen. Über den Schlüssel der Organisation geht der Verbrauch auf ihr Konto, der Schlüssel selbst bleibt bei der Organisation.

Auch das ChatGPT-Abo und der Sprachmodus lassen sich von der Organisation abschalten. Dann fehlen die Karten einfach.

### Was bedeuten die Qualitätsstufen S, A, B und C der Modelle?
`ki-qualitaetsstufen` · gilt für: [desktop] · Knöpfe: Modell wechseln (öffnet Seite)

> Fragen: was heißt stufe S beim modell · warum ist mein modell zu schwach · workflow anlegen blockiert stärkeres modell nötig · welche stufe hat mein modell · verflechtungen blockiert mit diesem modell

Jedes Modell hat in AVA eine Qualitätsstufe: S ist die Spitzenklasse, A stark, B solide Mittelklasse, C klein. Die Stufe entscheidet zum Beispiel, ob ein neues Ergebnis bessere ältere Daten überschreiben darf. Ein schwächeres Modell überschreibt nie, was ein stärkeres schon gefunden hat.

Zwei Funktionen hängen an der Stufe:
- Workflows per Chat anlegen oder ändern geht nur mit einem Chat-Modell der Stufe S, zum Beispiel Claude Sonnet 5.5 oder Opus. Starten, Freigaben und Vorlagen gehen mit jedem Modell, und im Workflow-Editor kannst du immer von Hand bauen.
- Firmen-Verflechtungen (Gesellschafterlisten), falls deine Organisation sie freigeschaltet hat, brauchen für die Hintergrund-Verarbeitung ein Modell ab Stufe A, das Bilder versteht. Sonst steht unter Anbieter & Modell ein Hinweis, dass sie blockiert sind.

In der Modell-Liste steht die Stufe nicht dabei. Zur Orientierung bei den empfohlenen Modellen: Stufe S haben Claude Sonnet 5.5, Grok 4.6 und Qwen3.8 Max, Stufe A GPT-6 Luna, Gemini 3.8 Flash und Mistral Large 4, Stufe B DeepSeek V4 Flash.

### Eigenen KI-Schlüssel (API-Key) hinterlegen
`ki-schluessel-hinterlegen` · gilt für: [desktop] · Knöpfe: Schlüssel eintragen (öffnet Seite)

> Fragen: wo trage ich meinen openai key ein · api key hinterlegen · anthropic schlüssel eingeben · wo bekomme ich einen api schlüssel · gemini api key einfügen

Unter meiner Antwort findest du den Knopf zur Seite, auf der du den Schlüssel einträgst. Schick ihn mir bitte nicht in den Chat, dort ist er nicht geschützt.

So geht es: Einstellungen → KI & Kosten → Anbieter & Modell, dann die Klappe „API-Schlüssel“ aufmachen. Dort gibt es eine Karte je Anbieter: OpenAI, Anthropic, Google, Mistral, DeepSeek, xAI (Grok) und Qwen. Schlüssel einfügen, „Speichern“, fertig. Unter jeder Karte führt „Wo bekomme ich einen Schlüssel?“ direkt zur Schlüsselseite des Anbieters. Mit „entfernen“ löschst du einen gespeicherten Schlüssel wieder.

AVA legt Schlüssel im Schlüsselbund deines Betriebssystems ab. Bei Anthropic reicht ein Claude-Abo nicht, es braucht einen Schlüssel. Mit einem OpenAI-Schlüssel gehen zusätzlich der Sprachmodus und die Websuche im Chat. Die Kosten rechnet der Anbieter direkt mit dir ab.

### Sprachmodus einstellen (Stimme, Ruhezeit, Signalton, „Hey AVA“)
`ki-sprachmodus-einstellen` · gilt für: [desktop] · Knöpfe: Einstellungen zeigen (Chat-Vorschlag), Ruhezeit auf 60 Sekunden setzen (Chat-Vorschlag), Sprachmodus einstellen (öffnet Seite)

> Fragen: andere stimme für ava · hey ava aktivierungswort einschalten · ruhezeit im sprachmodus ändern · signalton ausschalten · ava geht zu schnell in den ruhezustand

Den Sprachmodus stelle ich dir im Chat ein, du bestätigst die Änderung:
- Stimme: Marin (Standard), Coral, Sage oder Shimmer.
- Ruhezeit: wie viele Sekunden Stille, bis ich in den Ruhezustand gehe, zwischen 5 und 120, Standard 20. Im Ruhezustand entstehen keine Kosten.
- Signalton beim Aktivieren: an oder aus.
- Aktivierungswort „Hey AVA“: weckt mich aus dem Ruhezustand.

In den Einstellungen unter KI & Kosten → Mit AVA sprechen findest du die Schalter für Aktivierungswort und Signalton. „Hey AVA“ braucht das lokale Sprachmodell unter KI & Kosten → Spracherkennung. Ohne es weckst du mich mit einem Klick auf die Kugel oder der Leertaste.

Im Gespräch selbst kannst du das Mikrofon stumm schalten und dann die Leertaste gedrückt halten, um zu sprechen.

### Sprachmodus startet nicht oder bricht ab
`ki-sprachmodus-fehler` · gilt für: [desktop] · Knöpfe: OpenAI-Schlüssel prüfen (öffnet Seite), Sprachmodus öffnen (öffnet Seite)

> Fragen: sprachmodus geht nicht · zugriff auf das mikrofon wurde verweigert · keine verbindung zu openai im sprachmodus · der openai-schlüssel wurde abgelehnt · wellen knopf fehlt im chat

Die häufigsten Gründe und was hilft:
- „Der Zugriff auf das Mikrofon wurde verweigert“: Erlaube AVA das Mikrofon in den Systemeinstellungen (Knopf „Mikrofon-Einstellungen öffnen“), dann „Erneut verbinden“.
- „Kein Mikrofon gefunden“: Schließ ein Mikrofon an oder wähle eines in den Systemeinstellungen.
- „Keine Verbindung zu OpenAI“: Prüfe das Internet. Hinter einem Firmen-Proxy oder einer Firewall wird die Sprachverbindung oft blockiert, dann hilft ein anderes Netz.
- „Der OpenAI-Schlüssel wurde abgelehnt“: Trag deinen Schlüssel unter KI & Kosten → Anbieter & Modell neu ein. Läuft es über die Organisation, muss ein Admin ihn erneuern.
- „Kontingent bei OpenAI erschöpft“: Guthaben nachladen oder warten, bis das Limit zurückgesetzt ist.

Fehlt der Wellen-Knopf im Chat, ist der Sprachmodus aus, es fehlt ein OpenAI-Schlüssel oder deine Organisation hat ihn abgeschaltet. Unter KI & Kosten → Mit AVA sprechen steht dann der Grund.

### Sehen, wie viel KI ich verbraucht habe
`ki-verbrauch-ansehen` · gilt für: [desktop] · Knöpfe: Verbrauch ansehen (öffnet Seite)

> Fragen: wie viel habe ich verbraucht · wo sehe ich meinen verbrauch · welches modell hat am meisten gekostet · verbrauch der letzten 30 tage · token usage anzeigen

Deinen KI-Verbrauch findest du unter Einstellungen → KI & Kosten → Verbrauch. AVA zeichnet ihn auf deinem Rechner auf, erfasst sind die Anfragen aus dem Chat. Du wählst 7, 30 oder 90 Tage und siehst die Zahl der Anfragen, wie viel Text gelesen und geschrieben wurde und wie viel „wiederverwendet“ wurde, also Text, den der Anbieter schon kannte und günstiger abrechnet. Dazu ein Tagesdiagramm nach Modell und eine Tabelle „Modelle im Zeitraum“.

Beträge in Euro zeigt AVA hier bewusst nicht, weil eine Schätzung zu ungenau wäre. Was du wirklich zahlst, steht im Konto deines Anbieters. Beim ChatGPT-Abo siehst du den Verbrauch in ChatGPT unter Settings → Usage, die Karte „ChatGPT-Abo“ hat dafür den Knopf „Verbrauch bei ChatGPT ansehen“.

Mit „Verbrauchsdaten löschen“ leerst du die Aufzeichnung, Firmen und Verlauf bleiben unberührt.

## chat (15 Karten)

**Zuerst ansehen:**

### Einstellen, wie selbstständig AVA handelt (Manuell, Halb-auto, Voll-auto)
`chat-autonomie-modus` · gilt für: [desktop] · Knöpfe: Zum Eingabefeld springen (öffnet Seite)

> Fragen: kannst du einfach machen ohne zu fragen · was ist halb-auto · voll-auto modus · hör auf ständig nachzufragen · autonomie modus ändern

Am Eingabefeld im Chat wählst du, wie selbstständig ich handle:
- „Manuell“ (Standard): Jede Aktion, die etwas anlegt oder ändert, bestätigst du vorher.
- „Halb-auto“: Neues wie Notizen, Aufgaben oder Neuanlagen lege ich ohne Rückfrage an.
- „Voll-auto“: Ich ändere auch Bestehendes ohne Rückfrage.

Löschen fragt in jedem Modus nach. Was ich ohne Rückfrage tue, wird protokolliert, du findest es unter Einstellungen → Erweitert → Verlauf. Der Modus gilt auch für Telegram und Mail, bei Mail höchstens wie „Halb-auto“.

Den Modus stellst du selbst am Eingabefeld um, das kann ich im Chat nicht für dich tun. Fahre am Auswahlfeld mit der Maus darüber, dann steht dort, was der Modus gerade erlaubt.

---

**Offen:**

### Sehen, was AVA im Hintergrund genau macht (Arbeitsschritte und Verbrauch)
`arbeitsschritte-anzeigen` · gilt für: [desktop] · Knöpfe: Anzeige einstellen (öffnet Seite)

> Fragen: was machst du gerade genau · zeig mir die einzelnen Schritte · wie viele Tokens hat das verbraucht · wo sehe ich den Verbrauch je Antwort · Denkt nach ausschalten

Während ich arbeite, steht im Chat nur „Denkt nach“ und kurz, was gerade passiert. Danach bleibt eine Zeile „Nachgedacht“, die du aufklappen kannst, wenn du die einzelnen Schritte sehen willst.

Willst du immer alle Arbeitsschritte und den Verbrauch je Antwort sehen, schalte „Arbeitsschritte und Verbrauch anzeigen“ ein. Das findest du in den Einstellungen unter Meldungen bei den Vorschlägen im Chat. Ich kann es auch direkt für dich umstellen.

### Bilder oder Screenshots in den Chat geben
`chat-bilder` · gilt für: [desktop] · Knöpfe: Bild-Modell wählen (öffnet Seite)

> Fragen: kann ich dir einen screenshot schicken · bild in den chat einfügen · was steht auf diesem foto · aktuelles modell unterstützt keine bilder · visitenkarte abfotografiert auslesen

Bilder ziehst du in den Chat, hängst sie über das Plus an oder fügst sie direkt aus der Zwischenablage ins Eingabefeld ein, zum Beispiel einen Screenshot oder ein Foto einer Visitenkarte. Schreib dazu, was ich damit tun soll. Ein Bild darf höchstens 5 MB groß sein, sonst lehnen die Anbieter es oft ab.

Lesen kann ich Bilder nur mit einem Modell, das Bilder versteht. In der Modell-Liste steht bei solchen Modellen „vision“, etwa bei GPT-6 Luna, Claude Sonnet 5.5 oder Gemini 3.8 Flash. Kann dein Modell keine Bilder, zeigt der Chat über dem Bild „Aktuelles Modell unterstützt keine Bilder“, und das Bild würde ignoriert. Dann wechsle vor dem Senden das Modell, das Bild bleibt im Eingabefeld liegen.

### Eine Datei (PDF, Word, Text) hochladen und von AVA lesen lassen
`chat-dateien-lesen` · gilt für: [desktop] · Knöpfe: Datei zusammenfassen (Chat-Vorschlag)

> Fragen: kannst du dieses pdf lesen · word dokument hochladen · fass mir das dokument zusammen · such im pdf nach der kündigungsfrist · datei anhängen geht das

Zieh die Datei in den Chat oder hänge sie über das Plus neben dem Eingabefeld an, bis 25 MB je Datei. Schreib dazu, was ich damit tun soll, etwa „fass das zusammen“ oder „wo steht die Kündigungsfrist?“.

PDF, Word (.docx) und Textdateien lese ich seitenweise: Ich suche gezielt die passenden Stellen und lese nur die, statt das ganze Dokument auf einmal zu verarbeiten. Das ist schneller und günstiger, auch bei langen Jahresberichten. Andere Dateiarten nehme ich ebenfalls an, ohne sie zu lesen, zum Beispiel um sie als Mail-Anhang weiterzugeben.

Die Dateien gehören zum Gespräch, in dem du sie hochgeladen hast, und bleiben sieben Tage auf deinem Rechner. Danach lädst du sie bei Bedarf neu hoch. Eine Excel- oder CSV-Liste mit Firmen nehme ich auf Wunsch direkt in deine Firmenliste auf.

### Diagramme und Karten direkt in der Antwort
`chat-diagramme` · gilt für: [desktop, app] · Knöpfe: Diagramm anfragen (Chat-Vorschlag)

> Fragen: kannst du mir das als diagramm zeigen · mach ein balkendiagramm aus den umsätzen · zeig die entwicklung als linie · das diagramm konnte nicht angezeigt werden · chart erstellen

Bitte mich einfach um ein Diagramm, etwa „zeig mir die Umsätze der letzten Jahre als Balken“. Ich zeichne es direkt in die Antwort: als Balken (stehend oder liegend), Linie, Fläche, Tortendiagramm oder Streuung. Die Zahlen dafür kommen aus den Daten, die ich vorher abgefragt habe, nicht geschätzt.

Neben Diagrammen gibt es zwei Karten in der Antwort: das Buying Center einer Firma als Übersicht der Personen, falls deine Organisation es freigeschaltet hat, und den Mail-Entwurf, den du mit einem Knopf direkt in deinem Mail-Programm öffnest.

Steht statt des Diagramms „Das Diagramm konnte nicht angezeigt werden“, bitte mich, es noch einmal zu erstellen. Unter „Technische Details & Rohdaten“ siehst du die Zahlen trotzdem.

### AVA soll sich etwas merken oder wieder vergessen
`chat-gedaechtnis` · gilt für: alle Kanäle · Knöpfe: Gemerktes zeigen (Chat-Vorschlag), Gedächtnis öffnen (öffnet Seite)

> Fragen: merk dir dass ich nur mit maschinenbauern arbeite · vergiss das wieder · was weißt du über mich · erinnerst du dich an unser letztes gespräch · remember this

Sag einfach „Merk dir, dass …“, dann behalte ich das über alle Gespräche hinweg, zum Beispiel deine Vorlieben, wiederkehrende Firmen oder laufende Aufgaben. Stabile Vorlieben merke ich mir auch von selbst, etwa wenn du immer kurze Antworten willst. Was ich mir gemerkt habe, habe ich in jedem neuen Gespräch präsent.

Mit „Was hast du dir über mich gemerkt?“ zeige ich dir die Einträge. Mit „Vergiss, dass …“ suche ich den passenden Eintrag heraus, frage bei Unklarheit nach und lösche ihn. Löschen lässt sich nicht rückgängig machen.

Alle Einträge siehst und löschst du auch selbst unter Einstellungen → Konto → Langzeitgedächtnis. Das Gedächtnis gehört zu deiner AVA und ist unabhängig vom Chatverlauf: Löschst du ein Gespräch, bleibt das Gemerkte erhalten. Es liegt in deiner AVA auf deinem Rechner oder deiner Server-Instanz, nicht auf dem AVA-Server.

### Wie arbeite ich mit AVA im Chat?
`chat-grundlagen` · gilt für: [desktop] · Knöpfe: Was kannst du? (Chat-Vorschlag), Chat öffnen (öffnet Seite)

> Fragen: was kann ich dich fragen · wie funktioniert der chat · was kannst du alles · wie fange ich an mit ava · hilfe zum chat

Schreib mir einfach, was du brauchst, in deinen Worten: „Was gibt es Neues bei Firma X?“, „Finde mir Maschinenbauer in Ostwestfalen“ oder „Schreib eine Erstansprache an den Geschäftsführer“. Ich suche die Daten selbst zusammen, frage nach, wenn etwas nicht eindeutig ist, und schlage dir den nächsten Schritt vor.

Ein paar Handgriffe: Enter schickt die Nachricht ab, Umschalt+Enter macht eine neue Zeile. Mit „Stoppen“ brichst du eine laufende Antwort ab. Firmennamen in meinen Antworten sind anklickbar und führen zur Firmenseite. Dateien ziehst du einfach in den Chat oder hängst sie über das Plus an. Tippst du am Anfang einen Schrägstrich, erscheinen deine gespeicherten Befehle (Skills).

Wichtig: Ich nenne nur, was ich wirklich gefunden habe. Fehlt mir etwas, sage ich es und hole es nach. Was ich ändern soll, etwa im CRM, bestätigst du vorher, solange am Eingabefeld der Modus „Manuell“ eingestellt ist.

### Laufende Verarbeitung im Chat verfolgen und Bescheid bekommen
`chat-hintergrundaufgaben` · gilt für: [desktop] · Knöpfe: Stand zeigen (Chat-Vorschlag), Laufende Aufgaben öffnen (öffnet Seite)

> Fragen: sag mir bescheid wenn der import fertig ist · wie weit ist die verarbeitung · 12 von 40 firmen fertig was heißt das · abgebrochen 60 minuten ohne jeden fortschritt · muss ich warten bis das fertig ist

Startest du einen Import oder eine andere Verarbeitung, verfolge ich sie im Hintergrund. Im Chat steht dazu eine Karte mit Fortschritt, etwa „12 von 40 Firmen fertig“. Bei bis zu fünf Firmen siehst du die Schritte je Firma direkt dort, sonst führt „Vorgang öffnen“ zur Übersicht. Du musst nicht warten und kannst weiterarbeiten.

Sobald alles fertig ist, melde ich mich in diesem Gespräch von selbst mit dem Ergebnis, auch mit Fehlschlägen und dem nächsten sinnvollen Schritt. Ist die App gerade nicht im Vordergrund, bekommst du eine Systembenachrichtigung. Für andere laufende Vorgänge sag einfach „sag Bescheid, wenn es fertig ist“.

Bewegt sich 60 Minuten lang gar nichts, breche ich mit „Abgebrochen: 60 Minuten ohne jeden Fortschritt“ ab und biete an, es neu anzustoßen. Das × an der Karte beendet nur das Verfolgen, die Verarbeitung läuft weiter. Ist die App zu, melde ich mich beim nächsten Start.

### Woher hat AVA ihre Fakten, und was passiert, wenn Daten fehlen?
`chat-keine-erfundenen-fakten` · gilt für: alle Kanäle · Knöpfe: Quellen nennen (Chat-Vorschlag)

> Fragen: erfindest du zahlen · stimmt das wirklich · woher hast du diese information · warum weißt du nichts zu der firma · halluzinierst du

Firmenfakten, Kennzahlen, Ansprechpartner oder Adressen nenne ich nur, wenn ich sie in diesem Gespräch wirklich abgefragt habe, aus Register, Jahresabschlüssen, Website, CRM oder deinen Daten. Aus dem Kopf rate oder schätze ich nichts, auch keine Zahlen für Diagramme.

Fehlt etwas, weil eine Firma noch nicht vollständig aufbereitet ist, hole ich es selbst nach und melde mich, wenn es da ist. Ist ein Schritt fehlgeschlagen, stoße ich ihn neu an. „Dazu gibt es nichts“ sage ich nur, wenn die Daten vollständig da sind und die Angabe trotzdem fehlt.

Sagst du mir, dass etwas falsch ist, prüfe ich es nach, statt einfach zuzustimmen. Frag jederzeit „Woher hast du das?“, dann nenne ich dir die Quelle.

### Lange Gespräche, wann ein neues Gespräch beginnen?
`chat-lange-gespraeche` · gilt für: [desktop] · Knöpfe: Chat öffnen (öffnet Seite)

> Fragen: soll ich einen neuen chat anfangen · der chat wird langsam · vergisst du was wir am anfang besprochen haben · wie lang darf ein gespräch sein · neue konversation starten

Bei jeder Antwort lese ich das ganze bisherige Gespräch mit. Je länger es wird, desto mehr Text verarbeite ich pro Antwort: Das dauert länger und verbraucht mehr. Große Zwischenergebnisse von früher, etwa ausführliche Firmendaten, halte ich nach ein paar Runden nur noch als Platzhalter vor und frage sie bei Bedarf neu ab.

Fang deshalb für ein neues Thema am besten ein neues Gespräch an, über „Neue Konversation“ oben in der Seitenleiste des Chats. Das alte Gespräch bleibt dort erhalten, du kannst jederzeit zurück.

Was über das einzelne Gespräch hinaus gelten soll, sag mir mit „Merk dir …“. Das habe ich auch im neuen Gespräch präsent. Deine Firmen, Meldungen und Einstellungen hängen ohnehin nicht am Gespräch.

### AVA stellt eine Rückfrage oder will eine Bestätigung
`chat-rueckfragen` · gilt für: [desktop, app] · Knöpfe: keine

> Fragen: warum fragst du mich das · keine der optionen passt · welche firma meinst du · was bedeutet sonstiges · muss ich jedes mal bestätigen

Ich frage nach, wenn etwas nicht eindeutig ist, zum Beispiel wenn es mehrere Firmen mit demselben Namen in verschiedenen Orten gibt. Dann zeige ich dir alle passenden Kandidaten mit Ort als Knöpfe, du tippst den richtigen an. Passt keiner, schreib unter „Sonstiges …“, was du stattdessen meinst. Manchmal frage ich auch nach einem kurzen Text, etwa einem Namen.

Bevor ich etwas anlege, ändere oder lösche, etwa im CRM, in den Einstellungen oder in deiner Firmenliste, zeige ich dir, was passieren soll, und du bestätigst oder brichst ab.

Wie oft ich frage, stellst du in der Desktop-App mit dem Modus am Eingabefeld ein: „Manuell“ fragt bei jeder Aktion, „Halb-auto“ legt Neues ohne Rückfrage an, „Voll-auto“ ändert auch Bestehendes. Löschen fragt immer nach.

### Gescanntes PDF ohne Text lesen lassen
`chat-scan-pdf` · gilt für: [desktop] · Knöpfe: Bild-Modell wählen (öffnet Seite)

> Fragen: ist ein scan-pdf was heißt das · du kannst mein gescanntes pdf nicht lesen · wie viele seiten soll ich rendern · pdf ist nur ein bild · eingescannter vertrag lesen

Manche PDFs sind nur eingescannte Bilder ohne Text. Das erkenne ich beim Hochladen und frage dich: „ist ein Scan-PDF“. Dann wandle ich die Seiten in Bilder um, damit das Modell sie lesen kann.

Du wählst, wie viele Seiten: 5, 10, 20 oder alle. Der Rest wird nicht gelesen. Seiten als Bilder kosten deutlich mehr als normaler Text, die Knöpfe zeigen den ungefähren Umfang. Nimm deshalb nur so viele Seiten, wie du brauchst, und lade lieber einen Auszug hoch, wenn es nur um wenige Seiten geht.

Damit das klappt, muss dein Chat-Modell Bilder verstehen. In der Modell-Liste steht bei solchen Modellen „vision“. Mit einem Modell ohne Bildverständnis werden die Seiten ignoriert.

### AVA öffnet die passende Seite der App
`chat-seiten-oeffnen` · gilt für: [desktop] · Knöpfe: Firmenliste öffnen (Chat-Vorschlag)

> Fragen: zeig mir die einstellungen · öffne die firma · bring mich zum radar · wo finde ich das in der app · open settings for me

Muss etwas in der App erledigt werden oder willst du eine Ansicht sehen, lege ich dir unter meine Antwort einen Knopf, der genau diese Seite öffnet, statt dir einen langen Weg zu beschreiben. Die Seite öffnet sich erst, wenn du klickst, so kannst du vorher in Ruhe lesen, was zu tun ist. Das geht zum Beispiel für eine Firmenseite, deine Firmenliste, die Suche über alle Firmen, das Radar, Meldungen, Workflows, laufende Aufgaben, LinkedIn und den Posteingang. Bei den Einstellungen führt der Knopf direkt zur passenden Stelle, etwa Anbieter & Modell, ChatGPT-Abo, Verbrauch, Profil, Fokus-Themen oder das Verbinden von CRM, Mail, Telegram, LinkedIn und weiteren Diensten.

Dazu sage ich dir in einem Satz, was du dort tust. Zugangsdaten trägst du immer auf der Seite selbst ein, nie im Chat.

Die Knöpfe gibt es nur in der Desktop-App. Schreibst du mir über Telegram, nenne ich dir den Weg in Worten.

### Texte an Kunden schreiben lassen (Du oder Sie, Deutsch oder Englisch)
`chat-texte-an-dritte` · gilt für: alle Kanäle · Knöpfe: Englisch ansprechen (Chat-Vorschlag)

> Fragen: schreib die mail in sie form · warum fragst du ob du oder sie · kannst du auch englisch schreiben · antworte mir auf englisch · siez den kunden

Dich spreche ich immer mit Du an. Schreibe ich einen Text an andere, etwa eine Mail an einen Interessenten, frage ich einmal je Empfänger, ob Du oder Sie passt, wenn weder unser Gespräch noch der CRM-Eintrag einen Hinweis gibt. Die Antwort merke ich mir für dieses Gespräch. Sag es mir gern gleich mit dazu, etwa „in Sie-Form“.

Ich antworte dir auf Deutsch. Schreibst du mir in ganzen englischen Sätzen, antworte ich auf Englisch. Texte an Dritte schreibe ich in jeder Sprache, die du nennst, etwa „auf Englisch für den britischen Einkauf“.

Willst du dauerhaft eine bestimmte Anrede oder Sprache, sag „Merk dir …“, dann gilt das auch in künftigen Gesprächen.

### Frühere Gespräche finden, wieder aufnehmen oder löschen
`chat-verlauf` · gilt für: [desktop] · Knöpfe: Letzte Gespräche zeigen (Chat-Vorschlag), Chat öffnen (öffnet Seite)

> Fragen: wo finde ich meinen alten chat · wovon haben wir letzte woche geredet · chat von gestern löschen · in allen chats suchen · chatverlauf anzeigen

Alle Gespräche stehen links in der Seitenleiste des Chats, das neueste oben. Ein Klick öffnet ein Gespräch, und du machst dort weiter, wo ihr aufgehört habt. Die Leiste blendest du mit Cmd+Umschalt+S (Windows Ctrl+Umschalt+S) ein und aus. Mit Cmd+K (Windows Ctrl+K) oder „In allen Chats suchen“ suchst du in allen Chats nach einem Stichwort.

Du kannst mich auch fragen: „Worüber haben wir letzte Woche zu Firma X gesprochen?“ Dann sehe ich die früheren Gespräche durch und fasse dir zusammen, was dort stand.

Löschen geht über das Papierkorb-Symbol am Gespräch oder per Auftrag an mich, ich frage vorher nach. Ein gelöschtes Gespräch ist endgültig weg. Deine Gespräche liegen auf deinem Rechner. Was ich mir dauerhaft gemerkt habe, bleibt beim Löschen eines Gesprächs erhalten.
