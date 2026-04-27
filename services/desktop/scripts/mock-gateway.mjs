#!/usr/bin/env node
// Mock db-gateway for desktop UI testing.
//
// Implements every /v1/* endpoint the desktop calls, with fixture data and
// stubbed writes. CORS is wide open. JWTs are NOT verified — pair this with
// AVA_DEV_AUTH_BYPASS=1 on the desktop side.
//
// Usage:
//   node services/desktop/scripts/mock-gateway.mjs
//   (default port 8080; override with PORT=…)

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 9080);

// ---- Fixture data ---------------------------------------------------------

const COMPANIES = [
  { id: "c-001", name: "ACME Robotics GmbH", city: "Berlin" },
  { id: "c-002", name: "Bauhaus Bytes AG", city: "Munich" },
  { id: "c-003", name: "Container Logistik KG", city: "Hamburg" },
  { id: "c-004", name: "Dresden Datatech", city: "Dresden" },
  { id: "c-005", name: "Elbe Energie", city: "Hamburg" },
];

const TRANSACTIONS = [
  {
    id: "t-aaaaaaaa-1111",
    name: "Demo batch 1",
    startTime: "2026-04-26T10:00:00Z",
    createdAt: "2026-04-26T10:00:00Z",
    companyCount: 5,
  },
  {
    id: "t-bbbbbbbb-2222",
    name: "Demo batch 2",
    startTime: "2026-04-27T09:00:00Z",
    createdAt: "2026-04-27T09:00:00Z",
    companyCount: 2,
  },
];

const ENTITIES = COMPANIES.map((c, i) => ({
  companyId: c.id,
  service: ["companyProfile", "website", "companyPublication", "companyContact", "structuredContent"][i % 5],
  state: ["DONE", "DONE", "IN_PROGRESS", "ERROR", "DONE"][i % 5],
  updatedAt: "2026-04-27T09:30:00Z",
}));

const ERRORS = [
  {
    companyId: "c-004",
    service: "website",
    message: "domain detection: no high-confidence match",
    occurredAt: "2026-04-27T09:15:00Z",
  },
];

const BEST_MATCHES = [
  {
    id: "bm-1111",
    input: "We need a robotics integrator for a Berlin warehouse — ROS, AMR fleet, 6-month timeline.",
    transactionId: "t-aaaaaaaa-1111",
    results: [
      {
        id: "bmr-1",
        companyId: "c-001",
        score: 0.91,
        explanation: "Strong ROS + warehouse robotics fit.",
        matchFeedback: { label: "ACCEPTED" },
      },
      {
        id: "bmr-2",
        companyId: "c-002",
        score: 0.62,
        explanation: "Some robotics work, mostly software.",
        matchFeedback: null,
      },
    ],
    createdAt: "2026-04-27T10:00:00Z",
    updatedAt: "2026-04-27T10:05:00Z",
  },
];

const CHAT_SESSIONS = [
  {
    id: "cs-1111",
    transactionId: "t-aaaaaaaa-1111",
    summary: "Comparing ACME and Bauhaus on robotics depth",
    allowedCompanyIds: ["c-001", "c-002"],
    createdAt: "2026-04-27T10:30:00Z",
    updatedAt: "2026-04-27T10:31:00Z",
  },
];

const CHAT_MESSAGES = {
  "cs-1111": [
    {
      id: "cm-1",
      sessionId: "cs-1111",
      role: "user",
      content: "Which of these companies has more in-house robotics expertise?",
    },
    {
      id: "cm-2",
      sessionId: "cs-1111",
      role: "assistant",
      content:
        "ACME Robotics GmbH has a stronger pure-play robotics profile based on extracted keywords (ROS, ROS2, AMR, fleet management). Bauhaus Bytes AG mentions robotics in passing but their core is enterprise software.",
    },
  ],
};

// Per-company drill-down fixtures
const COMPANY_DETAIL = {
  "c-001": {
    profile: {
      companyId: "c-001",
      text: "ACME Robotics is a Berlin-based robotics integrator focused on warehouse automation.",
      businessPurpose: "Design, build, and integrate autonomous mobile robot fleets.",
    },
    keywords: { items: [{ keyword: "ROS" }, { keyword: "AMR" }, { keyword: "fleet" }, { keyword: "warehouse" }] },
    website: { domain: "acme-robotics.de", url: "https://acme-robotics.de" },
    publications: { items: [{ year: 2024, revenue: 4_200_000, employees: 28 }, { year: 2023, revenue: 3_100_000, employees: 22 }] },
    contacts: { items: [{ fullName: "Anna Schmidt", role: "CEO", email: "anna@acme-robotics.de" }] },
    structured: {
      legalForm: "GmbH",
      shareCapital: "€50,000",
      managingDirectors: [{ name: "Anna Schmidt" }, { name: "Jonas Weber" }],
    },
  },
};

// ---- HTTP plumbing --------------------------------------------------------

function json(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "X-Request-Id, Transaction-Id",
  });
  res.end(text);
}

function notFound(res) {
  json(res, 404, { error: "not_found", message: "no fixture for that path" });
}

function pageOf(items, page = 1, pageSize = 50) {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/json")) {
    return buf.length ? JSON.parse(buf.toString("utf8")) : {};
  }
  return buf; // multipart/binary — handled separately
}

// ---- Routes ---------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204);

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;
  const log = (extra = "") => console.log(`${m} ${p}${extra}`);

  try {
    // --- Whoami ---
    if (m === "GET" && p === "/v1/whoami") {
      log();
      return json(res, 200, {
        tenantId: "dev-tenant",
        actorId: "dev-user",
        scopes: ["company:read", "company:write", "transaction:read", "evaluation:read", "evaluation:write", "import:write"],
      });
    }

    // --- Companies search/list/detail ---
    if (m === "GET" && p === "/v1/companies/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      log(` q="${q}"`);
      const items = COMPANIES.filter((c) => c.name.toLowerCase().includes(q));
      return json(res, 200, { items, total: items.length });
    }
    if (m === "GET" && p === "/v1/companies") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
      log(` page=${page}`);
      return json(res, 200, pageOf(COMPANIES, page, pageSize));
    }
    let mc = p.match(/^\/v1\/companies\/([^\/]+)$/);
    if (mc && m === "GET") {
      log();
      const c = COMPANIES.find((x) => x.id === mc[1]);
      return c ? json(res, 200, c) : json(res, 404, { error: "not_found" });
    }

    // --- Company drill-down (W8–W13) ---
    mc = p.match(/^\/v1\/companies\/([^\/]+)\/(profile|keywords|website|publications|contacts|structured-content)$/);
    if (mc && m === "GET") {
      log();
      const [, id, sub] = mc;
      const key = sub === "structured-content" ? "structured" : sub;
      const fixture = COMPANY_DETAIL[id]?.[key];
      if (!fixture) return json(res, 404, { error: "not_found", message: `no ${sub} for ${id}` });
      return json(res, 200, fixture);
    }

    // --- Company writes (W23–W25) — accept and echo ---
    mc = p.match(/^\/v1\/companies\/([^\/]+)\/(profile|website|publications)$/);
    if (mc && m === "PUT") {
      log();
      const body = await readBody(req);
      console.log("  body:", body);
      return json(res, 200, { ok: true, companyId: mc[1], received: body });
    }

    // --- Transactions list / detail / entities / errors ---
    if (m === "GET" && p === "/v1/transactions") {
      log();
      return json(res, 200, pageOf(TRANSACTIONS));
    }
    let mt = p.match(/^\/v1\/transactions\/([^\/]+)$/);
    if (mt && m === "GET") {
      log();
      const t = TRANSACTIONS.find((x) => x.id === mt[1]);
      return t ? json(res, 200, t) : json(res, 404, { error: "not_found" });
    }
    mt = p.match(/^\/v1\/transactions\/([^\/]+)\/entities$/);
    if (mt && m === "GET") {
      log();
      return json(res, 200, pageOf(ENTITIES, 1, 200));
    }
    mt = p.match(/^\/v1\/transactions\/([^\/]+)\/errors$/);
    if (mt && m === "GET") {
      log();
      return json(res, 200, { items: ERRORS });
    }
    mt = p.match(/^\/v1\/transactions\/([^\/]+)\/stream$/);
    if (mt && m === "GET") {
      log(" (SSE)");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
      });
      let i = 0;
      const tick = setInterval(() => {
        i++;
        const ev = {
          companyId: COMPANIES[i % COMPANIES.length].id,
          service: ["companyProfile", "website"][i % 2],
          state: i > 5 ? "DONE" : "IN_PROGRESS",
        };
        res.write(`event: progress\ndata: ${JSON.stringify(ev)}\n\n`);
        if (i > 10) {
          clearInterval(tick);
          res.end();
        }
      }, 1500);
      req.on("close", () => clearInterval(tick));
      return;
    }

    // --- Imports (W1) — multipart upload, return a fake transactionId ---
    if (m === "POST" && p === "/v1/imports/excel") {
      log(" (multipart)");
      // Drain the body without parsing — we just need to ack it.
      for await (const _ of req) {
        /* discard */
      }
      const transactionId = `t-${randomUUID().slice(0, 8)}-mock`;
      console.log("  → transactionId:", transactionId);
      // Add to fixture so the user can navigate to it
      TRANSACTIONS.unshift({
        id: transactionId,
        name: "Mock upload",
        startTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        companyCount: 0,
      });
      return json(res, 202, { transactionId });
    }

    // --- Evaluations: best-matches list / detail / create / feedback ---
    if (m === "GET" && p === "/v1/evaluations/best-matches") {
      const tx = url.searchParams.get("transactionId");
      log(` tx=${tx}`);
      const items = BEST_MATCHES.filter((b) => b.transactionId === tx);
      return json(res, 200, pageOf(items));
    }
    let me = p.match(/^\/v1\/evaluations\/best-matches\/([^\/]+)$/);
    if (me && m === "GET") {
      log();
      const b = BEST_MATCHES.find((x) => x.id === me[1]);
      return b ? json(res, 200, b) : json(res, 404, { error: "not_found" });
    }
    if (m === "POST" && p === "/v1/evaluations/best-matches") {
      log();
      const body = await readBody(req);
      const id = `bm-${randomUUID().slice(0, 6)}`;
      BEST_MATCHES.unshift({
        id,
        input: body.input ?? "",
        transactionId: body.transactionId ?? null,
        results: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return json(res, 202, { id });
    }
    me = p.match(/^\/v1\/evaluations\/best-matches\/([^\/]+)\/feedback$/);
    if (me && m === "POST") {
      log();
      const body = await readBody(req);
      console.log("  feedback:", body);
      // Mutate the result row's matchFeedback so the UI reflects it.
      const job = BEST_MATCHES.find((b) => b.id === me[1]);
      const row = job?.results.find((r) => r.id === body.bestMatchJobResultId);
      if (row) row.matchFeedback = { label: body.label };
      return json(res, 200, { ok: true });
    }

    // --- Evaluations: chats list / messages / send ---
    if (m === "GET" && p === "/v1/evaluations/chats") {
      const tx = url.searchParams.get("transactionId");
      log(` tx=${tx}`);
      const items = CHAT_SESSIONS.filter((s) => s.transactionId === tx);
      return json(res, 200, pageOf(items));
    }
    let mch = p.match(/^\/v1\/evaluations\/chats\/([^\/]+)\/messages$/);
    if (mch && m === "GET") {
      log();
      const items = CHAT_MESSAGES[mch[1]] ?? [];
      return json(res, 200, pageOf(items, 1, 200));
    }
    if (mch && m === "POST") {
      log();
      const body = await readBody(req);
      const sid = mch[1];
      const userMsg = {
        id: `cm-${randomUUID().slice(0, 6)}`,
        sessionId: sid,
        role: "user",
        content: body.question,
      };
      const botMsg = {
        id: `cm-${randomUUID().slice(0, 6)}`,
        sessionId: sid,
        role: "assistant",
        content: `(mock) Echoing: ${body.question}`,
      };
      CHAT_MESSAGES[sid] ??= [];
      CHAT_MESSAGES[sid].push(userMsg);
      // Simulate async — assistant lands a tick later (poll picks it up)
      setTimeout(() => CHAT_MESSAGES[sid].push(botMsg), 1500);
      return json(res, 202, { messageId: userMsg.id });
    }
    if (m === "POST" && p === "/v1/evaluations/chats") {
      log();
      const body = await readBody(req);
      const sessionId = `cs-${randomUUID().slice(0, 6)}`;
      const messageId = `cm-${randomUUID().slice(0, 6)}`;
      CHAT_SESSIONS.unshift({
        id: sessionId,
        transactionId: body.transactionId,
        summary: body.question.slice(0, 60),
        allowedCompanyIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      CHAT_MESSAGES[sessionId] = [
        { id: messageId, sessionId, role: "user", content: body.question },
      ];
      setTimeout(() => {
        CHAT_MESSAGES[sessionId].push({
          id: `cm-${randomUUID().slice(0, 6)}`,
          sessionId,
          role: "assistant",
          content: `(mock) Got your question: ${body.question}`,
        });
      }, 1500);
      return json(res, 202, { sessionId, messageId });
    }

    // --- Catch-all ---
    log(" → 404");
    return notFound(res);
  } catch (err) {
    console.error("mock-gateway error:", err);
    return json(res, 500, { error: "mock_error", message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`mock-gateway listening on http://localhost:${PORT}`);
  console.log("  pair with: AVA_DEV_AUTH_BYPASS=1 GATEWAY_URL=http://localhost:" + PORT + " pnpm dev");
});
