# Abnahme Block 3: Kontakte, Radar, Recherche

Stand 2026-11-07. Je Karte: Titel, Beispielfragen, Knöpfe (erscheinen unter AVAs Antwort), Text so, wie AVA ihn liest.
Rückmeldung am einfachsten im Chat: „ok“ für den ganzen Ast oder je Karte die id mit dem, was falsch ist.

## kontakte (19 Karten)

**Neu oder geändert seit main 2ac245fd:**

### Einen Ansprechpartner per Name finden, ohne die Firma zu kennen
`kontakt-suchen` · gilt für: alle Kanäle · Knöpfe: Meine Firmen öffnen (öffnet Seite)

> Fragen: wer ist herr x · die e-mail von frau x · finde einen kontakt nach namen · kontaktdaten von einer person · in welcher meiner firmen arbeitet die person

Nenn mir einfach den Namen, etwa „E-Mail von Fabian Tölle“ oder „wer ist Frau Berger“. Ich suche die Person in den Kontakten all deiner Firmen in „Meine Firmen“, du musst die Firma nicht kennen. Schreibweisen mit und ohne Umlaut finde ich beide. Firma oder Ort helfen mir, wenn der Name häufig ist.

Du bekommst Name, Rolle, Firma, Ort und, falls vorhanden, die E-Mail-Adresse mit ihrer Herkunft. Eine Adresse, die ich nur aus dem Muster der Firma gebildet habe, nenne ich ausdrücklich „nicht bestätigt“. Gibt es keine Adresse, sage ich das, statt eine zu erfinden. Passen mehrere Personen, zeige ich dir eine kurze Liste und frage, wen du meinst.

Ist die Person nicht in deinen Firmen, suche ich auf deinen Wunsch auch außerhalb. Dann bekommst du höchstens fünf Treffer mit Name, Firma und Ort, ohne Rolle und ohne E-Mail. Mehr gibt es, sobald du die Firma aufnimmst.

### Wie AVA fehlende E-Mail-Adressen bildet und prüft
`email-adressen-ableiten` · gilt für: [alle] · Knöpfe: Muster ansehen (Chat-Vorschlag), Einstellungen zeigen (Chat-Vorschlag), E-Mail-Adressen öffnen (öffnet Seite)

> Fragen: woher kommt die email adresse · kannst du die email von herrn x herausfinden · email adressen ableiten · wie prüfst du ob eine mail adresse existiert · schickt ava dabei mails raus

Fehlt einem Kontakt die E-Mail-Adresse, leite ich sie aus dem Muster der Firma ab, etwa vorname.nachname@firma.de. Das Muster lerne ich aus bekannten persönlichen Adressen derselben Firma. Firmenadressen mit Namen wie pdettlev@ ordne ich der passenden Person zu. Funktionsadressen wie info@ nehme ich nie als persönliche Adresse und lerne aus ihnen kein Muster. Gebildete Adressen nenne ich so lange „nicht bestätigt“, bis eine Prüfung sie bestätigt. Das passiert direkt nach dem Kontaktlauf jeder Firma.

Jede gebildete Adresse frage ich einzeln beim Mail-Server der Firma ab, ohne eine E-Mail zu senden. Eine eingehende Antwort bestätigt eine Adresse, eine Unzustellbarkeitsmeldung entfernt sie wieder. Für eine Firma zeige ich dir auf Wunsch vorab, welches Muster ich erkenne und welche Adressen ich bilden würde.

In der Desktop-App liegen die Schalter unter Einstellungen → Recherche → E-Mail-Adressen: Ableitung an oder aus, Firmenadressen Personen zuordnen, unverifizierte Ableitungen anzeigen und die Verifizierungsrate, standardmäßig 300 Anfragen je Stunde. Höher ist schneller, belastet aber fremde Mail-Server stärker. Umstellen kann ich das auch hier.

---

**Offen:**

### Ein Buying Center (Power Map) für eine Firma anlegen
`buying-center-anlegen` · gilt für: [alle] · Knöpfe: Buying Center anlegen (Chat-Vorschlag)

> Fragen: lass uns ein buying center machen · power map für die müller gmbh · wer entscheidet bei dieser firma · entscheider und einkäufer beim kunden festhalten · stakeholder map erstellen

Sag mir die Firma, dann lege ich nach deinem OK ein Buying Center an. Ich beginne mit einem Entwurf: zuerst die Geschäftsführer aus dem Handelsregister und, falls bekannt, die Gesellschafter, dann die Kontakte der Firma nach Rolle. Was ich daraus ableite, sind Vorschläge, keine Fakten.

Je Person gibt es vier Einschätzungen: Rolle (Entscheider, Beeinflusser, Nutzer, Ratifizierer, Spezifizierer, Einkäufer, Gatekeeper), Einstellung zu euch (Coach, positiv, neutral, negativ, Feind), Kontakt (keiner, selten, regelmäßig, intensiv) und Einfluss (gering, mittel, hoch). Ein Fragezeichen ist ein ehrlicher Wert. Die Karte zeige ich dir direkt im Chat; in der Firmenansicht erscheint der Reiter „Buying Center“.

Die Firma wird damit dein Fokuskunde. Das Buying Center gehört nur dir; andere sehen es nur, wenn du es freigibst. Für einen zweiten Kaufprozess bei derselben Firma lege ich auf Wunsch ein weiteres mit eigenem Anlass an. Hat deine Organisation Buying Center abgeschaltet, gibt es die Funktion nicht.

### Einschätzungen und Beziehungen im Buying Center eintragen
`buying-center-pflegen` · gilt für: [alle] · Knöpfe: Lücken zeigen (Chat-Vorschlag), Recherche starten (Chat-Vorschlag)

> Fragen: der it leiter hat beim gf das letzte wort · frau berg ist unser coach · trag ein dass herr meier gegen uns ist · wer fehlt noch im buying center · nimm die assistentin der geschäftsführung auf

Erzähl mir einfach, was du über die Leute weißt, und ich trage es ein: „Frau Berg ist unser Coach“, „der IT-Leiter hat beim Geschäftsführer das letzte Wort“, „die beiden können nicht miteinander“. Beziehungen zeichne ich als Pfeil zwischen zwei Personen: Einfluss, vertraut oder Animosität. Den Grund halte ich sachlich fest, so wie du ihn sagst, ohne Charakterurteile, denn er kann der Person in einer Auskunft vorgelegt werden.

Kenne ich jemanden nicht, nehme ich ihn mit Name und Funktion auf und verbinde ihn später mit einem gefundenen Kontakt. Ich sage dir auch, welche Rolle noch fehlt und zu wem es keinen Kontakt gibt.

In der Karte öffnet ein Klick auf eine Person die Seitenleiste mit Einordnung, offenen Vorschlägen zum Übernehmen oder Verwerfen und Interaktionen aus dem CRM. „Recherche starten“ sucht auf Website und LinkedIn nach neuen Hinweisen und gleicht das CRM ab; das dauert ein paar Minuten. Im „Auto-Modus“ übernehme ich offene Vorschläge sofort, jede Übernahme steht in der Belegkette.

### Ein Buying Center mit Kollegen teilen oder geteilte ansehen
`buying-center-teilen` · gilt für: [alle] · Knöpfe: Buying Center freigeben (Chat-Vorschlag), Geteilte zeigen (Chat-Vorschlag), Geteilte öffnen (öffnet Seite)

> Fragen: kann mein kollege mein buying center sehen · buying center freigeben · teile die power map mit anna · wo sind die geteilten buying center · freigabe wieder entziehen

Ein Buying Center gehört nur dem, der es angelegt hat. Du kannst es einem Mitglied deiner Organisation zum Ansehen freigeben: Sag mir, wem, per Name oder E-Mail. Ich frage vorher nach, weil damit deine Einschätzungen über Menschen weitergehen. Ändern kann der Kollege nichts. Ich zeige dir auch, wem du schon freigegeben hast, und nehme eine Freigabe auf Wunsch zurück.

Was Kollegen dir freigegeben haben, findest du in der Desktop-App unter Firmen → Geteilte Buying Center; der Eintrag erscheint, sobald es mindestens eine Freigabe gibt. Dort steht je Firma, wem es gehört, der Anlass und der Stand. Bearbeiten lässt es sich nicht, und im Reiter „Buying Center“ der Firma erscheinen nur deine eigenen.

### Doppelte Kontakte zusammenführen oder eine Zusammenführung zurücknehmen
`dubletten-zusammenfuehren` · gilt für: [alle] · Knöpfe: Dubletten prüfen (Chat-Vorschlag), Zusammenführungen zeigen (Chat-Vorschlag)

> Fragen: die person steht doppelt drin · christian und christian krebel sind dieselbe person · dubletten bei den kontakten · zusammenführung rückgängig machen · das waren zwei verschiedene leute

Doppelte Personen führe ich bei jeder Firma etwa einmal pro Woche im Hintergrund zusammen. Sichere Fälle gehen direkt: gleiches LinkedIn- oder XING-Profil, ein Profil, dessen Adresse den vollen Namen trägt, oder dieselbe belegte E-Mail-Adresse. Steht jemand nur mit Vornamen da und gibt es genau ein passendes Gegenstück, etwa „Christian“ von der Website und „Christian Krebel“ von LinkedIn, entscheidet eine KI-Prüfung.

Sag mir die Firma, dann prüfe ich sofort. Ich zeige dir auch, was bisher zusammengeführt wurde, mit Regel und Grund. War eine Zusammenführung falsch, nehme ich sie nach deinem OK zurück; beide Personen stehen danach wieder genau so getrennt da wie vorher.

Eine eigene Seite dafür gibt es nicht, das läuft über den Chat.

### Die richtige E-Mail-Adresse eines Kontakts eintragen
`email-adresse-korrigieren` · gilt für: [alle] · Knöpfe: Adresse korrigieren (Chat-Vorschlag)

> Fragen: die email von herrn x ist falsch · die richtige mail adresse ist a.berg@firma.de · korrigiere die email adresse · ich kenne die email von der person · email wurde falsch abgeleitet

Ist eine angezeigte Adresse falsch und kennst du die richtige, sag sie mir einfach, zum Beispiel „die Adresse von Anna Berg ist a.berg@firma.de“. Ich frage einmal nach und speichere sie dann. Sie ersetzt abgeleitete oder zugeordnete Adressen dieser Person in dieser Firma und bleibt als von dir angegeben nachvollziehbar. Adressen, die ich gefunden oder verifiziert habe, bleiben stehen.

Deine Angabe hilft auch den anderen Kontakten der Firma: Beim nächsten Kontaktlauf nutze ich sie als Beleg für das Adressmuster der Domain. Passt die Domain nicht zur Website der Firma, sage ich dir das.

Ein Eingabefeld dafür gibt es an der Personenkarte nicht, das geht über den Chat.

### Was verifiziert, unbestätigt, offen und abgelehnt bei E-Mail-Adressen heißt
`email-status-verstehen` · gilt für: [alle] · Knöpfe: Adresse prüfen (Chat-Vorschlag), E-Mail-Adressen öffnen (öffnet Seite)

> Fragen: was heißt verifiziert bei der email · ist die email adresse sicher · was bedeutet catch all · warum steht oder neben der email · die adresse wurde abgelehnt was heißt das

Eine abgeleitete Adresse hat eines von vier Ergebnissen:

- verifiziert: Der Mail-Server hat bestätigt, dass es sie gibt, oder es kam eine Antwort von ihr. Nur diese Adressen tragen an der Personenkarte das grüne Zeichen „verifiziert“, mit Prüfdatum im Hinweis.
- unbestätigt: Der Server nimmt jede Adresse an (Catch-all). Das belegt nichts.
- offen: Die Prüfung war in deinem Netz nicht möglich oder blieb ohne Antwort. Die Adresse ist dann nach dem häufigsten Format gebildet; daneben stehen mit „oder …“ weitere übliche Schreibweisen.
- abgelehnt: Der Server kennt die Adresse nicht.

Offene und abgelehnte Adressen speichere ich nur, solange unter Einstellungen → Recherche → E-Mail-Adressen „Unverifizierte Ableitungen anzeigen“ an ist. Was für eine Adresse genau gilt, steht im Herkunftsnachweis der Person, oder frag mich. Kennst du die richtige Adresse, sag sie mir, dann ersetze ich die abgeleitete.

### Eine Funktionsadresse wie rechnung@ oder buchhaltung@ prüfen
`funktionsadresse-pruefen` · gilt für: [alle] · Knöpfe: Adressen prüfen (Chat-Vorschlag)

> Fragen: gibt es rechnung@ bei der firma · an welche adresse schicke ich die rechnung · prüf ob bewerbung@ existiert · welche mail hat die buchhaltung · presse email der firma finden

Brauchst du eine Adresse, die nicht vorliegt, etwa für Rechnung, Buchhaltung, Bewerbung oder Presse, sag mir Firma und Zweck. Ich prüfe bis zu zehn Varianten an der Domain der Firma beim Mail-Server, ohne eine E-Mail zu senden, zum Beispiel rechnung@, buchhaltung@, invoice@ und accounting@. Das dauert einige Sekunden.

Je Adresse bekommst du ein Ergebnis: existiert, existiert nicht, unbekannt, Catch-all oder gesperrt. Catch-all heißt, der Server nimmt alles an; das ist kein Beleg. Gespeichert wird dabei nichts.

### Sehen, welche Firmen gerade im Team Thema sind
`gerade-thema` · gilt für: [alle] · Knöpfe: Gerade Thema zeigen (Chat-Vorschlag), Gerade Thema öffnen (öffnet Seite)

> Fragen: arbeitet noch jemand an dieser firma · woran arbeitet mein team gerade · welche firmen beschäftigen die kollegen · hat ein kollege die firma auch auf dem schirm · was ist gerade thema

Ich zeige dir, welche Firmen deine Organisation gerade beschäftigen: je Firma, wie viele Mitglieder sie derzeit warm haben. Namen nenne ich bewusst nicht; wer genau dranhängt, fragst du am besten im Team. Eine Firma erscheint erst, wenn mindestens zwei Mitglieder an ihr arbeiten, und die Übersicht gibt es erst ab drei Mitgliedern, damit niemand auf Einzelne schließen kann. Deine eigenen Firmen sind mitgezählt.

Frag mich einfach, oder öffne in der Desktop-App Firmen → Gerade Thema. Der Eintrag fehlt, wenn deine Organisation die Übersicht oder Nähe & Vorrang abgeschaltet hat.

### Einen Kontakt nach Art. 14 DSGVO informieren und das festhalten
`kontakt-art14-hinweis` · gilt für: [alle] · Knöpfe: Hinweistext holen (Chat-Vorschlag)

> Fragen: art 14 hinweis für eine person · muss ich den kontakt informieren dass ich seine daten habe · datenschutzhinweis zum kopieren · markier frau berg als informiert · dsgvo infotext für einen ansprechpartner

Wenn du jemanden ansprichst, dessen Daten aus öffentlichen Quellen stammen, musst du ihn nach Art. 14 DSGVO informieren. Ich gebe dir dafür einen vorformulierten Hinweistext mit Quelle, Zweck, Speicherdauer, Rechten und Kontakt. Sag mir die Person, dann bekommst du ihn hier; auf Wunsch setze ich die Kontaktadresse deiner Organisation ein.

An der Personenkarte geht es auch selbst: „Datenschutz & Herkunft“ öffnen, „Art.-14-Hinweis kopieren“ legt den Text in die Zwischenablage.

Hast du die Person informiert, klick dort „als informiert markieren“ oder sag es mir, gern mit dem Kanal, etwa E-Mail. Ich frage vorher kurz nach. Die Karte zeigt danach „Art. 14 informiert am“ mit Datum. Der Vermerk gilt für deine Organisation. Ob und wann du informieren musst, entscheidest du als Verantwortlicher; die rechtliche Prüfung nehme ich dir nicht ab.

### Woher stammt ein Kontakt und wie sicher ist die Angabe?
`kontakt-herkunft` · gilt für: [alle] · Knöpfe: Herkunft nachweisen (Chat-Vorschlag)

> Fragen: woher hast du diesen kontakt · ist der ansprechpartner von linkedin oder von der website · wo steht die telefonnummer von herrn meier · herkunftsnachweis für eine person · auskunftsersuchen nach art 15 beantworten

Jede Personenkarte nennt neben der Position, woher die Person stammt: LinkedIn, Firmenwebsite, Websuche oder Datenschutzerklärung. „Firmenwebsite“ ist anklickbar und führt auf die Seite, auf der ich die Person gefunden habe. Neben Telefon, E-Mail und Adresse steht „Quelle“ mit der Belegseite und eine Prozentzahl für die Zuverlässigkeit. Sie steigt, wenn derselbe Wert auf mehreren Seiten und aus mehreren Quellen bestätigt wurde.

Den vollständigen Nachweis bekommst du an der Karte unter „Datenschutz & Herkunft“ → „Herkunftsnachweis“: alle Angaben mit Quelle, Beleg und Zeitpunkt, zum Kopieren, etwa für ein Auskunftsersuchen nach Art. 15 DSGVO. Sag mir, um wen es geht, dann hole ich ihn dir auch hier im Chat.

Ersetzte oder nicht mehr gefundene Werte stehen an der Karte unter „Frühere Angaben“.

### Ansprechpartner einer Firma ansehen und finden
`kontakte-einer-firma` · gilt für: [alle] · Knöpfe: Ansprechpartner zeigen (Chat-Vorschlag)

> Fragen: wer sind die ansprechpartner bei der müller gmbh · zeig mir die kontakte von firma x · wo finde ich die kontakte einer firma · gibt es da jemanden aus dem vertrieb · wer ist dort geschäftsführer und wer macht den einkauf

Sag mir einfach die Firma, dann nenne ich dir die Ansprechpartner mit Rolle, E-Mail, Telefon und Profil, die wichtigsten zuerst.

In der Desktop-App findest du sie in der Firmenansicht im Reiter „Kontakte“. Oben stehen Telefonnummern, E-Mail-Adressen und Anschriften der Firma, darunter die „Zugeordneten Personen“. Die Karten sind nach Rolle geordnet: Geschäftsleitung, Leitung, Vertrieb und Einkauf, dann Weitere. Ab sechs Personen erscheint ein Suchfeld. Es durchsucht Name, Position, Abteilung, Kontaktdaten und Herkunft, findet also auch „linkedin“ oder „leitung“, und kommt mit Tippfehlern zurecht.

An jeder Karte kannst du direkt mailen, anrufen oder das LinkedIn- oder XING-Profil öffnen.

Fehlt der Reiter, liegen noch keine Kontakte vor oder deine Organisation hat die Kontakt-Recherche nicht freigeschaltet.

### Die gefundenen Ansprechpartner passen nicht oder es fehlen welche
`kontakte-passen-nicht` · gilt für: [alle] · Knöpfe: Kontakte neu suchen (Chat-Vorschlag)

> Fragen: die kontakte stimmen nicht · warum sind da so wenige ansprechpartner · falsche personen bei der firma · such die kontakte nochmal · keine ansprechpartner gefunden

Schau zuerst an der Personenkarte, woher die Person stammt. Kommt sie nur aus der „Websuche“, ist sie oft unsicherer als ein Fund auf der Firmenwebsite oder über LinkedIn.

Sag mir die Firma. Fehlt der Kontaktschritt oder ist er fehlgeschlagen, starte ich ihn neu; das kostet nichts. Sind die Daten noch frisch, kann ich die ganze Firma neu verarbeiten lassen. Das zählt wie eine weitere Aufnahme in deinem Monatskontingent, deshalb frage ich vorher.

Im kostenlosen Plan kommen Ansprechpartner nur von der Website, Mitarbeiter von LinkedIn gibt es ab Pro.

Für einzelne Personen kann ich gezielt das LinkedIn-Profil suchen oder eine falsche E-Mail-Adresse durch die richtige ersetzen. Kennst du jemanden, der fehlt, kann ich ihn im Buying Center mit Name und Funktion aufnehmen.

### LinkedIn-Profil eines Ansprechpartners finden und speichern
`linkedin-profil-finden` · gilt für: [alle] · Knöpfe: LinkedIn-Profil suchen (Chat-Vorschlag)

> Fragen: finde das linkedin profil von frau schmidt · hat der kontakt ein linkedin profil · such die linkedin url vom geschäftsführer · beim kontakt fehlt linkedin · add linkedin profile to contact

Sag mir Person und Firma, dann suche ich das LinkedIn-Profil über die Websuche. Ich nehme nur Profile, deren Adresse plausibel zum Namen passt; geraten wird nicht. Gibt es genau einen Treffer, frage ich, ob ich ihn am Kontakt speichern soll. Bei mehreren lässt du mich wählen, bei keinem sage ich das offen und speichere nichts. Kennst du die Profiladresse schon, gib sie mir direkt.

Mit gespeichertem Profil erscheint an der Personenkarte das LinkedIn-Zeichen. Ab dann prüfe ich das Profil bei jeder Kontakt-Auffrischung auf einen Arbeitgeberwechsel. Außerdem kannst du die Person an der Karte über das Augen-Zeichen auf die Personen-Watchlist setzen, falls deine Organisation die freigeschaltet hat.

### Arbeitgeberwechsel von Ansprechpartnern erkennen
`linkedin-profil-pruefung` · gilt für: [desktop] · Knöpfe: Meldungen öffnen (öffnet Seite), Prüfstand ansehen (öffnet Seite)

> Fragen: merkt ava wenn ein kontakt die firma wechselt · arbeitgeberwechsel bei ansprechpartnern · ist der kontakt noch bei der firma · wie viele linkedin profile wurden geprüft · job change alert

Ja. Bei jeder Auffrischung der Kontakte einer Firma lese ich die bekannten LinkedIn-Profile deiner Ansprechpartner direkt auf deinem Rechner, ohne Anmeldung bei LinkedIn. Steht dort ein neuer Arbeitgeber, kann daraus eine Meldung „Arbeitgeberwechsel“ werden. Reicht der Zugriff nicht, weil LinkedIn die Seite sperrt, springt der LinkedIn-Datendienst ein.

Dafür musst du nichts einrichten, und der LinkedIn-Beobachter muss nicht an sein. Den Stand der letzten Tage siehst du unter Einstellungen → Erweitert → Dienste auf diesem Rechner bei „LinkedIn-Profile der Ansprechpartner“: bestätigt, gewechselt, gesperrt, nicht gefunden.

Gemeldet wird ein Wechsel nur, wenn er frisch ist. Ist belegt, dass die neue Stelle schon länger als etwa ein halbes Jahr besteht, ist es keine Neuigkeit mehr.

### Was Nähe & Vorrang ist und wie ich es abschalte oder lösche
`naehe-vorrang` · gilt für: [alle] · Knöpfe: Nähe erklären (Chat-Vorschlag), Einstellungen öffnen (öffnet Seite), Nähe & Vorrang öffnen (öffnet Seite)

> Fragen: warum hält ava diese firma für heiß · was bedeutet warm lauwarm kalt · merkt sich ava was ich anschaue · relevanz ausschalten · lösch was du über mein verhalten weißt

Ich merke mir, mit welchen Firmen und Personen du arbeitest: angesehen, im Chat behandelt, in Meine Firmen übernommen, ins CRM übernommen, Mailentwurf begonnen und Ähnliches. Daraus ergibt sich eine Nähe von 1 bis 10. In der Firmenansicht steht sie als kleine Anzeige „kalt“, „lauwarm“, „warm“ oder „heiß“; der Hinweis daran nennt die Gründe. Was dir nahesteht, beobachte ich genauer und melde es sofort statt in der Tageszusammenfassung. Warnungen zu Insolvenz oder Löschung bekommst du immer.

Die Signale liegen in deinem Konto, getrennt von allen anderen; auch die Verwaltung deiner Organisation sieht sie nicht. Nach 400 Tagen werden sie gelöscht.

Standardmäßig ist die Erfassung an. Unter Einstellungen → Meldungen → Nähe & Vorrang schaltest du sie aus, siehst alle erfassten Signale und löschst alles. Eine einzelne Firma oder Person vergesse ich auf Zuruf. Hat deine Organisation die Einstellung verbindlich gesetzt, gibt es keinen Schalter.

### Eine Person auf Löschwunsch entfernen
`person-loeschen` · gilt für: [alle] · Knöpfe: Person löschen (Chat-Vorschlag)

> Fragen: person löschen · der kontakt will gelöscht werden · löschwunsch nach dsgvo umsetzen · widerspruch gegen die speicherung · entferne herrn meier aus ava

Bittet dich jemand, seine Daten zu löschen, sag mir Name und Firma. Ich frage noch einmal nach und lösche die Person dann im gesamten Bestand, für alle Organisationen, nicht nur bei dir. Danach ist sie gegen erneute Erfassung gesperrt, damit sie beim nächsten Durchlauf nicht wieder auftaucht. Das lässt sich nicht rückgängig machen. Auch ihre Einträge in Buying Centern verschwinden. Löschen kann nur eine Organisation, die die Person selbst erfasst hat; sonst gebe ich den Wunsch auf Bitte ans AVA-Team weiter.

In der Desktop-App geht es an der Personenkarte unter „Datenschutz & Herkunft“ → „Person löschen“.

Willst du jemanden nur nicht mehr doppelt sehen, ist Löschen zu viel: Doppelte Einträge führe ich zusammen, und das kann ich auch wieder zurücknehmen.

### In welchen Firmen steckt eine Person noch (Rollen und Beteiligungen)?
`person-verflechtungen` · gilt für: [alle] · Knöpfe: Verflechtungen zeigen (Chat-Vorschlag)

> Fragen: in welchen firmen ist der geschäftsführer noch · hat die person weitere beteiligungen · welche firmen gehören herrn x · ist der gesellschafter auch woanders geschäftsführer · personenseite öffnen

Für Personen aus Handelsregister und Gesellschafterlisten zeige ich dir, mit welchen Firmen sie verbunden sind: aktuelle und frühere Rollen (Geschäftsführung, Gesellschafter, Prokura) mit Datum und Quelle sowie Beteiligungen mit Anteil und Nennbetrag. Gelöschte Firmen und Insolvenzen sind gekennzeichnet. Vom Geburtsdatum steht nur der Jahrgang da.

Sag mir die Person, oder klick in der Firmenansicht im Reiter „Verflechtungen“ auf einen Namen; dann öffnet sich die Personenseite. Das gilt für deutsche Firmen und nur, wenn deine Organisation Firmen-Verflechtungen freigeschaltet hat.

## radar (13 Karten)

### Passende Firmen aus meinem Bestand für ein Angebot oder eine Ausschreibung finden
`ausschreibung-abgleich` · gilt für: [alle] · Knöpfe: Angebot abgleichen (Chat-Vorschlag)

> Fragen: wer aus meinem bestand passt zu dieser ausschreibung · "angebot: wir suchen einen partner für lagerlogistik" · rfq welche firma passt · welche firma passt am besten zu dieser anfrage · für dieses angebot die besten kunden finden

Füge mir den Text des Angebots, der Anfrage oder der Ausschreibung einfach in den Chat, gern mit „Angebot:“ oder „Wir suchen:“ davor. Ich bewerte deine Firmenliste dann zusätzlich gegen genau diesen Text und gebe dir eine Rangliste mit Score und Begründung je Firma, ohne Rückfragen und ohne Hintergrundauftrag.

Grundlage bleibt dein Idealkundenprofil; fehlt es, legen wir es zuerst an. Ich bewerte nur Firmen aus deiner Firmenliste. Neue Firmen außerhalb davon findet der Radar.

### Mein Idealkundenprofil ansehen oder ändern
`icp-anpassen` · gilt für: [alle] · Knöpfe: ICP anzeigen (Chat-Vorschlag), Idealkundenprofil öffnen (öffnet Seite)

> Fragen: füge logistik zu meinen zielbranchen hinzu · ändere den radius auf 100 km · keine einzelhändler mehr im icp · zeig mir mein icp · was steht in meinem idealkundenprofil

Sag mir einfach, was sich ändern soll, zum Beispiel „nimm Logistik als Branche dazu“, „Umkreis 80 km“ oder „keine Agenturen“. Ich ändere nur diese Felder, der Rest bleibt. Auf Wunsch zeige ich dir, was gerade gespeichert ist.

In der Desktop-App geht es unter Firmen → Radar → „ICP bearbeiten“, danach „ICP übernehmen“.

Standorte außerhalb Deutschlands schreibst du mit Landeskürzel, etwa „Wien (AT)“, „Zürich (CH)“, „Manchester (UK)“, „Oslo (NO)“ oder „Helsinki (FI)“. Möglich sind bis zu fünf Orte, zwölf Branchen und ein Umkreis bis 200 km.

Für den Radar braucht das Profil mindestens einen Ort, eine Zielbranche und eine Beschreibung oder dein Angebot.

### Ein bestehendes ICP aus einem Dokument übernehmen
`icp-aus-dokument` · gilt für: [alle] · Knöpfe: Dokument übernehmen (Chat-Vorschlag), Idealkundenprofil öffnen (öffnet Seite)

> Fragen: ich habe schon ein icp als pdf · übernimm unser icp aus confluence · icp aus einem word dokument · hier ist unsere zielkundenbeschreibung · import my ideal customer profile

Hast du dein Idealkundenprofil schon beschrieben, etwa in Confluence, Word oder als PDF, zieh die Datei in den Chat oder füge den Text ein. Ich lese es einmal und verdichte es in die Felder: Angebot, Nutzen, Branchen, Orte, Größe, Merkmale, Ausschlüsse, Beispielkunden und Beschreibung. Bei langen Dokumenten dauert das ein bis zwei Minuten.

Ich zeige dir den Entwurf und sage, welche Felder im Dokument nicht belegt waren; die ergänzt du. Gespeichert wird erst nach deinem OK, das Dokument bleibt auf deinem Rechner.

In der Desktop-App geht das auf der Seite Idealkundenprofil über „Bestehendes ICP übernehmen“: PDF, Word, Text oder Markdown hineinziehen oder den Text einfügen.

### ICP-Entwurf aus meiner Website und Kunden-Websites erstellen
`icp-aus-website` · gilt für: [alle] · Knöpfe: Aus Website erstellen (Chat-Vorschlag), Idealkundenprofil öffnen (öffnet Seite)

> Fragen: erstell mein icp aus meiner website · analysiere meine website und die meiner kunden · icp automatisch erstellen · hier ist unsere url mach daraus ein idealkundenprofil · leite die zielgruppe aus unseren referenzkunden ab

Nenn mir deine Website und, wenn du magst, bis zu fünf Websites deiner besten Bestandskunden. Ich lese bei dir Angebot, Nutzen und Standort aus dem Impressum, bei den Kunden Branche, Größe und Standort. Aus den echten Entfernungen zu deinen Kunden schlage ich einen Umkreis vor. Das dauert ein bis drei Minuten.

Du bekommst einen Entwurf; gespeichert wird erst nach deinem OK. Die Daten deiner Kunden bleiben auf deinem Rechner.

In der Desktop-App heißt der Weg auf der Seite Idealkundenprofil „Aus deinen Websites“, der Knopf „Analysieren & ICP erstellen“. Danach prüfst du das Formular und klickst „ICP übernehmen“.

### Welche meiner Firmen passen am besten zu meinem Idealkundenprofil?
`icp-bestandsabgleich` · gilt für: [alle] · Knöpfe: Rangliste erstellen (Chat-Vorschlag)

> Fragen: welche meiner firmen passen am besten zum icp · ranking meiner firmenliste · mit welcher firma soll ich anfangen · best match aus meinem bestand · top 10 firmen für mich

Frag mich einfach, dann gleiche ich deine Firmenliste mit dem Idealkundenprofil ab. Erst sortiere ich nach Branchen, Größe, Orten und Ausschlüssen vor, dann bewerte ich die plausibelsten Firmen mit einem Score von 0 bis 100 und einem Satz Begründung, genauso wie im Radar. Du bekommst die Rangliste direkt, meist nach Sekunden bis einer Minute, und ich sage dir, wie viele Firmen ich geprüft habe und welchen zum Beispiel ein Profil fehlte.

Standardmäßig bewerte ich die besten 15 ausführlich, auf Wunsch bis 30. Du kannst auch einschränken, etwa auf Firmen mit einem bestimmten Namensteil oder Ort.

Ohne Idealkundenprofil geht es nicht; dann legen wir es zuerst an.

### Mein Idealkundenprofil (ICP) festlegen
`icp-festlegen` · gilt für: [alle] · Knöpfe: ICP festlegen (Chat-Vorschlag), Radar öffnen (öffnet Seite), Idealkundenprofil öffnen (öffnet Seite)

> Fragen: wie lege ich mein icp an · meine idealen kunden sind mittelständische maschinenbauer · idealkundenprofil erstellen · wo stelle ich meine zielgruppe ein · ideal customer profile

Das Idealkundenprofil beschreibt, welche Firmen deine perfekten Kunden sind. Danach richten sich der Firmen-Radar und der Abgleich deiner Firmenliste.

Der einfachste Weg: Beschreib es mir im Chat, etwa „Maschinenbauer mit 50 bis 500 Mitarbeitern rund um Hannover, keine Agenturen“. Ich speichere nur, was du sagst, und erfinde nichts dazu.

In der Desktop-App gibt es dafür die Seite Idealkundenprofil (Firmen → Radar → „ICP bearbeiten“) mit drei Wegen: aus deiner Website und bis zu fünf Kunden-Websites, aus einem bestehenden Dokument oder von Hand mit neun kurzen Fragen. Abgefragt werden Angebot, Nutzen, Standorte mit Umkreis, Zielbranchen, Größe, weitere Merkmale, Ausschlüsse, beste Bestandskunden und eine Zusammenfassung in deinen Worten, die beim Bewerten am stärksten zählt.

Damit der Radar starten kann, braucht das Profil mindestens einen Ort, eine Zielbranche und eine Beschreibung oder dein Angebot.

### Den Radar automatisch laufen lassen (täglich oder wöchentlich)
`radar-automatik` · gilt für: [alle] · Knöpfe: Radar täglich laufen lassen (Chat-Vorschlag), Radar öffnen (öffnet Seite)

> Fragen: radar automatisch laufen lassen · such jeden tag nach neuen firmen · radar automatik einschalten · benachrichtige mich bei neuen passenden firmen · radar nur wöchentlich

Die Automatik ist anfangs aus. Ich schalte sie dir nach deinem OK ein: täglich, wöchentlich oder in den bezahlten Plänen auch viermal täglich. Dann läuft der Radar selbstständig: Scan, Mini-Profile, Bewertung und bei heißen Treffern eine Meldung. Jede Firma melde ich nur einmal. Stehen mehrere Orte in deinem Profil, kommen sie abwechselnd dran.

In der Desktop-App schaltest du das unter Firmen → Radar mit „Automatik“ und der Auswahl daneben. „Jetzt komplett laufen lassen“ startet sofort einen vollen Lauf, das dauert einige Minuten. Daneben steht, wann der letzte Lauf war und was er gebracht hat.

„Sofortige Mini-Profil-Verarbeitung“ arbeitet alle offenen Kandidaten so schnell wie möglich ab. Der Chat behält Vorrang, es braucht aber mehr KI-Aufrufe in kurzer Zeit.

Im kostenlosen Plan gibt es keine Automatik, nur einen Scan pro Woche.

### Radar-Kandidaten verstehen (Mini-Profil, Score, Begründung)
`radar-kandidaten-verstehen` · gilt für: [alle] · Knöpfe: Heiße Kandidaten zeigen (Chat-Vorschlag), Radar öffnen (öffnet Seite)

> Fragen: was bedeutet der score im radar · warum passt diese firma laut radar · was ist ein mini profil · welche kandidaten sind heiß · warum hat die firma keinen score

Jeder Kandidat im Radar bekommt ein Mini-Profil: Ich lese die Startseite und bis zu vier Unterseiten wie Impressum und Leistungen und fasse zusammen, was die Firma macht. Danach bewerte ich das Profil gegen dein Idealkundenprofil mit einem Score von 0 bis 100 und einem Satz unter „Warum passt sie?“. Ab 70 gilt ein Kandidat als heiß.

Ohne Score ist ein Kandidat noch nicht bewertet; „ICP-Match aktualisieren“ holt das nach. Die Sanduhr heißt: noch kein Mini-Profil. „Mini-Profile erstellen“ arbeitet den Rückstand in 25er-Schritten ab, sonst läuft das im Hintergrund. Lädt eine Website nicht, versuche ich es bei einem späteren Lauf erneut; einen Bot-Schutz umgehe ich nicht. Ein Mini-Profil wird höchstens alle sechs Monate neu erstellt, und alle Nutzer profitieren davon.

Firmen, die schon in AVA bekannt sind, sind in der Liste markiert.

### Neue passende Firmen in einer Region finden (Firmen-Radar)
`radar-scan` · gilt für: [alle] · Knöpfe: Scan starten (Chat-Vorschlag), Radar öffnen (öffnet Seite)

> Fragen: finde neue firmen im umkreis von hannover · welche firmen gibt es in meiner region die ich noch nicht habe · neue kunden in der nähe finden · radar scan starten · such mir neue maschinenbauer um stuttgart

Sag mir Ort und Umkreis, zum Beispiel „neue Firmen im Umkreis von 30 km um Hannover“. Ich suche dort Firmen, die noch nicht in AVA sind, aus OpenStreetMap und der Google-Suche je Branche. Ohne Angabe nehme ich die Branchen aus deinem Idealkundenprofil. Ein Scan dauert etwa 30 bis 90 Sekunden, der Umkreis geht bis 100 km.

Danach erstelle ich Mini-Profile von den Websites und bewerte die Firmen gegen dein Profil. Die Ergebnisse stehen unter Firmen → Radar, die heißesten oben.

Außer Deutschland gehen Österreich, Schweiz, Vereinigtes Königreich, Norwegen und Finnland; nenn den Ort dann mit Kürzel, etwa „Wien (AT)“.

Ohne vollständiges Idealkundenprofil starte ich keinen Scan, sondern frage erst nach Ort, Branchen und Beschreibung. Firmen, die schon im geteilten Bestand sind, bringt ein Scan nicht noch einmal.

### Der Radar startet nicht oder bringt keine neuen Firmen
`radar-startet-nicht` · gilt für: [alle] · Knöpfe: Radar-Stand abfragen (Chat-Vorschlag), Radar öffnen (öffnet Seite)

> Fragen: warum läuft der radar nicht · radar findet nichts neues · kein radar scan möglich · läuft der radar gerade · radar hängt

Frag mich, was der Radar gerade tut. Ich sehe live, ob ein Scan, eine Mini-Profil-Runde oder eine Bewertung läuft, woran genau und was zuletzt schiefging. Auf der Radar-Seite zeigt das die Aktivitätsanzeige neben der Überschrift.

Häufige Gründe, warum nichts startet:
- Das Idealkundenprofil ist unvollständig. Es braucht Ort, Zielbranche und Beschreibung oder Angebot.
- Der Deckel ist erreicht: standardmäßig höchstens 300 offene Kandidaten. Entscheide erst über Kandidaten oder erhöhe „Offene Kandidaten höchstens“; 0 heißt unbegrenzt.
- Im kostenlosen Plan geht nur ein Scan pro Woche.

Kommen keine neuen Firmen, liegt das meist daran, dass ein Scan nur Firmen bringt, die noch nicht im geteilten Bestand sind; Ignoriertes und Importiertes kommt nicht wieder. Mehr Zulauf bringen weitere Orte oder Branchen im Profil oder ein größerer Umkreis.

### Radar-Firmen mit der Organisation teilen
`radar-teilen` · gilt für: [alle] · Knöpfe: Radar öffnen (öffnet Seite)

> Fragen: teile diese radar firmen mit meinen kollegen · empfehle die firma meinem team · was heißt von der organisation geteilt · ein kollege hat mir firmen geteilt · share radar companies

Findest du im Radar Firmen, die für Kolleginnen und Kollegen interessant sind, teile sie mit deiner Organisation: in der Desktop-App unter Firmen → Radar anhaken und „Mit Organisation teilen“ klicken, oder sag es mir, gern mit einer kurzen Notiz. Ich frage vorher nach. Die Firmen erscheinen dann bei allen Mitgliedern im Radar.

Was andere dir empfehlen, steht oben im Radar unter „Von der Organisation geteilt“, mit Absender und Notiz, unabhängig von deinem Idealkundenprofil. Dort wählst du „Importieren“, was wie gewohnt einen Vorgang anlegt, „Ignorieren“ oder „Ausblenden“; Ausblenden gilt nur für dich.

### Radar-Kandidaten übernehmen oder verwerfen
`radar-uebernehmen-verwerfen` · gilt für: [alle] · Knöpfe: Radar öffnen (öffnet Seite)

> Fragen: importiere die ersten fünf radar firmen · nimm die heißen kandidaten auf · ignoriere diese firma im radar · kommt eine ignorierte firma wieder · radar firma in meine firmen übernehmen

Sag mir, welche Kandidaten du übernehmen oder verwerfen willst; ich entscheide das nie von selbst. In der Desktop-App geht es unter Firmen → Radar: Kandidaten anhaken, dann „Importieren“ oder „Ignorieren“.

Importieren startet für alle gewählten Firmen einen Vorgang mit der vollen Verarbeitung; jede Firma braucht dafür einen Ort. Ignorieren blendet die Firma für dich dauerhaft aus, sie kommt auch bei späteren Scans nicht wieder. Nennst du mir einen Grund, etwa „zu klein“ oder „reine Agentur“, beachte ich ihn bei künftigen Bewertungen.

Die Entscheidung gilt nur für dich; für andere bleibt die Firma im geteilten Bestand.

### Warum sind Radar-Treffer verdeckt oder begrenzt?
`radar-verdeckt` · gilt für: [alle] · Knöpfe: Plan ansehen (öffnet Seite)

> Fragen: warum sehe ich nur zwei firmen im radar · die namen im radar sind verdeckt · was bedeutet das schloss im radar · ab dem plan pro sichtbar · radar im kostenlosen plan

Im kostenlosen Plan zeige ich von den bewerteten Radar-Treffern nur die zwei besten mit Namen und Begründung. Bei den übrigen siehst du den Score, damit du weißt, was da ist; Name, Website und Begründung bleiben verdeckt, auch im Chat. Ab dem Plan Pro siehst du alle.

Außerdem gilt im kostenlosen Plan: ein Scan pro Woche, Umkreis bis 25 km, ein Gebiet und keine Automatik. Meldungen zu heißen Treffern kommen dort höchstens drei pro Woche.

Den Plan wechselst du unter Einstellungen → Konto → Plan & Abrechnung.

## recherche (12 Karten)

### Eine Beobachtung mit eigener Regel anlegen (zum Beispiel Geschäftsführerwechsel)
`beobachtung-anlegen` · gilt für: [alle] · Knöpfe: Beobachtung anlegen (Chat-Vorschlag), Beobachtungen öffnen (öffnet Seite)

> Fragen: beobachte wöchentlich geschäftsführungswechsel bei meinen firmen · sag mir wenn bei acme neue abschlüsse kommen · prüf regelmäßig ob sich bei meinen top firmen was ändert · watch anlegen · standing watch einrichten

Sag mir, worauf ich bei deinen Firmen achten soll, zum Beispiel „Beobachte wöchentlich Geschäftsführungswechsel bei meinen wichtigsten Firmen“. Ich mache daraus einen Entwurf: einen konkreten Satz, woran ich einen Treffer erkenne, wie oft ich prüfe (täglich, wöchentlich oder monatlich, sonst wöchentlich) und auf Wunsch nur bestimmte Firmen oder Arten von Fundstellen. Gespeichert wird erst nach deinem OK.

Dann prüfe ich neue Fundstellen zu deinen Firmen, etwa Publikationen, Änderungen bei Finanzzahlen oder im Firmenprofil, gegen deine Regel. Treffer landen in den Meldungen.

In der Desktop-App geht es auch unter Einstellungen → Recherche → Beobachtungen mit „+ Neuen Watch anlegen“. Im Chat ist es einfacher, weil ich die Firmen selbst erkenne.

Eine Beobachtung prüft die Daten, die AVA zu deinen Firmen hat. Soll ich eine bestimmte Webseite auf Änderungen prüfen, ist die Link-Überwachung das Richtige.

### Beobachtungen ansehen, pausieren oder löschen
`beobachtungen-verwalten` · gilt für: [alle] · Knöpfe: Beobachtungen zeigen (Chat-Vorschlag), Beobachtungen öffnen (öffnet Seite)

> Fragen: welche beobachtungen sind aktiv · was beobachtest du gerade für mich · pausiere die acme beobachtung · lösch die beobachtung · was hat meine beobachtung gefunden

Frag mich, was ich gerade beobachte. Ich nenne dir alle Beobachtungen mit Regel, Takt, letzter Prüfung und Treffern. Sag mir, welche ich pausieren, wieder aktivieren oder löschen soll.

In der Desktop-App siehst du dieselbe Liste unter Einstellungen → Recherche → Beobachtungen, mit „Pausieren“, „Aktivieren“ und „Löschen“. Beim Löschen gehen die bisherigen Treffer verloren; eine pausierte Beobachtung behält sie.

Höchstens 20 Beobachtungen sind gleichzeitig aktiv. Ist die Grenze erreicht, pausiere oder lösche eine andere. Die Treffer selbst stehen in den Meldungen.

### Auch Firmen außerhalb meiner Firmenliste finden, die etwas bieten oder nutzen
`bestand-suchen-ausserhalb` · gilt für: [alle] · Knöpfe: Außerhalb suchen (Chat-Vorschlag)

> Fragen: findest du auch andere firmen die sap nutzen · such auch außerhalb meiner firmenliste · gibt es weitere firmen mit bav die ich noch nicht habe · such im ganzen ava bestand

Nur wenn du es ausdrücklich willst, suche ich auch außerhalb deiner Firmenliste: in den Belegen aller Firmen, die AVA schon verarbeitet hat. Dann bekommst du höchstens fünf Kandidaten mit Name und Ort, ohne Zitat und ohne Quelle; die Details gibt es erst nach der Aufnahme.

Willst du einen Kandidaten genauer sehen, nehme ich ihn auf deinen Wunsch in deine Firmenliste auf. Das kostet wie jede Aufnahme, deshalb frage ich vorher. Findet sich auch dort nichts, kann ich dir einen Radar-Scan in einer Region anbieten.

### Welche meiner Firmen nutzen, bieten oder suchen etwas?
`bestand-suchen` · gilt für: [alle] · Knöpfe: Beispiel bAV (Chat-Vorschlag)

> Fragen: welche meiner firmen nutzen sap · gibt es firmen die bav anbieten · wer von meinen firmen sucht vertriebler · welche firmen beliefern automotive · wer ist nach iso 9001 zertifiziert

Frag mich einfach, zum Beispiel „welche meiner Firmen nutzen SAP“ oder „gibt es Firmen, die bAV anbieten“. Ich durchsuche die Belege aller Firmen in deiner Firmenliste: Stellenanzeigen, Karriereseiten, Fokus-Themen, Referenzen und Partner, Firmenprofile und Jahresabschlüsse. Dabei suche ich mit mehreren Schreibweisen und Synonymen.

Du bekommst eine Tabelle mit Firma, Beleg als kurzem Zitat und Quelle, dazu wie viele Firmen insgesamt passen. Standardmäßig zeige ich fünf; sag zum Beispiel „zeig mir 50“, höchstens 100.

Ich ordne die Belege ein: Wird SAP nur als Partner oder Referenz genannt, heißt das nicht, dass die Firma SAP nutzt. Unsichere Treffer kennzeichne ich. Was nirgends belegt ist, finde ich nicht; dann sage ich das offen.

### Fokus-Themen festlegen, nach denen AVA auf jeder Firmen-Website sucht
`fokus-themen-anlegen` · gilt für: [alle] · Knöpfe: Thema anlegen (Chat-Vorschlag), Fokus-Themen öffnen (öffnet Seite)

> Fragen: leg ein fokus thema an · ava soll bei allen firmen nach betrieblicher altersvorsorge schauen · auf den websites nach iso 27001 suchen · eigene suchkriterien für meine firmen · was sind fokus themen

Fokus-Themen sind das, was dich persönlich an einer Firma interessiert, zum Beispiel „Betriebliche Altersvorsorge“, „ISO 27001“ oder „Photovoltaik“. Ich suche dann auf der Website jeder deiner Firmen zusätzlich danach: Je Thema wähle ich passende Seiten, suche nach den Begriffen und prüfe die Fundstellen. Ein Fund trägt immer ein wörtliches Zitat und die Seite als Quelle.

Sag mir Thema und wozu du es brauchst, dann lege ich es nach deinem OK an und ergänze Synonyme, Schreibweisen und englische Begriffe. Hast du noch keine Idee, schlage ich dir aus deinem Idealkundenprofil zwei bis drei vor.

In der Desktop-App geht es unter Einstellungen → Recherche → Fokus-Themen mit „+ Thema anlegen“: Name, was gemeint ist, wozu du es brauchst und eigene Suchbegriffe. „Begriffe ergänzen lassen“ fügt weitere hinzu. Höchstens fünf Themen sind gleichzeitig aktiv; weitere kannst du anlegen und ausgeschaltet lassen.

### Ergebnisse meiner Fokus-Themen bei einer Firma ansehen und neu prüfen
`fokus-themen-ergebnisse` · gilt für: [alle] · Knöpfe: Jetzt prüfen (Chat-Vorschlag)

> Fragen: bietet die firma laut website bav an · was hast du zu meinem fokus thema gefunden · wo ist der reiter mein fokus · prüf meine fokus themen bei firma x jetzt · fokus thema nicht gefunden obwohl es auf der website steht

In der Firmenansicht steht der Reiter „Mein Fokus“, sobald du Fokus-Themen hast. Je Thema siehst du „Gefunden“, „Unklar“ oder „Nicht gefunden“, dazu das wörtliche Zitat, die Seite als Quelle und das Datum der Prüfung. Bei „Unklar“ lohnt ein Blick auf das Zitat.

Neu geprüft wird mit dem nächsten Website-Lauf der Firma. Willst du es sofort, sag mir die Firma, oder klick in der Übersicht der Firma unter „Gezielte Recherche“ auf „Fokus prüfen“. Das läuft auf deinem allgemeinen KI-Modell und dauert etwa eine Minute.

Über alle Firmen hinweg frag mich einfach, etwa „welche meiner Firmen bieten bAV“.

### Eine Webseite überwachen lassen und bei Änderungen benachrichtigt werden
`link-ueberwachung-anlegen` · gilt für: [alle] · Knöpfe: Seite überwachen (Chat-Vorschlag), Link-Überwachung öffnen (öffnet Seite)

> Fragen: sag mir wenn sich auf dieser seite was ändert · überwache die preisseite · gib mir stündlich ein update zu dieser url · beobachte die karriereseite von firma x · melde neue produkte im shop

Schick mir den Link und sag, wie oft ich schauen soll und worauf ich achten soll, etwa „alle 30 Minuten, auf neue Produkte achten, alle Seiten der Liste durchgehen“. Nennst du keine Frequenz, frage ich nach. Möglich ist alle 5 Minuten bis wöchentlich. Ich öffne die Seite dann regelmäßig in einem Browser auf deinem Rechner und melde Änderungen wie neue Produkte, Preise oder Stellen als Meldung und Benachrichtigung. Das geht auch bei LinkedIn-Profilen und Unternehmensseiten.

In der Desktop-App geht es auch unter Einstellungen → Recherche → Link-Überwachung: Link, „Worauf achten?“ und Frequenz, dann „Überwachung starten“.

Höchstens fünf Überwachungen laufen gleichzeitig; weitere lege ich pausiert an.

### Die überwachte Seite lädt nicht oder zeigt eine Sicherheitsprüfung
`link-ueberwachung-bot-schutz` · gilt für: [desktop] · Knöpfe: Jetzt prüfen (Chat-Vorschlag), Link-Überwachung öffnen (öffnet Seite)

> Fragen: die link überwachung zeigt fehler · cloudflare prüfung bei der überwachung · seite lädt nicht bei der überwachung · timeout teilergebnis was heißt das · hat die seite wirklich geladen

Viele Shops und Seiten haben einen Bot-Schutz, etwa die Sicherheitsprüfung von Cloudflare. Läuft sie, warte ich bis zu 25 Sekunden ab. Geht sie von selbst durch, prüfe ich normal weiter. Bleibt sie stehen, löse ich sie nicht und umgehe sie nicht; der Lauf zeigt dann nicht die Zielseite.

Sehr kurze Intervalle lösen den Schutz häufiger aus. Für Verfügbarkeit und Preise sind 30 bis 60 Minuten meist die verlässlichere Wahl. Steht „Timeout (Teilergebnis)“ in der Zeile, hat die Seite zu lange gebraucht.

Ob eine Seite wirklich geladen hat, zeigt das Bildschirmfoto, das ich bei jedem Lauf aufnehme. Du findest es unter Einstellungen → Erweitert → Verlauf beim jeweiligen Eintrag. Je Überwachung bewahre ich die letzten zehn auf.

### Link-Überwachungen ändern, pausieren oder sofort prüfen
`link-ueberwachung-verwalten` · gilt für: [alle] · Knöpfe: Überwachungen zeigen (Chat-Vorschlag), Link-Überwachung öffnen (öffnet Seite)

> Fragen: welche links überwachst du · prüf die seite jetzt · pausiere die überwachung · ändere die frequenz auf täglich · überwache die seite nicht mehr

Frag mich, welche Links ich überwache. Ich nenne dir je Überwachung Status, Frequenz, letzte Prüfung und die letzte erkannte Änderung. Sag mir, was ich ändern soll: Link, Anweisung oder Frequenz, pausieren, fortsetzen, löschen oder sofort prüfen.

In der Desktop-App hat unter Einstellungen → Recherche → Link-Überwachung jede Zeile „Jetzt prüfen“, „Pause“ oder „Fortsetzen“, „Bearbeiten“ und „Löschen“. Ein Durchlauf kann bis zu drei Minuten dauern. Löschen entfernt die Überwachung samt Verlauf.

Gleichzeitig aktiv sind höchstens fünf. Willst du eine weitere fortsetzen, pausiere vorher eine andere.

### Ausschreibungen, Expansion und Beschaffung einer Firma recherchieren
`recherche-ausschreibungen` · gilt für: [alle] · Knöpfe: Recherche starten (Chat-Vorschlag)

> Fragen: expandiert die firma gerade · gibt es ausschreibungen von firma x · plant die firma neue standorte · öffentliche ausschreibungen der stadtwerke suchen · such nach expansionsplänen

Expansionsankündigungen und Ausschreibungen sind gute Anlässe für eine Ansprache; passen sie zu deiner Frage, nenne ich sie dir von selbst. Sag mir die Firma, dann suche ich im Web nach Expansionsankündigungen, öffentlichen Ausschreibungen und Beschaffungsmeldungen. Nach deinem OK dauert das etwa eine Minute; es läuft über AVA, ohne Schlüssel und ohne Kosten für dich.

Die Treffer stehen in der Firmenansicht im Reiter „Expansion & Ausschreibungen“, jeder mit Art und Quelle, oft mit weiteren Belegen. Der Reiter erscheint, sobald es Treffer gibt.

In der Desktop-App kannst du es auch selbst anstoßen: in der Übersicht der Firma unter „Gezielte Recherche“ mit „Jetzt suchen“ neben Ausschreibungen, Expansion & Beschaffung.

### Eine Webseite lesen lassen und Fragen dazu beantworten
`seite-lesen` · gilt für: [alle] · Knöpfe: Karriereseite lesen (Chat-Vorschlag)

> Fragen: lies diese seite · was steht auf dieser webseite · schau auf der karriereseite ob sie homeoffice anbieten · fass die pressemitteilung zusammen · read this url

Gib mir eine Adresse und sag, worauf es dir ankommt, etwa „Lies die Karriereseite und sag mir, ob sie betriebliche Altersvorsorge anbieten“. Ich lese die Seite und antworte dir daraus. Das geht auch bei Seiten, die sich erst im Browser aufbauen. Ich lese bis zu 20.000 Zeichen sichtbaren Text.

Grenzen: keine Seiten hinter einer Anmeldung, keine Downloads, keine Adressen aus lokalen oder privaten Netzen, und Seiten, die das Auslesen per robots.txt komplett verbieten, lese ich nicht.

Schickst du mir einen Link ganz ohne Kommentar, frage ich zuerst, ob ich ihn regelmäßig überwachen soll. Für eine laufende Beobachtung auf Änderungen ist die Link-Überwachung da.

### Stammdaten mitpflegen und Register-Abfragen auf meinem Rechner erlauben
`stammdaten-mithelfen` · gilt für: [desktop] · Knöpfe: Stand zeigen (Chat-Vorschlag), Mitpflegen öffnen (öffnet Seite)

> Fragen: was ist stammdaten mitpflegen · mithelfen einschalten · was macht mein rechner im hintergrund mit dem handelsregister · register jobs auf meinem rechner · nur handelsregister verarbeiten was heißt das

Die Firmendaten kommen aus dem Handelsregister. Schaltest du „Mithelfen“ ein, fragt dein Rechner das Register im Hintergrund ab, höchstens 60 Mal je Stunde und ohne Downloads. Davon haben alle Nutzer etwas. Standardmäßig ist es aus.

Du findest es unter Einstellungen → Recherche → Stammdaten mitpflegen. Standardmäßig pausiert es im Akkubetrieb. Dort siehst du auch, woran dein Rechner gerade arbeitet, wie viele Abfragen in der letzten Stunde liefen und was er insgesamt beigetragen hat. Sperrt das Registerportal vorübergehend, geht es danach von selbst weiter.

„Nur Handelsregister verarbeiten“ lässt alles andere ruhen, also Prüfläufe, Verarbeitung, Abläufe, Mail und Radar, bis du es wieder ausschaltest.

Hat deine Organisation das Mithelfen abgeschaltet, steht das dort. Den Stand kann ich dir auch hier nennen und den Schalter umlegen.
