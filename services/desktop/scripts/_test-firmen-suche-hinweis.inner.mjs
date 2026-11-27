import assert from "node:assert/strict";
import M0 from "../src/main/agent/firmen-suche-hinweis.ts";
const M = M0.default ?? M0;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

console.log("Domains im Text");
pruefe("Klammer", () => assert.deepEqual(M.domainsAusText("kannst du mir was zur Firma nexburg (nexburg.com) sagen?"), ["nexburg.com"]));
pruefe("URL mit Pfad und www", () => assert.deepEqual(M.domainsAusText("schau auf https://www.firma-x.de/kontakt nach"), ["firma-x.de"]));
pruefe("Satzende", () => assert.deepEqual(M.domainsAusText("Die Website ist valianttms.com."), ["valianttms.com"]));
pruefe("co.uk", () => assert.deepEqual(M.domainsAusText("shop.firma.co.uk"), ["shop.firma.co.uk"]));
pruefe("keine E-Mail", () => assert.deepEqual(M.domainsAusText("schreib an max@firma.de"), []));
pruefe("keine Datei", () => assert.deepEqual(M.domainsAusText("in bericht.pdf und liste.xlsx"), []));
pruefe("keine Abkuerzung", () => assert.deepEqual(M.domainsAusText("z.B. die Müller GmbH u.a."), []));
pruefe("zwei Domains", () => assert.deepEqual(M.domainsAusText("a.de und b.com"), ["a.de", "b.com"]));
pruefe("leer", () => assert.deepEqual(M.domainsAusText(undefined), []));

console.log("Domain-Name und Kernname");
pruefe("nexburg.com", () => assert.equal(M.domainName("nexburg.com"), "nexburg"));
pruefe("shop.firma.co.uk", () => assert.equal(M.domainName("shop.firma.co.uk"), "firma"));
pruefe("NEXBURG LTD.", () => assert.equal(M.kernName("NEXBURG LTD."), "nexburg"));
pruefe("Nexburg GmbH", () => assert.equal(M.kernName("Nexburg GmbH"), "nexburg"));
pruefe("Müller GmbH & Co. KG", () => assert.equal(M.kernName("Müller GmbH & Co. KG"), "müller"));

console.log("Website fuer die Suche");
pruefe("aus der Nachricht", () => assert.deepEqual(M.websiteFuerSuche({ q: "nexburg" }, "kannst du mir was zur Firma nexburg (nexburg.com) sagen?"), { q: "nexburg", website: "nexburg.com", quelle: "nachricht" }));
pruefe("Argument geht vor", () => assert.deepEqual(M.websiteFuerSuche({ q: "nexburg", website: "nexburg.de" }, "nexburg.com"), { q: "nexburg", website: "nexburg.de", quelle: "argument" }));
pruefe("Domain als Suchbegriff", () => assert.deepEqual(M.websiteFuerSuche({ q: "nexburg.com" }), { q: "nexburg", website: "nexburg.com", quelle: "suchbegriff" }));
pruefe("zwei Domains in der Nachricht: keine", () => assert.deepEqual(M.websiteFuerSuche({ q: "a" }, "a.de und b.com"), { q: "a" }));
pruefe("ohne Domain", () => assert.deepEqual(M.websiteFuerSuche({ q: "Müller" }, "was macht Müller?"), { q: "Müller" }));

const uk = { companyId: "UK_10819731", name: "NEXBURG LTD.", location: "London", country: "UK" };
const ch = { companyId: "CH_CHE103350767", name: "Newburg AG", location: "Lugano", country: "CH" };
const de = { companyId: "SCHWERIN_HRB_3515", name: "Wohnungsbaugesellschaft mbH Neuburg", location: "Neuburg" };
const gmbh = { companyId: "AACHEN_HRB_18923", name: "Nexburg GmbH", location: "Aachen", websiteTreffer: true, website: "http://www.nexburg.com/" };

console.log("Hinweise");
pruefe("websiteTreffer: gemeinte Firma", () => {
  const h = M.suchHinweis({ q: "nexburg", website: "nexburg.com", items: [gmbh, uk, ch, de] });
  assert.match(h, /gehört zu Nexburg GmbH \(Aachen\), companyId AACHEN_HRB_18923/);
  assert.match(h, /nicht nachfragen/);
});
pruefe("mehrere websiteTreffer: nur zwischen diesen waehlen", () => {
  const h = M.suchHinweis({ q: "nexburg", website: "nexburg.com", items: [gmbh, { ...gmbh, companyId: "AACHEN_HRB_28936", name: "Nexburg Management Services GmbH" }, uk] });
  assert.match(h, /Mehrere Firmen tragen die Website/);
});
pruefe("nur auslaendischer Namenstreffer (Fall vom 26.11.): Live-Suche", () => {
  const h = M.suchHinweis({ q: "nexburg", website: "nexburg.com", items: [uk, ch, de] });
  assert.match(h, /Keine Firma im Bestand trägt die Website nexburg\.com/);
  assert.match(h, /nur im Ausland \(Vereinigtes Königreich\)/);
  assert.match(h, /register_live_suche\(name: "nexburg"\)/);
});
pruefe("ohne Website, nur Ausland: Live-Suche", () => {
  const h = M.suchHinweis({ q: "Nexburg GmbH", items: [uk, ch, de] });
  assert.match(h, /register_live_suche\(name: "nexburg"\)/);
});
pruefe("deutscher Namenstreffer ohne Website: kein Hinweis", () => assert.equal(M.suchHinweis({ q: "Neuburg", items: [{ companyId: "X_HRB_1", name: "Neuburg GmbH", location: "Ulm" }, uk] }), null));
pruefe("Land per Filter bestimmt: kein Hinweis", () => assert.equal(M.suchHinweis({ q: "nexburg", country: "UK", items: [uk] }), null));
pruefe("Website ohne Treffer, deutscher Namenstreffer: Website-Pruefung abwarten", () => {
  const h = M.suchHinweis({ q: "neuburg", website: "neuburg-design.de", items: [{ companyId: "PASSAU_HRB_10930", name: "Neuburg Design GmbH", location: "Passau" }, { companyId: "X_HRB_1", name: "Neuburg GmbH", location: "Ulm" }] });
  assert.match(h, /Website-Prüfung/);
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
