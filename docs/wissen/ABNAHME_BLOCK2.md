# Abnahme Block 2: Firmen

Stand 2026-11-07. Je Karte: Titel, Beispielfragen, Knöpfe (erscheinen unter AVAs Antwort), Text so, wie AVA ihn liest.
Rückmeldung am einfachsten im Chat: „ok“ für den ganzen Ast oder je Karte die id mit dem, was falsch ist.

## firmen (48 Karten)

### Firmen aus HubSpot oder Close in AVA übernehmen
`crm-firmen-uebernehmen` · gilt für: alle Kanäle · Knöpfe: Aus CRM übernehmen (Chat-Vorschlag), CRM verbinden (öffnet Seite)

> Fragen: importiere alle firmen aus hubspot · firmen aus close übernehmen · alles aus dem crm anreichern · crm firmen in ava laden · salesforce import geht das

Ist dein CRM verbunden, hole ich die Firmen direkt von dort, bei HubSpot die Firmen, bei Close die Leads. Ich zeige dir zuerst eine Vorschau, wie viele ich eindeutig zuordnen konnte und welche unklar sind; die unklaren klärst du in einer Karte. Dann starte ich einen Vorgang für alle, und die AVA-Firmen bleiben mit dem jeweiligen CRM-Eintrag verknüpft. Du kannst weiterarbeiten, ich melde mich, wenn der Import fertig ist.

Gut zu wissen: Ich brauche je Firma Name und Ort. Firmen ohne Ort im CRM überspringe ich; pflege dort das Feld für die Stadt nach. Je Lauf übernehme ich bis zu 5.000 Firmen. Jede aufgenommene Firma zählt in deinem Kontingent.

Salesforce und Microsoft Dynamics kann ich noch nicht übernehmen. Dann geht der Weg über eine Excel-Datei aus dem CRM.

Ist das CRM noch nicht verbunden, findest du unter meiner Antwort den Knopf zur Seite dafür.

### Wie aktuell die Firmendaten sind und wie oft AVA auffrischt
`daten-aktualitaet` · gilt für: alle Kanäle · Knöpfe: Anstehendes zeigen (Chat-Vorschlag)

> Fragen: wie aktuell sind die daten · wann wurde die firma zuletzt aktualisiert · frischst du die daten automatisch auf · kann ich das aktualisierungsintervall ändern · aktualisiere jetzt meine firmen

Ich frische deine aktiven Firmen von selbst auf: Website, Profil und Kontakte alle 14 Tage, Registerinhalt und Jahresabschlüsse alle 30 Tage. Firmen, die dir wichtiger sind, kommen früher dran; schlägt eine Auffrischung fehl, ruht der Schritt einen Tag. Registeränderungen kommen zusätzlich täglich aus den Registern. Wann eine Firma zuletzt verarbeitet wurde, steht in Meine Firmen in der Spalte „Zuletzt verarbeitet“.

Was ich auf Zuruf tun kann: dir zeigen, was gerade zur Auffrischung ansteht, sofort eine Runde starten (einige Firmen je Runde, gedrosselt) und einzelne Firmen priorisieren, damit sie immer zuerst drankommen.

Den Rhythmus, eine Pause oder Drosselung der Auffrischung kannst du nicht selbst einstellen. Brauchst du eine Firma sofort ganz frisch, lass sie komplett neu verarbeiten. Ruhende Firmen werden nicht aufgefrischt.

### Bei einer Firma fehlen Daten (Kontakte, Profil, Website, Kennzahlen)
`daten-fehlen-bei-firma` · gilt für: alle Kanäle · Knöpfe: Fehlendes nachholen (Chat-Vorschlag)

> Fragen: warum fehlen bei firma x die kontakte · keine ansprechpartner bei der firma · wieso hat die firma kein profil · da steht gar nichts zur firma · die firma ist leer

Sag mir die Firma, dann sehe ich nach, wie weit sie verarbeitet ist, und handle gleich:

- Noch nicht aufgenommen: Ich nehme sie auf und bereite sie vollständig auf.
- Läuft noch: Ich verfolge die Verarbeitung und melde mich, wenn sie fertig ist.
- Ein Schritt fehlt oder ist fehlgeschlagen: Ich hole genau diesen Schritt nach, kostenlos.
- Die Firma ruht bei dir: Dann zeige ich nur Grunddaten; mit „Aktivieren“ wird sie wieder aufbereitet.

Bleibt es danach leer, liegt es an der Quelle: Ohne gefundene Website gibt es kein Profil, keine Kontakte und keine Stellen. Ohne veröffentlichten Abschluss gibt es keine Kennzahlen, und für manche Länder liefert das Register keine Personen. Kontakte siehst du außerdem nur, wenn deine Organisation das Modul Kontakte freigeschaltet hat.

### Wie verlässlich sind die Daten zu einer Firma?
`datenqualitaet` · gilt für: alle Kanäle · Knöpfe: Datenqualität prüfen (Chat-Vorschlag)

> Fragen: wie verlässlich sind die daten · woher hast du diese infos · kann ich den angaben trauen · mit welchem modell wurde die firma verarbeitet · data quality of this company

Für jeden Schritt einer Firma weiß ich, mit welchem KI-Modell und wann er gelaufen ist und wie verlässlich dieses Modell eingestuft ist. Frag mich „Wie verlässlich sind die Daten?“. Stammen Angaben, die ich dir nenne, von einem schwächeren Modell, sage ich das in einem Satz dazu.

Daten von einem schwächeren Modell überschreiben nie bessere Daten, die schon vorliegen. Registerangaben kommen direkt aus dem amtlichen Register, Kontakte tragen ihren Beleg und ihre Herkunft. Zahlen aus Abschlüssen nenne ich mit der Fundstelle.

Wirkt eine Angabe falsch, sag es mir. Ich kann den Schritt neu laufen lassen oder die ganze Firma neu verarbeiten; bleibt es falsch, melde es über „Problem melden“.

### Eine Excel- oder CSV-Liste mit Firmen importieren
`excel-liste-importieren` · gilt für: [desktop] · Knöpfe: Liste importieren (Chat-Vorschlag), Excel hochladen (öffnet Seite)

> Fragen: excel datei mit firmen hochladen · csv importieren · ich hab eine liste mit 200 firmen · wie lade ich meine leadliste hoch · import xlsx file

Zieh die Datei einfach in den Chat (Excel oder CSV). Ich erkenne, welche Spalte den Firmennamen und welche den Ort enthält, und sage dir das vor dem Start. Mehrere Spalten gehen auch, etwa Postleitzahl und Ort. Der Ort ist wichtig, weil viele Firmen gleich heißen. Vorher prüfe ich, welche Firmen ich eindeutig zuordnen kann, und starte nach deinem OK einen Vorgang für die ganze Liste. Die Datei halte ich 30 Minuten bereit, danach lädst du sie bitte neu hoch.

Ohne Chat: Vorgänge → Importieren. Dort lädst du eine .xlsx-Datei hoch und trägst die Überschriften der Spalten für Firmenname und Stadt selbst ein.

Eine Datei ordne ich gegen das deutsche Handelsregister zu. Firmen aus Österreich, der Schweiz, UK, Norwegen oder Finnland nenn mir lieber als Liste mit Land, dann suche ich sie im richtigen Register.

Danach verarbeite ich jede Firma im Hintergrund. Die Leiste über dem Eingabefeld zeigt den Fortschritt, und ich melde mich von selbst, wenn alles fertig ist.

### AVA hat einer Firma die falsche Website zugeordnet
`falsche-website` · gilt für: alle Kanäle · Knöpfe: Website prüfen lassen (Chat-Vorschlag)

> Fragen: falsche website bei der firma · die website gehört zu einer anderen firma · ava hat die falsche homepage gefunden · profil und kontakte passen nicht zur firma · wrong website assigned

Bei gleichnamigen Firmen kann ich die Website einer anderen Firma erwischen; dann passen Profil, Leistungen und Kontakte nicht. Sag mir, welche Firma betroffen ist und, wenn du sie kennst, die richtige Website.

Was ich tun kann: die Website-Verarbeitung erneut anstoßen, notfalls die ganze Firma neu verarbeiten. Ganz neu zu verarbeiten zählt wie eine weitere Aufnahme in deinem Kontingent, deshalb frage ich vorher. Ob dabei eine andere Website herauskommt, kann ich nicht versprechen.

Was heute nicht geht: Eine Website von Hand festlegen oder eine falsche sperren. Bleibt die Zuordnung falsch, melde es über „Problem melden“ mit Firma und richtiger Website, dann kümmert sich das Team darum. Für Firmen ohne Registereintrag gilt die Website, die du bestätigt hast.

### Eine einzelne Firma in Meine Firmen übernehmen
`firma-einzeln-aufnehmen` · gilt für: alle Kanäle · Knöpfe: Firmensuche öffnen (öffnet Seite)

> Fragen: wie füge ich eine firma zu meinen firmen hinzu · leg mir die Foo GmbH aus Berlin an · firma übernehmen und verarbeiten · add company to my list · wie bekomme ich die firma in meine liste

Sag mir einfach „nimm die Firma X aus Y auf“. Ich suche sie, und wenn genau eine passt, nehme ich sie sofort auf und verarbeite sie. Fragst du mich nach einer Firma, die noch nicht aufbereitet ist, bereite ich sie ebenfalls von selbst auf.

In der App: Öffne die Firma über die Firmensuche. Oben rechts auf der Firmenseite steht „Übernehmen und verarbeiten“. Danach steht die Firma in Meine Firmen, und unter „Fortschritt ansehen“ siehst du den Stand. Ist sie schon übernommen, zeigt der Knopf „Neu verarbeiten“ und daneben den Weg „in Meine Firmen“.

Andere Wege: aus dem Radar, aus den Referenzen einer Firma (Knopf „Übernehmen“) oder aus deinem CRM. Jede Aufnahme zählt in deinem Kontingent. Ist das Kontingent voll, wird die Firma übernommen, ruht aber, bis Platz frei ist.

### Eine Firma aus Meine Firmen entfernen
`firma-entfernen` · gilt für: [desktop] · Knöpfe: Meine Firmen öffnen (öffnet Seite)

> Fragen: kann ich eine firma wieder entfernen · firma aus meiner liste löschen · falsch importierte firma rausnehmen · remove company from my list · wie werde ich eine firma wieder los

In Meine Firmen hat jede Zeile rechts einen Papierkorb „Aus der Liste entfernen“. Nach einer kurzen Rückfrage verschwindet die Firma aus deiner Übersicht, ebenso ihr Verarbeitungsstand bei dir; Vorgänge, die dadurch leer werden, verschwinden aus der Liste. Die Firma selbst bleibt im gemeinsamen Bestand, andere Nutzer sind nicht betroffen. Für die Abrechnung wirkt das Entfernen ab dem Folgemonat. Im Chat kann ich eine Firma heute nicht entfernen, das geht nur dort.

Willst du sie behalten, aber nicht weiter verarbeiten lassen, gibt es zwei mildere Wege: das Pause-Zeichen setzt die Verarbeitung dieser Firma aus. Du kannst sie auch ruhen lassen; dann bleibt sie mit Grunddaten in der Liste und zählt ab dem Folgemonat nicht mehr im Kontingent. Ruhen lassen kann ich auch im Chat für dich.

Was das für deine Abrechnung heißt, erkläre ich dir gern im Einzelnen.

### Eine Firma komplett neu verarbeiten lassen
`firma-neu-verarbeiten` · gilt für: alle Kanäle · Knöpfe: Neu verarbeiten (Chat-Vorschlag)

> Fragen: verarbeite die firma komplett neu · alles nochmal von vorne für firma x · daten sind veraltet bitte neu holen · firma neu verarbeiten kostet das was · reprocess company

Willst du eine Firma trotz frischer Daten ganz neu haben, starte ich alle Schritte erneut: Register, Abschlüsse, Website, Profil, Kontakte und E-Mail-Adressen. Ich frage vorher kurz nach, weil das wie eine weitere Aufnahme in deinem Monatskontingent zählt. Es dauert einige Minuten, ich melde mich mit dem Ergebnis.

In der App: Firmenseite, oben rechts „Neu verarbeiten“, oder in Meine Firmen im Protokoll der Firma „Firma komplett neu verarbeiten“.

Oft reicht weniger: Fehlt nur ein Schritt oder ist einer fehlgeschlagen, starte ich nur diesen neu, kostenlos. Und deine Firmen werden ohnehin regelmäßig aufgefrischt.

### Eine Firma wird nicht gefunden
`firma-nicht-gefunden` · gilt für: alle Kanäle · Knöpfe: Firma suchen lassen (Chat-Vorschlag)

> Fragen: firma nicht gefunden · die firma gibt es bei euch nicht · ava findet meine firma nicht · kein treffer bei der suche obwohl es die firma gibt · company not found

Sag mir den Namen und am besten den Ort. Findet meine normale Suche nichts, gehe ich weiter, bevor ich „nicht gefunden“ sage:

1. Ich suche live im Handelsregister (handelsregister.de) mit dem Browser deiner AVA. Das dauert 30 bis 90 Sekunden. Treffer kommen sofort in den Bestand, die passende Firma nehme ich gleich auf. So finde ich auch frisch eingetragene Firmen.
2. Gibt es keinen Registereintrag, suche ich den Google-Eintrag der Firma und prüfe, ob sie eine eigene, erreichbare Website hat. Bin ich mir sicher, lege ich sie als Firma ohne Registereintrag an und verarbeite sie.
3. Bin ich unsicher, zeige ich dir die Kandidaten mit Begründung, und du bestätigst die richtige Website.

Grenzen: Die Live-Suche im Register geht nur für deutsche Firmen. Firmen ohne eigene Website nehme ich nicht auf. Sperrt das Registerportal die Abfragen vorübergehend, klappt es meist nach einer Stunde wieder.

### Firmen ohne Handelsregistereintrag aufnehmen (Einzelunternehmer, Praxen, GbR)
`firma-ohne-registereintrag` · gilt für: alle Kanäle · Knöpfe: Firma ohne Register aufnehmen (Chat-Vorschlag)

> Fragen: einzelunternehmer aufnehmen · die firma steht nicht im handelsregister · freiberufler als firma anlegen · firma ohne hrb · kann ich eine gbr in ava anlegen

Auch Firmen ohne Registereintrag kann ich aufnehmen, etwa Einzelunternehmer, Praxen oder eine GbR. Voraussetzung ist eine eigene, erreichbare Website mit echtem Inhalt. Social-Media-Seiten, Linksammlungen, Branchenverzeichnisse, Unterseiten von Website-Baukästen oder geparkte Domains zählen nicht.

So geht es: Nenn mir Namen und Ort oder gleich die Website. Ich prüfe den Google-Eintrag und die Website und lege die Firma nur an, wenn ich sicher bin, dass es ihre eigene ist. Sonst zeige ich dir die Kandidaten und frage nach.

Was du dann bekommst: Website, Profil, Kontakte und E-Mail-Adressen. Registerdaten, Geschäftsführung aus dem Register und Jahresabschlüsse gibt es für solche Firmen nicht. Auf der Firmenseite steht „ohne Registereintrag“ mit der Website. Gehört die Website schon zu einer Firma mit Registereintrag, lege ich keine zweite an, sondern nehme die bestehende.

### Eine Firma über die Registernummer finden oder aufnehmen
`firma-per-registernummer` · gilt für: alle Kanäle · Knöpfe: Firmensuche öffnen (öffnet Seite)

> Fragen: kann ich nach hrb nummer suchen · firma über handelsregisternummer finden · FN nummer aus österreich eingeben · uk company number suchen · firmen-id statt name importieren

In der Firmensuche kannst du statt des Namens die Registernummer eingeben. AVA zeigt je Land die amtliche Kennung: HRB oder HRA in Deutschland, FN im österreichischen Firmenbuch, die CHE-Nummer in der Schweiz, CRN bei Companies House, Org.nr. in Norwegen und Y-Tunnus in Finnland.

Im Chat nennst du mir die Nummer, in Deutschland am besten mit Registergericht oder Ort, weil dieselbe HRB-Nummer bei mehreren Gerichten vorkommt. Habe ich die Firma gefunden, nehme ich sie über ihre eindeutige Kennung auf. Das ist der sicherste Weg: Er klappt für jedes Land, ohne Namensabgleich und ohne Vorschau.

Für Listen gilt dasselbe: Kenne ich die Firmen schon aus der Suche, übernehme ich sie direkt über ihre Kennung statt über Name und Ort.

### Eine Firma bei der Auffrischung priorisieren
`firma-priorisieren` · gilt für: alle Kanäle · Knöpfe: Firma priorisieren (Chat-Vorschlag)

> Fragen: priorisiere acme · diese firma bitte immer zuerst aktualisieren · firma wichtiger machen bei der aktualisierung · priorität wieder entfernen · pin company

Sag mir „priorisiere ACME“. Dann rückt die Firma bei der Auffrischung immer nach vorn: Sind ihre Daten fällig, kommt sie vor allen anderen dran. Mit „ACME nicht mehr priorisieren“ nehme ich das wieder zurück. War die Firma gar nicht priorisiert, sage ich dir das.

Priorisieren beschleunigt nur die Reihenfolge, es frischt nicht sofort auf. Brauchst du die Daten gleich, kann ich eine Auffrischungsrunde sofort starten oder die Firma komplett neu verarbeiten; Letzteres zählt wie eine weitere Aufnahme in deinem Kontingent.

Eine eigene Schaltfläche dafür gibt es in der App nicht, das geht im Chat.

### Eine Firma in AVA suchen (Firmensuche über alle Firmen)
`firma-suchen` · gilt für: alle Kanäle · Knöpfe: Firmensuche öffnen (öffnet Seite)

> Fragen: wie finde ich eine firma · such mal nach Müller Maschinenbau in Straubing · gibt es die firma xy bei euch · wo ist die firmensuche · search company by name

Nenn mir einfach den Namen, gern mit Ort. Ich suche unscharf über rund 10,5 Millionen Firmen aus Deutschland, Österreich, der Schweiz, dem Vereinigten Königreich, Norwegen und Finnland; Tippfehler und Schreibvarianten sind kein Problem. Passt genau ein Treffer, mache ich direkt weiter. Gibt es mehrere gleichnamige Firmen, zeige ich dir die Kandidaten mit Ort zur Auswahl. Gelöschte Firmen oder Firmen in Insolvenz nenne ich dir ausdrücklich.

Selbst suchen: Firmen → Firmensuche. Ab zwei Zeichen erscheinen Treffer; du kannst nach Firmenname, Ort oder Registernummer suchen und nach Land filtern. Ein Klick öffnet die Firmenseite.

Die Firmensuche zeigt den ganzen Bestand. Deine eigenen, aufbereiteten Firmen findest du unter Firmen → Meine Firmen. Firmen aus anderen Ländern als den sechs genannten sind nicht im Bestand.

### Firmen nach Land, Gründungsjahr oder Fokus-Thema filtern
`firmen-filtern` · gilt für: alle Kanäle · Knöpfe: Firmensuche öffnen (öffnet Seite), Meine Firmen öffnen (öffnet Seite)

> Fragen: kann ich nach gründungsjahr filtern · zeig nur firmen aus österreich · filter nach branche gibt es das · firmen nach mitarbeiterzahl filtern · show only UK companies

In der Firmensuche (Firmen → Firmensuche) filterst du nach Land und nach Gründungsjahr von bis und sortierst nach „Älteste zuerst“ oder „Jüngste zuerst“. Das Gründungsjahr kennt AVA nur bei Firmen, deren Registerinhalt schon abgerufen wurde. Mit Jahresfilter wird der Name wörtlich gesucht, nicht unscharf.

In Meine Firmen filterst du nach Land, nach einem deiner Fokus-Themen („… gefunden“) und, falls dein Plan mit aktiven und ruhenden Firmen arbeitet, nach Aktiv oder Ruhend.

Im Chat suche ich ebenfalls mit Gründungsjahr. Nach Branche, Mitarbeiterzahl oder Bundesland filtert die Firmensuche heute nicht. Für neue Firmen in einer Region nutze das Radar. Für deine eigenen Firmen frag mich direkt, etwa „welche meiner Firmen suchen gerade Vertriebler“; dann durchsuche ich ihre Belege.

### Firmen in die Firmenliste aufnehmen (Liste, Namen oder aus dem CRM)
`firmen-importieren` · gilt für: [desktop] · Knöpfe: Liste importieren (Chat-Vorschlag)

> Fragen: wie bekomme ich meine Firmen in AVA · Excel-Liste importieren · nimm diese Firmen auf · Firmen aus HubSpot übernehmen · Kundenliste hochladen

Es gibt drei Wege, Firmen in deine Firmenliste zu bringen:

1. Zieh eine Excel- oder CSV-Datei in den Chat. Ich erkenne die Spalten, zeige dir vorher, welche Firmen ich gefunden habe, und nehme sie nach deinem OK auf.
2. Nenn mir einfach Firmennamen, am besten mit Ort. Ich suche sie im Register und nehme sie auf.
3. Ist dein CRM verbunden, übernehme ich die Firmen von dort.

Danach bereite ich jede Firma im Hintergrund auf: Register, Website, Jahresabschlüsse und Ansprechpartner. Du kannst sofort weiterarbeiten, ich melde mich, wenn alles da ist.

### Firmen aus Norwegen und Finnland in AVA
`firmen-norwegen-finnland` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: norwegische firmen suchen · gibt es finnische firmen · firmen aus oslo importieren · y-tunnus suchen · nordic companies

Norwegische Firmen kommen aus dem Enhetsregisteret und tragen die Org.nr., finnische aus dem Handelsregister Finnlands mit der Y-Tunnus. Du findest sie in der Firmensuche und im Chat.

Aufnehmen: Kenne ich die Firma aus der Suche, nehme ich sie über ihre Kennung auf. Nennst du mir Namen, sag „Norwegen“ oder „Finnland“ dazu, sonst suche ich im deutschen Register.

Was es gibt: Name, Rechtsform, Sitz, Anschrift und Status, dazu Website, Profil, Kontakte, Stellen und Referenzen. Für Norwegen kommen die Rollen aus dem Register als Geschäftsführung, Konkurse aus dem Register. Für Finnland enthalten die offenen Registerdaten keine Personen.

Was es nicht gibt: Jahresabschlüsse, deshalb fehlt der Reiter Finanzen, und Verflechtungen. Schweden und Dänemark sind noch nicht dabei.

### Firmen aus Österreich in AVA (Firmenbuch)
`firmen-oesterreich` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: österreichische firmen importieren · firmenbuch österreich · firmen aus wien suchen · warum fehlt bei der österreichischen firma der geschäftsführer · austrian companies

Österreichische Firmen kommen aus dem Firmenbuch und tragen die Kennung FN, etwa „FN 56247t“. Du findest sie in der Firmensuche, im Chat und im Radar.

Aufnehmen: Kenne ich die Firma aus der Suche, nehme ich sie über ihre Kennung auf. Nennst du mir Namen, sag „Österreich“ dazu, sonst suche ich im deutschen Register. Eine Excel-Datei ordne ich gegen das deutsche Register zu; österreichische Firmen nenn mir deshalb lieber als Liste mit Land.

Was es gibt: Name, Rechtsform, Sitz, Anschrift, dazu Website, Profil, Kontakte, Stellen und Referenzen wie überall. Insolvenzen kommen aus der Ediktsdatei und werden regelmäßig geprüft.

Was es nicht gibt: Die Geschäftsführung und Gesellschafter stehen nur im kostenpflichtigen Firmenbuchauszug, den AVA nicht abruft. Personen kommen deshalb nur von der Website. Jahresabschlüsse und Verflechtungen gibt es für Österreich nicht.

### Firmen aus der Schweiz in AVA (Handelsregister Schweiz)
`firmen-schweiz` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: schweizer firmen importieren · gibt es firmen aus der schweiz · zefix daten · warum keine jahresabschlüsse bei der schweizer ag · swiss companies

Schweizer Firmen kommen aus dem Handelsregister der Schweiz und tragen ihre UID, etwa „CHE-101.602.521“. Du findest sie in der Firmensuche, im Chat und im Radar.

Aufnehmen: Kenne ich die Firma aus der Suche, nehme ich sie über ihre Kennung auf. Nennst du mir Namen, sag „Schweiz“ dazu, sonst suche ich im deutschen Register.

Was es gibt: Name, Rechtsform, Sitz und Kanton, Zweck, Kapital, Anschrift, Gründungsjahr und frühere Namen, dazu Website, Profil, Kontakte, Stellen und Referenzen. Löschungen, Liquidationen und Konkurse kommen täglich aus dem Handelsamtsblatt.

Was es nicht gibt: Jahresabschlüsse sind in der Schweiz nicht öffentlich, deshalb fehlt der Reiter Finanzen. Personen wie Verwaltungsrat oder Geschäftsführung liefern die öffentlichen Registerdaten nicht; sie kommen nur von der Website. Verflechtungen gibt es nicht. Die Live-Suche im Register geht für die Schweiz nicht.

### Firmen aus dem Vereinigten Königreich in AVA (Companies House)
`firmen-uk` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: englische firmen importieren · companies house daten · firmen aus london suchen · uk ltd aufnehmen · british companies

Firmen aus dem Vereinigten Königreich kommen von Companies House und tragen die Kennung CRN, etwa „CRN 00077570“. Du findest sie in der Firmensuche, im Chat und im Radar.

Aufnehmen: Kenne ich die Firma aus der Suche, nehme ich sie über ihre Kennung auf. Nennst du mir Namen, sag „UK“ dazu, sonst suche ich im deutschen Register.

Was es gibt: Name, Rechtsform, Status, Gründung, Anschrift und Branchenschlüssel, die aktiven Directors als Geschäftsführung, dazu Website, Profil, Kontakte, Stellen und Referenzen. Insolvenzen kommen von Companies House und aus der Gazette.

Was es nicht gibt: Jahresabschlüsse lese ich für britische Firmen heute nicht, Gesellschafter und Verflechtungen gibt es nur für deutsche Firmen. Die Live-Suche im Register geht für UK nicht.

### Firmen im Chat anklicken und die Firmenseite öffnen
`firmenlink-im-chat` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: wie komme ich von deiner antwort zur firma · öffne die firma · zeig mir die firmenseite · der firmenname ist nicht klickbar · open company page

Nenne ich im Chat eine Firma, die in AVA steht, ist ihr Name ein Link. Ein Klick öffnet die Firmenseite mit allen Reitern. Sag mir auch einfach „öffne die Firma“, dann bekommst du in der Desktop-App unter meiner Antwort einen Knopf dorthin.

Ohne Link erscheinen Firmen, die noch nicht in AVA stehen, zum Beispiel in der Vorschau eines Imports, bevor du ihn bestätigt hast. Für sie gibt es noch keine Firmenseite. Personen verlinke ich nie, nur Firmen.

Auf Telegram kann ich keine Seite öffnen. Dort nenne ich dir die Firma, und du findest sie in der App oder unter app.ava.bi über die Firmensuche.

### Mehrere Firmen per Namen im Chat aufnehmen (eingefügte Liste)
`firmenliste-einfuegen` · gilt für: alle Kanäle · Knöpfe: Liste einfügen (Chat-Vorschlag)

> Fragen: ich kopier dir mal eine liste mit firmen rein · nimm diese 10 firmen auf · firmennamen aus linkedin übernehmen · leg mir diese firmen an · add these companies

Füg die Namen einfach in den Chat ein, je Zeile eine Firma, am besten mit Ort. Fehlt der Ort, nehme ich den bekannten Hauptsitz; die Vorschau zeigt dir, wo ich danebenliege.

Bei einer Liste mache ich zuerst eine Vorschau: Wie viele Firmen ich eindeutig gefunden habe, welche unklar sind, dazu ein Excel-Bericht in deinen Downloads. Die unklaren Fälle klärst du in einer Karte, dann starte ich alles in einem einzigen Vorgang. Bei einer einzelnen, klaren Firma lege ich direkt los.

Firmen außerhalb Deutschlands brauchen das Land, sonst suche ich im deutschen Register. Schreib also zum Beispiel „Spar Österreich, Salzburg, Österreich“.

Wichtig: „gestartet“ heißt noch nicht fertig. Die Verarbeitung läuft im Hintergrund, und ich melde mich, wenn sie abgeschlossen ist. Jede aufgenommene Firma zählt in deinem Kontingent.

### Was auf der Firmenseite steht (Reiter im Überblick)
`firmenseite-reiter` · gilt für: [desktop] · Knöpfe: keine

> Fragen: was sehe ich auf der firmenseite · welche reiter gibt es bei einer firma · wo finde ich die infos zu einer firma · firmenansicht erklären · company detail page tabs

Oben auf der Firmenseite stehen Name, Landeschip, Statuschips (etwa gelöscht oder insolvent), Registerzeile, Schlagworte und Kacheln wie Standort, Register, Gegründet, Mitarbeiter, Website und Social Media. Rechts der Knopf „Übernehmen und verarbeiten“ bzw. „Neu verarbeiten“.

Die Reiter:
- Übersicht: Firmenprofil, Geschäftszweck, Rechtsform, Kontakt & Standort, Insolvenzstand
- Finanzen: Jahresübersicht und Jahresberichte
- Geschäftsführung, Kontakte
- Erkenntnisse: Branche, Firmenalter, Unternehmensgegenstand, aktuelle Finanzen
- Stellenanzeigen, Expansion & Ausschreibungen
- Verflechtungen: Gesellschafter, Firmengeflecht, Konzern
- Buying Center, Referenzen & Partner, Mein Fokus

Ein Reiter erscheint nur, wenn es dafür Daten gibt. Alles davon kann ich dir auch im Chat zusammenfassen; frag einfach nach der Firma.

### Was die Hinweise „gelöscht“, „in Löschung“ oder „insolvent“ an einer Firma bedeuten
`firmenstatus-chips` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: was heißt der rote chip gelöscht · firma steht auf in löschung · was bedeutet insolvenzantrag bei der firma · ist die firma noch aktiv · company status insolvent meaning

Diese Hinweise stehen überall, wo eine Firma erscheint: in der Firmensuche, in Meine Firmen, in Vorgängen und auf der Firmenseite. Fährst du mit der Maus darüber, siehst du die Erklärung und das Datum.

- gelöscht: Das Registerblatt ist geschlossen.
- in Löschung: Die Löschung ist im Register angekündigt.
- insolvent: Das Insolvenzverfahren ist eröffnet.
- Insolvenzantrag: Es gibt Sicherungsmaßnahmen, etwa einen vorläufigen Insolvenzverwalter.
- Insolvenzverfahren: Es gibt Veröffentlichungen, der Verfahrensstand ist unklar.
- Insolvenz abgewiesen: Der Antrag wurde mangels Masse abgewiesen.
- Insolvenz beendet: Das Verfahren ist aufgehoben oder eingestellt.

Im Chat nenne ich solche Firmen ausdrücklich und spreche statt von Vertriebsanlässen vom Risiko. Ändert sich der Status einer deiner Firmen, bekommst du eine Meldung.

### Wer ist Geschäftsführer einer Firma?
`geschaeftsfuehrung` · gilt für: alle Kanäle · Knöpfe: Geschäftsführung zeigen (Chat-Vorschlag)

> Fragen: wer ist der geschäftsführer · wer leitet die firma · vorstand der ag · geschäftsführung laut handelsregister · who is the ceo

Frag mich „Wer führt die Firma?“. Ich nenne dir die Geschäftsführung aus dem Registerinhalt und ergänze, was ich auf der Website gefunden habe. In der App steht das auf der Firmenseite im Reiter Geschäftsführung.

Je Land unterschiedlich:
- Deutschland: Geschäftsführer und Vorstand aus dem Handelsregister.
- Vereinigtes Königreich: die aktiven Directors aus Companies House.
- Norwegen: die Rollen aus dem Enhetsregisteret.
- Österreich, Schweiz und Finnland: Die kostenlosen Registerdaten enthalten keine Personen. Dort kommt die Leitung nur aus der Website, wenn sie dort genannt ist.

Ansprechpartner über die Geschäftsführung hinaus findest du im Reiter Kontakte. Hat sich die Geschäftsführung geändert, melde ich das, sobald ich es im Register sehe.

### Wer sind die Gesellschafter einer Firma?
`gesellschafter` · gilt für: alle Kanäle · Knöpfe: Gesellschafter zeigen (Chat-Vorschlag)

> Fragen: wer sind die gesellschafter · wem gehört die firma · gesellschafterliste anzeigen · wer hält anteile an der gmbh · who owns this company

Frag mich „Wem gehört die Firma?“. Ich nenne dir die Gesellschafter aus der neuesten Gesellschafterliste im Handelsregister: Personen mit Geburtsjahr und Wohnort, Firmen mit Registerangabe, je mit Nennbetrag und Anteil, dazu die Beteiligungen der Firma an anderen Firmen.

In der App: Firmenseite → Verflechtungen → Gesellschafter. Dort steht auch, von wann die Liste ist und wann sie gelesen wurde.

Grenzen: Das geht nur für deutsche Firmen mit HRB-Eintrag, etwa GmbH oder AG; Firmen im HRA haben keine Gesellschafterliste. Liegt im Registerordner keine Liste, steht das so da. War die Lesung unsicher, übernehme ich sie nicht und lese sie beim nächsten Registerlauf erneut; lieber keine Daten als falsche. Gelesen wird mit deinem KI-Modell. Die Funktion gibt es nur, falls deine Organisation Verflechtungen freigeschaltet hat.

### Sehen, wie weit ein Import oder eine Verarbeitung ist
`import-fortschritt` · gilt für: alle Kanäle · Knöpfe: Stand abfragen (Chat-Vorschlag), Vorgänge öffnen (öffnet Seite)

> Fragen: wie weit ist der import · ist meine liste schon fertig · wie viele firmen sind durch · status vom import · is the import done

Frag mich einfach „wie weit ist der Import?“. Ich sage dir, wie viele Firmen fertig sind, wie viele noch laufen und welche fehlgeschlagen sind, mit dem Grund. Importe aus dem Chat verfolge ich ohnehin von selbst: Die Leiste über dem Eingabefeld zeigt „x von y Firmen fertig“, und sobald alle durch sind, melde ich mich in derselben Unterhaltung mit dem Ergebnis. Bei anderen Vorgängen sag „sag Bescheid, wenn es fertig ist“.

In der App siehst du jeden Vorgang unter Vorgänge, je Firma und Schritt mit farbigem Punkt. Mit „Nicht mehr verfolgen“ in der Leiste blendest du einen Vorgang dort aus; die Verarbeitung läuft trotzdem weiter.

„Übersprungen“ zählt nicht als Fehler: Der Schritt war für diese Firma gerade erst gelaufen, die Daten sind aktuell.

### Der Import dauert lange oder scheint zu hängen
`import-haengt` · gilt für: alle Kanäle · Knöpfe: Import prüfen (Chat-Vorschlag), Vorgänge öffnen (öffnet Seite)

> Fragen: import hängt · seit einer stunde passiert nichts · verarbeitung steckt fest · alles ist rot in der liste · processing stuck

Die Verarbeitung läuft in deiner AVA, also auf deinem Rechner oder deiner Server-Instanz. Ist die App geschlossen, steht sie still und läuft beim nächsten Start weiter. Bei großen Listen laufen die Firmen nicht alle gleichzeitig; das kann Stunden dauern.

Woran du Hänger erkennst: Die Leiste über dem Eingabefeld zeigt nach 15 Minuten „seit … keine Bewegung“. Bleibt ein Schritt 30 Minuten ohne Lebenszeichen, wird er mit „Zeitüberschreitung“ abgebrochen; das ist kein Datenfehler. Nach 60 Minuten ganz ohne Fortschritt wird die Aufgabe abgebrochen, offene Schritte enden mit Fehler, und ich sage dir, wo es stehen blieb.

Was ich tun kann: nachsehen, welche Schritte fehlgeschlagen sind, und genau diese neu starten. Prüf auch, ob die Verarbeitung oben in Meine Firmen auf „Pausiert“ steht oder die Firma dort ausgesetzt ist. Hängt es danach immer noch, melde es über „Problem melden“; die Protokolle deines Geräts gehen mit.

### Beim Import nicht eindeutige Firmen zuordnen oder überspringen
`import-treffer-zuordnen` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: was mache ich mit den unklaren treffern · einige firmen wurden nicht eindeutig erkannt · falsche firma beim import zugeordnet · wie wähle ich den richtigen kandidaten · import zeigt mehrere firmen zur auswahl

Bevor ich eine Liste aufnehme, gleiche ich jede Zeile mit dem Register ab. Das Ergebnis fasse ich in einem Satz zusammen, etwa „25 geprüft: 21 eindeutig, 4 unklar“, und lege dir zusätzlich einen Excel-Bericht in deine Downloads.

Für die unklaren Fälle zeige ich dir eine einzige Karte mit allen Zweifelsfällen. Je Firma stehen die Kandidaten mit Ort, der „bester Treffer“ ist vorausgewählt. Du wählst den richtigen oder „Überspringen“. Mit „Top-Vorschlag überall“ oder „Alle überspringen“ geht es für alle auf einmal, über „Filtern…“ findest du einzelne Zeilen. Dann „Auswahl übernehmen“, und ich starte den Import mit genau dieser Auswahl. Firmen mit nur einem klaren Kandidaten ordne ich selbst zu.

Ist die Liste schon gestartet und eine Firma falsch erkannt, nimm sie in Meine Firmen wieder heraus und nenn mir die richtige, am besten mit Ort oder Registernummer.

### Prüfen, ob eine Firma insolvent ist
`insolvenz-pruefen` · gilt für: alle Kanäle · Knöpfe: Insolvenz prüfen (Chat-Vorschlag)

> Fragen: ist die firma insolvent · gibt es ein insolvenzverfahren · prüf mal die insolvenz von firma x · insolvenzbekanntmachungen anzeigen · check if company is bankrupt

Frag mich „Ist die Firma insolvent?“. Ich nenne dir den Stand mit allen gespeicherten Veröffentlichungen (Datum, Gericht, Aktenzeichen, Gegenstand, Text) und stoße auf Wunsch eine neue Prüfung an. Das Ergebnis kommt nach einigen Minuten bis Stunden.

In der App: Firmenseite → Übersicht, ganz oben. Dort steht, wann zuletzt geprüft wurde, mit dem Knopf „Jetzt prüfen“ oder „Erneut prüfen“; bei Veröffentlichungen kannst du den Text aufklappen.

Die Quelle je Land: Insolvenzbekanntmachungen der Justiz in Deutschland, Ediktsdatei in Österreich, Handelsamtsblatt in der Schweiz, Companies House und Gazette im Vereinigten Königreich sowie die Register in Norwegen und Finnland. Für Österreich gibt es keinen Knopf; dort wird regelmäßig im Hintergrund geprüft. Deine Firmen werden ohnehin laufend beobachtet, und du bekommst eine Meldung, wenn sich etwas ändert.

### Den Jahresabschluss einer Firma lesen und Fragen dazu stellen
`jahresabschluss-lesen` · gilt für: alle Kanäle · Knöpfe: Abschluss zusammenfassen (Chat-Vorschlag)

> Fragen: zeig mir den jahresabschluss · wie hat sich der umsatz entwickelt · was steht im lagebericht · bilanz von firma x · annual report of this company

Frag mich direkt, zum Beispiel „Wie hat sich der Umsatz entwickelt?“ oder „Welche Risiken nennt der Lagebericht?“. Ich durchsuche die gespeicherten Abschlüsse der Firma (Bilanz, Gewinn- und Verlustrechnung, Anhang, Lagebericht) und antworte mit den passenden Stellen. Standardmäßig fasse ich die neuesten Jahre kompakt zusammen; Prognose, Chancen und Risiken oder alle Jahre hole ich auf Nachfrage.

In der App: Firmenseite → Finanzen. Dort findest du die Jahresübersicht mit Mitarbeiterzahlen je Jahr und darunter je Jahr einen Bericht mit Zeitraum, Kennzahlen und Kernaussagen.

Grenzen: Abschlüsse kommen aus dem Unternehmensregister und gibt es nur für deutsche Firmen, die veröffentlicht haben. Fehlt der Reiter Finanzen, liegt kein Abschluss vor oder die Verarbeitung ist noch nicht durch; dann hole ich ihn nach.

### Umsatz, Mitarbeiterzahl oder andere Kennzahlen fehlen bei einer Firma
`kennzahlen-fehlen` · gilt für: alle Kanäle · Knöpfe: Im Abschluss suchen (Chat-Vorschlag)

> Fragen: warum steht da kein umsatz · mitarbeiterzahl fehlt · wieso zeigt ava keine bilanzsumme · kennzahlen sind leer · no revenue shown

Kennzahlen stammen aus den veröffentlichten Jahresabschlüssen. Fehlen sie, hat das meist einen dieser Gründe:

- Die Firma hat keinen Abschluss veröffentlicht oder ist nicht aus Deutschland. Für andere Länder liegen in AVA keine Abschlüsse vor.
- Die Verarbeitung ist noch nicht durch. Sag mir die Firma, dann hole ich den Schritt nach.

Umsatz und Bilanzsumme zeige ich auf der Firmenseite bewusst nicht als große Kacheln, weil die automatische Zahlenerkennung dafür zu unzuverlässig war. Die Mitarbeiterzahl kommt aus einer eigenen, verlässlichen Auslesung. Frag mich nach einer Zahl, dann suche ich die Stelle im Abschluss und nenne dir die Quelle.

Bei einem Konzernabschluss gelten Mitarbeiter und Umsatz für die Muttergesellschaft selbst, nicht für den ganzen Konzern; Konzernsummen nenne ich ausdrücklich als solche.

### Konzern einer Firma ansehen (Töchter, Konzernmutter, Konzernabschluss)
`konzern-toechter` · gilt für: alle Kanäle · Knöpfe: Konzern anzeigen (Chat-Vorschlag)

> Fragen: welche töchter hat die firma · gehört die firma zu einem konzern · wer ist die muttergesellschaft · konzernabschluss anzeigen · subsidiaries of this company

Veröffentlicht eine deutsche Firma einen Konzernabschluss, lese ich daraus die Tochtergesellschaften mit Sitz, Anteil und Kerngeschäft, die Konzernmutter und die Geschäftsführung laut Abschluss. Frag einfach „Welche Töchter hat die Firma?“. Töchter, die ich in den Stammdaten wiederfinde, verlinke ich, und auf Wunsch nehme ich sie auf.

In der App: Firmenseite → Verflechtungen, Abschnitt „Laut Konzernabschluss“, mit Tabelle und Knopf zum Übernehmen je Tochter. Unter Finanzen ist ein Konzernabschluss mit „Konzern“ markiert.

Gut zu wissen: Der Stand ist der des Abschlussjahres, nicht des Registers. Mitarbeiter und Umsatz bei einem Konzernabschluss gelten für die Muttergesellschaft selbst, nicht für den ganzen Konzern. Ohne veröffentlichten Konzernabschluss gibt es diese Angaben nicht; Beteiligungen aus Gesellschafterlisten siehst du dann in den Verflechtungen.

### Kunden, Referenzen und Partner einer Firma sehen
`kunden-referenzen` · gilt für: alle Kanäle · Knöpfe: Referenzen zeigen (Chat-Vorschlag)

> Fragen: welche kunden hat die firma · referenzen der firma anzeigen · mit wem arbeitet die firma zusammen · welche zertifikate hat die firma · customers and partners of this company

Ich lese von der Website einer Firma, wen sie als Kunden, Partner, Referenzprojekt oder Technologiepartner nennt und welche Zertifikate und Siegel sie angibt, je mit Beleg und Quelle. Jeden Namen gleiche ich mit den Stammdaten ab: „sicher“ heißt eindeutiger Treffer, „unsicher“ heißt, mehrere Firmen passen (etwa Konzern und Töchter). Für deinen Vertrieb sage ich dazu, welche dieser Kunden auch deine anderen Firmen nennen und welche schon in Meine Firmen stehen.

In der App: Firmenseite → Referenzen & Partner. Mit „Übernehmen“ nimmst du eine genannte Firma direkt auf.

Wichtig: Das sind Selbstauskünfte der Website, keine bestätigten Geschäftsbeziehungen. Ein Logo ohne Zusammenhang werte ich vorsichtiger. Neue Kunden melde ich dir. Die Angaben gibt es erst, wenn die Website der Firma verarbeitet ist.

### Welche Länder AVA kennt und was je Land geht
`laender-uebersicht` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: gibt es auch firmen aus österreich · welche länder unterstützt ava · kann ich firmen aus der schweiz suchen · geht auch frankreich oder niederlande · which countries are supported

Ich kenne Firmen aus sechs Ländern: Deutschland, Österreich, der Schweiz, dem Vereinigten Königreich, Norwegen und Finnland. Firmen aus anderen Ländern sind nicht im Bestand und lassen sich heute auch nicht aufnehmen.

Website, Profil, Kontakte, Stellen und Referenzen funktionieren in allen Ländern gleich. Unterschiede gibt es bei dem, was die Register hergeben:

- Deutschland: alles, auch Jahresabschlüsse, Gesellschafter und Verflechtungen.
- Österreich, Schweiz, Finnland: Stammdaten ohne Personen, keine Jahresabschlüsse.
- Vereinigtes Königreich: Directors als Geschäftsführung, keine Jahresabschlüsse.
- Norwegen: Rollen als Geschäftsführung, keine Jahresabschlüsse.

Jede Firma trägt ein Landeschip und ihre amtliche Kennung; in Firmensuche und Meine Firmen filterst du nach Land. Nennst du mir Firmen außerhalb Deutschlands per Namen, sag das Land dazu, damit ich im richtigen Register suche.

### Was „Meine Firmen“ zeigt und wie ich die Liste lese
`meine-firmen-liste` · gilt für: [desktop] · Knöpfe: Meine Firmen öffnen (öffnet Seite)

> Fragen: wo sind meine firmen · meine firmenliste anzeigen · was bedeuten die punkte bei meinen firmen · was heißt rot gelb grün in der firmenliste · my companies overview

Unter Firmen → Meine Firmen stehen alle Firmen, die du aufgenommen hast, über alle Vorgänge hinweg. Jede Zeile zeigt die Schritte der Verarbeitung: Struktur (Registerinhalt), Publikation (Jahresabschlüsse), Website, Profil, Kontakt und E-Mail. Jeder Punkt steht für den jüngsten Stand: wartet, läuft, fertig, fehlgeschlagen oder übersprungen.

„Übersprungen“ ist kein Fehler: Der Schritt war gerade erst gelaufen oder hatte nichts zu tun. „Zeitüberschreitung“ heißt, der Schritt wurde abgebrochen; die Daten der Firma sind deshalb nicht falsch. „Zuletzt verarbeitet“ ist der jüngste abgeschlossene Schritt, auch aus der automatischen Auffrischung.

Ein Klick auf die Zeile öffnet rechts das Protokoll der Firma mit Fehlern, „Erneut versuchen“ und Diagnose. Der Firmenname führt zur Firmenseite. Oben suchst du nach Namen und filterst nach Land oder Fokus-Thema. Den Stand einer bestimmten Firma sage ich dir auch im Chat.

### Ein Reiter fehlt auf der Firmenseite (z. B. Finanzen oder Verflechtungen)
`reiter-fehlt-auf-firmenseite` · gilt für: [desktop] · Knöpfe: Verarbeitung prüfen (Chat-Vorschlag)

> Fragen: warum gibt es keinen finanzen reiter · der reiter verflechtungen fehlt · bei dieser firma sehe ich keine kontakte · wieso hat die firma so wenige reiter · tab missing on company page

Die Firmenseite zeigt nur Reiter, für die es Daten gibt. Typische Gründe, wenn einer fehlt:

- Die Verarbeitung ist noch nicht durch oder ein Schritt ist fehlgeschlagen. Sag mir die Firma, dann prüfe ich das und hole fehlende Schritte nach.
- Das Land: Finanzen gibt es für Firmen aus Österreich, der Schweiz, Norwegen und Finnland nicht, Verflechtungen nur für deutsche Firmen mit Handelsregistereintrag.
- Die Quelle gibt nichts her, etwa keine veröffentlichten Abschlüsse, keine Stellenanzeigen oder keine Referenzen auf der Website.
- Deine Organisation hat ein Modul abgeschaltet, zum Beispiel Kontakte, Verflechtungen oder Buying Center. Dann verschwindet der Reiter ganz.
- Die Firma ruht bei dir: Dann siehst du nur die Grunddaten und den Knopf „Aktivieren“, keine Reiter.

Das Buying Center erscheint erst, wenn du für die Firma eines angelegt hast.

### Einen fehlgeschlagenen Schritt einer Firma erneut starten
`schritt-wiederholen` · gilt für: alle Kanäle · Knöpfe: Fehlgeschlagene neu starten (Chat-Vorschlag), Meine Firmen öffnen (öffnet Seite)

> Fragen: starte die fehlgeschlagenen schritte neu · website nochmal laufen lassen für firma x · kontaktsuche wiederholen · roter punkt bei profil was tun · retry failed step

Sag mir „starte die fehlgeschlagenen Schritte neu“ oder nenne eine Firma und den Schritt, etwa „lass die Website für ACME nochmal laufen“. Ich starte genau diese Schritte neu. Das kostet nichts: Schritte, die schon aktuell sind, werden übersprungen, nur fehlende oder fehlgeschlagene laufen wirklich. „Neu gestartet“ heißt angestoßen, nicht fertig.

In der App: Meine Firmen, Zeile anklicken, rechts unter „Erneut versuchen“ den Schritt wählen und „Schritt erneut starten“. Dasselbe geht in einem Vorgang beim Klick auf die Firma.

Gut zu wissen: Fehlgeschlagene Schritte versuche ich ohnehin mehrmals von selbst. Nach fünf Fehlversuchen gebe ich auf, dann hilft nur noch der Neustart von Hand. Ist die Verarbeitung der Firma ausgesetzt, setze sie zuerst fort. Willst du trotz frischer Daten alles neu, gibt es „Firma komplett neu verarbeiten“.

### Offene Stellen und Arbeitgeberleistungen einer Firma sehen
`stellenanzeigen-firma` · gilt für: alle Kanäle · Knöpfe: Stellen zeigen (Chat-Vorschlag)

> Fragen: welche stellen hat die firma offen · sucht die firma gerade leute · was bietet die firma ihren mitarbeitern · gibt es betriebsrente bei der firma · job postings of this company

Ich finde die Stellenanzeigen einer Firma und ihre Karriereseite. Je Anzeige sehe ich Titel, Ort, Arbeitsmodell, Anforderungen, Leistungen und genannte Technologien; für die Firma insgesamt, was sie Beschäftigten bietet, mit Quelle. Frag einfach „Welche Stellen hat die Firma offen?“.

In der App: Firmenseite → Stellenanzeigen, oben „Was die Firma Beschäftigten bietet“, darunter die einzelnen Anzeigen.

Gut zu wissen: Die Stellen kommen aus der Verarbeitung der Website und werden mit der Auffrischung aktuell gehalten. Fehlen sie, hat die Firma vielleicht keine veröffentlicht, oder der Schritt ist noch nicht gelaufen. Neue Stellen melde ich dir. Fehlen dir Anzeigen, suche ich auf Zuruf gezielt nach; das dauert etwa eine Minute und kostet dich nichts. In der Desktop-App geht das auch in der Übersicht der Firma unter „Gezielte Recherche“ mit „Jetzt suchen“. Willst du wissen, welche deiner Firmen etwas Bestimmtes bieten, etwa eine Betriebsrente, frag mich über alle Firmen hinweg.

### Welche Systeme setzt eine Firma ein (CRM, Hosting, Marketing)?
`tech-stack` · gilt für: alle Kanäle · Knöpfe: Systeme zeigen (Chat-Vorschlag)

> Fragen: welches crm nutzt die firma · welche meiner firmen nutzen hubspot · tech stack der firma · welche software setzt die firma ein · which tools does this company use

Ich lese aus der Datenschutzerklärung einer Website, welche Anbieter eine Firma nennt, sortiert nach Bereichen wie CRM, ERP, Buchhaltung, Marketing, Analyse, Support, Shop, Hosting, Kommunikation oder Zahlung. Frag mich nach einer Firma oder umgekehrt: „Welche meiner Firmen nutzen HubSpot?“ Dann gehe ich über alle deine verarbeiteten Firmen.

Wichtig für die Einordnung: Eine Nennung in der Datenschutzerklärung belegt eine Geschäftsbeziehung, aber nicht sicher den aktiven Einsatz. Solche Seiten sind oft veraltet oder aus Vorlagen erzeugt. Ich sage dir das dazu, wenn du daraus Schlüsse ziehst.

Eine eigene Ansicht dafür gibt es auf der Firmenseite nicht; frag mich im Chat. Die Angaben gibt es erst, wenn die Website der Firma verarbeitet ist.

### Wie lange die Verarbeitung einer Firma oder Liste dauert
`verarbeitung-dauer` · gilt für: alle Kanäle · Knöpfe: keine

> Fragen: wie lange dauert die verarbeitung · wann ist die firma fertig · dauert das bei 500 firmen ewig · wie lange braucht der import · how long does processing take

Eine einzelne Firma ist meist nach einigen Minuten aufbereitet. Bei einer Liste laufen die Firmen nicht alle gleichzeitig, deshalb kann ein großer Import mehrere Stunden dauern. Du musst nicht warten: Ich melde mich in der Unterhaltung von selbst, sobald alles fertig ist, und die Leiste über dem Eingabefeld zeigt bis dahin den Fortschritt.

Gut zu wissen:
- Die Verarbeitung läuft in deiner AVA. Ist die Desktop-App geschlossen oder der Rechner aus, pausiert sie und läuft beim nächsten Start weiter.
- Schritte, die gerade erst für die Firma gelaufen sind, überspringe ich; das geht schnell.
- Die Website- und Kontaktschritte dauern am längsten, weil ich dafür Seiten aufrufe.

Steht etwas lange still, frag mich nach dem Stand. Ich sehe nach, wo es hängt, und starte fehlgeschlagene Schritte neu.

### Die Verarbeitung pausieren oder für eine Firma aussetzen
`verarbeitung-pausieren` · gilt für: [desktop] · Knöpfe: Meine Firmen öffnen (öffnet Seite)

> Fragen: verarbeitung anhalten · kann ich den import pausieren · eine firma nicht weiter verarbeiten · pause processing · verarbeitung läuft nicht mehr pausiert

Es gibt zwei Schalter, beide in Meine Firmen:

- Ganz oben „Verarbeitung pausieren“: hält die gesamte Verarbeitung auf diesem Rechner an. Der Knopf zeigt dann „Pausiert“, ein Klick setzt fort. Solange pausiert ist, starte ich auch keine neuen Importe. Daneben öffnet „Verarbeitung“ eine Übersicht, was gerade läuft und was zuletzt fertig wurde.
- Je Firma das Pause-Zeichen in der Zeile: setzt die Verarbeitung nur dieser Firma aus, es gibt dann keine weiteren Wiederanläufe. Mit dem Play-Zeichen geht es weiter.

Wichtig: Ist eine Firma ausgesetzt, klappt auch „Schritt erneut starten“ nicht; setze sie zuerst fort. Läuft bei dir nichts mehr, sieh zuerst hier nach, ob pausiert ist.

### Was nach dem Aufnehmen mit einer Firma passiert (Verarbeitung)
`verarbeitung-schritte` · gilt für: alle Kanäle · Knöpfe: Meine Firmen öffnen (öffnet Seite)

> Fragen: was machst du mit einer firma nach dem import · was heißt verarbeiten · welche schritte laufen bei einer firma · woher kommen die daten zu meinen firmen · what happens after import

Nimmst du eine Firma auf, bereite ich sie im Hintergrund in mehreren Schritten auf, die sich gegenseitig anstoßen:

- Struktur: der Registerinhalt, also Sitz, Gegenstand, Kapital, Geschäftsführung.
- Publikation: Jahresabschlüsse und Bekanntmachungen (nur Deutschland).
- Website: die passende Website finden und lesen, mit Stellenanzeigen, Karriereseite, Referenzen und eingesetzten Systemen.
- Profil: Angebot, Branche, Größe und Standorte aus der Website.
- Kontakt: Ansprechpartner und Kontaktwege mit Beleg.
- E-Mail: Adressen nach dem Muster der Firma ableiten und prüfen.

Das läuft in deiner AVA, auf deinem Rechner oder deiner Server-Instanz, mit deinem KI-Modell. Hat schon jemand anderes die Firma verarbeitet, nutze ich frische Daten mit und überspringe den Schritt. Den Stand je Schritt siehst du in Meine Firmen. Kontakte und E-Mail laufen nur, falls deine Organisation Kontakte freigeschaltet hat.

### Firmengeflecht verfolgen (Beteiligungen, gemeinsame Personen, gleiche Adressen)
`verflechtungen-netz` · gilt für: alle Kanäle · Knöpfe: Geflecht verfolgen (Chat-Vorschlag)

> Fragen: zeig mir das firmengeflecht · welche firmen hängen noch daran · in welchen firmen steckt der geschäftsführer noch · holding struktur verfolgen · verflechtungen tiefer prüfen

Ich zeige dir, wer eine Firma hält, woran sie beteiligt ist und welche Personen oder gemeinsamen Adressen mehrere Firmen verbinden. Zu einer Person sage ich dir, in welchen Firmen sie als Geschäftsführer, Gesellschafter oder Prokurist steht.

In der App: Firmenseite → Verflechtungen. Die Netzgrafik zeigt Beteiligungen, Geschäftsführung und gleiche Adressen; die Tiefe stellst du oben ein. Bei mehr als 300 Knoten wird das Netz gekürzt.

Tiefer verfolgen: Unter „Geflecht tiefer verfolgen“ lese ich die Gesellschafterlisten der Firmen-Gesellschafter nacheinander, standardmäßig bis Tiefe 6 und höchstens 200 Firmen, mit deinem KI-Modell auf deinem Rechner; es muss Bilder lesen können. Das läuft als eigener Vorgang. Ohne Notbremse geht es weiter, das bestätigst du vorher. Eine Ebene läuft nach jedem Registerlauf automatisch.

Nur für deutsche Firmen mit Handelsregistereintrag und nur, falls deine Organisation Verflechtungen freigeschaltet hat.

### Die Seite Vorgänge (Importe und Verarbeitungen im Überblick)
`vorgaenge-seite` · gilt für: [desktop] · Knöpfe: Vorgänge öffnen (öffnet Seite)

> Fragen: wo sehe ich meine importe · was ist ein vorgang · liste aller importe · roh-eventprotokoll was ist das · where are my imports

Jeder Import ist ein Vorgang: eine Excel-Datei, eine eingefügte Liste, eine einzelne Firma, ein CRM-Import oder ein tieferer Verflechtungslauf. Du findest sie oben unter Vorgänge → Alle Vorgänge, mit Name, Startzeit, Anzahl Firmen und dem Link „Live“. Geteilte Vorgänge tragen „geteilt“; darunter steht „Aus der Organisation“, was Kolleginnen und Kollegen mit dir geteilt haben.

Ein Klick auf einen Vorgang zeigt je Firma und Schritt einen farbigen Punkt. Fährst du darüber, siehst du Zeit, Fehler und ob ein neuer Versuch geplant ist. Klickst du auf eine Firma, öffnen sich rechts der Verlauf der Schritte, die Fehler, „Erneut versuchen“ und die Diagnose mit den Protokollen. „Roh-Eventprotokoll“ zeigt die Ereignisse des Vorgangs live.

Für den Überblick über alle Firmen, unabhängig vom Vorgang, nimm Meine Firmen. Im Chat sage ich dir den Stand jedes Vorgangs auch direkt.

### Eine Recherche oder einen Import mit der Organisation teilen
`vorgang-teilen` · gilt für: alle Kanäle · Knöpfe: Vorgang teilen (Chat-Vorschlag), Vorgänge öffnen (öffnet Seite)

> Fragen: kann ich meine recherche mit kollegen teilen · import mit dem team teilen · freigabe zurücknehmen · share this list with my team · kollegin soll meine firmen auch sehen

Du kannst jeden eigenen Vorgang mit allen Mitgliedern deiner Organisation teilen. Sag mir einfach, welchen; ich frage vor dem Teilen kurz nach, und du kannst eine Notiz für die anderen mitgeben. Mitglieder sehen den Vorgang dann unter „Aus der Organisation“ und können die Firmen daraus übernehmen.

In der App: Vorgänge, den Vorgang öffnen, „Mit Organisation teilen“. Mit „Freigabe zurücknehmen“ beendest du das Teilen; Kopien, die andere schon übernommen haben, bleiben bei ihnen.

Geteilt wird immer mit der ganzen Organisation, nicht mit einzelnen Personen. Radar-Firmen und Workflows lassen sich ebenfalls teilen.

### Firmen aus einem geteilten Vorgang von Kollegen übernehmen
`vorgang-uebernehmen` · gilt für: alle Kanäle · Knöpfe: Vorgänge öffnen (öffnet Seite), Geteiltes zeigen (Chat-Vorschlag)

> Fragen: kollege hat eine liste geteilt wie übernehme ich die · aus der organisation übernehmen · firmen vom team in meine liste holen · adopt shared list · geteilter import übernehmen

Haben Kolleginnen oder Kollegen einen Vorgang geteilt, steht er unter Vorgänge → „Aus der Organisation“ mit dem Namen der Person, die geteilt hat. Öffne ihn und klick „Firmen aus diesem Vorgang übernehmen“. Du bekommst eine eigene Kopie mit denselben Firmen und ihrem Verarbeitungsstand; neu verarbeitet wird dabei nichts. Die Firmen erscheinen danach in Meine Firmen.

Im Chat: Frag mich, was mit dir geteilt wurde, und sag, welchen Vorgang ich übernehmen soll. Ich frage vorher kurz nach.

Zieht die Person ihre Freigabe später zurück, bleibt deine Kopie erhalten.

### Wer nennt Firma X als Kunden, Partner oder Referenz?
`wer-nennt-als-kunden` · gilt für: alle Kanäle · Knöpfe: Umkehrsuche starten (Chat-Vorschlag)

> Fragen: wer nennt audi als kunden · welche meiner firmen arbeiten für siemens · wer hat firma x als referenz · wettbewerber am selben kunden finden · who lists x as a customer

Frag mich zum Beispiel „Wer nennt Audi als Kunden?“. Ich durchsuche die Kunden-, Partner- und Referenzangaben aller Firmen in Meine Firmen und sage dir, welche Firma den Namen nennt, in welcher Art (Kunde, Partner, Referenzprojekt) und mit Beleg.

Das hilft dir im Vertrieb: Du siehst Wettbewerber oder Partner, die denselben Kunden bedienen, und findest Referenzkunden für deine Ansprache.

Grenzen: Ich suche nur in deinen eigenen Firmen und nur in dem, was ihre Websites selbst angeben. Das sind Selbstauskünfte, keine bestätigten Geschäftsbeziehungen. Ein kürzerer Name findet oft mehr, etwa „Audi“ statt „AUDI AG Ingolstadt“.
