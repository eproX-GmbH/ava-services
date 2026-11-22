# Plan: AVA Cloud in Selbstbedienung

Stand 2026-11-21, Entwurf zur Abnahme. Baut auf docs/PLAN_AVA_CLOUD.md (§12–§14) auf.

## 1. Ziel

Neue Nutzer sollen AVA nutzen können, **ohne etwas zu installieren**. Heute verlieren wir viele
zwischen Registrierung und Desktop-Installation, und die Desktop-App muss für Hintergrundarbeit
dauerhaft laufen. Die Server-Instanz (headless AVA auf Fly) löst beides, gibt es aber nur per
Hand für Enterprise.

Zielbild:

1. Eine Organisation schaltet **je Mitglied** „AVA Cloud“ ein (oder ein Einzelnutzer für sich).
2. Die Zahlung läuft **sofort** über das bestehende Stripe-Abo der Organisation.
3. **Erst nach bezahlter Rechnung** legt AVA die Instanz automatisch an, ohne Operator.
4. Die Verbindung zum Konto ist **ein Klick in app.ava.bi**; keine Setup-Seite, kein Token-Link.
5. Sobald die Instanz läuft, kommt eine **Mail**.
6. Läuft die Zahlung aus, wird die Instanz **gestoppt und bleibt gestoppt**; niemand muss
   hinterherlaufen. Nach einer Frist werden die Daten gelöscht.
7. Desktop-App und Cloud dürfen gleichzeitig laufen; die Organisation sieht, wer was nutzt.

## 2. Was es schon gibt (Bestandsaufnahme 2026-11-21)

| Baustein | Stand |
|---|---|
| Headless AVA (`src/server/main.ts`, Image `ava-server-image:v<ver>` je Release) | fertig, läuft bei `headless-ava` und `ava-i-strategic-it` |
| Kontobindung `AVA_KONTO` (`core/konto-bindung.ts`) | fertig |
| Anlegen/Entfernen | nur per CLI-Skript vom Operator-Rechner (`scripts/instanz-anlegen.mjs`, `scripts/lib/instanz-fly.mjs`), Secrets nur in `~/.ava-instanzen/<slug>.json` |
| Image tauschen | Gateway `lib/instanz-update.ts` über Fly-Maschinen-API, Knopf in admin.ava.bi |
| Router `<slug>.ava.bi` | Gateway `lib/instanz-router.ts` per `fly-replay` |
| Auto-Start | bei Instanzen aus (`auto_start_machines=false`) |
| Embeddings | eigener Sidecar je Kunde (`ava-i-<slug>-ollama`, 2 GB) oder geteilt (`ava-ollama`) |
| Instanz-Datensatz | **keiner**: keine Tabelle, Liste nur im Speicher des Relais |
| Abrechnung | Stripe-Abo je Organisation mit Sitzen (Pro/Max/Ultra als Items), Webhook, Mahnlauf (`past_due` → nach 14 Tagen `suspended`); **berührt keine Instanz** |
| Preis | nur Kalkulation (`INSTANZ_PREIS_CENTS` 59 €), kein Stripe-Preis; Website und AGB sagen „nur auf Anfrage“ |
| Einrichtung | Setup-Seite der Instanz (Token-Link, Device-Code, API-Schlüssel, ChatGPT-Abo per URL-Einfügen, Telegram, Postfach): funktioniert, aber umständlich |
| Mails | Mailgun über `lib/mail/versand.ts`, Vorlagen in `lib/mail/vorlagen.ts`, Dienstmails ohne Einwilligung |
| Org-Rechte | `TenantMember` owner/admin/member, Einstellungen je Mitglied über `TenantBilling` des Mitglieds (LinkedIn-Limit, PAYG) |
| Gateway-Laufzeit | `min_machines_running = 1`, Cron (stündlich Abrechnung) läuft durchgehend |

Nebenbefund: Die Kontoprüfung in `instanz-update.ts` liest `AVA_KONTO` aus `config.env`; als
Fly-Secret steht es dort vermutlich nicht. Wird mit Z1 behoben.

## 3. Grundentscheidungen (Vorschlag)

### 3.1 Eine eigene Fly-Organisation für Kunden-Instanzen

Neue Fly-Org (z. B. `ava-kunden`) nur für Kunden-AVAs, mit eigenem Org-Token als Gateway-Secret
`FLY_KUNDEN_TOKEN`. Gateway, Keycloak, Datenbank und Worker bleiben in der bisherigen Org.

- Ein Fehler im Bereitsteller kann so nie eine Betriebs-App treffen.
- Fly-Tokens lassen sich nicht auf ein Namenspräfix beschränken, wohl aber auf eine Org.
- Kosten der Kunden-Instanzen sind auf der Fly-Rechnung getrennt sichtbar.
- Das Token liegt nur im Gateway, nie in einer Kunden-Maschine.

### 3.2 Jede Instanz in ihrem eigenen privaten Netz

Fly verbindet standardmäßig alle Apps einer Org über `.internal`. Jede Kunden-App bekommt beim
Anlegen ein eigenes Netz (`network: "ava-u-<id>"`, später nicht änderbar). Dann kann keine
Kunden-AVA eine andere erreichen.

Folge: Der Embeddings-Sidecar muss **im selben Netz** liegen, also in derselben App (§3.3), und
der Weg über `<slug>.ava.bi` per `fly-replay` aus dem Gateway funktioniert nicht über Netz- und
Org-Grenzen (§3.5).

### 3.3 Embeddings in derselben App

Drei Wege, Entscheidung nach dem Test in Z0:

| Weg | Kosten/Monat (fra) | Bewertung |
|---|---|---|
| **A: Ollama als zweiter Container in derselben Maschine** | keine zweite Maschine; ggf. mehr RAM | am einfachsten, ein Lebenszyklus; Fly-„Container“ in Maschinen erst prüfen |
| **B: zweite Maschine in derselben App** (2 GB) | + ca. 15 $ | sicher machbar, zwei Maschinen gemeinsam stoppen |
| C: geteilter Sidecar für alle | spart ca. 15 $/Nutzer | braucht je Kunden-Netz eine eigene Adresse und eigene Authentifizierung; verletzt die Trennung; **nicht empfohlen** |

### 3.4 Soll-Ist-Abgleich statt Einzelbefehlen

Der wichtigste Punkt für „nie hinterherlaufen müssen“: Das Gateway hält für jede Instanz einen
**Soll-Zustand**, abgeleitet aus Abrechnung und Schaltern, und gleicht ihn mit Fly ab.

```
soll = laufen  ⇔  Cloud für das Mitglied eingeschaltet
               ∧  Abrechnung der Org aktiv (nicht suspended/canceled, Cloud-Zeitraum bezahlt)
               ∧  nicht vom Betreiber gesperrt
               ∧  Konto nicht gelöscht/gesperrt
sonst  soll = gestoppt
```

- Der **Abgleicher** läuft alle 5 Minuten im Gateway-Cron und sofort nach jedem Stripe-Webhook
  und jeder Admin-Aktion.
- Läuft eine Maschine, die gestoppt sein soll (Fly-Neustart nach Host-Umzug, Proxy-Wettlauf,
  Fehler), stoppt der Abgleicher sie spätestens nach 5 Minuten wieder und schreibt ein Ereignis.
- Ist eine Maschine gestoppt, die laufen soll (Absturz), startet er sie.
- **Nur der Abgleicher startet Maschinen.** Kein Aufruf von außen (Router, PWA, MCP) kann eine
  gestoppte Instanz wecken.

### 3.5 Kein automatischer Start, mehrfach abgesichert

Fly startet gestoppte Maschinen von selbst über den Proxy (Autostart), über die Neustart-Regel
und nach Host-Umzügen. Absicherung in Schichten:

1. Maschinen-Konfiguration: `autostart: false`, `autostop: off`, Neustart-Regel `on-failure`.
2. Beim Stoppen: Dienste deregistrieren (`cordon`), dann stoppen.
3. Der Abgleicher (§3.4) korrigiert jede Abweichung binnen 5 Minuten.
4. Nach **7 Tagen** gestoppt: Maschine **löschen**, Volume behalten. Ohne Maschine kann nichts
   mehr starten; beim Fortsetzen legt der Abgleicher sie aus derselben Konfiguration neu an.
5. Kein öffentlicher Router-Weg: Die Instanz braucht für Nutzer keine eigene Adresse mehr
   (§3.6). Für den Betreiber reicht `<app>.fly.dev` (geteilte IPv4, kostenlos).

### 3.6 Nutzer sehen die Instanz nur über app.ava.bi

Die Setup-Seite der Instanz bleibt als Notzugang für den Betreiber. Für Nutzer läuft alles in
app.ava.bi (Mehr → Deine AVA) und in der Konsole:

- **Verbinden:** Die Instanz meldet ihren Device-Code beim Start über ein Einmal-Geheimnis an das
  Gateway. app.ava.bi zeigt „Cloud-AVA mit deinem Konto verbinden“; ein Klick öffnet die
  Keycloak-Bestätigung mit vorausgefülltem Code, der Nutzer ist dort schon angemeldet → „Ja“.
- **Modellzugang, Telegram, Postfach:** über das bestehende Relais (`appAnfrage`) als Formulare in
  app.ava.bi statt auf der Setup-Seite. Org-Schlüssel greift wie heute automatisch.
- **Umzug** Desktop → Cloud bleibt wie gebaut (Einstellungen → Deine AVAs).

### 3.7 Abrechnung als viertes Item am Org-Abo

Ein Stripe-Preis `STRIPE_PRICE_CLOUD` als weiteres Item am bestehenden Sitz-Abo der Organisation,
Menge = Mitglieder mit Cloud. Damit gelten Zyklus, Rechnung, Portal und Mahnlauf wie bei Sitzen.

- **Einschalten:** Menge +1 mit `proration_behavior: always_invoice` → Stripe stellt sofort eine
  anteilige Rechnung bis zum Zyklusende. **Angelegt wird erst bei `invoice.paid`.**
- **Organisation ohne Abo** (Free): eigener Checkout für die Cloud; danach dasselbe.
- **Ausschalten durch Admin:** Menge −1 zum Zyklusende (wie Sitze, keine Erstattung); die Instanz
  läuft bis dahin.
- **Zahlung scheitert:** `past_due` → Instanz läuft während einer **Cloud-Frist** (Vorschlag 7
  Tage) weiter, dann gestoppt. `invoice.paid` → Abgleicher startet wieder.
- **Kündigung** (`subscription.deleted`): sofort gestoppt.

## 4. Lebenszyklus einer Instanz

```
angefragt ──(Admin schaltet ein)──▶ zahlung_offen ──(invoice.paid)──▶ wird_angelegt
                                                                          │
                                       ┌──────────────────────────────────┘
                                       ▼
                               wartet_auf_verbindung ──(Device-Code bestätigt, Relais da)──▶ laeuft
                                                                                              │
     ┌──────────── (soll = gestoppt: Zahlung, Admin, Kündigung, Betreiber) ◀──────────────────┘
     ▼
  gestoppt ──(7 Tage)──▶ ruht (Maschine gelöscht, Volume da) ──(30 Tage, Mail 7 Tage vorher)──▶ geloescht
     ▲                     │
     └──(soll = laufen)────┘  (Abgleicher startet bzw. legt Maschine neu an)
```

Jeder Übergang wird als Ereignis gespeichert (wer, warum, wann) und ist in Konsole und
Betreiber-Ansicht sichtbar.

## 5. Datenmodell (Gateway)

```prisma
model CloudInstanz {
  id            String   @id @default(cuid())
  tenantId      String
  actorId       String            // Kontobindung AVA_KONTO
  flyApp        String   @unique  // ava-u-<kurz>
  region        String   @default("fra")
  groesse       String   @default("standard")  // standard 4 GB | gross 8 GB
  zustand       String            // siehe §4
  soll          String            // laufen | gestoppt
  grund         String?           // zahlung | admin | kuendigung | betreiber | konto
  imageVersion  String?
  maschinenIds  Json?             // Kopf (+ Sidecar)
  volumeId      String?
  bootstrapHash String?           // Einmal-Geheimnis für die Erstverbindung (nur Hash)
  bezahltBis    DateTime?
  gestopptAt    DateTime?
  loeschenAb    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([tenantId, actorId])
}

model CloudEreignis {
  id         String   @id @default(cuid())
  instanzId  String
  art        String   // angelegt, gestartet, gestoppt, wieder_gestoppt, neu_angelegt, geloescht, fehler …
  quelle     String   // abgleicher | webhook | admin | betreiber | system
  details    Json?
  createdAt  DateTime @default(now())
  @@index([instanzId, createdAt])
}
```

`AVA_SECRETS_KEY` wird beim Anlegen erzeugt und **nur** als Fly-Secret gesetzt, nirgends sonst
gespeichert. Den alten Setup-Token gibt es für Selbstbedienungs-Instanzen nicht mehr.

## 6. Sicherheit

- Fly-Token nur im Gateway, nur für die Kunden-Org (§3.1).
- Eigenes Netz je Instanz (§3.2), keine öffentliche Kunden-Adresse nötig (§3.5).
- Anlegen nur nach bezahlter Rechnung; Obergrenze je Organisation (Vorschlag 10 ohne
  Betreiber-Freigabe) und global (Fly-Limit 100 Maschinen je Org, Erhöhung bei Fly anfragen).
- Notschalter `CLOUD_SELBSTBEDIENUNG=0`: keine neuen Instanzen, bestehende laufen weiter.
- Kontobindung wie heute; die Erstverbindung nimmt nur das gebundene Konto an.
- Alle Fly-Aufrufe idempotent (Idempotenzschlüssel, Wiederaufnahme nach Gateway-Neustart).
- Betreiber-Alarm bei: Anlegen fehlgeschlagen, Maschine lief gegen Soll, Kosten-Abweichung
  (Fly-Maschinen ohne Datensatz).

## 7. Kosten je Nutzer (Fly, fra, Recherche 2026-11-21)

| Zustand | Weg A (ein Container-Paar) | Weg B (zwei Maschinen) |
|---|---|---|
| läuft 24/7 | ca. 33 $ | ca. 48 $ |
| gestoppt (Volumes + Root-FS) | ca. 4,50 $ | ca. 4,50 $ |
| ruht (nur Volumes) | ca. 1,50–3,75 $ | ca. 3,75 $ |

Kalkulation heute: 59 € je Instanz. Bei Weg B bleibt wenig Marge; deshalb Z0 zuerst.

## 8. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| **Z0** | Test in einer neuen Fly-Org: Anlegen/Stoppen/Löschen per Maschinen-API aus einem Skript; prüfen, dass gestoppte Maschinen gestoppt bleiben (Autostart aus, cordon, Neustart-Regel); Ollama als zweiter Container; Speicherbedarf messen; Device-Code-Übergabe | 2–3 Tage |
| **Z1** | `CloudInstanz`/`CloudEreignis`, Fly-Client `lib/fly-maschinen.ts` (REST statt CLI), idempotente Schritte Anlegen/Stoppen/Starten/Neu-Anlegen/Löschen, Betreiber-Routen zum Testen; Fix Kontoprüfung `instanz-update.ts` | 4–5 Tage |
| **Z2** | Abgleicher (Soll/Ist, Cron + Ereignisse), Ruhen nach 7 Tagen, Löschfrist, Notschalter, Betreiber-Alarm | 3–4 Tage |
| **Z3** | Stripe: Preis Cloud, Item am Org-Abo, Sofortrechnung, Anlegen bei `invoice.paid`, Mahnlauf/Kündigung → Soll; Checkout für Orgs ohne Abo | 4–5 Tage |
| **Z4** | Erstverbindung ohne Setup-Seite (Device-Code über Gateway, Ein-Klick in app.ava.bi), Mail „Deine AVA läuft“, Mails „gestoppt“ und „Löschung in 7 Tagen“ | 3–4 Tage |
| **Z5** | Oberflächen: app.ava.bi „Deine AVA“ (Status, Verbinden, Modellzugang, Telegram, Postfach über Relais), Konsole je Mitglied (Schalter, Zustand, Kosten), Betreiber-Übersicht, Hinweis in der Desktop-App | 6–8 Tage |
| **Z6** | Registrierung: „Im Browser starten (Cloud)“ neben „Desktop-App laden“; Preise-Seite, AGB §3, Datenschutz; Onboarding-Messung (PLAN_ONBOARDING O0) | 2–3 Tage |
| **Z7** | Automatische Image-Aktualisierung nach jedem Release (erst eine Instanz, dann alle), Löschung mit Snapshot-Frist, Übernahme der bestehenden Hand-Instanzen | 3 Tage |

Summe ca. 6–7 Wochen. Z0–Z2 sind ohne Preis- oder AGB-Entscheidung baubar; ab Z3 braucht es
die Entscheidungen unten.

## 8a. Ergebnis Z0 (2026-11-22)

Test in der Fly-Org `ava-447` („AVA“, Entscheidung Joyce: wird die Kunden-Org) mit
`scripts/cloud-z0.mjs`, ausschließlich über die Maschinen-REST-API. Testinstanz danach gelöscht.

| Frage | Ergebnis |
|---|---|
| Anlegen ohne CLI (App mit eigenem Netz, Secrets, Volume, IPs, Maschine) | ✓ in unter 1 Minute bis `started`, `/healthz` 200 |
| Image aus der persönlichen Org | ✗ Fly lädt keine Images über Org-Grenzen → Image-App `ava-kunden-image` in `ava-447` angelegt, Image kopiert. **Folge:** Release-CI muss jedes Server-Image zusätzlich dorthin schieben. |
| AVA + Ollama als zwei Container in **einer** Maschine (Weg A) | ✓ AVA erreicht Ollama über `127.0.0.1:11434`, beide sehen das Volume `/data`, Modelle liegen unter `/data/ollama` |
| Speicher (4 GB-Maschine) | Leerlauf: AVA ≈ 1,9 GB, Ollama ≈ 0,2 GB. Mit geladenem Modell und 20 Embeddings: gesamt ≈ 2,4 GB belegt, 1,5 GB frei. 4 GB reichen für den Start; unter echter Aufbereitung (Chromium) noch messen. |
| Embeddings | `embeddinggemma` (621 MB), 20 Abrufe in 3,5 s inkl. Laden, 768 Dimensionen |
| Secrets bei Containern | ✗→✓ Fly reicht App-Secrets **nicht** automatisch an Container durch; sie müssen je Container genannt werden (`containers[].secrets`). Vorteil: Ollama sieht keine AVA-Secrets. |
| Gestoppt + 30 Anfragen über 5 Min. (mit `cordon`) | ✓ bleibt gestoppt, kein Startereignis |
| Gestoppt ohne `cordon` + 25 Anfragen | ✓ bleibt gestoppt |
| Konfig-Änderung an gestoppter Maschine (`skip_launch`) + 30 Anfragen | ✓ bleibt gestoppt (der in der Community gemeldete Wettlauf trat nicht auf) |
| Maschine löschen, Volume behalten, neu anlegen | ✓ in 4 s angelegt, nach ~20 s gesund; Instanz-ID, Daten und Modell vorhanden |
| Ein-Klick-Anmeldung | ✓ machbar: die Instanz hat den Keycloak-Link mit vorausgefülltem Code (`verification_uri_complete`); muss in Z4 ans Gateway gemeldet statt auf der Setup-Seite gezeigt werden |
| API-Eigenheiten | `wait` höchstens 60 s je Aufruf; `fly auth token` läuft nach wenigen Minuten ab → für das Gateway ein dauerhaftes Org-Token für `ava-447` nötig |

**Entscheidung E8 damit:** Weg A (ein Rechner, zwei Container). Kosten je laufender Instanz
≈ 33 $/Monat (fra), gestoppt ≈ 2 $ (10-GB-Volume + Root-FS), ruhend ≈ 1,50 $.

Bleibt in Z1: Org-Token für `ava-447` (Joyce bestätigt das Erzeugen), Release-CI schiebt das
Image auch nach `registry.fly.io/ava-kunden-image`.

## 8b. Stand Z1 (2026-11-22)

Gebaut und deployt (Gateway v401): Tabellen `CloudInstanz`/`CloudEreignis`, Fly-Client
`lib/cloud/fly-maschinen.ts` (Token `FLY_KUNDEN_TOKEN` nur für `ava-447`), Konfiguration
`lib/cloud/konfig.ts`, Abläufe `lib/cloud/instanzen.ts`, Betreiber-Routen
`/v1/betreiber/cloud/instanzen`, Test `npm run test:cloud`. Release-CI kopiert Images nach
`ava-kunden-image` (Secret `FLY_KUNDEN_IMAGE_TOKEN`).

Live-Test mit dem Demo-Konto (im Gateway, echte Org und Datenbank, danach gelöscht):

| Schritt | Ergebnis |
|---|---|
| anlegen bis `wartet_auf_verbindung` | ✓ 116 s (erstes Laden des Images); `/healthz` 200 |
| stoppen + 6 Anfragen | ✓ bleibt `stopped` |
| ruhen | ✓ Maschine gelöscht, Volume bleibt |
| starten aus `ruht` | ✓ neue Maschine mit altem Volume in 4 s `started`; `/healthz` 35 s danach noch nicht erreichbar → in Z2 erst nach erfolgreichem Health-Check als bereit werten |
| löschen | ✓ App weg, Datensatz `geloescht`, Ereigniskette vollständig |

Nebenbei: Kontoprüfung beim Image-Tausch (`instanz-update.ts`) liest die Bindung jetzt aus den
Maschinen-Metadaten; `ava-i-strategic-it` braucht dafür einmal `ava_konto` in den Metadaten.

## 8c. Stand Z2 (2026-11-22, gebaut)

- **Wunsch und Soll getrennt:** `gewuenscht` (Admin/Betreiber) bleibt, wenn der Abgleicher wegen
  Zahlung/Konto stoppt; ist das geklärt, läuft die Instanz von selbst wieder an.
- **Soll-Regeln** (`lib/cloud/abgleich.ts`, `sollBestimmen`): Konto gesperrt/gelöscht → gestoppt
  (konto); Abrechnung `canceled` → gestoppt (kuendigung); `suspended` → gestoppt (zahlung);
  Wunsch gestoppt → gestoppt; sonst laufen. `past_due` läuft bis `suspended` (Cloud-Frist E6 kommt
  mit Z3).
- **Abgleicher** (`abgleichen`, alle 5 Min., erster Lauf 1 Min. nach Start; Betreiber-Route
  `POST /v1/betreiber/cloud/abgleich`): je Instanz genau eine Aktion — Anlegen fortsetzen
  (höchstens 5 Fehlversuche), stoppen (Meldung, wenn Fly sie selbst gestartet hat), nach 7 Tagen
  ruhen, nach 30 Tagen löschen (nur mit `CLOUD_AUTO_LOESCHEN=1`, sonst Meldung „Löschung fällig“
  bis die Vorwarn-Mail aus Z4 steht), Absturz neu starten, `/healthz` prüfen (Meldung nach
  15 Min. ohne Antwort), Fly-Apps ohne Datensatz melden.
- **Meldungen** an den Betreiber per Telegram (`betreiberBenachrichtigen`), je Art und Instanz
  höchstens alle 6 Stunden.
- **Notschalter:** `CLOUD_ABGLEICH=0`.
- Test: `npm run test:cloud` (40 Prüfungen).

## 9. Offene Entscheidungen

| # | Frage | Vorschlag |
|---|---|---|
| E1 | Preis je Instanz und Monat | 59 € netto (Kalkulation), alternativ 49 € nur bei Weg A |
| E2 | Cloud nur mit bezahltem Sitz (Pro+) oder auch für Free | nur mit bezahltem Sitz |
| E3 | Wer bestellt | Admin/Owner schaltet je Mitglied; Mitglieder können „anfragen“ (Mail an Admins); Einzelnutzer = Owner = direkt |
| E4 | Abrechnung beim Einschalten | anteilig bis Zyklusende sofort in Rechnung, Anlegen erst nach Zahlung |
| E5 | Ausschalten durch Admin | läuft bis Zyklusende, keine Erstattung (wie Sitze) |
| E6 | Frist bei gescheiterter Zahlung | 7 Tage, dann gestoppt (Org-Mahnlauf hat 14) |
| E7 | Aufbewahrung nach Stopp/Kündigung | 7 Tage gestoppt, dann ruhend; nach 30 Tagen gelöscht, Mail 7 Tage vorher |
| E8 | Embeddings | **entschieden durch Z0: Weg A** (zwei Container in einer Maschine) |
| E9 | Adresse | keine Kunden-Adresse; alles über app.ava.bi; `<slug>.ava.bi` nur für Bestands-Instanzen |
| E10 | Updates | Selbstbedienungs-Instanzen automatisch nach jedem Release; Enterprise weiter per Knopf |
| E11 | Fly-Org | **entschieden: `ava-447` („AVA“)**; Org-Token für das Gateway noch zu erzeugen |
| E12 | Standardweg nach der Registrierung | Cloud als erster Vorschlag, Desktop-App als Alternative |

## 10. Customer Journey und Benachrichtigungen (2026-11-22, Entwurf)

Anstoß Joyce: Gerade Einzelkämpfer dürfen nach der Registrierung nicht „lost“ sein. Die Wahl
„AVA läuft für mich im Hintergrund (Server)“ muss so einfach sein wie der Desktop-Download, und
der Nutzer muss jederzeit wissen, was mit seiner AVA los ist – auch per Mail.

### 10.1 Grundsätze

1. **Eine Entscheidung, zwei gleichwertige Wege.** Nach der Registrierung fragt AVA einmal: „Wo
   soll AVA für dich arbeiten?“ – *Im Hintergrund auf unserem Server* oder *Auf deinem Rechner
   (Desktop-App)*. Kein automatischer Download mehr, bevor der Nutzer gewählt hat.
2. **Später jederzeit wechselbar.** Wer mit der Desktop-App startet, sieht dort und in app.ava.bi
   einen ruhigen Hinweis „AVA auch arbeiten lassen, wenn dein Rechner aus ist“ → Server dazubuchen;
   die Daten zieht der vorhandene Umzug mit.
3. **Immer ein sichtbarer Status.** Jeder Zustand der Instanz hat einen Satz in Nutzersprache, eine
   Farbe und genau eine nächste Handlung (§10.3) – in app.ava.bi, in der Desktop-App und in der
   Konsole der Organisation.
4. **Mails nur bei Änderungen, die den Nutzer betreffen.** Jede Mail sagt: was ist passiert, was
   bedeutet es für dich, was musst du tun (oft: nichts), mit genau einem Knopf. Keine Fachbegriffe
   (Instanz, Fly, Maschine, Volume), keine Plan-Verweise.
5. **Keine Mail-Flut.** Ausfälle erst nach 10 Minuten, je Instanz höchstens eine Ausfallmail in
   6 Stunden; Wackeln wird zu einer Mail zusammengefasst. Geplante Updates erzeugen keine
   Ausfallmail.

### 10.2 Wege durch AVA

**A. Einzelkämpfer, neu (Hauptfall)**

| Schritt | Was der Nutzer sieht | Was im Hintergrund passiert |
|---|---|---|
| 1. Registrieren (www.ava.bi/registrieren) | wie heute | Keycloak-Konto, Start-Analyse |
| 2. `/willkommen` | „Wo soll AVA für dich arbeiten?“ zwei Karten: **Server** (Vorteile: läuft rund um die Uhr, nichts installieren, Preis klar sichtbar) und **Desktop-App** (kostenlos, läuft, solange dein Rechner an ist) | – |
| 3a. Server gewählt | Stripe-Checkout (Sitz + Server, ein Betrag) | nach `invoice.paid`: Instanz wird angelegt |
| 4a. Weiterleitung zu app.ava.bi | Statuskarte „Deine AVA wird eingerichtet … (1–3 Minuten)“ mit Fortschritt; Mail M1 „Zahlung erhalten, AVA wird eingerichtet“ | Abgleicher legt an |
| 5a. Instanz gesund | Karte: „Fast fertig: Bestätige, dass diese AVA für dich arbeiten darf“ → **ein Klick** (Keycloak-Bestätigung, Nutzer ist schon angemeldet) | Device-Code über Gateway (Z4) |
| 6a. Verbunden | Karte „Deine AVA läuft“ + nächster Schritt „Modell wählen“ (ChatGPT-Abo, API-Schlüssel oder Org-Schlüssel) direkt in app.ava.bi; Mail M2 „Deine AVA läuft“ mit Links: app.ava.bi, Telegram verbinden, Desktop-App optional | Relais meldet Verbindung → `verbundenAt` |
| 3b. Desktop gewählt | Download startet wie heute | – |
| 4b+ später | Hinweis in Desktop/app.ava.bi „Server dazubuchen“ (siehe 10.1 Nr. 2) | Weg 3a ff., danach Umzug Desktop → Server angeboten |

**B. Organisation:** Admin schaltet in der Konsole (Mitglieder) je Person „Server“ ein; die
Person bekommt M2, sobald ihre AVA läuft, Admins sehen den Status in der Mitgliederliste.
Mitglieder ohne Server sehen in app.ava.bi „Server anfragen“ → Mail an Admins.

**C. Rückweg:** Server abbestellen (Einzelkämpfer: app.ava.bi → Deine AVA; Organisation:
Konsole) → läuft bis Ende des Abrechnungszeitraums → Mail M9 mit Datum, Hinweis auf Umzug zurück
auf den Desktop.

### 10.3 Status in Nutzersprache

| Zustand (intern) | Anzeige | Farbe | Nächste Handlung |
|---|---|---|---|
| Zahlung offen | „Zahlung wird bestätigt …“ | grau | – |
| `wird_angelegt` | „Deine AVA wird eingerichtet (1–3 Minuten)“ | blau | – |
| `wartet_auf_verbindung` | „Fast fertig: Bestätige, dass diese AVA für dich arbeiten darf“ | gelb | **Jetzt bestätigen** |
| `laeuft`, ohne Modell | „Deine AVA läuft – wähle noch, mit welchem KI-Modell sie arbeitet“ | gelb | **Modell wählen** |
| `laeuft`, gesund | „Deine AVA läuft im Hintergrund“ (+ zuletzt aktiv) | grün | – |
| Update läuft | „Deine AVA wird gerade aktualisiert (wenige Minuten)“ | blau | – |
| ungesund > 10 Min. | „Deine AVA ist gerade nicht erreichbar. Wir kümmern uns darum.“ | rot | Hilfe/Problem melden |
| gestoppt (zahlung) | „Pausiert: Die letzte Zahlung ist nicht eingegangen. Deine Daten bleiben erhalten.“ | rot | **Zahlung aktualisieren** |
| gestoppt (kuendigung/admin) | „Pausiert seit …. Deine Daten bleiben bis … erhalten.“ | grau | **Wieder starten** (bzw. Admin fragen) |
| ruht | wie gestoppt, plus Löschdatum | grau | **Wieder starten** |

### 10.4 Mail-Katalog

Alle Mails gehen an den Nutzer der Instanz; Zahlungsmails zusätzlich an Owner/Admins der
Organisation (bei Einzelkämpfern dieselbe Person). Dienstmails ohne Einwilligung
(`DIENSTMAILS`), weil sie den gebuchten Dienst betreffen; nur M7 (Update) lässt sich abbestellen.

| # | Mail | Auslöser | Zeitpunkt/Bremse | Knopf |
|---|---|---|---|---|
| M1 | „Zahlung erhalten – deine AVA wird eingerichtet“ | erste `invoice.paid` für den Server | sofort | Status ansehen |
| M2 | „Deine AVA läuft“ | erstmals `laeuft` + gesund | sofort, einmalig | AVA öffnen (+ Telegram, Desktop optional) |
| M3 | „Ein Schritt fehlt noch: AVA bestätigen“ | `wartet_auf_verbindung` > 30 Min. | einmal nach 30 Min., einmal nach 24 h | Jetzt bestätigen |
| M4 | „Deine AVA ist gerade nicht erreichbar“ | ungesund ≥ 10 Min. (nicht bei Update/Stopp) | höchstens 1 je 6 h | Status ansehen |
| M5 | „Deine AVA läuft wieder“ | nach M4 wieder gesund ≥ 5 Min. | sofort; mit Dauer des Ausfalls | – |
| M6 | „Deine AVA wird heute Nacht aktualisiert“ | nur bei Updates mit spürbarer Änderung | am Vortag | Was ist neu |
| M7 | „AVA ist jetzt auf dem neuesten Stand“ | Update erfolgreich | gesammelt höchstens 1 je Woche; abbestellbar | Was ist neu |
| M8 | „Zahlung fehlgeschlagen – bitte Zahlungsmittel prüfen“ | `invoice.payment_failed` | sofort; Erinnerung Tag 3 und Tag 6 („morgen wird pausiert“) | Zahlung aktualisieren (Stripe-Portal) |
| M9 | „Deine AVA ist pausiert“ | gestoppt wegen Zahlung/Kündigung/Admin | sofort; nennt Grund, Datenaufbewahrung bis … | Zahlung aktualisieren / Wieder starten |
| M10 | „Deine AVA läuft wieder“ (nach Pause) | `invoice.paid` nach Pause bzw. Wieder starten | sofort | AVA öffnen |
| M11 | „Deine Daten werden in 7 Tagen gelöscht“ | 23 Tage nach Stopp | einmal | Wieder starten / Daten auf den Desktop holen |
| M12 | „Deine Daten wurden gelöscht“ | Löschung | sofort | – |
| M13 | Zahlungsbeleg | jede erfolgreiche Zahlung | **Stripe** verschickt Rechnung/Beleg (Kundenmail in Stripe einschalten); AVA schickt keine eigene Mail | Rechnung |

Erst M11 macht die automatische Löschung (`CLOUD_AUTO_LOESCHEN=1`) vertretbar.

### 10.5 Zahlungsverlauf mit Folgen (Vorschlag zu E6)

| Tag | Ereignis | Instanz | Mail |
|---|---|---|---|
| 0 | Zahlung scheitert (`past_due`) | läuft | M8 |
| 3 | Stripe versucht erneut | läuft | M8 Erinnerung |
| 6 | | läuft | M8 „morgen wird pausiert“ |
| 7 | Cloud-Frist abgelaufen | **gestoppt** | M9 |
| 14 | Org-Mahnlauf (`suspended`) | gestoppt | – |
| 14 (gestoppt seit 7 Tagen) | | ruht | – |
| 30 | | | M11 (Löschung in 7 Tagen) |
| 37 | | **gelöscht** | M12 |
| jederzeit | Zahlung geht ein | startet wieder | M10 |

### 10.6 Updates für alle Instanzen

- **Wellen:** nach jedem Release zuerst die Betreiber-Instanz, nach 24 h ohne Auffälligkeiten
  10 % der Kunden-Instanzen, nach weiteren 24 h der Rest. Abbruch der Welle bei Fehlerquote > 5 %.
- **Fenster:** nachts 02:00–05:00 Uhr (Berlin), außer der Nutzer startet es selbst („Jetzt
  aktualisieren“ in app.ava.bi).
- **Ablauf je Instanz:** Image tauschen → warten bis gesund (max. 10 Min.) → sonst automatisch
  zurück auf die alte Version + Betreiber-Meldung. Während des Updates keine Ausfallmail.
- **Information:** M6 nur bei spürbaren Änderungen, M7 gesammelt; „Was ist neu“ verlinkt die
  Release-Notiz in Nutzersprache.

### 10.7 Wo der Nutzer was sieht

- **app.ava.bi → Deine AVA:** Statuskarte (§10.3), Server buchen/abbestellen, Bestätigen,
  Modellzugang, Telegram, Postfach, „Jetzt aktualisieren“, Daten auf den Desktop holen.
- **Desktop-App:** Hinweis „Server dazubuchen“ und, falls gebucht, Status der Server-AVA.
- **Konsole (Organisation):** Mitgliederliste mit Server-Schalter und Status je Person; Abrechnung
  mit Server-Posten.
- **Telegram** (falls verbunden): dieselben Statusmeldungen wie M4/M5/M9/M10 als Nachricht – kommt
  vom Gateway, nicht von der Instanz (die bei einem Ausfall nichts senden kann).

### 10.8 Neue Entscheidungen

| # | Frage | Vorschlag |
|---|---|---|
| E13 | Einzelkämpfer-Preis | Paket „Pro + Server“ als ein Betrag (z. B. 99 € statt 49 + 59), damit der Server-Weg nicht teurer wirkt als nötig |
| E14 | Testphase für den Server | keine kostenlose Testphase (Kosten ab Minute 1); stattdessen monatlich kündbar, anteilige Abrechnung |
| E15 | Wahl auf `/willkommen` | zwei gleichwertige Karten, **Server zuerst** (empfohlen), kein automatischer Download mehr |
| E16 | Wer bekommt Zahlungsmails | Nutzer + Owner/Admins; Einzelkämpfer nur einmal |
| E17 | Update-Mails | M7 gesammelt wöchentlich und abbestellbar; M6 nur bei spürbaren Änderungen |
| E18 | Update-Wellen und Fenster | wie §10.6 |

### 10.9 Auswirkung auf die Stufen

- **Z3** (Abrechnung) bringt M1, M8, M9, M10 und die Cloud-Frist (§10.5) mit.
- **Z4** (Erstverbindung) bringt M2, M3, M4, M5, M11, M12 und die Telegram-Spiegelung.
- **Z5** (Oberflächen) baut die Statuskarte (§10.3) an allen drei Orten.
- **Z6** (Registrierung) baut `/willkommen` mit der Wahl (E15) und den Desktop-Hinweis.
- **Z7** (Updates) baut die Wellen (§10.6) mit M6/M7.
- Aufwand zusätzlich ca. 1 Woche (Mail-Vorlagen, Statuskarte an drei Orten, Wellen).
