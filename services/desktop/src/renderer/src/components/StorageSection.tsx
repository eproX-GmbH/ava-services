import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  StorageCategory,
  StorageCategoryKey,
  StorageItem,
  StorageOverview,
} from "../../../shared/types";

// v0.1.365 — Settings → System: Speicher-Aufschlüsselung + Bereinigung.
//
// Nutzer berichten volllaufende Platten; Ursache sind veraltete Ollama-
// Modelle in ~/.ollama/models, die über AVA-Versionen hinweg liegenbleiben
// (Default-Chat-Modell wechselte; Modell-Picker lässt große Modelle
// ausprobieren) — und nichts räumt sie auf. Dieses Panel zeigt den
// Verbrauch pro Ordner/Modell und erlaubt gezieltes + automatisches
// Löschen. Aktives + erforderliches Modell ist immer geschützt.

function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

type TabId = "modelle" | "sprache" | "system" | "daten";

const TABS: Array<{ id: TabId; label: string; cats: StorageCategoryKey[] }> = [
  { id: "modelle", label: "Sprachmodelle", cats: ["ollamaModels"] },
  { id: "sprache", label: "Spracherkennung", cats: ["whisperModels"] },
  { id: "system", label: "Programm & Cache", cats: ["ollamaManaged", "avaCache"] },
  { id: "daten", label: "Deine Daten", cats: ["avaData"] },
];

export function StorageSection() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("modelle");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const o = await window.api.storage.getOverview();
      setOverview(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const catByKey = useMemo(() => {
    const m = new Map<StorageCategoryKey, StorageCategory>();
    for (const c of overview?.categories ?? []) m.set(c.key, c);
    return m;
  }, [overview]);

  const handleDelete = useCallback(
    async (cat: StorageCategory, item: StorageItem) => {
      const confirmMsg =
        cat.key === "avaCache"
          ? `„${item.label}" leeren (${formatBytes(item.sizeBytes)} freigeben)?`
          : `„${item.label}" endgültig löschen (${formatBytes(item.sizeBytes)} freigeben)?`;
      if (!window.confirm(confirmMsg)) return;
      setBusy(item.id);
      setError(null);
      try {
        const res = await window.api.storage.deleteItem(cat.key, item.id);
        if (!res.ok) {
          setError(res.error ?? "Löschen fehlgeschlagen.");
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const handleCleanup = useCallback(async () => {
    if (!overview || overview.orphanCount === 0) return;
    if (
      !window.confirm(
        `${overview.orphanCount} nicht benötigte Modell(e) entfernen und ` +
          `${formatBytes(overview.orphanBytes)} freigeben? Das aktive und die ` +
          `erforderlichen Modelle bleiben erhalten.`,
      )
    )
      return;
    setBusy("__cleanup__");
    setError(null);
    try {
      const res = await window.api.storage.cleanupOrphans();
      if (!res.ok && res.error) setError(res.error);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [overview, reload]);

  const openFolder = useCallback((path: string) => {
    void window.api.storage.openFolder(path);
  }, []);

  const activeCats = useMemo(() => {
    const def = TABS.find((t) => t.id === tab)!;
    return def.cats.map((k) => catByKey.get(k)).filter(Boolean) as StorageCategory[];
  }, [tab, catByKey]);

  return (
    <section className="provider-section" id="storage">
      <h3>Speicherplatz</h3>
      <p className="muted small">
        Aufschlüsselung des Plattenverbrauchs. Der größte Posten sind meist
        veraltete Sprachmodelle, die von früheren AVA-Versionen übrig sind —
        die kannst du hier gefahrlos entfernen.
      </p>

      {overview && (
        <ul className="kv">
          <li>
            <span className="muted">Gesamt (von AVA verwaltet):</span>{" "}
            <strong>{formatBytes(overview.totalBytes)}</strong>
          </li>
          {overview.orphanCount > 0 && (
            <li>
              <span className="muted">Nicht benötigte Modelle:</span>{" "}
              <span className="badge warn" style={{ marginLeft: "0.25rem" }}>
                {overview.orphanCount} · {formatBytes(overview.orphanBytes)}
              </span>
            </li>
          )}
        </ul>
      )}

      {overview && overview.orphanCount > 0 && (
        <div className="actions" style={{ marginBottom: "0.75rem" }}>
          <button
            type="button"
            onClick={() => void handleCleanup()}
            disabled={busy !== null}
          >
            {busy === "__cleanup__"
              ? "Wird bereinigt…"
              : `Nicht benötigte Modelle entfernen (${formatBytes(overview.orphanBytes)} freigeben)`}
          </button>
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      {/* Tab-Leiste */}
      <div className="storage-tabbar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={t.id === tab ? "storage-tab active" : "storage-tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !overview ? (
        <p className="muted small">Wird geladen…</p>
      ) : (
        activeCats.map((cat) => (
          <div key={cat.key} style={{ marginBottom: "1rem" }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "0.5rem",
              }}
            >
              <strong>{cat.label}</strong>
              <span className="muted small">
                {formatBytes(cat.totalBytes)}
                {"  "}
                <button
                  type="button"
                  className="link"
                  onClick={() => openFolder(cat.path)}
                  title={cat.path}
                >
                  Ordner öffnen
                </button>
              </span>
            </div>

            {cat.items.length === 0 ? (
              <p className="muted small">Nichts vorhanden.</p>
            ) : (
              <ul className="storage-list" style={{ listStyle: "none", padding: 0, margin: "0.4rem 0 0" }}>
                {cat.items.map((item) => (
                  <li
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.75rem",
                      padding: "0.35rem 0",
                      borderBottom: "1px solid var(--border, #2a2a2a)",
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <code>{item.label}</code>{" "}
                      {item.detail && (
                        <span
                          className={
                            item.protected ? "badge ok" : "badge"
                          }
                          style={{ marginLeft: "0.35rem" }}
                        >
                          {item.detail}
                        </span>
                      )}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 }}>
                      <span className="muted small">{formatBytes(item.sizeBytes)}</span>
                      {cat.deletable && !item.protected && (
                        <button
                          type="button"
                          className="link danger"
                          disabled={busy !== null}
                          onClick={() => void handleDelete(cat, item)}
                        >
                          {busy === item.id
                            ? "…"
                            : cat.key === "avaCache"
                              ? "Leeren"
                              : "Löschen"}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}

      <div className="actions">
        <button
          type="button"
          className="link"
          onClick={() => void reload()}
          disabled={loading}
        >
          Aktualisieren
        </button>
      </div>
    </section>
  );
}
