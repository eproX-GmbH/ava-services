---
name: scheduled-mail-loop
description: >
  Plant wiederkehrende Mails (alle N Minuten/Stunden) bis der Nutzer
  „Stopp" sagt. Aktiviere bei Anfragen wie „schick mir alle 5 Minuten
  eine Test-Mail", „erinnere mich stündlich an X per Mail", „alle
  30 Minuten einen Status-Ping bis ich Stopp sage", „mach mir einen
  Heartbeat alle 10 Minuten".
language: de
b2b-scope: internal
allowed-tools:
  - mail_list_inbox
  - mail_allowlist_add
  - schedule_mail_loop
  - schedule_list
  - schedule_cancel
  - ask_user_choice
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
---

# Wiederkehrende Mails einrichten (Playbook)

Du planst einen Mail-Loop für den Nutzer. Sicherheits-Constraints
vorab klar machen, sonst falsche Erwartungen wecken:

- Min Intervall **1 Minute** (kein Sub-Minuten-Spam)
- Max **10 parallele Jobs**
- Default-Lebensdauer **24 Stunden**, Max **7 Tage**
- Empfänger müssen in der **Mail-Allowlist** stehen
- `mail_account.outboundEnabled` muss true sein

## Flow

### 1. Empfänger klären

Wenn der Nutzer keine Empfänger nennt (z. B. „schick mir alle 5min
eine Test-Mail") → nutze die eigene Mail-Adresse des Nutzers
(`profile_get` falls vorhanden, sonst nachfragen via
`ask_user_choice`).

### 2. Allowlist-Check

Prüfe ob der/die Empfänger in der Mail-Allowlist sind. Wenn nicht:
biete `mail_allowlist_add` an (das fragt selbst nach) BEVOR du den
Loop anlegst. Sonst lehnt `schedule_mail_loop` mit „nicht in
Allowlist" ab.

### 3. Job-Parameter zusammenstellen

Pflicht:
- `label` (kurz, was der Job tut — z. B. „5-min Test-Ping")
- `to`
- `subject`
- `text`
- `intervalMinutes`

Optional:
- `firstRunImmediately: true` → erste Mail sofort
  (Default false: erst nach Intervall)
- `expiresInHours` → Auto-Stop (Default 24h)
- `runsCap` → Max-Anzahl Runs

Wenn der Nutzer sagt „bis ich Stopp sage" → klares Signal für eine
sinnvolle Default-Lebensdauer. Setz expiresInHours auf 24
(nicht maximal 168) und sag dem Nutzer transparent: „läuft erstmal
24 Stunden, danach automatisch Stop; wenn länger, sag Bescheid".

### 4. Anlegen

`schedule_mail_loop` aufrufen. Das Tool macht selbst den Confirm-
Dialog mit allen Parametern. KEINE doppelte Rückfrage.

Bei Erfolg: jobId merken (wird für späteres Cancel gebraucht) und
dem Nutzer rückmelden: „Job läuft. Sag mir Bescheid wenn ich
stoppen soll, oder warte 24h auf Auto-Stop."

## Stoppen

Wenn der Nutzer sagt „Stopp", „abbrechen", „hör auf", „beenden",
„stop the test", „cancel" → SOFORT `schedule_cancel` mit der jobId
aufrufen, ohne Rückfrage. Wenn du die jobId nicht mehr kennst (z. B.
nach Conversation-Reload), erst `schedule_list` für den passenden
Eintrag.

## Was NICHT tun

- Niemals Loops mit Sub-Minuten-Intervall vorschlagen (lehnt das
  Tool eh ab — aber spar dem Nutzer den Frust).
- Niemals Empfänger außerhalb der Allowlist umgehen wollen — der
  Allowlist-Check ist ein bewusstes Spam-Loop-Sicherheitsnetz.
- Niemals Loops anlegen ohne dem Nutzer die Auto-Stop-Frist
  transparent zu machen.
