// Doppelte Kontakte einer Firma (main/contacts/personen-abgleich.ts): Abgleich anstoßen,
// Zusammenführungen ansehen und zurücknehmen.

import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { PersonenAbgleich } from "../../contacts/personen-abgleich";

export function buildPersonenZusammenfuehrenTools(deps: { gateway: GatewayClient; get: () => PersonenAbgleich | null }): Tool[] {
  const tool = defineTool({
    name: "person_zusammenfuehrung",
    summary: "Doppelte Kontakte einer Firma zusammenführen, Zusammenführungen ansehen oder zurücknehmen.",
    category: "kontakte personen dubletten doppelt zusammenfuehren zusammenfuehrung rueckgaengig",
    description:
      "Doppelte Personen einer Firma (z. B. „Christian“ von der Website und „Christian Krebel“ von LinkedIn). `aktion`:\n" +
      "- 'abgleichen' mit `companyId`: sofort prüfen. Sichere Fälle (gleiches LinkedIn-/Xing-Profil, Profil-Slug = voller Name, gleiche belegte Adresse) " +
      "führt der Gateway zusammen; „nur Vorname mit genau einem Gegenstück“ entscheidet ein KI-Urteil. Läuft sonst wöchentlich im Hintergrund.\n" +
      "- 'liste' mit `companyId`: bisherige Zusammenführungen mit Regel und Grund.\n" +
      "- 'rueckgaengig' mit `id` aus der Liste: stellt beide Personen exakt wieder her.",
    parameters: {
      type: "object",
      required: ["aktion"],
      properties: {
        aktion: { type: "string", enum: ["abgleichen", "liste", "rueckgaengig"] },
        companyId: { type: "string" },
        id: { type: "string", description: "Zusammenführung aus 'liste'" },
      },
    },
    schema: yup
      .object({
        aktion: yup.string().oneOf(["abgleichen", "liste", "rueckgaengig"]).required(),
        companyId: yup.string().trim().max(200).optional(),
        id: yup.string().trim().max(80).optional(),
      })
      .noUnknown(true),
    preview: (r: { text?: string; error?: string; items?: unknown[] } | ReturnType<typeof userDeclined>) =>
      "error" in r && r.error ? String(r.error) : "text" in r && r.text ? String(r.text) : "items" in r && r.items ? `${r.items.length} Zusammenführungen` : "abgebrochen",
    run: async (args, c) => {
      if (args.aktion === "rueckgaengig") {
        if (!args.id) return { error: "`id` fehlt (aus aktion 'liste')." };
        const ok = await c.ui.confirmAction(
          { kind: "mutating", prompt: "Diese Zusammenführung zurücknehmen? Beide Personen stehen danach wieder getrennt.", confirmValue: "ja", options: [{ value: "ja", label: "Zurücknehmen" }, { value: "nein", label: "Abbrechen" }] },
          c.signal,
        );
        if (ok !== "ja") return userDeclined();
        await deps.gateway.request(`/v1/contacts/zusammenfuehrungen/${encodeURIComponent(args.id)}/rueckgaengig`, { method: "POST", body: {} });
        return { text: "Zusammenführung zurückgenommen." };
      }
      if (!args.companyId) return { error: "`companyId` fehlt." };
      if (args.aktion === "liste") {
        const r = await deps.gateway.request<{ items: Array<Record<string, unknown>> }>(`/v1/companies/${encodeURIComponent(args.companyId)}/contacts/zusammenfuehrungen`);
        return { items: r.items };
      }
      const s = deps.get();
      if (!s) return { error: "Der Abgleich ist noch nicht gestartet." };
      return { text: await s.tick(args.companyId) };
    },
  });
  return [tool];
}
