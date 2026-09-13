# Windows-Code-Signing der AVA-Desktop-App

Stand: 2026-09-13 (v0.1.641). Die Windows-Installer (`AVA-Setup-<version>.exe`)
werden seit v0.1.641 in CI mit einem Zertifikat auf **eproX GmbH** signiert.
Davor liefen sie unsigniert aus und Windows SmartScreen zeigte
„Unbekannter Herausgeber".

## Wie es funktioniert

Wir nutzen **Azure Artifact Signing** (bis Mitte 2026 „Trusted Signing"),
Microsofts verwalteten Signierdienst. Es gibt keinen privaten Schluessel in
unserem Besitz: Der Schluessel liegt bei Microsoft, jede Signatur wird per API
angefordert. Die ausgestellten Zertifikate sind **3 Tage gueltig** und werden
automatisch neu ausgestellt; deshalb ist der RFC-3161-Zeitstempel Pflicht
(electron-builder setzt ihn automatisch auf `http://timestamp.acs.microsoft.com`).

Ablauf im Release-Workflow (`.github/workflows/desktop-release.yml`, Job
`build-windows`):

1. `electron-builder --win --x64` baut die App.
2. electron-builder (>= 26) installiert das PowerShell-Modul `TrustedSigning`
   und ruft `Invoke-TrustedSigning` fuer `AVA.exe`, den Uninstaller und den
   NSIS-Installer auf. Anmeldung ueber `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET` (Azure `EnvironmentCredential`).
3. Der Schritt „Verify Authenticode signature" prueft jede `.exe` im
   Release-Ordner: Status `Valid`, Signierer `CN=eproX GmbH`, Zeitstempel
   vorhanden. Sonst bricht der Job ab.
4. electron-builder schreibt `publisherName: eproX GmbH` in `app-update.yml`;
   electron-updater prueft damit die Signatur jedes heruntergeladenen Updates
   (`verifyUpdateCodeSignature`, Default `true`).

Die Signier-Optionen stehen **nicht** in `electron-builder.yml`, sondern werden
per `--config.win.azureSignOptions.*` im Workflow uebergeben (wie
`mac.notarize`). So baut ein lokales `pnpm package:win` weiterhin ohne
Azure-Zugang, dann allerdings unsigniert.

## Azure-Ressourcen

| Was | Wert |
|---|---|
| Entra-Mandant | `jrafflenbeuleproxgmbh.onmicrosoft.com` („Standardverzeichnis") |
| Abonnement | `Azure subscription 1` (`c453d257-585e-448c-847c-dd2a525d9786`) |
| Ressourcengruppe | `ava-codesigning-rg` |
| Artifact-Signing-Konto | `eproxavasigning`, Region North Europe, Tarif Basic (9,99 USD/Monat, 5.000 Signaturen) |
| Endpoint | `https://neu.codesigning.azure.net` |
| Identitaetspruefung | Organisation / Oeffentlich, eproX GmbH, HRB17968, abgeschlossen 2026-09-13 |
| Zertifikatsprofil | `ava-desktop-public` (Public Trust), Subject `CN=eproX GmbH, O=eproX GmbH, L=Herford, S=North Rhine-Westphalia, C=DE` |
| App-Registrierung (CI) | `ava-desktop-codesign-ci`, Client-ID `39f7a0c3-4985-4630-8701-cd83d9731459` |
| Rolle der App | `Artifact Signing Certificate Profile Signer` auf dem Konto `eproxavasigning` |
| Rolle des Admins | `Artifact Signing Identity Verifier` (fuer neue Identitaetsantraege) |

West Europe nahm am 2026-09-13 keine neuen Kunden an, deshalb North Europe.
Die Region bestimmt den Endpoint; bei einem Umzug muss der Endpoint im
Workflow mitgezogen werden.

## GitHub-Secrets (Repository `eproX-GmbH/ava-services`)

| Secret | Inhalt |
|---|---|
| `AZURE_TENANT_ID` | Verzeichnis-ID des Mandanten |
| `AZURE_CLIENT_ID` | Anwendungs-ID (Client) der App-Registrierung |
| `AZURE_CLIENT_SECRET` | Wert eines Client-Geheimnisses der App-Registrierung (max. 24 Monate gueltig) |

Fehlt eines der drei, bricht der Windows-Job mit `::error` ab und
veroeffentlicht **kein** unsigniertes Paket.

## Wiederkehrende Pflege

- **Client-Geheimnis erneuern** (spaetestens alle 24 Monate): Azure-Portal →
  App-Registrierungen → `ava-desktop-codesign-ci` → Zertifikate & Geheimnisse →
  Neuer geheimer Clientschluessel → Wert in `AZURE_CLIENT_SECRET` eintragen.
  Das alte Geheimnis danach loeschen.
- **Identitaetspruefung verlaengern**: Die Pruefung hat ein Ablaufdatum (Spalte
  „Ablaufdatum" unter Identitaetsueberpruefungen). Rechtzeitig „Verlaengern"
  klicken, sonst stellt Microsoft keine Zertifikate mehr aus und der
  Windows-Job faellt im Signier-Schritt.
- **Firmendaten geaendert** (Name, Adresse): neue Identitaetspruefung anlegen,
  neues Zertifikatsprofil damit verknuepfen, `certificateProfileName` und ggf.
  `publisherName` im Workflow anpassen. Achtung: ein geaenderter
  `publisherName` bricht die Update-Signaturpruefung bestehender
  Installationen; dann muss die Vorgaengerversion beide Namen als Liste
  kennen (electron-builder erlaubt `publisherName` als Array).

## Fehlersuche

| Symptom | Ursache / Abhilfe |
|---|---|
| `Repository-Secret AZURE_* fehlt` | Secret nicht gesetzt, siehe Tabelle oben |
| `Invoke-TrustedSigning` meldet 401/403 | Geheimnis abgelaufen oder Rolle „Certificate Profile Signer" fehlt/entfernt |
| `Invoke-TrustedSigning` meldet 404 auf Profil | `certificateProfileName`/`codeSigningAccountName`/`endpoint` passen nicht zur Region |
| Verify-Schritt: Status nicht `Valid` | Zertifikatskette auf dem Runner nicht vertraut (selten, Windows-Root-Update fehlt) oder Signatur fehlgeschlagen. Log des Build-Schritts pruefen |
| SmartScreen warnt trotz Signatur | Signatur ist da (Herausgeber wird angezeigt), Reputation baut sich auf. Bei Artifact Signing ist sie an die geprueften Firmendaten gebunden und stellt sich erfahrungsgemaess schnell ein |

## Historie

- 2026-09-13, v0.1.641–v0.1.643: erster Signier-Lauf. v0.1.641 scheiterte
  am macOS-Schema (`mac.notarize` ist in electron-builder 26 nur noch ein
  Boolean) und an einem falsch kopierten Client-Geheimnis (`AADSTS7000215`,
  Geheimnis-ID statt Wert). v0.1.642 legte zwei Release-Objekte fuer einen
  Tag an (electron-publish 26 ohne vorab existierenden Entwurf); seit
  v0.1.643 erzeugt der Job `prepare-release` den Entwurf vorab.
- 2026-09-13: Azure-Abonnement, Signier-Konto, Identitaetspruefung (zweiter
  Antrag, der erste scheiterte an einem versehentlich geklickten
  „Irrtum"-Link in der Bestaetigungsmail), Zertifikatsprofil,
  App-Registrierung, Rollen. electron-builder 24.13 → 26.16 im Desktop-Paket,
  Workflow und Verify-Schritt (v0.1.641).
- Bis v0.1.640: Windows unsigniert (Phase-8.u1-Scope-Cut, siehe
  `docs/PLAN_ENTERPRISE_FREIGABE.md` E4.1).
