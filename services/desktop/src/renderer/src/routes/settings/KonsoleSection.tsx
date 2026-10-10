// Organisation verwalten (docs/PLAN_ADMIN_WEB.md): Mitglieder, Vorgaben,
// Organisationsschlüssel, Limits und Abrechnung liegen in der Web-Konsole;
// die Desktop-App verweist nur noch dorthin.
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../../api/gateway";
import { ExternalLink } from "../../components/ExternalLink";
import { KONSOLE_URL } from "../../../../shared/config";
import type { OrgState } from "../../../../shared/types";

const ROLLEN: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Mitglied" };

export function KonsoleSection() {
  const org = useQuery({ queryKey: ["org"], queryFn: () => gatewayFetch<OrgState>("/v1/tenants/me"), retry: false });
  const st = org.data;
  const inOrg = st?.kind === "organisation";
  return (
    <section id="organisation" className="provider-section" aria-label="Organisation">
      <h3>Organisation</h3>
      <p className="muted">
        {inOrg
          ? `Du bist ${ROLLEN[st.myRole] ?? st.myRole} in ${st.name ?? "einer Organisation"}. `
          : "Du arbeitest in deinem persönlichen Bereich. "}
        Mitglieder, Vorgaben, Organisationsschlüssel, Limits und Abrechnung verwaltest du in der AVA Konsole im Browser;
        dort legst du auch eine Organisation an oder trittst einer bei.
      </p>
      <ExternalLink href={KONSOLE_URL} className="btn">
        AVA Konsole öffnen
      </ExternalLink>
    </section>
  );
}
