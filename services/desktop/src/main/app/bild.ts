// Bilder eines Gesprächs für die AVA-App (docs/PLAN_APP_PWA.md): Der Verlauf
// trägt nur Dateiname und Typ, die App holt jedes Bild einzeln nach.
// Verkleinert wird mit Electrons nativeImage; auf dem Server (ohne Electron)
// geht das Original raus, solange es unter die Relais-Grenze passt.

import { nativeImage } from "electron";
import type { AgentMessageImage } from "../../shared/types";

/** Das Relais nimmt höchstens 6 MB je Nachricht; Base64 plus Hülle bleibt darunter. */
const MAX_BASE64 = 4_500_000;

export function bildVerkleinern(bild: AgentMessageImage, kante: number): AgentMessageImage {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(bild.base64, "base64"));
    if (img.isEmpty()) return passend(bild);
    const { width, height } = img.getSize();
    if (Math.max(width, height) <= kante && bild.base64.length <= MAX_BASE64) return bild;
    const klein = width >= height ? img.resize({ width: Math.min(width, kante), quality: "good" }) : img.resize({ height: Math.min(height, kante), quality: "good" });
    const name = bild.filename ? bild.filename.replace(/\.[^.]+$/, "") + ".jpg" : undefined;
    return { base64: klein.toJPEG(82).toString("base64"), mimeType: "image/jpeg", ...(name ? { filename: name } : {}) };
  } catch {
    // Server-Modus: nativeImage fehlt.
    return passend(bild);
  }
}

function passend(bild: AgentMessageImage): AgentMessageImage {
  if (bild.base64.length > MAX_BASE64) throw Object.assign(new Error("Das Bild ist zu groß für die Übertragung."), { code: "zu_gross" });
  return bild;
}
