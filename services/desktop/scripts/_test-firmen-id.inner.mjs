import assert from "node:assert/strict";
import * as yup from "yup";
import M0 from "../src/main/agent/firmen-id.ts";
const M = M0.default ?? M0;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

console.log("Firmen-IDs erkennen");
for (const id of ["OSNABRUECK_HRB_120444", "KLEVE_HRA_3232", "BREMEN_HRB_2514BHV", "HAMBURG_HRB_1_FALTONA", "MUENCHEN_GNR_12", "BADOEYNHAUSEN_HRB_14952", "AT_FN56247T", "CH_CHE105805080", "UK_11171399", "NO_923609016", "FI_0112038-9", "WEB_BEISPIEL.DE"])
  pruefe(`ja: ${id}`, () => assert.equal(M.istFirmenId(id), true));
for (const x of ["Berentzen-Gruppe AG", "HRB 120444", "Osnabrück HRB 120444", "osnabrueck_hrb_120444", "AT_", "UK_1", "", null, 42])
  pruefe(`nein: ${JSON.stringify(x)}`, () => assert.equal(M.istFirmenId(x), false));

console.log("Zeilen nach companyIds heben");
pruefe("IDs als Namen ohne Ort", () => {
  const r = M.firmenIdsAusZeilen({ companies: [{ name: "OSNABRUECK_HRB_120444" }, { name: "FREIBURG_HRB_611072", city: "" }], dryRun: true });
  assert.deepEqual(r, { companyIds: ["OSNABRUECK_HRB_120444", "FREIBURG_HRB_611072"], dryRun: true });
});
pruefe("IDs als blanke Texte", () => assert.deepEqual(M.firmenIdsAusZeilen({ companies: ["UK_11171399", " AT_FN56247T "] }), { companyIds: ["UK_11171399", "AT_FN56247T"] }));
pruefe("gemischt: echte Zeilen bleiben, vorhandene IDs bleiben, keine Doppelten", () => {
  const r = M.firmenIdsAusZeilen({ companyIds: ["KLEVE_HRA_3232"], companies: [{ name: "Foo GmbH", city: "Berlin" }, { name: "KLEVE_HRA_3232" }] });
  assert.deepEqual(r, { companyIds: ["KLEVE_HRA_3232"], companies: [{ name: "Foo GmbH", city: "Berlin" }] });
});
pruefe("CRM-Zeile mit ID-artigem Namen bleibt Zeile", () => {
  const z = { name: "OSNABRUECK_HRB_120444", city: "Haselünne", crm: { type: "hubspot", externalId: "1" } };
  assert.deepEqual(M.firmenIdsAusZeilen({ companies: [z] }), { companies: [z] });
});
pruefe("ohne companies unveraendert", () => { const v = { companyIds: ["X_HRB_1"] }; assert.equal(M.firmenIdsAusZeilen(v), v); });

console.log("im yup-Schema (wie import_companies)");
const schema = yup.object({
  companyIds: yup.array().of(yup.string().trim().required().min(1).max(64)).max(500).optional(),
  companies: yup.array().of(yup.object({ name: yup.string().required().min(1), city: yup.string().required().min(1) }).noUnknown(true)).optional(),
  dryRun: yup.boolean().optional(),
}).transform((v) => M.firmenIdsAusZeilen(v)).noUnknown(true)
  .test("firmen", "companyIds oder companies angeben", (v) => (v.companyIds?.length ?? 0) + (v.companies?.length ?? 0) > 0);
pruefe("Zeilen ohne Ort werden gueltig statt Fehler", () => {
  const r = schema.validateSync({ companies: [{ name: "OSNABRUECK_HRB_120444" }, { name: "STUTTGART_HRB_480839" }] }, { abortEarly: false, stripUnknown: true });
  assert.deepEqual(r.companyIds, ["OSNABRUECK_HRB_120444", "STUTTGART_HRB_480839"]);
  assert.equal(r.companies, undefined);
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
