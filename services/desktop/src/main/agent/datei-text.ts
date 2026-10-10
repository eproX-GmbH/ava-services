// Text aus PDF und DOCX (pdf-parse, mammoth), je Seite. Genutzt vom
// Desktop-Chat (IPC agent:extractPdfText) und vom App-Kanal (Anhänge aus der
// AVA-App, docs/PLAN_APP_PWA.md §3.2).

export interface DateiText {
  text: string;
  numPages: number;
  filename: string;
  truncated: boolean;
  /** Text je Seite fuer datei_lesen/datei_suchen. */
  seiten: string[];
}

export async function textAusDatei(input: { filename: string; bytes: Uint8Array }): Promise<DateiText> {
  const u8 =
    input.bytes instanceof Uint8Array
      ? new Uint8Array(input.bytes)
      : new Uint8Array(input.bytes as ArrayBufferLike);
  const buf = Buffer.from(u8);
  // DOCX ueber mammoth (liegt als Abhaengigkeit vor): eine "Seite".
  if (input.filename.toLowerCase().endsWith(".docx")) {
    try {
      const mammoth = (await import("mammoth")) as unknown as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> };
      const text = (await mammoth.extractRawText({ buffer: buf })).value ?? "";
      return { text: text.slice(0, 200_000), numPages: 1, filename: input.filename, truncated: text.length > 200_000, seiten: [text] };
    } catch (err) {
      throw new Error(`DOCX "${input.filename}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Lazy-import wie im Mail-Attachment-Pfad — pdf-parse hat Top-
  // Level-Side-Effects (öffnet ein Test-PDF), die wir nur lazy
  // tolerieren wollen.
  const mod = (await import("pdf-parse")) as unknown as {
    default: (data: Buffer, opts?: { pagerender?: (p: unknown) => Promise<string> }) => Promise<{ text: string; numpages: number }>;
  };
  try {
    // Seitenweise sammeln (gleiche Logik wie pdf-parse intern, nur
    // dass wir jede Seite einzeln behalten).
    const seiten: string[] = [];
    const pagerender = async (pageData: unknown): Promise<string> => {
      const p = pageData as { getTextContent: (o: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<{ items: Array<{ str: string; transform: number[] }> }> };
      const tc = await p.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      let text = ""; let lastY: number | null = null;
      for (const item of tc.items) {
        const y = item.transform[5] ?? 0;
        text += lastY === null || lastY === y ? item.str : `\n${item.str}`;
        lastY = y;
      }
      seiten.push(text);
      return text;
    };
    const result = await mod.default(buf, { pagerender });
    const TEXT_CAP = 200_000; // ~50k tokens, hoch genug für Verträge
    const text = result.text ?? "";
    return {
      text: text.slice(0, TEXT_CAP),
      numPages: result.numpages ?? 0,
      filename: input.filename,
      truncated: text.length > TEXT_CAP,
      seiten,
    };
  } catch (err) {
    throw new Error(
      `PDF "${input.filename}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
