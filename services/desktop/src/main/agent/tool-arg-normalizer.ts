// v0.1.227 — Zentraler Tool-Argument-Normalizer.
//
// Wird in `define-tool.ts` direkt VOR `schema.validateSync(...)`
// aufgerufen. Repariert die häufigsten LLM-Misformatierungen:
//
//   - Objects als JSON-Strings ankommen           → JSON.parse versuchen
//   - Arrays als JSON-Strings ankommen            → JSON.parse versuchen
//   - Arrays als Single-Value ankommen            → in Array wrappen
//   - Booleans als "true" / "false" / "yes" / …  → echter Boolean
//   - Numbers als Strings ankommen                → parseFloat
//
// Das Pattern ist defensiv: wir machen NIE eine destruktive Annahme.
// Wenn ein Cast scheitert (z. B. JSON.parse wirft), reichen wir den
// Original-Wert weiter und das danach folgende yup-validate produziert
// die normale Fehlermeldung. Wir machen also nichts schlechter, nur
// in bekannten Fällen besser.
//
// Warum hier zentral und nicht in den Tool-Schemas:
//
//   - Pro-Tool-Coercion (v0.1.226) hat sich nicht skaliert — bei
//     jedem neuen Tool mit nicht-trivialen Args trat dieselbe Bug-
//     Klasse wieder auf.
//   - Zentral haben wir EINEN Wartungs-Punkt für die Coercion-Regeln.
//   - Neue Tools profitieren automatisch.

import * as yup from "yup";

/**
 * Normalisiert `args` gegen das gegebene Schema. `schema` muss eine
 * `yup.ObjectSchema` sein (alle Tool-Schemas in AVA sind das).
 *
 * Returns eine NEUE args-Struktur — Input wird nicht mutiert.
 *
 * Logging: bei jeder Coercion wird der Field-Name an `appliedFixes`
 * angehängt. Caller kann das für Telemetry verwenden oder einfach
 * ignorieren.
 */
export function normaliseToolArgs(
  args: unknown,
  schema: yup.AnySchema,
): { args: unknown; appliedFixes: string[] } {
  const appliedFixes: string[] = [];

  // Schritt 1 — Wenn args selbst ein String ist + Schema erwartet ein
  // Object, JSON-parse versuchen. Selten, aber kommt bei manchen
  // Modellen vor (gesamtes args wird als JSON-String emittiert).
  if (typeof args === "string" && isObjectSchema(schema)) {
    const parsed = tryJsonParse(args);
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      appliedFixes.push("$root");
      return walkObject(parsed as Record<string, unknown>, schema, appliedFixes);
    }
  }

  if (!isObjectSchema(schema)) {
    // Nicht-Object-Schemas (selten in AVA — wir nutzen yup.object für
    // alle Tools). Fallback: das ganze Argument coercen.
    const out = coerceValue(args, schema, "$root", appliedFixes);
    return { args: out, appliedFixes };
  }

  if (typeof args !== "object" || args === null) {
    // args ist ein primitiver Typ obwohl wir ein Object erwarten —
    // wir können nichts retten, yup macht den Fehlertext.
    return { args, appliedFixes };
  }

  return walkObject(args as Record<string, unknown>, schema, appliedFixes);
}

function walkObject(
  obj: Record<string, unknown>,
  schema: yup.AnySchema,
  appliedFixes: string[],
): { args: unknown; appliedFixes: string[] } {
  const out: Record<string, unknown> = {};
  const fields = getObjectFields(schema);
  for (const [k, v] of Object.entries(obj)) {
    const fieldSchema = fields[k];
    if (fieldSchema) {
      out[k] = coerceValue(v, fieldSchema, k, appliedFixes);
    } else {
      // Unknown field — yup wird's mit `stripUnknown: true` eh werfen,
      // aber wir reichen es defensiv weiter.
      out[k] = v;
    }
  }
  return { args: out, appliedFixes };
}

function coerceValue(
  value: unknown,
  schema: yup.AnySchema,
  fieldName: string,
  appliedFixes: string[],
): unknown {
  const type = (schema as { type?: string }).type;

  switch (type) {
    case "object":
      // String → JSON-Object versuchen.
      if (typeof value === "string") {
        const parsed = tryJsonParse(value);
        if (
          parsed !== undefined &&
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          appliedFixes.push(`${fieldName}:string→object`);
          // Rekursiv weitercoercen, falls das Object verschachtelte
          // Felder hat (selten, aber Notion-Filter z. B.).
          return walkObject(
            parsed as Record<string, unknown>,
            schema,
            appliedFixes,
          ).args;
        }
      }
      // Object → tieferes Walk, falls Sub-Fields definiert.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return walkObject(value as Record<string, unknown>, schema, appliedFixes)
          .args;
      }
      return value;

    case "array":
      // String → JSON-Array versuchen, sonst single-value-wrap.
      if (typeof value === "string") {
        const parsed = tryJsonParse(value);
        if (Array.isArray(parsed)) {
          appliedFixes.push(`${fieldName}:string→array`);
          return parsed;
        }
        // Kommaseparierte Liste? "lead, b2b" → ["lead", "b2b"].
        // Konservativ: nur wenn der String mindestens ein Komma enthält.
        if (value.includes(",")) {
          appliedFixes.push(`${fieldName}:csv→array`);
          return value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        // Single-Value-String: in Array wrappen.
        appliedFixes.push(`${fieldName}:single→array`);
        return [value];
      }
      // Single Non-Array, Non-String → in Array wrappen.
      if (
        value !== null &&
        value !== undefined &&
        !Array.isArray(value) &&
        typeof value !== "object"
      ) {
        appliedFixes.push(`${fieldName}:single→array`);
        return [value];
      }
      return value;

    case "boolean":
      if (typeof value === "string") {
        const v = value.toLowerCase().trim();
        if (["true", "yes", "ja", "1", "on"].includes(v)) {
          appliedFixes.push(`${fieldName}:string→boolean(true)`);
          return true;
        }
        if (["false", "no", "nein", "0", "off"].includes(v)) {
          appliedFixes.push(`${fieldName}:string→boolean(false)`);
          return false;
        }
      }
      if (typeof value === "number") {
        if (value === 1) {
          appliedFixes.push(`${fieldName}:number→boolean(true)`);
          return true;
        }
        if (value === 0) {
          appliedFixes.push(`${fieldName}:number→boolean(false)`);
          return false;
        }
      }
      return value;

    case "number":
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) return value;
        const n = Number(trimmed);
        if (Number.isFinite(n)) {
          appliedFixes.push(`${fieldName}:string→number`);
          return n;
        }
      }
      return value;

    default:
      // string, date, mixed → keine Coercion. yup macht's selber
      // tolerant für `date` (parsed ISO-Strings); für `mixed` wollen
      // wir gar nichts anfassen.
      return value;
  }
}

function isObjectSchema(schema: yup.AnySchema): boolean {
  return (schema as { type?: string }).type === "object";
}

function getObjectFields(schema: yup.AnySchema): Record<string, yup.AnySchema> {
  const fields = (schema as { fields?: Record<string, yup.AnySchema> }).fields;
  return fields ?? {};
}

function tryJsonParse(s: string): unknown | undefined {
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  // Schnell-Filter: muss mit `{` oder `[` oder `"` anfangen, sonst
  // ist es definitiv kein JSON.
  if (!/^[{[]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
