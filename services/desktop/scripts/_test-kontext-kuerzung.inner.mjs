import assert from "node:assert/strict";
import K from "../src/main/agent/kontext-kuerzung.ts";
const { ergebnisBegrenzen, verlaufFuerModell } = K;
// K1
const gross = JSON.stringify({ a: "x".repeat(50_000) });
const b = ergebnisBegrenzen(gross);
assert.equal(b.gekuerzt, true); assert.ok(b.content.length < 41_000); assert.match(b.content, /originalZeichen/);
assert.equal(ergebnisBegrenzen("{}").gekuerzt, false);
// K3
const u = (id, t) => ({ id, role: "user", content: t, createdAt: 0 });
const a = (id, calls) => ({ id, role: "assistant", content: "", toolCalls: calls, createdAt: 0 });
const t = (id, callId, len) => ({ id, role: "tool", content: JSON.stringify({ d: "y".repeat(len) }), toolCallId: callId, createdAt: 0 });
const msgs = [
  u("u1", "Firma?"), a("a1", [{ id: "c1", name: "company_contacts", arguments: {} }]), t("t1", "c1", 5000),
  u("u2", "Und?"),   a("a2", [{ id: "c2", name: "datei_lesen", arguments: {} }]), t("t2", "c2", 5000),
  u("u3", "Weiter"), a("a3", [{ id: "c3", name: "company_profile", arguments: {} }]), t("t3", "c3", 5000), t("t4", "c3", 50),
  u("u4", "Jetzt"),
];
const out = verlaufFuerModell(msgs);
assert.match(out[2].content, /Ergebnis von company_contacts/, "alter 3 → ersetzt");
assert.equal(out[5].content, msgs[5].content, "datei_lesen alter 2 < 4 → bleibt");
assert.equal(out[8].content, msgs[8].content, "alter 1 → bleibt");
assert.equal(out[9].content, msgs[9].content, "kleine Ergebnisse bleiben");
const kurz = msgs.slice(0, 4); assert.equal(verlaufFuerModell(kurz), kurz, "nichts zu ersetzen → gleiche Referenz");
console.log("Kontext-Kuerzung-Tests ok");
