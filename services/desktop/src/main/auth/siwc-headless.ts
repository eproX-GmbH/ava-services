// „Sign in with ChatGPT“ ohne Fenster (docs/PLAN_AVA_CLOUD.md §12, R4).
//
// Derselbe Flow wie in siwc-oauth-flow.ts (Authorization Code + PKCE, feste
// Weiterleitung auf 127.0.0.1:1456, dynamische Client-ID je Installation), nur
// ohne BrowserWindow: Der Server erzeugt den Anmeldelink, die Person meldet
// sich in einem beliebigen Browser an und landet danach auf einer Adresse, die
// bei ihr ins Leere läuft, aber Code und State trägt. Diese Adresse fügt sie
// auf der Setup-Seite ein; `abschliessen` prüft State und Client-ID und
// tauscht den Code. Die Prüfungen sind dieselben wie im Fenster-Flow.

import {
  buildSiwcAuthorizationUrl,
  exchangeSiwcCode,
  generateSiwcPkce,
  hatPlanScope,
  istAusgegebeneClientId,
  parseSiwcCallback,
  SIWC_REDIRECT_URI,
  type SiwcPkce,
  type SiwcTokenResult,
} from "./siwc-oauth";

export interface SiwcHeadlessErgebnis extends SiwcTokenResult {
  clientId: string;
  planScope: boolean;
}

/** Fehlertexte wie im Fenster-Flow, damit beide Wege gleich sprechen. */
export function siwcTauschFehlerText(err: unknown): string {
  const e = err as { status?: number; detail?: string; message?: string } | null;
  const status = e?.status;
  // 2026-11-24 (Befund Joyce): Ein abgelaufener oder schon eingeloester Code kam als rohe
  // OAuth-Antwort ("HTTP 400: {"error":"invalid_grant"…}") auf der Setup-Seite an.
  if (/invalid_grant/.test(`${e?.detail ?? ""} ${e?.message ?? ""}`)) {
    return "Der Anmeldecode ist abgelaufen oder wurde schon verwendet. Erzeuge einen neuen Link und füge die Adresse direkt nach der Anmeldung ein.";
  }
  if (status === 401 || status === 403) return "ChatGPT hat die Anmeldung abgelehnt. Plan-Nutzung gibt es nur mit ChatGPT Plus oder Pro.";
  if (typeof status === "number" && status >= 500) return "OpenAI ist gerade nicht erreichbar. Versuch's gleich nochmal.";
  if (typeof status === "number") return `ChatGPT hat die Anmeldung nicht angenommen (Fehler ${status}). Erzeuge einen neuen Link und versuch es noch einmal.`;
  return err instanceof Error ? err.message : String(err);
}

export class SiwcHeadlessFlow {
  private pkce: SiwcPkce | null = null;
  private clientId: string | null = null;
  private begonnen = 0;

  /** Gültigkeit eines begonnenen Flows; danach muss ein neuer Link erzeugt werden. */
  static readonly GUELTIG_MS = 15 * 60 * 1000;

  /** Erzeugt den Anmeldelink; `clientId` ist die gespeicherte ID dieser Installation (fehlt bei der Erstanmeldung). */
  starten(opts: { hostId: string; clientId?: string | null; idTokenHint?: string | null; loginHint?: string | null }): string {
    this.pkce = generateSiwcPkce();
    this.clientId = opts.clientId ?? null;
    this.begonnen = Date.now();
    return buildSiwcAuthorizationUrl({
      pkce: this.pkce,
      hostId: opts.hostId,
      clientId: this.clientId,
      idTokenHint: opts.idTokenHint ?? null,
      loginHint: opts.loginHint ?? null,
    });
  }

  laeuft(): boolean {
    return this.pkce !== null && Date.now() - this.begonnen < SiwcHeadlessFlow.GUELTIG_MS;
  }

  /** Ende der Gültigkeit des laufenden Vorgangs (ms seit Epoche), sonst null. */
  gueltigBis(): number | null {
    return this.laeuft() ? this.begonnen + SiwcHeadlessFlow.GUELTIG_MS : null;
  }

  /** Nimmt die eingefügte Weiterleitungsadresse (oder nur ihren Query-Teil) und tauscht den Code. */
  async abschliessen(eingabe: string): Promise<SiwcHeadlessErgebnis> {
    if (!this.pkce) throw new Error("Kein Anmeldevorgang begonnen. Bitte zuerst den Anmeldelink erzeugen.");
    if (!this.laeuft()) {
      this.pkce = null;
      throw new Error("Der Anmeldevorgang ist abgelaufen. Bitte einen neuen Link erzeugen.");
    }
    const roh = eingabe.trim();
    const url = roh.startsWith("http") ? roh : roh.startsWith("?") ? SIWC_REDIRECT_URI + roh : SIWC_REDIRECT_URI + "?" + roh;
    const cb = parseSiwcCallback(url);
    if (cb.error) {
      throw new Error(
        cb.error === "access_denied"
          ? "Du hast die Anmeldung abgebrochen oder die Plan-Nutzung nicht freigegeben."
          : `ChatGPT hat die Anmeldung abgelehnt: ${cb.error}`,
      );
    }
    if (!cb.code) throw new Error("Die eingefügte Adresse enthält keinen Code.");
    if (!cb.state || cb.state !== this.pkce.state) throw new Error("Sicherheitsprüfung fehlgeschlagen: Die Adresse gehört nicht zu diesem Anmeldevorgang.");
    let clientId = this.clientId;
    if (istAusgegebeneClientId(cb.clientId)) {
      if (clientId && clientId !== cb.clientId) {
        throw new Error("ChatGPT hat eine andere Client-ID zurückgegeben als gespeichert. Bitte trennen und neu verbinden.");
      }
      clientId = cb.clientId;
    }
    if (!clientId) throw new Error("ChatGPT hat keine Client-ID für diese Installation ausgegeben.");
    const pkce = this.pkce;
    this.pkce = null;
    try {
      const token = await exchangeSiwcCode({ code: cb.code, verifier: pkce.verifier, clientId });
      const scope = token.scope ?? cb.scope ?? "";
      return { ...token, scope, clientId, planScope: hatPlanScope(scope) };
    } catch (err) {
      throw new Error(siwcTauschFehlerText(err));
    }
  }
}
