import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Search as SearchIcon } from "lucide-react";
import type { ConversationSearchHit } from "../../../shared/types";

// ChatSearchModal (v0.1.85).
//
// Global Cmd/Ctrl+K modal that searches the full text of every
// conversation transcript on disk. Results are case-insensitive
// substring matches across user + assistant messages; multi-word
// queries are AND-joined. The modal is decoupled from the chat route
// — picking a hit dispatches an `ava:chat-search-pick` CustomEvent
// that the chat route listens for, switches conversation, and
// scrolls / highlights the matched message.

export interface ChatSearchPickPayload {
  conversationId: string;
  messageIndex: number;
  messageId: string;
}

const PICK_EVENT = "ava:chat-search-pick";

/**
 * Imperative dispatcher used by both the modal and any future
 * caller (e.g. a future deep-link). Lives at module scope so
 * we don't have to thread a callback through the AppShell.
 */
export function dispatchChatSearchPick(payload: ChatSearchPickPayload): void {
  window.dispatchEvent(new CustomEvent<ChatSearchPickPayload>(PICK_EVENT, { detail: payload }));
}

export function onChatSearchPick(
  cb: (payload: ChatSearchPickPayload) => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ChatSearchPickPayload>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(PICK_EVENT, handler);
  return () => window.removeEventListener(PICK_EVENT, handler);
}

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Called BEFORE the conversation switch so the AppShell can route
   * to /chat if the user is somewhere else. The actual switch +
   * scroll is driven by the `ava:chat-search-pick` event the modal
   * dispatches right after.
   */
  onBeforePick?: (hit: ConversationSearchHit) => void;
}

export function ChatSearchModal({ open, onClose, onBeforePick }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reqIdRef = useRef(0);

  // Reset on open/close.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setSelected(0);
      setLoading(false);
      return;
    }
    // Microtask focus — the input is autoFocus, but we re-focus on
    // every open in case the modal is being re-shown after a close.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myReq = ++reqIdRef.current;
    const t = setTimeout(() => {
      void window.api.agent
        .searchConversations({ query: q, limit: 50, perChat: 5 })
        .then((res) => {
          if (myReq !== reqIdRef.current) return;
          setHits(res);
          setSelected(0);
          setLoading(false);
        })
        .catch(() => {
          if (myReq !== reqIdRef.current) return;
          setHits([]);
          setLoading(false);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [query, open]);

  const pick = useCallback(
    (hit: ConversationSearchHit) => {
      onBeforePick?.(hit);
      dispatchChatSearchPick({
        conversationId: hit.conversationId,
        messageIndex: hit.messageIndex,
        messageId: hit.messageId,
      });
      onClose();
    },
    [onBeforePick, onClose],
  );

  // Keep selected row in view.
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(
      `[data-search-row="${selected}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selected, open, hits]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (hits.length === 0) return;
        setSelected((s) => Math.min(hits.length - 1, s + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (hits.length === 0) return;
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[selected];
        if (hit) pick(hit);
        return;
      }
    },
    [hits, selected, pick, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="chat-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Konversationen durchsuchen"
      onMouseDown={(e) => {
        // Click on the backdrop closes; clicks inside the panel don't.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="chat-search-panel">
        <div className="chat-search-input-row">
          <SearchIcon size={18} className="chat-search-input-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="In allen Chats suchen…"
            aria-label="Suchbegriff"
            autoFocus
          />
        </div>
        <div className="chat-search-results" ref={listRef}>
          <ResultsBody
            query={query}
            loading={loading}
            hits={hits}
            selected={selected}
            onPick={pick}
            onHover={setSelected}
          />
        </div>
        <div className="chat-search-hint muted small">
          ↵ öffnen · Esc schließen · ↑↓ navigieren
        </div>
      </div>
    </div>
  );
}

function ResultsBody(props: {
  query: string;
  loading: boolean;
  hits: ConversationSearchHit[];
  selected: number;
  onPick: (hit: ConversationSearchHit) => void;
  onHover: (idx: number) => void;
}) {
  const trimmed = props.query.trim();
  if (!trimmed) {
    return (
      <div className="chat-search-empty muted">
        Tippe, um in allen Chats zu suchen.
      </div>
    );
  }
  if (props.loading) {
    return <div className="chat-search-empty muted">Lädt…</div>;
  }
  if (props.hits.length === 0) {
    return <div className="chat-search-empty muted">Keine Treffer.</div>;
  }
  // Per-conversation hit counts so each row can show a "N Treffer"
  // badge — lets users spot hot conversations at a glance without
  // scanning every excerpt. O(n) precompute, O(1) lookup per row.
  const countByConversation = new Map<string, number>();
  for (const h of props.hits) {
    countByConversation.set(
      h.conversationId,
      (countByConversation.get(h.conversationId) ?? 0) + 1,
    );
  }
  return (
    <>
      {props.hits.map((hit, idx) => {
        const isSelected = idx === props.selected;
        const roleLabel = hit.messageRole === "user" ? "Du" : "AVA";
        const hitCount = countByConversation.get(hit.conversationId) ?? 1;
        return (
          <div
            key={`${hit.conversationId}:${hit.messageIndex}`}
            data-search-row={idx}
            className={`chat-search-row${isSelected ? " chat-search-row--selected" : ""}`}
            onMouseEnter={() => props.onHover(idx)}
            onMouseDown={(e) => {
              // mouseDown so we beat the input blur on click.
              e.preventDefault();
              props.onPick(hit);
            }}
          >
            <div className="chat-search-row__head">
              <span className="chat-search-row__title">
                {hit.conversationLabel || `(leer) ${hit.conversationId.slice(0, 8)}`}
              </span>
              {hitCount > 1 && (
                <span
                  className="chat-search-row__count"
                  title={`${hitCount} Treffer in dieser Konversation`}
                >
                  {hitCount} Treffer
                </span>
              )}
              <span className="chat-search-row__time muted small">
                {formatRelative(hit.conversationModifiedAt)}
              </span>
            </div>
            <div className="chat-search-row__meta">
              <span
                className={`chat-search-pill chat-search-pill--${hit.messageRole}`}
              >
                {roleLabel}
              </span>
              <span className="chat-search-row__excerpt">
                {renderExcerpt(hit.excerpt, hit.matchOffsets)}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * Splits the excerpt into alternating plain spans and `<mark>` spans.
 * Avoids dangerouslySetInnerHTML — every fragment goes through React.
 */
export function renderExcerpt(
  excerpt: string,
  offsets: Array<[number, number]>,
): ReactNode[] {
  if (!offsets || offsets.length === 0) return [excerpt];
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const [start, end] of offsets) {
    if (start > cursor) {
      out.push(<span key={`p-${key++}`}>{excerpt.slice(cursor, start)}</span>);
    }
    out.push(<mark key={`m-${key++}`}>{excerpt.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < excerpt.length) {
    out.push(<span key={`p-${key++}`}>{excerpt.slice(cursor)}</span>);
  }
  return out;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "gerade eben";
  if (diff < 3_600_000) return `vor ${Math.round(diff / 60_000)} Min.`;
  if (diff < 86_400_000) return `vor ${Math.round(diff / 3_600_000)} Std.`;
  return `vor ${Math.round(diff / 86_400_000)} Tagen`;
}

/**
 * useChatSearchModal — wires the global Cmd/Ctrl+K shortcut and
 * exposes `{open, setOpen}` for the AppShell. Mounted once at the
 * shell so the modal works on every route.
 */
export function useChatSearchHotkey(setOpen: (v: boolean) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isToggle =
        (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      if (!isToggle) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

/** Helper for components that want a pure consumer (no hotkey). */
export function useChatSearchModalState() {
  const [open, setOpen] = useState(false);
  useChatSearchHotkey(setOpen);
  // Re-export the setter-only "open it" affordance so the sidebar
  // search-icon button can call it without rebinding the hotkey.
  return useMemo(
    () => ({ open, setOpen, openModal: () => setOpen(true), closeModal: () => setOpen(false) }),
    [open],
  );
}
