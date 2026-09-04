import type { OllamaToolSpec, Tool } from "./types";

// Tool registry.
//
// 8.a ships an empty registry — orchestrator still calls /api/chat without
// the `tools` field when this is empty, which is the "no tools" smoke-test
// path. 8.b populates this with read-only proxies (gateway company lookups,
// evaluation RAG, etc.) and 8.e adds write tools.

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  /** O3 — Organisationsvorgabe: gesperrte Tools sind weder sichtbar noch aufrufbar. */
  private gesperrt: (name: string) => boolean = () => false;

  setSperre(pred: (name: string) => boolean): void {
    this.gesperrt = pred;
  }

  register<TArgs, TResult>(tool: Tool<TArgs, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as Tool);
  }

  get(name: string): Tool | undefined {
    if (this.gesperrt(name)) return undefined;
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).filter((t) => !this.gesperrt(t.name));
  }

  /** Materialise the JSON-Schema descriptors Ollama's `/api/chat` expects. */
  toOllamaTools(): OllamaToolSpec[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  size(): number {
    return this.tools.size;
  }
}
