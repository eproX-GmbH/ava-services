// v0.1.522 — Markdown-Darstellung fuer Meldungs-Beschreibungen.
//
// Vorher ein nacktes <p>{rationale}</p>: Sammel-Meldungen mit 13
// Signalen wurden zu einer unlesbaren Zeile, URLs waren toter Text.
// Dieselbe Link-Logik wie im Chat: `company:<id>` / /companies/<id>
// → SPA-Detailseite, http(s) → System-Browser, unbekannt → Text.
// remark-gfm macht auch nackte URLs (aeltere Meldungen) klickbar.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { extractCompanyId, toSpaPath } from "../routes/Chat";

const COMPONENTS: Components = {
  a({ href, children }) {
    const target = typeof href === "string" ? href.trim() : "";
    const companyId = extractCompanyId(target);
    if (companyId) {
      return (
        <Link
          to={`/companies/${encodeURIComponent(companyId)}`}
          className="chat-company-link"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </Link>
      );
    }
    if (/^https?:\/\//i.test(target)) {
      return (
        <a
          href={target}
          className="chat-link"
          title={target}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void window.api.shell.openExternal(target);
          }}
        >
          {children}
        </a>
      );
    }
    const spa = toSpaPath(target);
    if (spa) {
      return (
        <Link to={spa} className="chat-link" onClick={(e) => e.stopPropagation()}>
          {children}
        </Link>
      );
    }
    return <span className="chat-link-dead">{children}</span>;
  },
};

export function AlertMarkdown({ text }: { text: string }) {
  return (
    <div className="alert-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
