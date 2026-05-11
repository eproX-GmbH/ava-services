// SlashPalette — slash-command picker for the chat composer.
//
// Renders a popover above the composer textarea when the user is typing
// `/<name>` at the start of the input. Shows enabled, trusted, gate-
// satisfied, user-invocable skills first, then registered agent tools.
//
// The parent owns the open/query state. We expose an imperative API so
// the parent's `onKeyDown` can drive arrow/Enter/Tab/Escape without
// duplicating list/index bookkeeping or fighting React for focus.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { SkillRow, SkillB2bScope } from "../../../../shared/types";

export interface SlashPaletteItem {
  kind: "skill" | "tool";
  name: string;
  description: string;
  /** Only populated for `kind === "skill"`. */
  b2bScope: SkillB2bScope | null;
}

export interface SlashPaletteHandle {
  /** Arrow-down — wraps around. */
  moveDown(): void;
  /** Arrow-up — wraps around. */
  moveUp(): void;
  /** Enter / Tab — fires onSelect with the highlighted item. Returns
   *  true when a selection happened, false when the visible list is
   *  empty (caller should fall through to default Enter behaviour). */
  select(): boolean;
  /** Number of currently-visible rows after filtering. */
  visibleCount(): number;
}

interface Props {
  open: boolean;
  /** Text after the leading "/", lowercased. May be empty. */
  query: string;
  onSelect: (cmd: { kind: "skill" | "tool"; name: string }) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
}

export const SlashPalette = forwardRef<SlashPaletteHandle, Props>(
  function SlashPalette({ open, query, onSelect, onClose, anchorRef }, ref) {
    const [items, setItems] = useState<SlashPaletteItem[] | null>(null);
    const [active, setActive] = useState(0);
    const [pos, setPos] = useState<CSSProperties | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    // Load skills + tools once on mount. The list rarely changes mid-
    // session; the orchestrator picks up enabled/trust changes on the
    // next send anyway, so a refresh-on-open isn't worth the cost.
    useEffect(() => {
      let cancelled = false;
      async function load() {
        try {
          const [skills, tools] = await Promise.all([
            window.api.skills.list(),
            window.api.skills.listAvailableTools(),
          ]);
          if (cancelled) return;
          const skillItems: SlashPaletteItem[] = skills
            .filter(
              (s: SkillRow) =>
                s.enabled &&
                s.gateSatisfied &&
                s.trust === "trusted" &&
                s.userInvocable !== false &&
                s.disableModelInvocation !== true,
            )
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => ({
              kind: "skill" as const,
              name: s.name,
              description: s.description ?? "",
              b2bScope: s.b2bScope,
            }));
          const toolItems: SlashPaletteItem[] = tools
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({
              kind: "tool" as const,
              name: t.name,
              description: t.description ?? "",
              b2bScope: null,
            }));
          setItems([...skillItems, ...toolItems]);
        } catch {
          if (!cancelled) setItems([]);
        }
      }
      void load();
      return () => {
        cancelled = true;
      };
    }, []);

    // Filtered + sorted view. Substring match on name first; description
    // is a secondary surface so the user can find a tool by what it
    // does, not just by what it's called.
    const filtered = useMemo<SlashPaletteItem[]>(() => {
      const list = items ?? [];
      const q = query.trim().toLowerCase();
      if (!q) return list;
      const nameHits: SlashPaletteItem[] = [];
      const descHits: SlashPaletteItem[] = [];
      for (const it of list) {
        if (it.name.toLowerCase().includes(q)) nameHits.push(it);
        else if (it.description.toLowerCase().includes(q)) descHits.push(it);
      }
      return [...nameHits, ...descHits];
    }, [items, query]);

    // Reset selection whenever the visible list shape changes.
    useEffect(() => {
      setActive(0);
    }, [filtered.length, open]);

    // Position above the textarea, anchored to its left edge with the
    // same width — measured on open and on layout flush.
    useLayoutEffect(() => {
      if (!open) return;
      const el = anchorRef.current;
      if (!el) return;
      const updatePos = () => {
        const r = el.getBoundingClientRect();
        setPos({
          position: "fixed",
          left: r.left,
          width: r.width,
          bottom: window.innerHeight - r.top + 6,
        });
      };
      updatePos();
      window.addEventListener("resize", updatePos);
      window.addEventListener("scroll", updatePos, true);
      return () => {
        window.removeEventListener("resize", updatePos);
        window.removeEventListener("scroll", updatePos, true);
      };
    }, [open, anchorRef]);

    // Keep the active row in view when arrow-keys cross the scroll edge.
    useEffect(() => {
      if (!open) return;
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-row-index="${active}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
    }, [active, open]);

    useImperativeHandle(
      ref,
      () => ({
        moveDown() {
          if (filtered.length === 0) return;
          setActive((i) => (i + 1) % filtered.length);
        },
        moveUp() {
          if (filtered.length === 0) return;
          setActive((i) => (i - 1 + filtered.length) % filtered.length);
        },
        select() {
          if (filtered.length === 0) return false;
          const target = filtered[Math.min(active, filtered.length - 1)];
          if (!target) return false;
          onSelect({ kind: target.kind, name: target.name });
          return true;
        },
        visibleCount() {
          return filtered.length;
        },
      }),
      [filtered, active, onSelect],
    );

    if (!open) return null;
    if (items === null) {
      return (
        <div className="slash-palette" style={pos ?? undefined}>
          <div className="slash-palette__empty">Lade Befehle…</div>
        </div>
      );
    }
    if (filtered.length === 0) {
      return (
        <div className="slash-palette" style={pos ?? undefined}>
          <div className="slash-palette__empty">Keine Treffer für „/{query}".</div>
        </div>
      );
    }

    // Split into a skills segment and a tools segment so each gets its
    // own sticky header. We preserve the order from `filtered` (name-
    // hits before description-hits) within each group.
    const skills = filtered.filter((f) => f.kind === "skill");
    const tools = filtered.filter((f) => f.kind === "tool");

    let cursor = 0;
    const sections: ReactNode[] = [];
    if (skills.length > 0) {
      const start = cursor;
      sections.push(
        <div key="hdr-skills" className="slash-palette__group">
          Skills ({skills.length})
        </div>,
      );
      for (const it of skills) {
        const idx = start + (cursor - start);
        sections.push(renderRow(it, idx));
        cursor++;
      }
    }
    if (tools.length > 0) {
      const start = cursor;
      sections.push(
        <div key="hdr-tools" className="slash-palette__group">
          Tools ({tools.length})
        </div>,
      );
      for (const it of tools) {
        const idx = start + (cursor - start);
        sections.push(renderRow(it, idx));
        cursor++;
      }
    }

    function renderRow(it: SlashPaletteItem, idx: number) {
      const isActive = idx === active;
      const desc = truncate(it.description, 120);
      return (
        <div
          key={`${it.kind}-${it.name}`}
          data-row-index={idx}
          className={`slash-palette__row${isActive ? " active" : ""}`}
          onMouseEnter={() => setActive(idx)}
          onMouseDown={(e) => {
            // Use mousedown so the click fires before the textarea blur
            // closes the palette (otherwise the click never lands).
            e.preventDefault();
            onSelect({ kind: it.kind, name: it.name });
          }}
        >
          <span className="slash-palette__name">
            /{highlight(it.name, query)}
          </span>
          {it.kind === "skill" && it.b2bScope && (
            <span className="slash-palette__scope">{it.b2bScope}</span>
          )}
          {desc && (
            <span className="slash-palette__desc" title={it.description}>
              {highlight(desc, query)}
            </span>
          )}
        </div>
      );
    }

    return (
      <div
        className="slash-palette"
        ref={listRef}
        style={pos ?? undefined}
        // Pre-empt blur from the textarea so onMouseDown can fire.
        onMouseDown={(e) => e.preventDefault()}
        role="listbox"
        aria-label="Slash-Befehle"
      >
        {sections}
        {/* Hidden so we register for the close-on-outside check. */}
        <span style={{ display: "none" }} onClick={onClose} />
      </div>
    );
  },
);

function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="slash-palette__highlight">
        {text.slice(idx, idx + q.length)}
      </span>
      {text.slice(idx + q.length)}
    </>
  );
}
