// ICP → Nutzerprofil-Bruecke.
//
// Der ICP-Assistent extrahiert aus der eigenen Website Angebot, Nutzen,
// Branchen und Standort — genau die Infos, die auch das Nutzerprofil
// (Settings → Profil, wird in jeden Agenten-Turn eingewoben) braucht.
// Beim Speichern eines ICP werden daraus LEERE Profil-Felder befuellt:
//
//   bio        ← angebot (+ nutzen), auf 300 Zeichen gekuerzt
//   industries ← branchen (Zielbranchen = Branchen, in denen der
//                Nutzer unterwegs ist)
//   geographies← orte
//
// Eiserne Regel: NIE bestehende Nutzer-Eingaben ueberschreiben — nur
// Luecken fuellen. rolle/ton/signalInterests sind nicht ableitbar und
// bleiben unangetastet.

import type { UserProfileStore } from "./profile-store";
import type { IcpProfile } from "./icp-store";

/** Leere Profil-Felder aus dem ICP ergaenzen. Liefert die Labels der
 *  tatsaechlich befuellten Felder (leer = nichts geaendert). */
export function fillProfileFromIcp(
  profile: UserProfileStore,
  icp: IcpProfile,
): string[] {
  const current = profile.get();
  const patch: Parameters<UserProfileStore["set"]>[0] = {};
  const filled: string[] = [];

  if (!current.bio?.trim() && (icp.angebot || icp.nutzen)) {
    const bio = [icp.angebot, icp.nutzen].filter(Boolean).join(" ").trim();
    if (bio.length >= 10) {
      patch.bio = bio.slice(0, 300);
      filled.push("Bio");
    }
  }
  if ((current.industries ?? []).length === 0 && icp.branchen.length > 0) {
    patch.industries = icp.branchen.slice(0, 8);
    filled.push("Branchen");
  }
  if ((current.geographies ?? []).length === 0 && icp.orte.length > 0) {
    patch.geographies = icp.orte;
    filled.push("Regionen");
  }

  if (filled.length > 0) profile.set(patch);
  return filled;
}
