import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes, Navigate } from "react-router-dom";
// Plus Jakarta Sans — Corporate Trust display face. Bundled locally
// (CSP `font-src 'self' data:` rules out Google Fonts CDN). The five
// weights cover Regular/Medium/SemiBold/Bold/ExtraBold called for in
// the design system. Geist Mono stays for tabular / code cells.
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "@fontsource-variable/geist-mono";
import { App } from "./App";
import { AppShell } from "./components/AppShell";
import { Whoami } from "./routes/Whoami";
import { Settings } from "./routes/Settings";
import { Chat } from "./routes/Chat";
import { Ingest } from "./routes/Ingest";
import { Transactions } from "./routes/Transactions";
import { TransactionDetail } from "./routes/TransactionDetail";
import { TransactionStream } from "./routes/TransactionStream";
import { Companies } from "./routes/Companies";
import { AllCompanies } from "./routes/AllCompanies";
import { CompanyDetail } from "./routes/CompanyDetail";
import { Evaluations } from "./routes/Evaluations";
import { BestMatchDetail } from "./routes/BestMatchDetail";
import { ChatSession } from "./routes/ChatSession";
import { Alerts } from "./routes/Alerts";
import { LinkedIn } from "./routes/LinkedIn";
import { bootstrapTheme } from "./lib/theme";
import "./styles.css";

// Apply the persisted (or system-resolved) theme BEFORE React renders,
// so the first paint already matches the user's preference and we avoid
// a light-mode flash on every launch.
bootstrapTheme();

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
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/whoami" element={<Whoami />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/:tab" element={<Settings />} />
              <Route path="/ingest" element={<Ingest />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/linkedin" element={<LinkedIn />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/transactions/:id" element={<TransactionDetail />} />
              <Route path="/transactions/:id/stream" element={<TransactionStream />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/alle-firmen" element={<AllCompanies />} />
              <Route path="/companies/:id" element={<CompanyDetail />} />
              <Route path="/transactions/:id/evaluations" element={<Evaluations />} />
              <Route path="/evaluations/best-matches/:id" element={<BestMatchDetail />} />
              <Route path="/evaluations/chats/:sessionId" element={<ChatSession />} />
            </Routes>
          </AppShell>
        </App>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
