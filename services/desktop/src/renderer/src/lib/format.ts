// Shared display formatters for the renderer (Phase 8.l5 prep).
//
// Centralised so every route renders dates, money and contact details
// the same way. Locale is locked to `de-DE` — the tool is targeted at
// German companies, see the i18n work plan in AGENT_PLAN.md (8.m).

const eurFmt = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat("de-DE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// ---- Numbers / money -------------------------------------------------------

/**
 * Coerce mixed shapes (number, `{value, currency}` value-object, numeric
 * string with currency suffix) into a plain number; null when not parseable.
 */
export function numVal(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const n = (v as { value?: unknown }).value;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }
  if (typeof v === "string") {
    // Strip everything except digits, signs, dots and commas.
    const trimmed = v.replace(/[^\d.,-]/g, "");
    if (!trimmed) return null;
    // German format with explicit decimal comma — e.g. "26.000,50".
    // Dots are thousand seps, comma is the decimal mark.
    if (trimmed.includes(",")) {
      const n = Number(trimmed.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    // No comma. Dot is ambiguous: German "26.000" (thousand sep) vs.
    // US / Postgres-NUMERIC "37500.000" (decimal with trailing zeros
    // — node-pg serialises NUMERIC(_,3) like this). Treat dots as a
    // thousands separator ONLY when every dot-separated group after
    // the first has exactly 3 digits AND the first group is 1-3
    // digits, i.e. /^-?\d{1,3}(\.\d{3})+$/. Anything else (including
    // "37500.000" — first group is 5 digits) is a decimal point.
    const looksLikeGermanThousands = /^-?\d{1,3}(\.\d{3})+$/.test(trimmed);
    const normalised = looksLikeGermanThousands ? trimmed.replace(/\./g, "") : trimmed;
    const n = Number(normalised);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function currencySymbol(c?: string | null): string {
  switch ((c ?? "").toUpperCase()) {
    case "EUR":
    case "":
      return "€";
    case "USD":
      return "$";
    case "GBP":
      return "£";
    default:
      return c ? ` ${c}` : "€";
  }
}

/**
 * Format a numeric or `{value,currency}` value-object as German money.
 * Falls back to the em-dash placeholder for missing values. EUR is the
 * default currency when none is provided.
 */
export function fmtMoney(v: unknown): string {
  const n = numVal(v);
  if (n == null) return "";
  const cur =
    typeof v === "object" && v !== null && "currency" in v
      ? ((v as { currency?: string | null }).currency ?? null)
      : null;
  const sym = currencySymbol(cur);
  if (sym === "€" || sym === "$" || sym === "£") {
    return `${eurFmt.format(n)} ${sym}`;
  }
  return `${eurFmt.format(n)}${sym}`;
}

/**
 * Format a `shareCapital`-like string. Upstream typically delivers
 * raw strings such as `"26000"`, `"26000 EUR"` or `"26.000,00 €"`;
 * normalise everything to `26.000 €`.
 */
export function fmtShareCapital(v: unknown): string {
  if (v == null || v === "") return "";
  // If we can extract a number, render via fmtMoney with EUR default.
  const n = numVal(v);
  if (n != null) {
    // Sniff a non-EUR currency code from the original string.
    const codeMatch = typeof v === "string" ? v.match(/[A-Z]{3}/) : null;
    return fmtMoney({ value: n, currency: codeMatch?.[0] ?? "EUR" });
  }
  return String(v);
}

// ---- Dates -----------------------------------------------------------------

/**
 * Format a date-ish value (ISO string, Date, epoch ms) as `DD.MM.YYYY`.
 * Returns `"—"` for nullish input and the original string when it
 * doesn't parse.
 *
 * v0.1.66 — calendar dates from upstream (births, fiscal years,
 * register entries) come as `YYYY-MM-DD` or `YYYY-MM-DDT00:00:00Z`.
 * Naive `new Date(iso)` parses as UTC, then `Intl.DateTimeFormat` in
 * Berlin (UTC+1) shifts to the previous day at midnight (e.g. a
 * birthday of 1998-12-08 renders as 07.12.1998). Cure: when the
 * string looks like a calendar date, slice the YYYY-MM-DD prefix and
 * format from those parts directly — no timezone conversion. Real
 * timestamps (with explicit offsets / non-zero clocks) keep the
 * locale-aware path.
 */
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]00:00(?::00(?:\.0+)?)?Z?)?$/;

export function fmtDate(v: unknown): string {
  if (v == null || v === "") return "";
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? "" : dateFmt.format(v);
  }
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "" : dateFmt.format(d);
  }
  if (typeof v === "string") {
    const m = CALENDAR_DATE_RE.exec(v);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return dateFmt.format(d);
    return v;
  }
  return "";
}

/** Format an ISO date range as `DD.MM.YYYY – DD.MM.YYYY`. */
export function fmtDateRange(begin?: unknown, end?: unknown): string {
  const b = begin == null || begin === "" ? null : fmtDate(begin);
  const e = end == null || end === "" ? null : fmtDate(end);
  if (b && e) return `${b} – ${e}`;
  return b ?? e ?? "";
}

// ---- Contact links ---------------------------------------------------------

/**
 * Normalise a phone number for use in a `tel:` href. Keeps the leading
 * `+`, strips all other non-digits — `tel:` is forgiving but spaces and
 * parentheses can confuse some dialers.
 */
export function telHref(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, "");
  return `tel:${cleaned}`;
}

/** `mailto:` href with the address trimmed. */
export function mailHref(email: string): string {
  return `mailto:${email.trim()}`;
}

/**
 * Build a Google Maps search URL for an address. Returns null when no
 * address parts are usable (so the caller can render plain text).
 */
export function mapsHref(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.map((p) => p?.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const q = encodeURIComponent(cleaned.join(", "));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// Conservative regex; we treat any string containing an `@` flanked by
// non-whitespace as an email-ish, and anything that looks like a phone
// number (5+ digits, optional +, spaces / dashes / parens) as a phone.
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const PHONE_RE = /^\+?[\d][\d\s/().-]{4,}$/;

export function looksLikeEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}
export function looksLikePhone(v: string): boolean {
  return PHONE_RE.test(v.trim());
}
