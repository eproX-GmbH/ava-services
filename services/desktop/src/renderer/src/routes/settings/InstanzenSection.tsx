// Deine AVAs (docs/PLAN_AVA_CLOUD.md §13.1): alle Instanzen dieses Kontos
// (diese Desktop-App, Server), mit Telegram-Bot, Radar, Modell und MCP-Ziel.
// Die Liste kommt vom Gateway; Name und MCP-Schalter dieser Instanz stellt
// man hier ein.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../../api/gateway";
import { ExternalLink } from "../../components/ExternalLink";
import { bestaetigen } from "../../components/Bestaetigung";

interface Instanz {
  id: string;
  art: "desktop" | "server";
  name: string;
  version: string;
  verbunden: boolean;
  seit: string;
  zuletzt: string;
  mcpZiel: boolean;
  zustand: {
    mcp?: boolean;
    modell?: string;
    icp?: boolean;
    adresse?: string | null;
    telegram?: { eingerichtet?: boolean; botId?: string | null; bot?: string | null; chat?: boolean; aktiv?: boolean; konflikt?: boolean } | null;
    radar?: { an?: boolean; intervallStunden?: number | null; letzterLauf?: string | number | null; ergebnis?: string | null } | null;
  };
}

const zeit = (s: string | number | null | undefined) => (s ? new Date(s).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–");

function telegramText(i: Instanz, doppelt: Set<string>): string {
  const t = i.zustand.telegram;
  if (!t?.eingerichtet) return "nicht eingerichtet";
  const bot = t.bot ? `@${t.bot}` : "Bot";
  if (t.botId && doppelt.has(t.botId)) return `${bot} — auch an einer anderen Instanz, eigenen Bot anlegen`;
  if (t.konflikt) return `${bot} — wird von einer anderen Stelle abgeholt`;
  if (!t.chat) return `${bot}, Chat noch nicht verknüpft`;
  return `${bot}, ${t.aktiv ? "Zustellung an" : "Zustellung aus"}`;
}

function radarText(i: Instanz): string {
  const r = i.zustand.radar;
  if (!r) return "–";
  if (!r.an) return "aus";
  const teil = r.intervallStunden ? `an, alle ${r.intervallStunden} h` : "an";
  return r.ergebnis ? `${teil} · ${r.ergebnis}` : teil;
}

export function InstanzenSection() {
  const qc = useQueryClient();
  const liste = useQuery<{ items: Instanz[] }>({
    queryKey: ["instanzen"],
    queryFn: () => gatewayFetch<{ items: Instanz[] }>("/v1/instanzen"),
    retry: false,
    refetchInterval: 30_000,
  });
  const eigen = useQuery({ queryKey: ["instanz", "eigen"], queryFn: () => window.api.instanz.get() });
  const setzen = useMutation({
    mutationFn: (patch: { name?: string; mcp?: boolean }) => window.api.instanz.set(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instanz", "eigen"] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["instanzen"] }), 1500);
    },
  });
  type Stand = Awaited<ReturnType<typeof window.api.umzug.stand>>;
  const [umzug, setUmzug] = useState<Stand | null>(null);
  const [umzugFehler, setUmzugFehler] = useState<string | null>(null);
  useEffect(() => {
    void window.api.umzug.stand().then(setUmzug);
    return window.api.umzug.onStand(setUmzug);
  }, []);
  const laeuft = umzug?.phase === "wartet" || umzug?.phase === "sendet" || umzug?.phase === "empfaengt";
  const umziehen = async (richtung: "holen" | "senden", i: Instanz) => {
    setUmzugFehler(null);
    const ok = await bestaetigen(
      richtung === "holen"
        ? {
            titel: `Den kompletten Stand von „${i.name}“ hierher holen?`,
            text: "Diese AVA wird dabei vollständig überschrieben (Gedächtnis, Chats, Profil, ICP, Radar, Workflows, Mail-Speicher, Schlüssel …) und startet neu. Dein bisheriger Stand bleibt als Sicherung erhalten.\n\nAnmeldung, Telegram-Bot und Abo-Anmeldungen bleiben, wie sie sind.",
            bestaetigen: "Hierher holen",
            zerstoerend: true,
          }
        : {
            titel: `Den kompletten Stand dieser AVA an „${i.name}“ senden?`,
            text: `„${i.name}“ wird dabei vollständig überschrieben und startet neu; der dortige Stand bleibt als Sicherung erhalten.\n\nAnmeldung, Telegram-Bot und Abo-Anmeldungen bleiben dort, wie sie sind.`,
            bestaetigen: "Senden",
            zerstoerend: true,
          },
    );
    if (!ok) return;
    const r = richtung === "holen" ? await window.api.umzug.holen(i.id) : await window.api.umzug.senden(i.id);
    if (!r.ok) setUmzugFehler(r.grund ?? "Umzug nicht gestartet.");
  };
  const items = liste.data?.items ?? [];
  const bots = new Map<string, number>();
  for (const i of items) {
    const b = i.zustand.telegram?.botId;
    if (b) bots.set(b, (bots.get(b) ?? 0) + 1);
  }
  const doppelt = new Set([...bots.entries()].filter(([, n]) => n > 1).map(([b]) => b));

  return (
    <section id="instanzen" className="provider-section" aria-label="Deine AVAs">
      <h3>Deine AVAs</h3>
      <p className="muted">
        AVA läuft auf diesem Rechner oder auf einem Server. Hier siehst du, welche AVA gerade aktiv ist und welche Telegram, den Firmen-Radar und die Anfragen aus Claude oder ChatGPT übernimmt (Server vor Rechner).
      </p>
      {liste.isLoading && <p className="muted">Lädt …</p>}
      {liste.error && <p className="muted">Liste nicht abrufbar: {(liste.error as Error).message}</p>}
      {liste.data && items.length === 0 && <p className="muted">Gerade ist kein Gerät mit dem AVA-Server verbunden.</p>}
      {items.length > 0 && (
        <table className="kunden-tabelle">
          <thead>
            <tr>
              <th>Gerät</th>
              <th>Telegram</th>
              <th>Radar</th>
              <th>Modell</th>
              <th>MCP</th>
              <th className="kunden-aktion" aria-label="Umzug" />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.name}
                  {eigen.data?.id === i.id && <span className="pill pill--active" style={{ marginLeft: 6 }}>diese</span>}
                  <div className="muted small">
                    {i.art === "server" ? "Server" : "Desktop"}
                    {i.zustand.adresse && (
                      <>
                        {" · "}
                        <ExternalLink href={i.zustand.adresse}>{i.zustand.adresse.replace(/^https?:\/\//, "")}</ExternalLink>
                      </>
                    )}
                    {" · "}v{i.version} · {i.verbunden ? `verbunden seit ${zeit(i.seit)}` : `offline seit ${zeit(i.zuletzt)}`}
                  </div>
                </td>
                <td>{telegramText(i, doppelt)}</td>
                <td>{radarText(i)}</td>
                <td>
                  {i.zustand.modell ?? "–"}
                  {i.zustand.icp === false && <div className="muted small">kein Idealkundenprofil</div>}
                </td>
                <td>{i.mcpZiel ? "beantwortet" : i.zustand.mcp === false ? "aus" : "bereit"}</td>
                <td className="kunden-aktion">
                  {eigen.data?.id !== i.id && i.verbunden && (
                    <div className="u-row">
                      <button type="button" disabled={laeuft} onClick={() => void umziehen("holen", i)} title="Kompletten Stand dieses Geräts hierher übertragen">
                        Hierher holen
                      </button>
                      <button type="button" disabled={laeuft} onClick={() => void umziehen("senden", i)} title="Kompletten Stand von hier dorthin übertragen">
                        Dorthin senden
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {eigen.data && (
        <label className="toggle u-row u-mt-2">
          <input type="checkbox" checked={eigen.data.mcp} disabled={setzen.isPending} onChange={(e) => setzen.mutate({ mcp: e.target.checked })} />
          <span>Dieses Gerät ({eigen.data.name}) darf Anfragen aus Claude und ChatGPT beantworten</span>
        </label>
      )}
      {setzen.error && <p className="error">{(setzen.error as Error).message}</p>}
      {umzug && umzug.phase !== "bereit" && (
        <p className={umzug.phase === "fehler" ? "error" : "muted"}>
          Umzug {umzug.rolle === "ziel" ? `von ${umzug.gegenueber}` : `an ${umzug.gegenueber}`}: {umzug.meldung}
          {umzug.teile > 0 && ` (${Math.round(umzug.bytes / 1024 / 1024)} MB)`}
        </p>
      )}
      {umzugFehler && <p className="error">{umzugFehler}</p>}
      <p className="muted small">
        Umzug: Überträgt alles, was AVA auf diesem Gerät hält, auf das andere und überschreibt dort den Stand. So wechselst du
        jederzeit zwischen Desktop- und Serverbetrieb. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben je Gerät.
      </p>
    </section>
  );
}
