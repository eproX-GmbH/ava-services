// ICP → Nutzerprofil-Bruecke.
//
// Der ICP-Assistent extrahiert aus der eigenen Website Angebot, Nutzen,
// Branchen und Standort — genau die Infos, die auch das Nutzerprofil
// (Settings → Profil, wird in jeden Agenten-Turn eingewoben) braucht.
//
//   bio        ← angebot (+ nutzen), an Satzgrenze auf den Cap gekuerzt
//   industries ← branchen
//   geographies← orte
//
// v0.1.521 — Regel praezisiert (Live-Befund 2026-09-02: ICP fuer ava.bi
// neu erstellt, Profil blieb auf dem quikk.de-Stand). Vorher galt "nur
// LEERE Felder fuellen" — damit war ein einmal befuelltes Profil fuer
// jedes weitere ICP unerreichbar. Jetzt:
//   - leeres Feld                          → fuellen
//   - Feld == letzter ICP-abgeleiteter Wert → ersetzen (der Nutzer hat
//     die Auto-Fuellung nie angefasst; sie ist nur veraltet)
//   - Feld vom Nutzer bearbeitet           → UNANTASTBAR, wird gemeldet
// Die Provenienz steckt im Profil selbst (icpAbgeleitet-Snapshot).
// rolle/ton/themen/signalInterests sind nicht ableitbar und bleiben
// immer unangetastet.

import { USER_PROFILE_BIO_CAP } from "../../shared/types";
import type { UserProfileStore } from "./profile-store";
import type { IcpProfile } from "./icp-store";

export interface ProfilSyncErgebnis {
  /** Labels der geschriebenen Felder. */
  aktualisiert: string[];
  /** Labels der Felder, die wegen Nutzer-Bearbeitung unangetastet blieben. */
  beibehalten: string[];
}

/** Auf den Cap kuerzen, aber an einer Satzgrenze — nie mitten im Wort. */
export function kuerzeAnSatzgrenze(text: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const kopf = t.slice(0, cap);
  const satzEnde = Math.max(kopf.lastIndexOf(". "), kopf.lastIndexOf("! "), kopf.lastIndexOf("? "));
  if (satzEnde >= cap * 0.5) return kopf.slice(0, satzEnde + 1).trim();
  const wortEnde = kopf.lastIndexOf(" ");
  return (wortEnde > 0 ? kopf.slice(0, wortEnde) : kopf).trim() + " …";
}

function gleich(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

export function fillProfileFromIcp(
  profile: UserProfileStore,
  icp: IcpProfile,
): ProfilSyncErgebnis {
  const current = profile.get();
  const snap = current.icpAbgeleitet ?? {};
  const patch: Parameters<UserProfileStore["set"]>[0] = {};
  const neuerSnap: NonNullable<typeof current.icpAbgeleitet> = { ...snap };
  const aktualisiert: string[] = [];
  const beibehalten: string[] = [];

  // Bio
  const bioQuelle = [icp.angebot, icp.nutzen].filter(Boolean).join(" ").trim();
  if (bioQuelle.length >= 10) {
    const bio = kuerzeAnSatzgrenze(bioQuelle, USER_PROFILE_BIO_CAP);
    const aktuell = current.bio?.trim() ?? "";
    if (aktuell.length === 0 || aktuell === (snap.bio ?? "").trim()) {
      if (aktuell !== bio) {
        patch.bio = bio;
        aktualisiert.push("Bio");
      }
      neuerSnap.bio = bio;
    } else if (aktuell !== bio) {
      beibehalten.push("Bio");
    }
  }
  // Branchen
  if (icp.branchen.length > 0) {
    const ziel = icp.branchen.slice(0, 8);
    const aktuell = current.industries ?? [];
    if (aktuell.length === 0 || gleich(aktuell, snap.industries)) {
      if (!gleich(aktuell, ziel)) {
        patch.industries = ziel;
        aktualisiert.push("Branchen");
      }
      neuerSnap.industries = ziel;
    } else if (!gleich(aktuell, ziel)) {
      beibehalten.push("Branchen");
    }
  }
  // Regionen
  if (icp.orte.length > 0) {
    const ziel = icp.orte.slice(0, 12);
    const aktuell = current.geographies ?? [];
    if (aktuell.length === 0 || gleich(aktuell, snap.geographies)) {
      if (!gleich(aktuell, ziel)) {
        patch.geographies = ziel;
        aktualisiert.push("Regionen");
      }
      neuerSnap.geographies = ziel;
    } else if (!gleich(aktuell, ziel)) {
      beibehalten.push("Regionen");
    }
  }

  if (aktualisiert.length > 0) {
    patch.icpAbgeleitet = neuerSnap;
    profile.set(patch);
  }
  return { aktualisiert, beibehalten };
}
