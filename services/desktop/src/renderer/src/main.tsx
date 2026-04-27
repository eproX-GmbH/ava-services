import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes, NavLink, Navigate } from "react-router-dom";
import { App } from "./App";
import { Whoami } from "./routes/Whoami";
import { Ingest } from "./routes/Ingest";
import { Transactions } from "./routes/Transactions";
import { TransactionDetail } from "./routes/TransactionDetail";
import { TransactionStream } from "./routes/TransactionStream";
import { Companies } from "./routes/Companies";
import { CompanyDetail } from "./routes/CompanyDetail";
import { useAuthStore } from "./store/auth";
import "./styles.css";

function UserBadge() {
  const actorId = useAuthStore((s) => s.actorId);
  const tenantId = useAuthStore((s) => s.tenantId);
  return (
    <div className="user-badge">
      <span className="muted">{tenantId} / </span>
      <span>{actorId ?? "—"}</span>
      <button
        onClick={() => void window.api.auth.signOut()}
        className="link"
        title="Sign out"
      >
        sign out
      </button>
    </div>
  );
}

// React Query is the only HTTP cache. Defaults err on the side of "fresh
// is cheap, the gateway is fast" — short staleTime, refetch on focus stays
// off because Electron windows lose focus often during data-care work.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App>
          <nav className="nav">
            <div className="nav-links">
              <NavLink to="/ingest">Ingest</NavLink>
              <NavLink to="/transactions">Transactions</NavLink>
              <NavLink to="/companies">Companies</NavLink>
              <NavLink to="/whoami">Whoami</NavLink>
            </div>
            <UserBadge />
          </nav>
          <main className="main">
            <Routes>
              <Route path="/" element={<Navigate to="/transactions" replace />} />
              <Route path="/whoami" element={<Whoami />} />
              <Route path="/ingest" element={<Ingest />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/transactions/:id" element={<TransactionDetail />} />
              <Route path="/transactions/:id/stream" element={<TransactionStream />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/companies/:id" element={<CompanyDetail />} />
            </Routes>
          </main>
        </App>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
