import assert from "node:assert/strict";
import M0 from "../src/renderer/src/components/chat/gen-ui/firmenprofil-daten.ts";
import T0 from "../src/shared/gen-ui/text.ts";
import B0 from "../src/shared/gen-ui/bausteine.ts";
const M = M0.default ?? M0;
const T = T0.default ?? T0;
const B = B0.default ?? B0;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

const F = "AACHEN_HRB_18923";
const p = (id, feld, wert, extra = {}) => ({ entityType: "PERSON", entityId: id, field: feld, value: wert, status: "ACTIVE", ...extra });
const fakten = [
  { entityType: "COMPANY", field: "email", value: "info@nexburg.com", status: "ACTIVE" },
  { entityType: "COMPANY", field: "phone", value: "+49 241 1", status: "INACTIVE" },
  { entityType: "COMPANY", field: "linkedinUrl", value: "https://www.linkedin.com/company/nexburg", status: "ACTIVE" },
  p("a", "fullName", "Oliver Simon"), p("a", "jobTitle", "Business Development Manager", { companyId: F }), p("a", "linkedinUrl", "https://www.linkedin.com/in/oliver-simon-5532168"),
  p("b", "fullName", "Dr. Frank J. Nellissen"), p("b", "jobTitle", "Geschäftsführer", { companyId: F }), p("b", "linkedinUrl", "linkedin.com/in/dr-frank"),
  p("c", "fullName", "Fernando Andrade Gomes"), p("c", "jobTitle", "Geschäftsführer", { companyId: F }),
  p("d", "fullName", "Wolfgang Schmitt"), p("d", "jobTitle", "Product Owner", { companyId: F }), p("d", "xingUrl", "https://www.xing.com/profile/w"),
  // Rolle bei einer anderen Firma zaehlt hier nicht (Befund 2026-10-05).
  p("e", "fullName", "Joyce R."), p("e", "jobTitle", "Founder & Managing Director", { companyId: "ANDERE_HRB_1" }),
  // Hat die Firma verlassen: Titel nur noch inaktiv.
  p("f", "fullName", "Ehemalige Person"), p("f", "jobTitle", "Vertriebsleiter", { companyId: F, status: "INACTIVE" }),
  // Ohne Namen nicht verwendbar.
  p("g", "jobTitle", "Sales Manager", { companyId: F }),
];

console.log("Personen aus Fakten");
const alle = M.personenAusFakten(fakten, F);
pruefe("Reihenfolge: Geschäftsleitung (mit LinkedIn zuerst), Vertrieb, Übrige", () => assert.deepEqual(alle.map((x) => x.name), ["Dr. Frank J. Nellissen", "Fernando Andrade Gomes", "Oliver Simon", "Joyce R.", "Wolfgang Schmitt"]));
pruefe("Rolle anderer Firma wird nicht übernommen", () => assert.equal(alle.find((x) => x.personId === "e").titel, null));
pruefe("Ehemalige und Namenlose fallen weg", () => assert.ok(!alle.some((x) => x.personId === "f" || x.personId === "g")));
pruefe("LinkedIn ohne Protokoll wird https", () => assert.equal(alle.find((x) => x.personId === "b").linkedin, "https://linkedin.com/in/dr-frank"));
pruefe("XING bleibt", () => assert.equal(alle.find((x) => x.personId === "d").xing, "https://www.xing.com/profile/w"));
pruefe("javascript:-Adresse wird verworfen", () => assert.equal(M.personenAusFakten([p("x", "fullName", "X"), p("x", "linkedinUrl", "javascript:alert(1)")], F)[0].linkedin, null));
pruefe("ohne Fakten leer", () => assert.deepEqual(M.personenAusFakten(undefined, F), []));

console.log("Auswahl");
pruefe("vom Modell genannte personIds in dessen Reihenfolge", () => assert.deepEqual(M.personenAuswahl(alle, ["a", "b"]).map((x) => x.personId), ["a", "b"]));
pruefe("unbekannte und doppelte ids fallen weg", () => assert.deepEqual(M.personenAuswahl(alle, ["zz", "a", "a", null]).map((x) => x.personId), ["a"]));
pruefe("nur unbekannte ids: ranghöchste", () => assert.deepEqual(M.personenAuswahl(alle, ["zz"], 2).map((x) => x.personId), ["b", "c"]));
pruefe("ohne Angabe höchstens vier", () => assert.equal(M.personenAuswahl(alle, null).length, 4));

console.log("Firmen-Links und Kleinkram");
pruefe("LinkedIn zuerst, ohne Doppelte, Firmenseite aus Kontaktdaten", () => {
  const l = M.firmenLinks([{ platform: "youtube", url: "https://youtube.com/@x" }, { platform: "xing", url: "https://www.xing.com/pages/x" }], fakten);
  assert.deepEqual(l.map((x) => x.art), ["linkedin", "xing", "youtube"]);
  assert.equal(l[0].label, "LinkedIn");
});
pruefe("Website-Angabe geht vor Kontaktdaten", () => assert.equal(M.firmenLinks([{ platform: "linkedin", url: "https://www.linkedin.com/company/Nexburg" }], fakten)[0].url, "https://www.linkedin.com/company/Nexburg"));
pruefe("Personenprofil ist keine Firmenseite", () => assert.deepEqual(M.firmenLinks([], [{ entityType: "COMPANY", field: "linkedinUrl", value: "https://www.linkedin.com/in/jemand", status: "ACTIVE" }]), []));
pruefe("aktiver Firmen-Fakt", () => { assert.equal(M.firmenFakt(fakten, "email"), "info@nexburg.com"); assert.equal(M.firmenFakt(fakten, "phone"), null); });
pruefe("allgemeine Adresse: info@ vor Länder- und Abteilungsadressen", () => {
  const m = (v, status = "ACTIVE") => ({ entityType: "COMPANY", field: "email", value: v, status });
  assert.equal(M.firmenMail([m("uk-support@nexburg.com"), m("sales@nexburg.com"), m("info@nexburg.com")]), "info@nexburg.com");
  assert.equal(M.firmenMail([m("uk-support@nexburg.com"), m("sales@nexburg.com")]), "sales@nexburg.com");
  assert.equal(M.firmenMail([m("b@x.de"), m("a@x.de")]), "b@x.de");
  assert.equal(M.firmenMail([m("info@alt.de", "INACTIVE"), m("kein-at")]), null);
});
pruefe("Website-Anzeige", () => assert.equal(M.websiteAnzeige("http://www.nexburg.com/"), "nexburg.com"));
pruefe("Kürzel", () => { assert.equal(M.kuerzel("Nexburg GmbH"), "N"); assert.equal(M.kuerzel("Müller & Söhne Maschinenbau GmbH & Co. KG"), "MS"); assert.equal(M.kuerzel(""), "?"); });

console.log("Katalog und Textfassung");
pruefe("Baustein beschrieben, nimmt Kinder", () => { assert.ok(B.BAUSTEINE.Firmenprofil.wofuer.includes("NICHT zusätzlich")); assert.equal(B.BAUSTEINE.Firmenprofil.kinder, true); });
pruefe("Textfassung nennt Firma und Einordnung", () => {
  const spec = ['{"op":"add","path":"/root","value":"p"}', '{"op":"add","path":"/elements/p","value":{"type":"Firmenprofil","props":{"companyId":"AACHEN_HRB_18923"},"children":["t"]}}', '{"op":"add","path":"/elements/t","value":{"type":"Text","props":{"inhalt":"Software für Telekommunikationsanbieter."},"children":[]}}'].join("\n");
  const text = T.specAlsText(spec);
  assert.match(text, /Firmenprofil AACHEN_HRB_18923/);
  assert.match(text, /Software für Telekommunikationsanbieter/);
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
