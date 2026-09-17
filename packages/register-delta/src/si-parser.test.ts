import { test } from "node:test";
import assert from "node:assert/strict";
import { istSiXml, namenPassen, parseStrukturierterInhalt } from "./si-parser";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tns:nachricht.reg.0400003 xmlns:tns="http://www.xjustiz.de">
  <tns:fachdatenRegister>
    <tns:basisdatenRegister>
      <tns:rechtstraeger>
        <tns:bezeichnung.aktuell>QUIKK Software GmbH</tns:bezeichnung.aktuell>
        <tns:rechtsform listURI="urn:xoev-de:xjustiz:codeliste:gds.rechtsform"><!--Gesellschaft mit beschränkter Haftung (GmbH)--><code>221110</code></tns:rechtsform>
        <tns:sitz><tns:ort>Bad Oeynhausen</tns:ort></tns:sitz>
      </tns:rechtstraeger>
      <tns:anschrift>
        <tns:strasse>Hahler Str.</tns:strasse><tns:hausnummer>1 A</tns:hausnummer>
        <tns:postleitzahl>32545</tns:postleitzahl><tns:ort>Bad Oeynhausen</tns:ort>
      </tns:anschrift>
      <tns:gegenstand>Entwicklung von Software &amp; Beratung</tns:gegenstand>
      <tns:kapital><tns:zahl>25000.00</tns:zahl><tns:waehrung>EUR</tns:waehrung></tns:kapital>
      <tns:ersteSatzung><tns:satzungsdatum>2020-11-25</tns:satzungsdatum></tns:ersteSatzung>
      <tns:letzteEintragung>2024-03-01</tns:letzteEintragung>
      <tns:letzteAenderung><tns:aenderungsdatum>2024-03-01</tns:aenderungsdatum></tns:letzteAenderung>
    </tns:basisdatenRegister>
    <tns:beteiligung>
      <tns:beteiligter><tns:natuerlichePerson>
        <tns:vorname>Joyce Marvin</tns:vorname><tns:nachname>Rafflenbeul</tns:nachname>
        <tns:geburtsdatum>1990-01-02</tns:geburtsdatum><tns:anschrift><tns:ort>Herford</tns:ort></tns:anschrift>
      </tns:natuerlichePerson></tns:beteiligter>
    </tns:beteiligung>
    <tns:beteiligung>
      <tns:beteiligter><tns:organisation><tns:bezeichnung.aktuell>Holding GmbH</tns:bezeichnung.aktuell></tns:organisation></tns:beteiligter>
    </tns:beteiligung>
  </tns:fachdatenRegister>
</tns:nachricht.reg.0400003>`;

test("si-parser: liest Kopf, Adresse, Kapital, Gruendungsjahr und Geschaeftsfuehrer", () => {
  const si = parseStrukturierterInhalt(XML);
  assert.ok(si);
  assert.equal(si.name, "QUIKK Software GmbH");
  assert.equal(si.legalForm, "Gesellschaft mit beschränkter Haftung (GmbH)");
  assert.equal(si.street, "Hahler Str.");
  assert.equal(si.houseNumber, "1 A");
  assert.equal(si.zipCode, "32545");
  assert.equal(si.city, "Bad Oeynhausen");
  assert.equal(si.corporatePurpose, "Entwicklung von Software & Beratung");
  assert.equal(si.shareCapital, 25000);
  assert.equal(si.foundingYear, 2020);
  assert.equal(si.lastRegisterEntry, "2024-03-01");
  assert.equal(si.lastRegisterModification, "2024-03-01");
  assert.deepEqual(si.managingDirectors, [{ firstName: "Joyce Marvin", lastName: "Rafflenbeul", birthDay: "1990-01-02", city: "Herford" }]);
});

test("si-parser: einzelne Beteiligung (kein Array) und unbekannter Rechtsform-Code", () => {
  const xml = XML.replace(/<tns:beteiligung>\s*<tns:beteiligter><tns:organisation>[\s\S]*?<\/tns:beteiligung>/, "")
    .replace("<!--Gesellschaft mit beschränkter Haftung (GmbH)--><code>221110</code>", "<code>999999</code>")
    .replace(/<tns:ersteSatzung>[\s\S]*?<\/tns:ersteSatzung>/, "")
    .replace(/<tns:kapital>[\s\S]*?<\/tns:kapital>/, "");
  const si = parseStrukturierterInhalt(xml);
  assert.ok(si);
  assert.equal(si.managingDirectors.length, 1);
  assert.equal(si.legalForm, "999999");
  assert.equal(si.foundingYear, 2024);
  assert.equal(si.shareCapital, null);
});

test("si-parser: Gruendungsdatum (HRA) geht vor Satzungsdatum", () => {
  const xml = XML.replace("<tns:gegenstand>", "<tns:gruendungsmetadaten><tns:gruendungsdatum>2002-03-22</tns:gruendungsdatum></tns:gruendungsmetadaten><tns:gegenstand>");
  assert.equal(parseStrukturierterInhalt(xml)?.foundingYear, 2002);
});

test("si-parser: kein XML, HTML-Fehlerseite oder ohne Firmenname → null", () => {
  assert.equal(istSiXml("<html><body>Fehler</body></html>"), false);
  assert.equal(parseStrukturierterInhalt("<html><body>Fehler</body></html>"), null);
  assert.equal(parseStrukturierterInhalt("PK nicht xml"), null);
  assert.equal(parseStrukturierterInhalt(XML.replace(/<tns:bezeichnung.aktuell>QUIKK Software GmbH<\/tns:bezeichnung.aktuell>/, "")), null);
});

test("si-parser: Rechtstraeger nur als Beteiligung — nur mit passendem erwarteten Namen", () => {
  // Auszug ohne Basisdaten-Namen: die Firma steht als beteiligte Organisation,
  // daneben eine Gesellschafterin. Ohne erwarteten Namen darf nichts gelesen werden.
  const xml = `<?xml version="1.0"?><tns:n xmlns:tns="http://www.xjustiz.de">
    <tns:basisdatenRegister><tns:gegenstand>Handel</tns:gegenstand>
      <tns:anschrift><tns:strasse>Weg</tns:strasse><tns:hausnummer>2</tns:hausnummer><tns:postleitzahl>28195</tns:postleitzahl><tns:ort>Bremen</tns:ort></tns:anschrift>
    </tns:basisdatenRegister>
    <tns:beteiligung><tns:natuerlichePerson><tns:vorname>Eva</tns:vorname><tns:nachname>Beispiel</tns:nachname></tns:natuerlichePerson></tns:beteiligung>
    <tns:beteiligung><tns:organisation><tns:bezeichnung.aktuell>Nordlicht Handels GmbH</tns:bezeichnung.aktuell></tns:organisation></tns:beteiligung>
  </tns:n>`;
  assert.equal(parseStrukturierterInhalt(xml), null);
  const si = parseStrukturierterInhalt(xml, "Nordlicht Handels GmbH");
  assert.ok(si);
  assert.equal(si.name, "Nordlicht Handels GmbH");
  assert.equal(si.city, "Bremen");
  assert.equal(si.managingDirectors[0]?.lastName, "Beispiel");
  // Fremder erwarteter Name: der Auszug gehoert nicht zu dieser Firma.
  assert.equal(parseStrukturierterInhalt(xml, "Suedwind Logistik GmbH"), null);
});

test("si-parser: Namensabgleich ist tolerant bei Rechtsform und Zusaetzen, aber nicht beliebig", () => {
  assert.equal(namenPassen("QUIKK Software GmbH", "QUIKK Software GmbH"), true);
  assert.equal(namenPassen("QUIKK Software GmbH", "QUIKK Software UG (haftungsbeschränkt)"), true);
  // Kaufmaennisches Und und ausgeschriebenes Und meinen dieselbe Firma.
  assert.equal(namenPassen("Meyer & Sohn KG", "Meyer und Sohn KG"), true);
  // Ein einzelnes gemeinsames Wort reicht nicht.
  assert.equal(namenPassen("Nordlicht Handels GmbH", "Nordlicht Immobilien Verwaltung GmbH"), false);
  assert.equal(namenPassen("Nordlicht Handels GmbH", "Südwind Logistik GmbH"), false);
  assert.equal(namenPassen("", "Irgendwas GmbH"), false);
});
