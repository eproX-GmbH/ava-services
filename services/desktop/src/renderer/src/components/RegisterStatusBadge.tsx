// Register-Delta — Kennzeichnung geschlossener oder in Loeschung befindlicher
// Registerblaetter (master-data GermanCompany.registerStatus). Ueberall dort,
// wo eine Firma erscheint: Suche, Meine Firmen, Vorgaenge, Firmendetails.

export function registerStatusText(status: string | null | undefined): string | null {
  if (status === "CLOSED") return "gelöscht";
  if (status === "LOESCHUNG_ANGEKUENDIGT") return "in Löschung";
  return null;
}

export function RegisterStatusBadge({ status, closedAt }: { status: string | null | undefined; closedAt?: string | null }) {
  const text = registerStatusText(status);
  if (!text) return null;
  const titel =
    status === "CLOSED"
      ? `Registerblatt geschlossen${closedAt ? ` (gesehen am ${new Date(closedAt).toLocaleDateString("de-DE")})` : ""}`
      : "Löschung im Handelsregister angekündigt";
  return (
    <span className={`badge ${status === "CLOSED" ? "bad" : "warn"}`} title={titel} style={{ marginLeft: "0.4rem", verticalAlign: "middle" }}>
      {text}
    </span>
  );
}
