# Analyse: Chrome-Prozesse von AVA bleiben stehen

Stand 2026-09-17. Anlass: Mehrere Nutzerinnen und Nutzer melden, dass ihr Rechner
einfriert oder sich nicht herunterfahren lässt, weil Google Chrome sich nicht
beenden lässt. Bisher macOS, Windows nicht ausgeschlossen.

Dieses Dokument beschreibt den Befund und die Lösungswege. **Umgesetzt in
v0.1.680**, siehe Abschnitt 9 am Ende.

## 1. Kurzfassung

AVA startet Chrome nicht selbst, sondern über Selenium: Die App startet einen
Producer als Kindprozess, der Producer startet chromedriver, chromedriver startet
Chrome. Chrome ist damit ein Urenkel der App.

Unter macOS und Linux räumt das Betriebssystem beim Beenden eines Prozesses
dessen Enkel nicht mit auf. Es gibt drei Stellen, an denen AVA das selbst tun
müsste, und alle drei greifen nicht:

1. Die Producer beenden ihren Browser nicht, wenn sie ein Beendigungssignal
   bekommen, weil sie kein solches Signal behandeln.
2. Die App räumt beim Beenden nach, aber der Aufräumschritt läuft nie zu Ende,
   weil der Wachhund die App vorher hart abschießt.
3. Der Wachhund, der die App abschießt, räumt selbst nichts auf.

Ergebnis: Bei jedem Beenden der App bleiben Browser stehen. Sie tragen dieselbe
Programmkennung wie der Chrome der Nutzerin oder des Nutzers. Beim Herunterfahren
wartet macOS auf sie, bekommt keine Antwort und meldet, Google Chrome lasse sich
nicht beenden.

## 2. Belege

Gemessen auf dem Rechner des Betreibers, Protokolle vom 16. und 17.09.2026.

**Das Beenden der App hängt bei jedem einzelnen Mal.** Der Wachhund protokolliert
in jeder Sitzung `QUIT WEDGED: heartbeat frozen ... for 5000ms` und danach
`SIGKILL`. Das zieht sich über alle Versionen von 0.1.672 bis 0.1.675 und über
zwölf aufgezeichnete Beendigungen ohne eine einzige Ausnahme.

**Der Aufräumschritt beim Beenden hat noch nie eine Zeile geschrieben.** Im
gesamten Hauptprotokoll gibt es genau zwei Einträge des Aufräumers, beide vom
Start der App:

| Zeitpunkt | Meldung |
|---|---|
| 17.09. 16:49 | 14 verwaiste Browser-Prozesse beendet |
| 17.09. 18:56 | 7 verwaiste Browser-Prozesse beendet |

Das sind die Reste der jeweils vorangegangenen Sitzung. Der Aufräumer beim
Beenden protokolliert nie, weil er nie dazu kommt.

**Die eigentliche Beendigungskette ist in 74 Millisekunden durch.** Vom Beginn um
19:18:47.080 bis zum letzten Eintrag `window 1 closed` um 19:18:47.154. Danach
folgen zehn Sekunden Stille, dann der Abschuss. Eine Stichprobe des hängenden
Prozesses zeigt durchgehend aktives JavaScript auf dem Hauptthread, keine
Blockade in einem Systemaufruf. Die Ereignisschleife ist also durch synchronen
Code belegt, weshalb weder der Aufräumer noch der Notausgang der App laufen
können.

## 3. Die Ursachenkette

1. Die App beginnt das Beenden, alle Stoppbefehle werden abgeschickt, ohne auf
   ihr Ergebnis zu warten.
2. Unmittelbar danach belegt synchroner Code die Ereignisschleife, der
   Herzschlag bleibt stehen.
3. Der Wachhund sieht den stehenden Herzschlag und schießt die App nach etwa
   sechseinhalb Sekunden ab.
4. Die Producer hatten zehn Sekunden Zeit zugestanden bekommen. Sie sind zum
   Zeitpunkt des Abschusses noch nicht fertig.
5. Die Producer bekommen zwar ein Beendigungssignal, behandeln es aber nicht.
   Node beendet sich sofort, ohne die Aufräumzweige im Code auszuführen. Der
   Browser wird nie geschlossen.
6. chromedriver und Chrome verlieren ihren Elternprozess und laufen weiter.
7. Der Aufräumer, der genau das auffangen soll, läuft nicht mehr.
8. Die Waisen bleiben liegen, bis die App das nächste Mal startet. Fährt die
   Person den Rechner vorher herunter, blockieren sie das Herunterfahren.

## 4. Einzelne Defekte

**D1. Kein Producer behandelt Beendigungssignale.** In den fünf Producern
findet sich keine einzige Signalbehandlung. Nur der Register-Delta-Worker hat
eine. Ohne sie läuft der Aufräumzweig, der den Browser schließt, bei einem
Beendigungssignal grundsätzlich nicht.

**D2. Der Aufräumer beim Beenden ist unverbindlich.** Er wird angestoßen und
nicht abgewartet, dazu ein zweiter Versuch anderthalb Sekunden später. Beides
hängt an einer Ereignisschleife, die zu diesem Zeitpunkt belegt ist. Auf Windows
wird korrekt gewartet, auf macOS nicht.

**D3. Zwei Fristen widersprechen sich.** Die App gesteht den Producern zehn
Sekunden zu, der Wachhund schießt nach sechseinhalb Sekunden. Ein sauberes
Beenden ist damit auch ohne Hänger unmöglich. Die Wachhundfrist wurde einmal
von acht auf fünf Sekunden verkürzt, damit Nutzer nicht auf ein Beenden warten
müssen. Genau das hat das Aufräumen strukturell ausgeschaltet.

**D4. Zwei Producer setzen die Kennzeichnung nicht.** Der Aufräumer erkennt
AVA-Browser an einer Startkennung. Die Producer für Firmenprofile und Kontakte
setzen sie nicht. Deren Browser werden nur von einer schwächeren Ersatzregel
erfasst, die verlangt, dass der Elternprozess bereits tot ist. Solange ihr
chromedriver noch lebt, werden sie nie erkannt, auch nicht beim Beenden.

**D5. Drei Producer halten einen dauerhaften Browser.** Website, Firmenprofile
und Kontakte halten eine einzige Browsersitzung offen und schließen sie erst
nach einer Minute Leerlauf. Der zuständige Zeitgeber ist so eingestellt, dass er
den Prozess nicht am Leben hält, also feuert er beim Prozessende nicht. Diese
Browser werden im Normalbetrieb also nie über den regulären Weg geschlossen.

**D6. Das Schließen des Browsers hat nirgends eine Frist.** Der Aufruf geht über
das Netzwerk an chromedriver. Antwortet dieser nicht, wartet der Aufruf
unbegrenzt.

**D7. Der Register-Delta-Worker wird beim Beenden nicht gestoppt.** Es gibt
keinen Beendigungsschritt für ihn. Sein Kindprozess bekommt beim App-Ende kein
Signal. Er startet ebenfalls Chrome. Das wiegt seit dem Worker-Modus schwerer,
weil dieser Prozess dann dauerhaft läuft.

**D8. Enkelprozesse werden nie als Gruppe beendet.** Die Producer werden ohne
eigene Prozessgruppe gestartet. Auf macOS und Linux erreicht ein Signal an den
Producer dessen Enkel nicht. Auf Windows wird der Baum mit abgeräumt, deshalb
ist die Lage dort besser.

**D9. Der Wachhund räumt nicht auf.** Er ist der Einzige, der sicher läuft,
wenn die App stirbt, und er ist sogar derjenige, der sie tötet. Er beendet
ausschließlich die App und kümmert sich nicht um deren Nachkommen.

**D10. AVA benutzt den Chrome der Nutzerin oder des Nutzers.** Gestartet wird
die installierte Anwendung mit der Kennung `com.google.Chrome`. Für macOS sind
die Hintergrundinstanzen damit Teil derselben Anwendung wie das sichtbare
Fenster. Beim Herunterfahren fordert das System die Anwendung zum Beenden auf
und wartet auf Antwort. Eine Instanz ohne Oberfläche beantwortet diese
Aufforderung nicht. Das ist der direkte Auslöser der Meldung, Google Chrome
lasse sich nicht beenden.

**D11. Ungeklärt: Was belegt beim Beenden die Ereignisschleife.** Die Stichprobe
zeigt aktives JavaScript nach dem Schließen aller Fenster, aber die
Aufrufnamen sind nicht auflösbar. Ohne diese Antwort bleibt das Beenden auch
nach allen anderen Verbesserungen unsauber.

## 5. Warum der bestehende Aufräumer das Problem nicht löst

Er wurde am 16.09. gebaut und tut, was er soll, aber er greift an der falschen
Stelle an. Er läuft im selben Prozess, der gerade stirbt. Von seinen drei
Startzeitpunkten funktioniert in der Praxis nur einer, nämlich der beim Start der
App. Der stündliche Lauf hilft nur bei laufender App, und der Lauf beim Beenden
kommt nie zum Zug.

Dazu kommt eine Lücke im Erkennungsmuster: Ein Browser gilt nur dann als verwaist,
wenn sein Besitzer nicht mehr lebt. Die Producer sind aber langlebig. Verliert ein
laufender Producer eine Browsersitzung, etwa weil das Schließen fehlschlug, dann
lebt der Besitzer weiter und der Browser wird im laufenden Betrieb nie erkannt.

## 6. Lösungswege

**L1. Der Wachhund räumt auf.** Er ist ein eigener, abgekoppelter Prozess, er
überlebt die App, und er weiß genau, wann er sie getötet hat. Er bekommt die
Erkennungslogik des Aufräumers und wendet sie nach jedem Abschuss an, und
zusätzlich beim eigenen Start. Kleiner Aufwand, große Wirkung, weil es die
einzige Stelle ist, die im Fehlerfall sicher läuft.

**L2. Beendigungssignale in den Producern behandeln.** Bei einem Signal wird die
laufende Browsersitzung mit einer Frist geschlossen, danach beendet sich der
Prozess. Damit wird der Normalfall sauber, statt sich auf Nachsorge zu verlassen.
Betrifft fünf Submodule, jeweils wenige Zeilen an einer zentralen Stelle.

**L3. Producer in eigener Prozessgruppe starten.** Dann erreicht ein Signal an
die Gruppe auch chromedriver und Chrome. Das ist auf macOS und Linux der
strukturell saubere Weg und macht die Nachsorge zum Ausnahmefall. Erfordert
Sorgfalt, weil eine eigene Prozessgruppe das Verhalten beim Absturz ändert: Die
Gruppe muss dann ausdrücklich adressiert werden.

**L4. Die Fristen in Einklang bringen.** Die Frist des Wachhunds muss länger
sein als die Zeit, die das Beenden regulär braucht, sonst ist jedes saubere
Beenden ausgeschlossen. Sinnvoller als eine einzelne Zahl ist, dass die App dem
Wachhund während des Beendens Fortschritt meldet: Solange Schritte voranschreiten,
wird nicht abgeschossen, erst bei echtem Stillstand.

**L5. Eigener Browser statt des Chrome der Nutzerin oder des Nutzers.** Eine
eigene Installation, etwa Chrome for Testing, hat eine andere Programmkennung und
einen anderen Namen. Damit verschwindet das gemeldete Symptom vollständig, weil
macOS die Hintergrundinstanzen nicht mehr der Anwendung Google Chrome zurechnet.
Zusätzlich werden AVA-Prozesse eindeutig unterscheidbar und können nie mit dem
Browser der Person verwechselt werden. Das ist der größte Eingriff, weil die
Installation verteilt und gepflegt werden muss, und zugleich der einzige Weg,
der die gemeldete Ursache direkt beseitigt.

**L6. Kennzeichnung überall setzen und ein eigenes Profilverzeichnis je
Sitzung.** Behebt D4 und macht AVA-Browser unabhängig von der Kennung
erkennbar. Sehr kleiner Aufwand.

**L7. Frist um das Schließen des Browsers.** Behebt D6, verhindert, dass ein
hängender chromedriver das Beenden blockiert.

**L8. Den Register-Delta-Worker beim Beenden stoppen.** Behebt D7.

**L9. Den Hänger beim Beenden untersuchen.** Behebt D11. Vorgehen: Den
Herzschlag während des Beendens weiterschreiben und die Schritte nach dem
Schließen der Fenster einzeln protokollieren, bis die Stelle eingegrenzt ist.

## 7. Vorschlag zur Reihenfolge

Zuerst die Nachsorge sicher machen, danach den Normalfall sauber, danach die
Ursache beseitigen:

1. L1, L6, L8 und L7. Zusammen sorgen sie dafür, dass keine Waisen liegen
   bleiben, egal wie die App endet.
2. L2 und L4. Damit endet die App im Normalfall sauber und braucht die Nachsorge
   nicht mehr.
3. L3. Macht das Aufräumen strukturell überflüssig.
4. L5. Beseitigt die Verwechslung mit dem Browser der Person und damit die
   Ursache der gemeldeten Meldung beim Herunterfahren.
5. L9 läuft parallel, weil die Antwort die Dringlichkeit von L4 verändert.

## 8. Was noch zu klären ist

- Was beim Beenden die Ereignisschleife belegt (D11).
- Ob Windows betroffen ist. Dort wird der Prozessbaum beim Stoppen mit
  abgeräumt, und der Aufräumer wird beim Beenden korrekt abgewartet. Der Verdacht
  ist deshalb geringer, aber es gibt dort keinen Signalweg beim Herunterfahren
  des Betriebssystems.
- Wie viele Browser im Betrieb gleichzeitig entstehen können. Auf dem Rechner des
  Betreibers waren es einmal 110 Prozesse mit 2,7 Gigabyte, zuletzt 14 und 7 je
  Sitzung. Die Obergrenze ergibt sich aus der Zahl der Producer mal ihrer
  Sitzungen und ist bisher nicht bestimmt.
- Ob die Producer für Firmenprofile und Kontakte in ausgelieferten Fassungen
  überhaupt laufen und damit unkenntliche Browser erzeugen.

## 9. Umsetzung in v0.1.680

Zwei Zusagen waren zu erfüllen: Es dürfen keine verwaisten Browser mehr
liegenbleiben, und AVA darf den Browser der Person in keiner Weise anfassen.

**Eindeutiges Erkennungsmerkmal.** Jeder von AVA gestartete Browser trägt jetzt
den Schalter `--ava-browser`. Chrome ignoriert unbekannte Schalter, der
Aufräumer erkennt uns daran. Bewusst kein Pfad als Merkmal: Ein Test deckte auf,
dass ein Profil der Person, dessen Pfad zufällig ähnlich heißt, sonst erfasst
worden wäre. Der Browser der Person trägt diesen Schalter nie.

**Eigenes Profil je Browser.** Jeder Browser bekommt ein frisches, leeres
Profilverzeichnis, das nach dem Schließen entfernt wird. Damit gibt es keine
Berührung mit dem Profil der Person: keine geteilten Anmeldungen, keine
Sitzungskonflikte, keine Meldung über ein nicht ordnungsgemäßes Beenden. Vorher
liefen alle AVA-Browser ohne eigenes Profil.

**Beendigungssignale werden behandelt.** Alle sechs Pakete, die einen Browser
starten, teilen sich dafür ein gemeinsames Modul (`browser-lebenszyklus.ts`).
Kommt ein Signal, werden die offenen Browser geschlossen, bevor der Prozess
endet. Vorher behandelte kein einziger Producer ein Signal, weshalb der
Aufräumzweig nie lief. Jedes Schließen hat eine Frist von acht Sekunden, ein
stummer chromedriver blockiert also nichts mehr.

**Der Wachhund räumt auf.** Er ist die einzige Stelle, die sicher läuft, wenn
die App stirbt, und er ist derjenige, der sie tötet. Nach jedem harten Beenden
und wenn die App verschwunden ist, beendet er die Browser mit dem AVA-Schalter
sowie chromedriver ohne lebenden Elternprozess. Das schließt die Lücke, an der
das Aufräumen bisher scheiterte: Die App kam nach einem Abschuss nicht mehr
dazu.

**Fristen passen zusammen.** Die Frist des Wachhunds beim Beenden lag bei fünf
Sekunden, die Zeit für das Beenden der Producer bei zehn. Ein sauberes Beenden
war damit ausgeschlossen. Die Frist liegt jetzt bei zwölf Sekunden.

**Der Register-Delta-Worker wird beim Beenden gestoppt.** Vorher bekam sein
Kindprozess überhaupt kein Signal, obwohl er ebenfalls Chrome startet und im
Worker-Modus dauerhaft läuft.

**Abgedeckt durch Tests.** Sechs Tests für den Lebenszyklus (Profil anlegen und
entfernen, Schließen, fehlschlagendes Schließen, hängendes Schließen, alle
schließen) und sechs für die Erkennung, darunter ausdrücklich: Der Browser der
Person bleibt in jeder Betriebsart unberührt, auch mit einem eigenen Profil und
auch bei einem ähnlich benannten Profilpfad.

Weiterhin offen: D11, also was beim Beenden die Ereignisschleife blockiert. Das
ist jetzt weniger dringend, weil das Aufräumen nicht mehr davon abhängt.
Ebenfalls offen ist L5, ein eigener Browser statt der Installation der Person.
Das bleibt die einzige Maßnahme, die auch den seltenen Fall abdeckt, dass beim
Herunterfahren gerade ein AVA-Browser arbeitet.
