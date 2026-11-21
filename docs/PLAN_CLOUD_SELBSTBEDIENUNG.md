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
| E8 | Embeddings | nach Z0: Weg A, sonst B; geteilt (C) nicht |
| E9 | Adresse | keine Kunden-Adresse; alles über app.ava.bi; `<slug>.ava.bi` nur für Bestands-Instanzen |
| E10 | Updates | Selbstbedienungs-Instanzen automatisch nach jedem Release; Enterprise weiter per Knopf |
| E11 | Fly-Org `ava-kunden` | Joyce legt sie an (Zahlungsweg bei Fly) und erzeugt das Org-Token |
| E12 | Standardweg nach der Registrierung | Cloud als erster Vorschlag, Desktop-App als Alternative |
