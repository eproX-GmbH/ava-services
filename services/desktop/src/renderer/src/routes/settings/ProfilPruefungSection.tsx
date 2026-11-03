// Einstellungen → Erweitert → Dienste auf diesem Rechner: Stand der lokalen
// LinkedIn-Profil-Pruefung (2026-11-03). Der Kontakt-Producer liest beim
// 14-Tage-Lauf die bekannten Profile der Ansprechpartner im Hintergrund-Chrome
// dieses Rechners; hier steht, was dabei in den letzten 30 Tagen herauskam.
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../../api/gateway";

interface Statistik {
  tage: number;
  bestaetigt: number;
  gewechselt: number;
  gesperrt: number;
  nichtGefunden: number;
  ueberApify: number;
}

export function ProfilPruefungSection() {
  const q = useQuery({
    queryKey: ["profil-pruefung-statistik"],
    queryFn: () => gatewayFetch<Statistik>("/v1/contacts/linkedin-profile/statistik"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const s = q.data;
  const gesamt = s ? s.bestaetigt + s.gewechselt + s.gesperrt + s.nichtGefunden : 0;
  return (
    <div id="profil-pruefung" style={{ marginTop: 16 }}>
      <h4>LinkedIn-Profile der Ansprechpartner</h4>
      <p className="muted small">
        Bei jeder Kontakt-Auffrischung liest AVA die bekannten LinkedIn-Profile deiner Ansprechpartner direkt auf diesem Rechner, ohne Anmeldung, und meldet Arbeitgeberwechsel. Reicht der Zugriff nicht, springt der LinkedIn-Datendienst ein.
      </p>
      {q.isLoading && <p className="muted small">Lade…</p>}
      {q.isError && <p className="muted small">Noch keine Angaben.</p>}
      {s && (
        <p className="small">
          Letzte {s.tage} Tage: {gesamt === 0 ? "noch keine Prüfung" : `${s.bestaetigt} bestätigt · ${s.gewechselt} ${s.gewechselt === 1 ? "Wechsel" : "Wechsel"} · ${s.gesperrt} gesperrt · ${s.nichtGefunden} nicht gefunden${s.ueberApify > 0 ? ` · ${s.ueberApify} über den LinkedIn-Datendienst` : ""}`}
        </p>
      )}
    </div>
  );
}
