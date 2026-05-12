// C4 — Fixtures gegen parseAndValidate (6 valid + 6 invalid).
//
// Wird über `pnpm test:chart` via tsx ausgeführt — analog zu den
// skills-Tests. Lädt die TS-Quelle direkt, kein Build-Step.

import { parseAndValidate } from "../src/renderer/src/lib/chart-spec.ts";

const failures = [];
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

function expectOk(label, json) {
  const r = parseAndValidate(JSON.stringify(json));
  assert(r.ok === true, `valid: ${label}`);
  if (!r.ok) console.error("    reason:", r.reason);
}

function expectFail(label, raw, mustInclude) {
  const r =
    typeof raw === "string"
      ? parseAndValidate(raw)
      : parseAndValidate(JSON.stringify(raw));
  assert(r.ok === false, `invalid: ${label}`);
  if (r.ok === false && mustInclude) {
    assert(
      r.reason.toLowerCase().includes(mustInclude.toLowerCase()),
      `invalid: ${label} — Grund enthält „${mustInclude}"`,
    );
  }
}

// ─── 6 valid fixtures ─────────────────────────────────────────────────

console.log("[test:chart] Gültige Specs");

expectOk("bar / 4 Punkte / num", {
  kind: "bar",
  title: "Mitarbeiter",
  format: "num",
  series: [
    {
      name: "Mitarbeiter",
      data: [
        { x: "2020", y: 42 },
        { x: "2021", y: 48 },
        { x: "2022", y: 61 },
        { x: "2023", y: 74 },
      ],
    },
  ],
});

expectOk("line / zwei Serien / eur", {
  kind: "line",
  title: "Umsatz",
  format: "eur",
  series: [
    {
      name: "A",
      data: [
        { x: "2021", y: 1240000 },
        { x: "2022", y: 1410000 },
        { x: "2023", y: 1605000 },
      ],
    },
    {
      name: "B",
      data: [
        { x: "2021", y: 890000 },
        { x: "2022", y: 1020000 },
        { x: "2023", y: 1180000 },
      ],
    },
  ],
});

expectOk("hbar / Top-5 / num", {
  kind: "hbar",
  format: "num",
  series: [
    {
      name: "Anzahl",
      data: [
        { x: "Müller GmbH", y: 12 },
        { x: "Schmidt AG", y: 9 },
        { x: "Weber KG", y: 7 },
        { x: "Fischer GmbH", y: 5 },
        { x: "Becker AG", y: 4 },
      ],
    },
  ],
});

expectOk("area / kumulativ", {
  kind: "area",
  format: "num",
  series: [
    {
      name: "Veröffentlichungen kumuliert",
      data: [
        { x: "2020", y: 3 },
        { x: "2021", y: 8 },
        { x: "2022", y: 15 },
        { x: "2023", y: 27 },
      ],
    },
  ],
});

expectOk("pie / 4 Segmente", {
  kind: "pie",
  format: "pct",
  series: [
    {
      name: "Anteile",
      data: [
        { x: "Süd", y: 0.4 },
        { x: "Nord", y: 0.3 },
        { x: "Ost", y: 0.2 },
        { x: "West", y: 0.1 },
      ],
    },
  ],
});

expectOk("scatter / numerische x", {
  kind: "scatter",
  format: "num",
  series: [
    {
      name: "Korrelation",
      data: [
        { x: 10, y: 100 },
        { x: 20, y: 180 },
        { x: 30, y: 260 },
        { x: 40, y: 350 },
      ],
    },
  ],
});

// ─── 6 invalid fixtures ───────────────────────────────────────────────

console.log("[test:chart] Ungültige Specs");

expectFail(
  "unbekannter kind",
  { kind: "donut", series: [{ name: "x", data: [{ x: "a", y: 1 }, { x: "b", y: 2 }] }] },
  "kind",
);

expectFail(
  "nur 1 Datenpunkt",
  { kind: "bar", series: [{ name: "x", data: [{ x: "a", y: 1 }] }] },
  "data",
);

expectFail(
  "NaN als y",
  {
    kind: "bar",
    series: [
      {
        name: "x",
        data: [
          { x: "a", y: Number.NaN },
          { x: "b", y: 2 },
        ],
      },
    ],
  },
  "y",
);

expectFail(
  "pie mit zwei Serien",
  {
    kind: "pie",
    series: [
      { name: "A", data: [{ x: "a", y: 1 }, { x: "b", y: 2 }] },
      { name: "B", data: [{ x: "a", y: 1 }, { x: "b", y: 2 }] },
    ],
  },
  "pie",
);

expectFail(
  "unbekanntes Feld (noUnknown)",
  {
    kind: "bar",
    extra: "boom",
    series: [{ name: "x", data: [{ x: "a", y: 1 }, { x: "b", y: 2 }] }],
  },
  "extra",
);

// scatter mit string-x ist hart verboten
expectFail(
  "scatter mit string-x",
  {
    kind: "scatter",
    series: [
      {
        name: "x",
        data: [
          { x: "a", y: 1 },
          { x: "b", y: 2 },
        ],
      },
    ],
  },
  "scatter",
);

// ─── Bonus: 8 KB Cap ──────────────────────────────────────────────────

console.log("[test:chart] 8 KB Cap");
const huge = '{"kind":"bar","series":[{"name":"x","data":[' +
  Array.from({ length: 500 }, (_, i) => `{"x":"${i}","y":${i}}`).join(",") +
  "]}]}";
const cap = parseAndValidate(huge);
assert(cap.ok === false, "8 KB Cap blockt zu großes JSON");

if (failures.length > 0) {
  console.error(`\n[test:chart] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:chart] Alle Asserts grün.`);
}
