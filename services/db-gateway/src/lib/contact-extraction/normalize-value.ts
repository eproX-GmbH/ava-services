export type NormalizeInput = {
  field: string;
  value: string;
  defaultCountryCode?: string;
};

export function normalizeValue(input: NormalizeInput): string {
  const v = (input.value ?? "").trim();
  if (!v) return "";
  const f = input.field.toLowerCase();

  if (f.includes("email")) return v.toLowerCase();

  if (f.includes("phone") || f.includes("tel")) {
    const digits = v.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) return digits;
    const cc = (input.defaultCountryCode ?? "").replace(/[^\d]/g, "");
    if (!cc) return digits;
    return `+${cc}${digits.replace(/^\+/, "")}`;
  }

  if (
    f.includes("url") ||
    f.includes("website") ||
    f.includes("linkedin") ||
    f.includes("xing")
  ) {
    try {
      const u = new URL(v.startsWith("http") ? v : `https://${v}`);
      u.hash = "";
      u.searchParams.forEach((_, k) => {
        if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
      });
      if ([...u.searchParams.keys()].length === 0) u.search = "";
      const host = u.hostname.toLowerCase();
      const path = u.pathname.replace(/\/+$/, "") || "/";
      return `${u.protocol}//${host}${path}${u.search}`;
    } catch {
      return v;
    }
  }

  return v.replace(/\s+/g, " ").trim();
}
