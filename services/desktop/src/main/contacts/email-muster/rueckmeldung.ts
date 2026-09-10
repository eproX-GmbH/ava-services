// M4 (docs/PLAN_EMAIL_MUSTER.md) — Rueckmeldung aus dem Postfach fuer abgeleitete
// Adressen: eine Unzustellbarkeitsmeldung (Bounce) entfernt die Adresse, eine
// Antwort von der Adresse bestaetigt sie. Laeuft lokal, der Server aendert nur den
// Fakt (POST /v1/email-patterns/feedback), und nur fuer Adressen mit Quelle pattern:*.

import type { MailMessage } from "../../../shared/types";

type Req = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

const BOUNCE_FROM_RE = /^(mailer-daemon|postmaster|mail-daemon|bounce[s]?|no-?reply\.bounce)@/i;
const BOUNCE_SUBJECT_RE = /(undeliver|unzustellbar|delivery (status|failure)|delivery has failed|mail delivery failed|returned mail|nicht zugestellt|zustellung fehlgeschlagen|failure notice)/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Erkennt eine Unzustellbarkeitsmeldung und liefert die betroffenen Adressen. */
export function bounceAdressen(msg: Pick<MailMessage, "from" | "subject" | "bodyText">, eigene: Set<string> = new Set()): string[] {
  const istBounce = BOUNCE_FROM_RE.test(msg.from.address) || BOUNCE_SUBJECT_RE.test(msg.subject);
  if (!istBounce) return [];
  const gefunden = new Set<string>();
  for (const m of msg.bodyText.match(EMAIL_RE) ?? []) {
    const e = m.toLowerCase();
    if (BOUNCE_FROM_RE.test(e) || eigene.has(e)) continue;
    gefunden.add(e);
  }
  return [...gefunden].slice(0, 10);
}

/** Bounce → deaktivieren, sonst Absender → bestaetigen (falls abgeleitet). */
export async function meldeAbgeleiteteAdressen(msg: MailMessage, request: Req, log: (m: string) => void = () => undefined): Promise<void> {
  const eigene = new Set(msg.to.map((t) => t.address.toLowerCase()));
  const bounces = bounceAdressen(msg, eigene);
  if (bounces.length > 0) {
    for (const email of bounces) {
      const r = await request<{ gefunden: boolean; aktion: string }>("/v1/email-patterns/feedback", { method: "POST", body: { email, ergebnis: "bounce", hinweis: msg.subject.slice(0, 120) } });
      if (r.gefunden) log(`[email-muster] Bounce: ${email} ${r.aktion}`);
    }
    return;
  }
  const absender = msg.from.address.toLowerCase();
  if (!absender || BOUNCE_FROM_RE.test(absender) || /^(no-?reply|newsletter|notification[s]?)@/i.test(absender)) return;
  const r = await request<{ gefunden: boolean; aktion: string }>("/v1/email-patterns/feedback", { method: "POST", body: { email: absender, ergebnis: "antwort", hinweis: msg.subject.slice(0, 120) } });
  if (r.gefunden && r.aktion === "bestaetigt") log(`[email-muster] Antwort bestaetigt abgeleitete Adresse ${absender}`);
}
