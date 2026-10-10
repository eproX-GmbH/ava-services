// AVA-Kontext für externe KIs (MCP-Werkzeug ava_kontext, docs/PLAN_MCP_OEFFNUNG.md §13).
//
// Der Gateway liefert Rolle, Verhaltensregeln und Arbeitsweise; dieser Teil
// kommt von der laufenden AVA des Nutzers und ist persönlich: Profil,
// Idealkundenprofil (ICP), Gemerktes, eigene Abläufe (Skills), verfügbare
// Fähigkeiten und die Lage dieser Instanz. Bewusst Markdown in Abschnitten,
// damit Claude/ChatGPT es als Arbeitsanweisung lesen. Obergrenzen halten den
// Text kompakt (ein Werkzeugergebnis, kein Datenexport).

import type { UserProfile } from "../../shared/types";
import type { IcpProfile } from "../../main/agent/icp-store";

export interface AvaKontextDeps {
  profil: () => UserProfile | null;
  icp: () => IcpProfile | null;
  /** Neueste zuerst (GeneralMemoryStore.list). */
  gedaechtnis: () => Array<{ content: string; tags?: string[] }>;
  skills: () => Array<{ name: string; description: string }>;
  /** Fähigkeitsgruppen als Zeilen "- id: text" (main/suggestions/faehigkeiten.ts). */
  faehigkeiten: () => string;
  lage: () => Promise<Record<string, unknown>>;
  instanzName: () => string;
}

const MAX_GEDAECHTNIS = 40;
const MAX_SKILLS = 25;
const MAX_ZEICHEN = 14_000;

const kurz = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function profilText(p: UserProfile | null): string | null {
  if (!p) return null;
  const z: string[] = [];
  if (p.bio.trim()) z.push(kurz(p.bio, 1200));
  if (p.role) z.push(`- Rolle: ${p.role}`);
  if (p.industries.length) z.push(`- Branchen: ${p.industries.join(", ")}`);
  if (p.geographies.length) z.push(`- Regionen: ${p.geographies.join(", ")}`);
  if (p.topics.length) z.push(`- Schwerpunkte: ${p.topics.join(", ")}`);
  if (p.tone) z.push(`- Bevorzugter Ton: ${p.tone}`);
  if (p.signalInterests?.trim()) z.push(`- Relevant auf LinkedIn (zusätzliche Signale): ${kurz(p.signalInterests, 600)}`);
  return z.length ? z.join("\n") : null;
}

function icpText(p: IcpProfile | null): string | null {
  if (!p) return null;
  const z: string[] = [];
  if (p.beschreibung) z.push(kurz(p.beschreibung, 1500));
  if (p.angebot) z.push(`- Eigenes Angebot: ${kurz(p.angebot, 600)}`);
  if (p.nutzen) z.push(`- Nutzenversprechen: ${kurz(p.nutzen, 600)}`);
  if (p.branchen.length) z.push(`- Zielbranchen: ${p.branchen.join(", ")}`);
  if (p.groesse) z.push(`- Größe: ${p.groesse}`);
  if (p.merkmale.length) z.push(`- Merkmale: ${p.merkmale.join("; ")}`);
  if (p.orte.length) z.push(`- Region: ${p.orte.join(", ")} (Umkreis ${p.radiusKm} km)`);
  if (p.ausschluesse) z.push(`- Ausschlüsse: ${kurz(p.ausschluesse, 600)}`);
  if (p.kundenBeispiele.length) {
    z.push(`- Beispiele guter Bestandskunden: ${p.kundenBeispiele.slice(0, 10).map((k) => k.name ?? k.domain).join(", ")}`);
  }
  return z.length ? z.join("\n") : null;
}

export async function avaKontextText(d: AvaKontextDeps): Promise<string> {
  const teile: string[] = [];

  const profil = profilText(d.profil());
  teile.push(
    "## Über den Nutzer",
    profil ??
      "Noch kein Profil hinterlegt. Wenn es für die Aufgabe hilft, frag kurz nach Rolle, Branche und Region und schlage vor, es mit profile_propose_update zu speichern (über werkzeug_ausfuehren).",
  );

  const icp = icpText(d.icp());
  teile.push(
    "## Idealkundenprofil (ICP)",
    icp
      ? `${icp}\n\nNutze das ICP als Maßstab: Firmen danach einordnen und priorisieren, Abweichungen und Ausschlüsse offen benennen.`
      : "Noch kein ICP festgelegt. Bei Fragen nach passenden Kunden oder Priorisierung zuerst anbieten, das ICP gemeinsam festzulegen (icp_* über werkzeug_suchen / werkzeug_ausfuehren).",
  );

  const gemerkt = d
    .gedaechtnis()
    .filter((e) => e.content.trim())
    .slice(0, MAX_GEDAECHTNIS)
    .map((e) => `- ${kurz(e.content, 300)}${e.tags?.length ? ` [${e.tags.join(", ")}]` : ""}`);
  if (gemerkt.length) {
    teile.push(
      "## Was AVA sich über den Nutzer gemerkt hat",
      `${gemerkt.join("\n")}\n\nDiese Einträge gelten als Wissen über den Nutzer. Ältere oder weitere Fakten mit recall_memory; Neues nach Rückfrage mit remember speichern.`,
    );
  }

  const skills = d.skills().slice(0, MAX_SKILLS);
  if (skills.length) {
    teile.push(
      "## Eigene Abläufe (Skills) des Nutzers",
      `${skills.map((s) => `- ${s.name}: ${kurz(s.description, 200)}`).join("\n")}\n\nPasst eine Aufgabe zu einem Ablauf, ihn mit skill_get laden und befolgen.`,
    );
  }

  const faehigkeiten = d.faehigkeiten().trim();
  if (faehigkeiten) {
    teile.push(
      "## Was diese AVA kann",
      `${faehigkeiten}\n\nDie passenden Werkzeuge findest du mit werkzeug_suchen (Stichwort aus der Liste) und rufst sie mit werkzeug_ausfuehren auf.`,
    );
  }

  const lage = await d.lage().catch(() => ({}) as Record<string, unknown>);
  const zl: string[] = [`- Instanz: ${d.instanzName()}`];
  const radar = lage.radar as { an?: boolean; intervallStunden?: number | null } | null | undefined;
  if (radar) zl.push(`- Firmen-Radar: ${radar.an ? `an${radar.intervallStunden ? `, alle ${radar.intervallStunden} h` : ""}` : "aus"}`);
  const tg = lage.telegram as { eingerichtet?: boolean; aktiv?: boolean } | null | undefined;
  if (tg) zl.push(`- Telegram: ${tg.eingerichtet ? (tg.aktiv ? "eingerichtet, Zustellung an" : "eingerichtet, Zustellung aus") : "nicht eingerichtet"}`);
  if (typeof lage.modell === "string") zl.push(`- KI-Anbieter dieser AVA: ${lage.modell}`);
  teile.push("## Lage", zl.join("\n"));

  let text = teile.join("\n\n");
  if (text.length > MAX_ZEICHEN) text = `${text.slice(0, MAX_ZEICHEN)}\n\n(gekürzt)`;
  return text;
}
