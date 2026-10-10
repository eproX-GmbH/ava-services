// App-Strom (docs/PLAN_APP_PWA.md §3.2): Frames der AVA eines Nutzers an alle
// offenen Apps dieses Nutzers (Server-Sent Events). Ringpuffer je Nutzer, damit
// eine App nach einem Funkloch mit Last-Event-ID nahtlos weiterliest.
// Solange eine App lauscht, verlängert der Gateway das Abo bei der AVA, damit
// sie Frames schickt (sonst bleiben Desktop-Chats ohne App lokal).

const PUFFER_MAX = 500;
const PUFFER_MS = 10 * 60_000;
const ABO_TAKT_MS = 60_000;

export interface StromEreignis {
  id: number;
  zeit: number;
  daten: string;
}

type Abonnent = (e: StromEreignis) => void;

export class AppStrom {
  private zaehler = Date.now();
  private readonly puffer = new Map<string, StromEreignis[]>();
  private readonly abonnenten = new Map<string, Set<Abonnent>>();
  private readonly takte = new Map<string, NodeJS.Timeout>();

  /** @param aboMelden wird je Nutzer beim ersten Abonnenten und danach im Takt aufgerufen. */
  constructor(private readonly aboMelden: (actorId: string, an: boolean) => void) {}

  veroeffentlichen(actorId: string, daten: unknown): void {
    const e: StromEreignis = { id: ++this.zaehler, zeit: Date.now(), daten: JSON.stringify(daten) };
    let p = this.puffer.get(actorId);
    if (!p) {
      p = [];
      this.puffer.set(actorId, p);
    }
    p.push(e);
    const grenze = Date.now() - PUFFER_MS;
    while (p.length > PUFFER_MAX || (p[0] && p[0].zeit < grenze)) p.shift();
    for (const a of this.abonnenten.get(actorId) ?? []) {
      try {
        a(e);
      } catch {
        /* ein haengender Abonnent darf die anderen nicht stoeren */
      }
    }
  }

  /** Abonniert den Strom; liefert zuerst gepufferte Ereignisse nach `nachId`. */
  abonnieren(actorId: string, nachId: number | null, a: Abonnent): () => void {
    let s = this.abonnenten.get(actorId);
    if (!s) {
      s = new Set();
      this.abonnenten.set(actorId, s);
    }
    s.add(a);
    if (nachId !== null) for (const e of this.puffer.get(actorId) ?? []) if (e.id > nachId) a(e);
    if (!this.takte.has(actorId)) {
      this.aboMelden(actorId, true);
      this.takte.set(
        actorId,
        setInterval(() => this.aboMelden(actorId, true), ABO_TAKT_MS),
      );
    }
    return () => {
      s!.delete(a);
      if (s!.size === 0) {
        this.abonnenten.delete(actorId);
        const t = this.takte.get(actorId);
        if (t) clearInterval(t);
        this.takte.delete(actorId);
        // Abo nicht sofort beenden: Apps verbinden sich alle paar Minuten neu.
      }
    };
  }

  /** Für Tests. */
  stopp(): void {
    for (const t of this.takte.values()) clearInterval(t);
    this.takte.clear();
  }
}
