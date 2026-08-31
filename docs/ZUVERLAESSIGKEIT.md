# Zuverlässigkeit: „Nie ‚hat geklappt' sagen, wenn es nicht geklappt hat"

Stand: 2026-08-30 (v0.1.465) · Ergebnis der Zuverlässigkeits-Evaluation

## 1. Die drei Fehlerklassen

1. **Halluzination**: Das Modell behauptet Vollzug ohne Tool-Call.
2. **Verifikationslücke**: Ein Tool meldet Erfolg, obwohl die Wirkung
   nicht (voll) eingetreten ist.
3. **Asynchronität**: Etwas wurde nur ANGESTOSSEN, klingt aber wie
   ERLEDIGT.

## 2. Konvention für Write-Tools (verbindlich für neue Tools)

Jedes Tool, das nach außen schreibt (CRM, Mail, Notion, …), muss seine
Wirkung BELEGEN statt der API-Response zu glauben:

- **Update**: Before-Snapshot → Write → Fresh-GET → Feld-Diff;
  `ok: false` + `notApplied`-Liste, wenn Werte still verworfen wurden.
  Referenz-Implementierung: `updateHubspotObject`
  (src/main/crm/write-objects.ts, „Notion-Lesson v0.1.255").
- **Create**: Die vom Server vergebene ID belegt das Objekt. Alles,
  was der Server STILL verwerfen kann (z. B. Associations), per
  Fresh-GET verifizieren; Ergebnis als `associationsMissing` /
  `associationsUnverified` melden — „Verify fehlgeschlagen" ist NICHT
  „alles ok". Referenz: `createHubspotObject` (v0.1.465).
- **Send**: Erfolg heißt zugestellt AN ALLE. Teilweise abgelehnte
  Empfänger → `sent: false` + explizite Liste, wer NICHT erreicht
  wurde (mail_send/reply/forward, v0.1.465).
- **Dispatch** (Import, Retry, Freshness): Der Rückgabewert benennt
  ehrlich nur den Start; die Beschreibung/der Prompt verpflichtet den
  Agenten auf „gestartet, läuft im Hintergrund"-Formulierungen.
- **Best-effort-Nebenpfade** (Spiegelungen, Caches): dürfen den
  Hauptpfad nicht brechen, aber auch nicht STILL scheitern — mindestens
  ein Audit-Eintrag (Beispiel: Outbound-Spiegel in sendAndSync).

## 3. Wächter gegen Halluzination (Klasse 1)

- **Wahrheitspflicht-Regel** (Systemprompt, Auto-Modus, v0.1.464):
  Regel 3b — nie Vollzug behaupten ohne erfolgreichen Schreib-Tool-Call;
  Regel 3c — angestoßen ist nicht erledigt.
- **Write-Claim-Erkennung** (agent/write-claim.ts, deterministisch,
  kein LLM): Vollzugs-Verb in Vergangenheitsform + Aktions-Objekt im
  selben Satz vs. Tool-Trace des Turns.
  - Telegram (inbound.ts): seit v0.1.472 mit AUTO-RETRY — bei
    „Vollzug behauptet, kein Write gelaufen" bekommt der Agent genau
    EINE automatische Korrektur-Runde im selben Faden (Aktion jetzt
    wirklich ausführen ODER ehrlich zurückrudern; nur bei freiem
    Orchestrator, sonst würde die Runde unbeobachtet nachlaufen).
    Erst wenn auch die zweite Runde behauptet statt handelt, geht der
    ⚠️-Hinweis an den Nutzer + Audit-Warnung.
  - Orchestrator (auditWriteClaim, v0.1.465): Post-Turn-Audit für ALLE
    autonomen Konversationen (`agent.claim.unverified`, severity
    warning) — beim Mail-Pfad ist die Antwort schon raus, aber der
    Vorfall wird sichtbar.
- **HubSpot-Link-Regel** (Systemprompt): Links nur mit echter
  Portal-ID aus `crm_status`, sonst gar keinen Link.

## 4. Zustell-Härtung (v0.1.465)

- Telegram `reply()`: 3 Versuche mit Backoff; endgültiger Verlust →
  Audit-Error („Nachricht verloren") statt stilles console.warn.
- Telegram-Benachrichtigungskanal hatte bereits Outbox + Retry +
  sichtbare Deaktivierung bei terminalem Fehler.

## 5. Bekannte Restlücken (bewusst offen)

- **Best-Match-Jobs** können ohne Reaper ewig `queued` stehen — geplant
  zusammen mit dem evaluation-Rest (Job-Reaper + UI-Status).
- **Interaktiver Chat** hat keinen Claim-Guard — der Nutzer sieht dort
  die Tool-Chips selbst; geringes Risiko, bewusst nicht verdrahtet.
- **Sync-interne Creates** (crm_sync_hubspot_company_from_ava legt
  Kontakte intern an) nutzen das Association-Verify noch nicht — das
  Tool sammelt aber bereits eine errors-Liste.
