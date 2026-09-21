// Wer nicht mehr beschaeftigt ist, gehoert nicht in die Kontaktliste.
//
// Befund 2026-09-21: Im Buying Center stand eine Person mit Position
// "Retired". Solche Eintraege kommen aus LinkedIn-Profilen (Ruhestand als
// "aktuelle Stellung"), von Team-Seiten ("ehemaliger Geschaeftsfuehrer")
// und aus Suchtreffern. Der Filter sitzt hier am Nadeloehr, damit er fuer
// jede Quelle gilt — und er prueft nur den Titel: Eine Person ohne Titel
// wird nicht verworfen, "nichts wissen" ist nicht "ausgeschieden".

const AUSGESCHIEDEN_RE =
  /\b(retired|retiree|ruhestand|pension(iert|är|aer)?|rentner(in)?|altersteilzeit|ehemalig\w*|former|ausgeschieden|verstorben|deceased)\b|\b(i\. ?r\.|a\. ?d\.)$|^ex[- ]/i;

/** true, wenn der Titel sagt, dass die Person nicht (mehr) dort arbeitet. */
export function istAusgeschieden(titel: string | null | undefined): boolean {
  if (!titel) return false;
  return AUSGESCHIEDEN_RE.test(titel.trim());
}
