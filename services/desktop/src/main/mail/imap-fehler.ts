// IMAP-Fehler verständlich machen (Befund 2026-10-10, neues IONOS-Postfach): imapflow
// meldet nur „Command failed“; der Grund steht in responseText, serverResponseCode
// und authenticationFailed. Gemeinsam für AVAs Postfach und das Entwurfs-Postfach.

export function imapFehlerText(err: unknown, host?: string): string {
  const e = (err ?? {}) as { message?: string; responseText?: string; serverResponseCode?: string; authenticationFailed?: boolean; code?: string; responseStatus?: string };
  const antwort = (e.responseText ?? "").trim();
  const roh = `${e.message ?? String(err)}${antwort ? ` (${antwort})` : ""}`;
  const ionos = /ionos|1und1|1and1/i.test(host ?? "");
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(e.serverResponseCode ?? "") || /auth|login|credential|password/i.test(antwort)) {
    return (
      "Anmeldung abgelehnt: Benutzername oder Passwort stimmen nicht." +
      (ionos
        ? " Bei IONOS ist das Passwort des Postfachs gemeint (kein App-Passwort). Ein gerade angelegtes Postfach ist oft erst nach einigen Minuten nutzbar; dann bitte erneut testen."
        : " Bei Gmail und iCloud ein App-Passwort verwenden; Microsoft 365 erlaubt keine Anmeldung per Passwort mehr.") +
      (antwort ? ` Antwort des Servers: ${antwort}` : "")
    );
  }
  if (e.code === "ENOTFOUND" || /getaddrinfo/i.test(e.message ?? "")) return `Server ${host ?? ""} nicht gefunden. Adresse prüfen.`;
  if (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || /timeout/i.test(e.message ?? "")) return "Server nicht erreichbar. Port (meist 993) und TLS prüfen.";
  if (/certificate|self.signed|CERT_/i.test(e.message ?? "")) return "Zertifikat des Servers ungültig. Servername prüfen (z. B. imap.ionos.de statt der eigenen Domain).";
  if (/UNAVAILABLE|LIMIT|throttl|too many/i.test(`${e.serverResponseCode ?? ""} ${antwort}`)) return `Der Server lehnt gerade ab (Grenze oder Wartung). Bitte später erneut versuchen. ${antwort}`.trim();
  return roh;
}
