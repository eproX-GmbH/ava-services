// Light/dark theme.
//
// Three states map to two CSS classes:
//   "light" -> no class on <html>
//   "dark"  -> class="dark" on <html>
//   "system" (default) -> follow `prefers-color-scheme`, re-evaluated on change
//
// Persisted in localStorage under `ava.theme`. The Corporate Trust
// styles.css reserves a `:root.dark` block that overrides the surface
// tokens; the brand aqua + cyan keep their hue across both modes.

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "ava.theme";

export function getStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage unavailable (private mode); fall back to system */
  }
  return "system";
}

export function setStoredMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Resolve a mode + the current OS preference into the actual class name. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

/** Mutate <html> to reflect the resolved theme. */
export function applyTheme(theme: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  // Native form controls + scrollbars need this hint too.
  root.style.colorScheme = theme;
  // v0.1.386 — Windows: die Fensterleisten-Buttons (titleBarOverlay) mit
  // umfärben, damit Min/Max/Schließen im Dark-Mode nicht schwarz-auf-dunkel
  // verschwinden. Auf macOS ist das ein No-op im Main-Process.
  try {
    void window.api?.setTitleBarOverlay?.(theme);
  } catch {
    /* api noch nicht bereit / nicht in Electron — egal */
  }
}

/** Apply the currently-stored mode immediately. Call once at boot. */
export function bootstrapTheme(): void {
  applyTheme(resolveTheme(getStoredMode()));
}

/**
 * Subscribe to OS-level preference changes. Returns an unsubscribe
 * function. Only applies when the stored mode is `"system"`.
 */
export function watchSystemPreference(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (): void => {
    if (getStoredMode() === "system") onChange();
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
