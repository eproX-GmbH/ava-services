import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes, NavLink, Navigate } from "react-router-dom";
import { App } from "./App";
import { Whoami } from "./routes/Whoami";
import { Transactions } from "./routes/Transactions";
import { TransactionStream } from "./routes/TransactionStream";
import "./styles.css";

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
            <NavLink to="/whoami">Whoami</NavLink>
            <NavLink to="/transactions">Transactions</NavLink>
          </nav>
          <main className="main">
            <Routes>
              <Route path="/" element={<Navigate to="/whoami" replace />} />
              <Route path="/whoami" element={<Whoami />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/transactions/:id/stream" element={<TransactionStream />} />
            </Routes>
          </main>
        </App>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
