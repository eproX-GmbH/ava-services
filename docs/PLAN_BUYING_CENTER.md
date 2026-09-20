# Plan: Buying Center (Power Map) in AVA

Stand 2026-09-20. Fachliche Grundlage: Sieck, "Der strategische Key
Account Plan" (Vahlen), Abschnitt "Power Map" — vier Dimensionen je Person
und sechs Leitfragen. Die Seiten liegen vor; der Plan bildet sie ab, nicht
ein eigenes Schema.

---

## 0. Festlegungen und meine Meinung

Vier Dinge sind entschieden, zwei davon gegen meinen ersten Vorschlag.
Ich halte sie fest, damit sie nicht wieder aufgemacht werden:

1. **Das Schema kommt aus dem Buch, vollstaendig — samt "Feind".** Ich
   hatte wertende Etiketten vermeiden wollen. Das Gegenargument traegt:
   Der Vertriebler schreibt es sonst auf Papier oder ins CRM, nur
   unstrukturiert. AVA aendert nichts daran, dass die Einschaetzung
   existiert; sie macht sie nur brauchbar. Die Folge fuer den Datenschutz
   steht in Abschnitt 10 — als Konsequenz, nicht als Einwand.
2. **Nie automatisch.** Ein Buying Center entsteht nur auf Wunsch des
   Nutzers. Damit wird die Firma zum **Fokuskunden**, und erst dann darf
   AVA fuer sie Aufwand treiben, den sie fuer die anderen 2000 nicht
   treibt.
3. **Das Buying Center ist eine Hypothese des Nutzers.** AVA liefert den
   ersten Entwurf und spaeter Vorschlaege. Was der Nutzer gesetzt hat,
   ueberschreibt kein Lauf. Das ist die wichtigste technische Festlegung
   im ganzen Plan, siehe Abschnitt 5.
4. **Es gehoert IMMER der Person, die es angelegt hat.** Keine
   Organisationsweite Teilung, kein gemeinsames Bearbeiten. Ein Buying
   Center ist hoch individuell: Es ist die Einschaetzung EINES
   Vertrieblers, mit seinen Gespraechen, seinen Gruenden, seiner
   Beziehung zu den Personen. Zwei Kollegen an derselben Firma haben zwei
   Buying Center, und die duerfen sich widersprechen — das ist kein
   Fehler, sondern Information.

   Spaeter kommt eine **Sichtfreigabe**: Der Eigentuemer kann Mitgliedern
   seiner Organisation erlauben, das Buying Center zu SEHEN. Aendern kann
   es weiterhin nur er. Geteilte Buying Center leben in einem eigenen
   Bereich, nicht in der Firmenansicht (Abschnitt 8.3).

   (Mein erster Vorschlag war Organisationseigentum. Der Einwand
   ueberzeugt: Was einer ueber Menschen denkt, ist nicht das, was das
   Team denkt.)

Meine Meinung zu dem, was das Buch nicht sagt: **Einfluss ist ein
Graph.** Leitfrage 5 ("Wer hat welchen Einfluss auf wen?") laesst sich
mit Etiketten nicht beantworten. Das IT-Leiter-Beispiel braucht eine
Kante vom IT-Leiter zum Geschaeftsfuehrer. Ohne diese Kanten ist die
Power Map eine Tabelle; mit ihnen ist sie eine Karte — und genau das ist
der Unterschied, der im Buch mit "Inner Circle" gemeint ist.

---

## 1. Der fachliche Rahmen (aus dem Buch)

### 1.1 Vier Dimensionen je Person

| Dimension | Werte | Bedeutung |
| --- | --- | --- |
| **Rolle** | E Entscheider, B Beeinflusser, N Nutzer/Anwender, R Ratifizierer, S Spezifizierer, EK Einkaeufer, GK Gatekeeper, ? unbekannt | Funktion im Kaufprozess. Mehrere Rollen je Person sind moeglich (der Einkaeufer ist oft auch Ratifizierer). |
| **Einstellung** zu uns | C Coach, + positiv, = neutral, − negativ, F Feind, ? unbekannt | Coach unterstuetzt aktiv; Positiv/Negativ nur auf Nachfrage; Feind ist der Coach des Wettbewerbers. |
| **Kontaktintensitaet** | 0 kein Kontakt, S selten, R regelmaessig, I intensiv | Wie gut kennen WIR die Person. |
| **Einfluss** auf die Kaufentscheidung | G gering, M mittel, H hoch, ? unbekannt | Ausdruecklich unabhaengig von der Hierarchie ("Die Stellung in der Hierarchie laesst nicht automatisch auf die Groesse des Einflusses schliessen"). |

Dazu je Person: Name, Funktion im Unternehmen, **primaerer
Ansprechpartner in unserer Organisation** (Leitfrage 6, Key Account
Team).

Das Fragezeichen ist in jeder Dimension ein vollwertiger Wert. Ein
Buying Center voller Fragezeichen ist kein Fehler, sondern der ehrliche
Anfangszustand.

### 1.2 Sechs Leitfragen

1. Wer ist involviert, in welcher Rolle? Sind alle Rollen besetzt?
2. Wie sind die Personen uns gegenueber eingestellt?
3. Wie gut kennen wir sie? Zu wem fehlt Kontakt?
4. Wer hat welchen Einfluss auf die Entscheidung?
5. Wer beeinflusst wen? Freundschaften, Animositaeten, Inner Circle?
6. Wer von uns baut zu wem eine dauerhafte Beziehung auf?

Frage 1 und 3 lassen sich teilweise aus Daten beantworten. Frage 2, 4,
5 und 6 kann nur der Nutzer beantworten. Diese Trennung zieht sich durch
den ganzen Plan.

### 1.3 Die XING/LinkedIn-Checkliste

Das Buch nennt fuer die Einzelanalyse: Interessen, berufliche Stationen
(neu in der Position? frueherer Arbeitgeber als Referenz? Wechselrate?),
Qualifikationen, internes Netzwerk, "Ich suche …". Das sind Fragen an
das Profil einer Person, und AVA kann sie fuer Fokuskunden gezielt
beantworten (Abschnitt 4).

---

## 2. Was es dafuer schon gibt

| Baustein | Wo | Beitrag |
| --- | --- | --- |
| Personen mit Titel, Rang, Belegen | Kontakt-Bestand (`Person`, `Employment`, `Fact`) | Startmenge und Startvorschlag fuer Rolle/Einfluss |
| `rangFuerTitel` | Kontakt-Rang | Leitung → Vorschlag Entscheider, Fach → Nutzer |
| Verflechtungen-Graph | `VerflechtungenTab` | Knoten, Kanten, Kraftlayout, Verschieben, Klick → Person. Die Zeichnung fuer die Power Map |
| Diagramme im Chat | ```chart-Zaun, `ChartBlock` | Muster fuer einen ```buying-center-Zaun |
| CRM-Anbindung | HubSpot-Tools: Notizen, Aktivitaeten, Aufgaben, Deals | Kontaktintensitaet ableiten, Gespraechsmuster erkennen |
| Personen-Watchlist, Personen-Radar | LinkedIn-Beobachter | Aktivitaet und Sichtbarkeit einer Person |
| Relevanz | Naehe je Person, Alarmweg | Mitglieder werden heiss; Positionswechsel meldet sofort |
| Watchlist-`fokus` | Personen-Watchlist | Vorbild fuer den Fokuskunden auf Firmenebene |

---

## 3. Datenmodell (Gateway, je Organisation)

```prisma
/// Ein Buying Center je Firma und EIGENTUEMER. Entsteht nur auf Wunsch.
/// Zwei Mitglieder derselben Organisation haben zwei getrennte Buying
/// Center zu derselben Firma.
model BuyingCenter {
  id          String   @id @default(cuid())
  tenantId    String
  /// Der Eigentuemer. Nur er liest (ohne Freigabe) und nur er schreibt.
  eigentuemerActorId String
  companyId   String
  /// Anlass — "Angebot Lagerverwaltung 2026". Ein Buying Center gilt
  /// fuer einen Kaufprozess; eine Firma kann mehrere haben.
  anlass      String?
  status      String   @default("aktiv")   // aktiv | abgeschlossen | archiviert
  angelegtVon String                        // actorId
  angelegtAt  DateTime @default(now())
  updatedAt   DateTime @updatedAt
  mitglieder  BuyingCenterMitglied[]
  kanten      BuyingCenterKante[]
  freigaben   BuyingCenterFreigabe[]
  @@unique([tenantId, eigentuemerActorId, companyId, anlass])
  @@index([tenantId, eigentuemerActorId])
  @@index([tenantId, companyId])
}

/// Sichtfreigabe (spaetere Stufe): Ein Organisationsmitglied darf sehen,
/// nicht aendern. Nur der Eigentuemer erteilt und entzieht sie.
model BuyingCenterFreigabe {
  buyingCenterId String
  actorId        String   // wer sehen darf
  erteiltVon     String   // = Eigentuemer
  erteiltAt      DateTime @default(now())
  buyingCenter   BuyingCenter @relation(...)
  @@id([buyingCenterId, actorId])
  @@index([actorId])
}

/// Eine Person im Buying Center mit den vier Dimensionen.
model BuyingCenterMitglied {
  id              String  @id @default(cuid())
  buyingCenterId  String
  /// Verweis in den Kontakt-Bestand, wenn die Person dort existiert.
  personId        String?
  /// Sonst frei erfasst ("die Assistentin des GF, Frau Kowalski").
  name            String
  funktion        String?
  rollen          String[]  // E,B,N,R,S,EK,GK — mehrere moeglich, leer = ?
  einstellung     String?   // C,+,=,-,F — null = ?
  kontakt         String?   // 0,S,R,I — null = ?
  einfluss        String?   // G,M,H — null = ?
  /// Leitfrage 6: wer von uns kuemmert sich. actorId eines Mitglieds.
  ansprechpartnerBeiUns String?
  /// Position auf der Karte, damit sie nach dem Neuladen so aussieht wie
  /// verlassen.
  x               Float?
  y               Float?
  buyingCenter    BuyingCenter @relation(...)
  angaben         BuyingCenterAngabe[]
  @@index([buyingCenterId])
}

/// Jede Dimension einzeln mit Herkunft und Grund — das ist die Belegkette.
/// Wird nie ueberschrieben, nur ergaenzt; die juengste Nutzerangabe gilt.
model BuyingCenterAngabe {
  id          String   @id @default(cuid())
  mitgliedId  String
  dimension   String   // rolle | einstellung | kontakt | einfluss | ansprechpartner | notiz
  wert        String?
  /// nutzer | ava:titel | ava:website | ava:linkedin | ava:crm
  herkunft    String
  grund       String   // Klartext: "hat mir im Termin gesagt, dass …"
  vonActorId  String?  // bei herkunft = nutzer
  erfasstAt   DateTime @default(now())
  @@index([mitgliedId, dimension, erfasstAt])
}

/// Leitfrage 5: Wer beeinflusst wen, wer mag wen nicht.
model BuyingCenterKante {
  id              String  @id @default(cuid())
  buyingCenterId  String
  vonMitgliedId   String
  nachMitgliedId  String
  art             String  // EINFLUSS | VERTRAUT | ANIMOSITAET
  staerke         String? // G,M,H
  grund           String?
  herkunft        String  // nutzer | ava:…
  vonActorId      String?
  erfasstAt       DateTime @default(now())
}
```

**Zugriffsregel, im Gateway erzwungen, nicht im Client:**

```
lesen     eigentuemerActorId = ich  ODER  Freigabe fuer mich vorhanden
schreiben eigentuemerActorId = ich
```

Kein Parameter, ueber den ein anderer Eigentuemer adressierbar waere;
`actorId` kommt aus dem JWT. Ein Freigegebener bekommt die Karte und die
Seitenleiste, aber jeder Schreibversuch endet mit 403 — auch aus dem Chat
heraus, und das Werkzeug sagt es dann klar statt still nichts zu tun.

Warum `BuyingCenterAngabe` als eigene Tabelle und nicht vier Spalten am
Mitglied: Die vier Spalten am Mitglied sind der **aktuelle Stand**, die
Angaben sind die **Geschichte mit Begruendung**. Beim Darueberfahren im
Chat will man genau die sehen: "Einfluss hoch — vom Nutzer, 12.09.: 'GF
verlaesst sich in IT-Fragen komplett auf ihn'. Rolle Beeinflusser — von
AVA, Grund: Titel 'Leiter IT'."

**Personen ohne `personId`** sind ausdruecklich vorgesehen. Wird die
Person spaeter im Kontakt-Bestand gefunden (etwa durch einen
Website-Lauf), bietet AVA das Verknuepfen an, statt es stillschweigend
zu tun.

---

## 4. Fokuskunde

Ein Buying Center anzulegen macht die Firma zum Fokuskunden — **fuer
diesen Nutzer**. Das Kennzeichen haengt am Nutzer, nicht an der
Organisation (`FokusKunde(tenantId, actorId, companyId, seit)`), und es
schaltet Aufwand frei, der sonst zu teuer waere:

| Was AVA fuer Fokuskunden zusaetzlich tut | Warum nicht fuer alle |
| --- | --- |
| Website erneut gezielt nach **Personen** lesen: Team-Seite, Impressum, "Ueber uns", Reihenfolge und Hervorhebung | Ein zweiter Crawl je Firma, nur fuer Namen |
| LinkedIn-Profile der Mitglieder in die Watchlist (mit Rueckfrage) | Watchlist ist gedeckelt |
| CRM-Notizen und Aktivitaeten je Mitglied laden und auswerten | Viele Aufrufe, nur hier sinnvoll |
| Positionswechsel eines Mitglieds → sofortige Meldung | Alarmweg-Positivliste |
| Naehe der Mitglieder: Mindestwert 7 | Buying-Center-Mitgliedschaft ist das staerkste Personensignal |

Fokus ist umkehrbar: Status "abgeschlossen" oder "archiviert" nimmt das
Kennzeichen wieder weg, die Daten bleiben.

**Wichtig fuer die Kosten:** Fokuskunden werden wenige sein — das ist
der Zweck. Ein Deckel je Nutzer (Vorschlag: 25 aktive) verhindert, dass
jemand den ganzen Bestand zum Fokus erklaert und die Watchlist sprengt.
Der Website-Personenlauf ist dabei je Firma nur einmal je Tag faellig,
auch wenn drei Kollegen dieselbe Firma im Fokus haben — die Daten landen
ohnehin im gemeinsamen Kontakt-Bestand.

---

## 5. Herkunft: Vorschlag gegen Angabe

Die Regel, die alles andere traegt:

```
Nutzerangabe   > AVA-Vorschlag
juenger        > aelter        (innerhalb derselben Herkunft)
```

- Ein AVA-Lauf **setzt** nur, was leer ist (Fragezeichen). Ist eine
  Dimension vom Nutzer belegt, legt AVA hoechstens einen **Hinweis**
  daneben ("laut LinkedIn seit August nicht mehr bei der Firma").
- Ein AVA-Lauf **entfernt** nie ein Mitglied. Er markiert es als
  "moeglicherweise ausgeschieden" und fragt.
- Der Nutzer kann jeden AVA-Vorschlag mit einem Wort annehmen oder
  verwerfen; beides wird als Angabe mit Grund gespeichert, damit AVA
  denselben Vorschlag nicht wiederholt.

---

## 6. Signale und was sie vorschlagen

Alle Vorschlaege tragen Herkunft und Grund und sind einzeln annehmbar.

| Signal | Herkunft | Vorschlag |
| --- | --- | --- |
| Titel Geschaeftsfuehrer / Vorstand / Inhaber | ava:titel | Rolle E, Einfluss H (nur Vorschlag — das Buch warnt ausdruecklich vor Hierarchie = Einfluss) |
| Titel Einkauf | ava:titel | Rolle EK |
| Titel Leiter Fachbereich | ava:titel | Rolle B oder S |
| Assistenz, Office, Sekretariat | ava:titel | Rolle GK |
| Auf der Team-Seite an erster Stelle / mit Foto und Zitat | ava:website | Einfluss M–H, "wird hervorgehoben" |
| Postet regelmaessig ueber die Firma, teilt Beitraege des GF | ava:linkedin | Einfluss M, "sichtbar, engagiert" |
| Neu in der Position (< 6 Monate) | ava:linkedin | Hinweis aus der Buch-Checkliste: "Informationsvorsprung moeglich" |
| Frueherer Arbeitgeber = eigener Kunde | ava:linkedin | Hinweis: "kennt uns moeglicherweise" |
| "Ich suche … neue Herausforderung" | ava:linkedin | Hinweis: "wechselt vermutlich bald" |
| n Kontakte in 90 Tagen im CRM | ava:crm | Kontaktintensitaet 0 / S / R / I nach Schwellen (0, 1–2, 3–8, > 8) |
| Immer dieselben zwei Personen, Deal unveraendert seit 60 Tagen | ava:crm | **Hinweis, keine Zuordnung:** "Ihr sprecht seit Monaten nur mit A und B. Entscheider und Einkaeufer sind ohne Kontakt." |
| Leitfrage 1: Rolle unbesetzt | — | "Kein Einkaeufer bekannt. Wer verhandelt den Vertrag?" |

Der letzte und der vorletzte Punkt sind die wertvollsten, weil sie eine
**Handlung** empfehlen und nicht nur einordnen. Sie sind auch die
einzigen, die ohne neue Daten auskommen — sie lesen nur, was schon da
ist.

---

## 7. Im Chat

### 7.1 Werkzeuge

| Werkzeug | Tut | Rueckfrage |
| --- | --- | --- |
| `buying_center_anlegen` | Firma → Fokuskunde, Entwurf aus Kontakt-Bestand mit Vorschlaegen, Anzeige | ja (`confirmAction`: macht die Firma zum Fokuskunden) |
| `buying_center_anzeigen` | Karte im Chat rendern | nein |
| `buying_center_setzen` | Dimension(en) einer Person setzen, mit Grund | nein — der Nutzer hat es gerade gesagt |
| `buying_center_person_aufnehmen` | Person hinzufuegen, auch ohne Kontakt-Eintrag | nein |
| `buying_center_kante` | "X beeinflusst Y stark", "A und B koennen nicht miteinander" | nein |
| `buying_center_vorschlaege` | Offene AVA-Vorschlaege und Hinweise (Leitfragen 1, 3, Gespraechsmuster) | nein |
| `buying_center_abschliessen` | Status setzen, Fokus aufheben | ja |
| `buying_center_freigeben` *(spaeter)* | Sicht fuer ein Organisationsmitglied erteilen oder entziehen | ja — es gibt Einschaetzungen ueber Menschen weiter |

Alle Werkzeuge arbeiten nur auf den **eigenen** Buying Centern. Wer ein
freigegebenes anspricht, bekommt es angezeigt; jeder Versuch, es zu
aendern, wird mit Begruendung abgelehnt.

Der Gespraechsfluss, den das ergibt:

> **Nutzer:** Lass uns fuer die Zimmer Group ein Buying Center machen.
> **AVA:** *(legt an, zeigt Karte)* Ich habe fuenf Personen aus dem
> Bestand uebernommen. Herr Zimmer als Entscheider ist ein Vorschlag aus
> dem Titel — Einfluss habe ich offen gelassen. Ohne Kontakt sind bisher
> alle. Wer ist euer Ansprechpartner dort?
> **Nutzer:** Mit Frau Berg sprechen wir regelmaessig, sie ist Coach.
> Und der IT-Leiter Herr Roth hat beim Zimmer das letzte Wort in
> Technikfragen, auch wenn er nur Beeinflusser ist.
> **AVA:** *(setzt Berg: Kontakt R, Einstellung C; Roth: Rolle B,
> Einfluss H; Kante Roth → Zimmer, stark; alles mit Grund "laut Nutzer,
> 20.09.")* Eingetragen. Ein Einkaeufer fehlt noch — wer verhandelt den
> Vertrag?

### 7.2 Die Karte im Antworttext

Wie die Diagramme: ein Zaun im Markdown, den der Renderer abfaengt.

```buying-center
{ "id": "bc_…" }
```

Der Zaun traegt **nur die Kennung**, nicht die Daten. Der Renderer laedt
das Buying Center frisch und zeichnet es. Damit ist eine Karte, die vor
drei Wochen im Chat stand, beim erneuten Oeffnen des Verlaufs aktuell —
und nicht ein Schnappschuss von damals. (Beim Diagramm ist es umgekehrt
richtig: Dort sind die Daten der Inhalt.)

Damit laesst sich das Buying Center in jeden Chat "hineinladen": Der
Nutzer sagt "zeig mir das Buying Center der Zimmer Group", und die Karte
erscheint, gleich in welcher Konversation.

---

## 8. Die Darstellung

Grundlage ist der Verflechtungen-Graph: Kraftlayout, Knoten verschieben,
Positionen speichern (`x`, `y` am Mitglied), Klick oeffnet die Person.

**Knoten:** Personen, Groesse nach Einfluss (G/M/H), Rand nach
Einstellung (Coach gruen, positiv hellgruen, neutral grau, negativ
orange, Feind rot, unbekannt gestrichelt), Rollen als Kuerzel-Chips (E,
B, N …) am Knoten, Kontaktintensitaet als Fuellung (0 leer bis I voll).
Das ist die Legende aus Abbildung 21 des Buchs, in Form gegossen.

**Kanten:** Einfluss als Pfeil (Staerke = Dicke), Vertrautheit als
Doppellinie, Animositaet als gestrichelte rote Linie.

**Beim Darueberfahren oder Anklicken** eine Seitenleiste mit drei
Bereichen:

1. **Einordnung** — die vier Dimensionen mit Herkunft und Grund
   (aus `BuyingCenterAngabe`, juengste zuerst): "Einfluss hoch — Nutzer,
   20.09.: 'hat das letzte Wort in Technikfragen'".
2. **Interaktionen** — was das CRM ueber Kontakte mit dieser Person
   weiss (Notizen, Anrufe, Termine), neueste zuerst, und was AVA
   beobachtet hat (LinkedIn-Aktivitaet, Positionswechsel).
3. **Offene Vorschlaege** — was AVA zu dieser Person vermutet und noch
   nicht bestaetigt ist, mit Annehmen/Verwerfen.

Eine leere Seitenleiste ist erlaubt. Sie sagt dann: "Zu dieser Person
liegt nichts vor. Du kannst im Chat ergaenzen, was du weisst."

### 8.2 Reiter in der Firmenansicht: nur das eigene

Denselben Graphen gibt es in der Firmenansicht als Reiter "Buying
Center" — **nur, wenn der Nutzer selbst eines zu dieser Firma hat.**
Sonst gibt es den Reiter nicht (Regel: Abgeschaltetes wird ausgeblendet,
und leere Reiter erscheinen ohnehin nicht mehr). Die Buying Center von
Kollegen erscheinen dort NIE — sonst wird die Firmenansicht
unuebersichtlich, und sie gehoeren dem Nutzer auch nicht.

### 8.3 Geteilte Buying Center: ein eigener Bereich

Was Kollegen freigegeben haben, bekommt einen eigenen Ort, getrennt von
allem Eigenen:

```
Mit dir geteilte Buying Center
  ▸ Zimmer Group GmbH                       2 Buying Center
      Henning Johnsen  ·  "Angebot Lager 2026"  ·  zuletzt 18.09.
      Patrick Dettley  ·  (ohne Anlass)          ·  zuletzt 02.09.
  ▸ Mueller KG                              1 Buying Center
      Henning Johnsen  ·  (ohne Anlass)          ·  zuletzt 11.09.
```

Eine Liste von Firmen, aufklappbar; darunter je Firma die freigegebenen
Buying Center der einzelnen Kollegen mit Eigentuemer, Anlass und Stand.
Ein Klick oeffnet einen **eigenen Bildschirm**, der nur dieses eine
Buying Center zeigt — dieselbe Karte, dieselbe Seitenleiste, aber ohne
jede Bearbeitung: keine Werkzeuge, kein Verschieben, das Verschieben
der Knoten wird nicht gespeichert. Oben steht, wem es gehoert.

Der Bereich erscheint in der Navigation nur, wenn mindestens eine
Freigabe fuer den Nutzer existiert. Ohne Freigaben gibt es ihn nicht.

Aus dem Chat heraus laesst sich ein geteiltes Buying Center ebenfalls
anzeigen ("zeig mir Hennings Buying Center zur Zimmer Group"); die
Setz-Werkzeuge lehnen dann mit dem Hinweis ab, dass es nicht das eigene
ist.

---

## 9. Lebendig halten

Das Buying Center darf nicht leise veralten. Drei Mechanismen:

1. **Personensignale laufen hinein.** Positionswechsel, Firmenwechsel,
   neue LinkedIn-Aktivitaet eines Mitglieds erscheinen als Hinweis am
   Knoten und als sofortige Meldung (Alarmweg-Positivliste).
2. **CRM-Abgleich beim Oeffnen.** Kontaktintensitaet wird aus den
   CRM-Aktivitaeten der letzten 90 Tage neu vorgeschlagen, wenn sie vom
   Nutzer nicht gesetzt ist. Ist sie gesetzt und weicht stark ab, ein
   Hinweis: "Du hast 'intensiv' eingetragen, im CRM steht seit vier
   Monaten nichts."
3. **Der Heartbeat fragt nach.** Einmal im Monat je aktivem Buying
   Center: "Stimmt das noch?" mit den drei aeltesten Angaben. Nicht
   oefter — sonst wird es ignoriert.

---

## 10. Datenschutz: die Folge der Entscheidung

Das Schema speichert Einschaetzungen ueber benannte Menschen, darunter
"Feind". Das ist entschieden, und die Begruendung ist tragfaehig. Drei
Konsequenzen, die sich daraus ergeben und in den Bau gehoeren:

1. **Auskunft (Art. 15).** Verlangt eine Person Auskunft, muss auch das
   Buying Center mitgeliefert werden — samt "Feind" und Grund. Das ist
   kein Grund, es nicht zu speichern, aber ein Grund, es **sachlich zu
   formulieren**: Der Chat-Prompt soll Gruende als Beobachtung
   festhalten ("bevorzugt laut eigener Aussage den Wettbewerber X"),
   nicht als Charakterurteil. Der bestehende Personen-Export (Herkunft,
   Art.-14-Hinweis) bekommt einen Abschnitt "Einschaetzungen im Buying
   Center".
2. **Autorenschaft ist Pflicht.** Jede Angabe traegt, wer sie gemacht
   hat. Wer "Feind" schreibt, steht dazu.
3. **Nie ueber den Eigentuemer hinaus — ausser durch seine ausdrueckliche
   Freigabe.** Kein Aggregat, keine Organisationssicht, kein Teilen
   zwischen Organisationen, keine Verwendung in Modell-Prompts fuer
   andere Firmen. Eine Freigabe ist eine Weitergabe von Einschaetzungen
   ueber Menschen und fragt deshalb nach.

Der bestehende Art.-14-Ablauf bleibt unberuehrt: Personen im Buying
Center sind dieselben Personen wie im Kontakt-Bestand.

---

## 11. Umsetzungsstufen

| Stufe | Inhalt | Ergebnis |
| --- | --- | --- |
| **BC0** | Gateway: Modelle, Migration, Routen (anlegen, lesen, Mitglied/Angabe/Kante setzen, abschliessen). Fokuskunde-Kennzeichen mit Deckel. | Speicherbar, noch unsichtbar |
| **BC1** | Chat-Werkzeuge anlegen/setzen/aufnehmen/kante/abschliessen. Entwurf aus dem Kontakt-Bestand mit Titel-Vorschlaegen. Prompt-Regeln fuer sachliche Gruende. | Im Chat erarbeitbar |
| **BC2** | ```buying-center-Zaun und Karte im Chat auf Verflechtungen-Grundlage, mit Seitenleiste (Einordnung, Interaktionen, Vorschlaege). Reiter in der Firmenansicht fuer Fokuskunden. | Sichtbar, klickbar |
| **BC3** | CRM: Kontaktintensitaet aus Aktivitaeten, Interaktionsverlauf in der Seitenleiste, Gespraechsmuster-Hinweis. | Leitfrage 3 aus Daten |
| **BC4** | Fokuskunden-Aufwand: gezielter Personen-Lauf ueber die Website (Hervorhebung), LinkedIn-Checkliste je Mitglied, Watchlist-Aufnahme mit Rueckfrage. | Leitfrage 1 und Buch-Checkliste aus Daten |
| **BC5** | Lebendigkeit: Personensignale am Knoten, Alarmweg-Positivliste, monatliche Nachfrage, Verknuepfen freier Personen mit dem Bestand. | Veraltet nicht leise |
| **BC6** | Auskunfts-Export, Faehigkeitsgruppe fuer die Vorschlaege, Organisationsschalter `buyingcenter` in `ORG_FEATURES`. | Vollstaendig |
| **BC7** *(spaeter)* | Sichtfreigabe: Freigabe-Werkzeug, Bereich "Mit dir geteilte Buying Center" mit aufklappbaren Firmen, eigener Nur-Lese-Bildschirm. | Kollegen koennen sehen, nicht aendern |

BC0–BC2 sind der Kern und gehoeren zusammen; damit laesst sich das
Buying Center im Chat erarbeiten und ansehen. BC3 macht es aus Daten
klueger, BC4 macht den Fokuskunden zum Fokuskunden, BC5 haelt es am
Leben.

### Stand der Umsetzung (2026-09-20)

| Stufe | Stand |
| --- | --- |
| BC0–BC2 | gebaut, Gateway deployt, Desktop v0.1.705 |
| BC3 | gebaut (CRM-Interaktionen je Mitglied, Kontaktintensitaets-Vorschlaege `ava:crm`, Gespraechsmuster-Hinweis, Route `POST …/mitglieder/{mid}/vorschlaege`); Gateway-Deploy und Desktop-Release folgen mit BC4 |
| BC4 | teilweise: Werkzeug `buying_center_beobachten` (LinkedIn-Checkliste je Mitglied: Profil bekannt / auf der Watchlist / Fokus / aufnehmbar; Aufnahme aller aufnehmbaren Mitglieder nach EINER Rueckfrage, Firma zugeordnet, optional Fokus; Mitglieder ohne Profil-URL werden benannt → `contact_linkedin_lookup` anbieten). `/v1/contacts/linkedin-profiles` liefert dafuer jetzt `personId`. **Teil 2 (2026-09-20):** Hervorhebung auf der Website. Der company-contact-Producer zaehlt je Seite durch (`hervorhebungJePerson`: Platz aus der Array-Position, nicht vom Modell erfragt; `mitFoto`/`mitZitat` vom Modell mit eigener Prompt-Regel `PAGE_HIGHLIGHT_RULES`), das Gateway schreibt daraus je Person und Seite den Fakt `websiteHervorhebung` ("Platz 1 von 12, mit Foto, mit Zitat", Seite in Observation.evidenceUrl, auch im Herkunftsnachweis), und das Buying Center legt beim Anlegen und beim Oeffnen (`GET …/vorschlaege`, nur im eigenen) einen offenen Einfluss-Vorschlag `ava:website` ab (`vorschlagAusHervorhebung`: erste Stelle von ≥ 3 → M, mit Foto oder Zitat → H; Platz ≤ 3 von ≥ 6 oder Foto+Zitat → M; sonst nichts; Fakten hoechstens 180 Tage alt). Kein eigener Zweitcrawl: Die Hervorhebung faellt im bestehenden Kontakte-Lauf im selben Modellaufruf mit an, deshalb fuer jede Firma; fuer den Altbestand liefert sie ein erneuter Kontakte-Lauf der Firma nach. Producer-Aenderung → wirkt ab dem naechsten Desktop-Release (v0.1.706 oder spaeter). **Noch offen:** Buch-Checkliste aus LinkedIn-Profildaten (neu in der Position, frueherer Arbeitgeber) — braucht Profildaten, nicht nur Aktivitaet. |
| BC5 | gebaut (2026-09-20): Naehe-Untergrenze 7 fuer Fokuskunden und Buying-Center-Mitglieder (Gateway `naeheMitFokus`); Fokuskunden-Positivliste im Alarmweg (nie sammeln, mindestens warn; `fokus.ts` liest die aktiven Buying Center); monatliche Nachfrage als Erinnerung (`nachgefragtAt`, `GET /v1/buying-center?faellig=true`, `POST …/nachgefragt`, Heartbeat einmal taeglich); Verknuepfen freier Personen (`verknuepfbar` in `/vorschlaege`, `POST …/mitglieder/{mid}/verknuepfen`, Werkzeug `buying_center_verknuepfen`); Naehe der Person in der Karten-Seitenleiste. Auslieferung mit Gateway-Deploy und v0.1.706. |
| BC6 | gebaut (2026-09-20): Organisationsschalter `buyingcenter` in `ORG_FEATURES` — Desktop: Tool-Sperre `buying_center_*` (`featureOfTool`), Faehigkeitsgruppe mit `feature`, Reiter in der Firmenansicht und ```buying-center-Block im Chat ausgeblendet, Heartbeat ohne Fokus-Positivliste und ohne monatliche Nachfrage; Gateway: 403 auf allen `/v1/buying-center`-Routen (auch lesend), Fokus-Untergrenze in der Relevanz nur mit Schalter. Auskunfts-Export `GET /v1/persons/{id}/herkunft` mit Abschnitt "Einschaetzungen im Buying Center" (`buyingCenterEinschaetzungen`): nur die Buying Center der ANFRAGENDEN Organisation, vier Dimensionen ausgeschrieben (auch "Feind"), Belegkette mit Autor (E-Mail/Name aus `TenantMember`, sonst Kennung), Beziehungen; Art.-14-Hinweis nennt die Einschaetzungen; die globale Personenloeschung raeumt Mitglieder und Kanten in allen Buying Centern mit. Auslieferung: Gateway-Deploy + naechstes Desktop-Release nach v0.1.706. |
| BC7 | offen (Sichtfreigabe, eigener Bereich, Nur-Lese-Bildschirm) |

---

## 12. Offene Entscheidungen

1. **Ein Buying Center je Firma oder je Kaufprozess?** Das Modell
   erlaubt mehrere (Feld `anlass`). Mein Vorschlag: im Chat standardmaessig
   eines je Firma, ein zweites nur auf ausdruecklichen Wunsch ("fuer das
   Projekt X ein eigenes").
2. **Deckel fuer Fokuskunden je Nutzer.** Vorschlag 25. Bei
   Ueberschreitung: Hinweis, kein hartes Nein.
3. **Kontaktintensitaets-Schwellen aus dem CRM** (0 / 1–2 / 3–8 / > 8 in
   90 Tagen). Geschaetzt; nach vier Wochen an echten Daten pruefen.
4. **Darf AVA "Einstellung" je vorschlagen?** Ich sage nein. Aus einem
   Repost lasst sich Engagement ablesen, nicht Wohlwollen uns gegenueber.
   Einstellung bleibt reine Nutzerangabe — das ist auch die Dimension,
   die im Auskunftsfall am heikelsten ist.
5. ~~**Sichtbarkeit in der Organisation.**~~ Entschieden: Ein Buying
   Center gehoert immer nur seinem Ersteller. Sichtfreigabe an einzelne
   Mitglieder als spaetere Stufe BC7, nur lesend, in einem eigenen
   Bereich.
