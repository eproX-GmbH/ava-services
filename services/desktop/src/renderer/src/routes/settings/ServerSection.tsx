// AVA-Server (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §10.7, Z5): Hinweis zum Dazubuchen und, falls
// gebucht, der Stand des Servers. Gebucht und verwaltet wird in der AVA-App im Browser; die
// Desktop-App zeigt nur an. Solange der Server nicht buchbar ist und keiner läuft, fehlt der
// Abschnitt ganz.
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../../api/gateway";
import { ExternalLink } from "../../components/ExternalLink";
import { AVA_APP_URL } from "../../../../shared/config";

type Zustand = "zahlung_offen" | "wird_angelegt" | "wartet_auf_verbindung" | "laeuft" | "gestoppt" | "ruht";
interface CloudMein {
  server: {
    zustand: Zustand;
    grund: "zahlung" | "kuendigung" | "abbestellt" | "admin" | "betreiber" | "konto" | null;
    abbestelltZum: string | null;
    loeschenAb: string | null;
    stoerungSeit: string | null;
    wirdAktualisiert: boolean;
    bestaetigen: { link: string; bis: string | null } | null;
    modellGewaehlt: boolean | null;
  } | null;
  buchbar: boolean;
  weg: "buchen" | "kaufen" | "anfragen" | null;
  preis: { serverCents: number; paketCents: number };
}

const tag = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" }) : "–");
const euro = (cents: number) => `${(cents / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} €`;

function standSatz(s: NonNullable<CloudMein["server"]>): string {
  switch (s.zustand) {
    case "zahlung_offen": return "Die Zahlung wird bestätigt …";
    case "wird_angelegt": return "Dein Server wird gerade eingerichtet (1–3 Minuten).";
    case "wartet_auf_verbindung": return "Fast fertig: Bestätige, dass dein Server für dich arbeiten darf.";
    case "laeuft":
      if (s.stoerungSeit) return "Dein Server ist gerade nicht erreichbar. Wir kümmern uns darum.";
      if (s.wirdAktualisiert) return "Dein Server wird gerade aktualisiert (wenige Minuten).";
      if (s.modellGewaehlt === false) return "Dein Server läuft. Wähle in der AVA-App noch, mit welchem KI-Modell er arbeitet.";
      return s.abbestelltZum ? `Dein Server läuft im Hintergrund, abbestellt zum ${tag(s.abbestelltZum)}.` : "Dein Server läuft im Hintergrund, auch wenn dieser Rechner aus ist.";
    default:
      return `Dein Server ist pausiert. Die Daten bleiben bis zum ${tag(s.loeschenAb)} erhalten.`;
  }
}

export function ServerSection() {
  const q = useQuery({
    queryKey: ["cloud-mein"],
    queryFn: () => gatewayFetch<CloudMein>("/v1/cloud/mein"),
    retry: false,
    refetchInterval: 60_000,
  });
  const d = q.data;
  if (!d || (!d.server && !d.buchbar)) return null;
  const mehr = `${AVA_APP_URL}/mehr`;
  return (
    <section id="server-section" className="provider-section" aria-label="AVA-Server">
      <h3>AVA-Server</h3>
      {d.server ? (
        <>
          <p className="muted">{standSatz(d.server)}</p>
          {d.server.zustand === "wartet_auf_verbindung" && d.server.bestaetigen ? (
            <ExternalLink href={d.server.bestaetigen.link} className="btn">Jetzt bestätigen</ExternalLink>
          ) : (
            <ExternalLink href={mehr} className="btn">In der AVA-App ansehen</ExternalLink>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Lass AVA rund um die Uhr arbeiten, auch wenn dieser Rechner aus ist: Radar, Meldungen und Aufträge laufen weiter,
            und du erreichst AVA unterwegs in der AVA-App.{" "}
            {d.weg === "kaufen"
              ? `${euro(d.preis.paketCents)} im Monat für Pro und Server zusammen, zzgl. MwSt., monatlich kündbar.`
              : d.weg === "anfragen"
                ? "Den Server bucht deine Organisation für dich."
                : `${euro(d.preis.serverCents)} im Monat zzgl. MwSt., monatlich kündbar.`}
          </p>
          <ExternalLink href={mehr} className="btn">
            {d.weg === "anfragen" ? "In der AVA-App anfragen" : "In der AVA-App buchen"}
          </ExternalLink>
        </>
      )}
    </section>
  );
}
