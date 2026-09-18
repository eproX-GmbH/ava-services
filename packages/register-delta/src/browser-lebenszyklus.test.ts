import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { AVA_BROWSER_SCHALTER, neuesProfilVerzeichnis, offeneBrowser, profilArgumente, schliesseAlleBrowser, ueberwache } from "./browser-lebenszyklus";

function attrappe(verhalten: "ok" | "wirft" | "haengt" = "ok") {
  const zustand = { beendet: false };
  return {
    zustand,
    driver: {
      async quit() {
        if (verhalten === "wirft") throw new Error("chromedriver antwortet nicht");
        if (verhalten === "haengt") await new Promise(() => {});
        zustand.beendet = true;
      },
    },
  };
}

test("profilArgumente: eigener Schalter, Besitzerkennung und eigenes Profil", () => {
  const profil = neuesProfilVerzeichnis();
  const args = profilArgumente(profil);
  assert.equal(args[0], AVA_BROWSER_SCHALTER);
  assert.ok(args.some((a) => a === `--ava-owner=${process.pid}`));
  assert.ok(args.some((a) => a === `--user-data-dir=${profil}`));
  // Das Profil liegt ausserhalb des Profils der Person und existiert wirklich.
  assert.ok(existsSync(profil));
  assert.ok(profil.includes("ava-chrome-"));
});

test("ueberwache: quit schliesst den Browser, entfernt das Profil und traegt ihn aus", async () => {
  const profil = neuesProfilVerzeichnis();
  const a = attrappe();
  const d = ueberwache(a.driver, profil);
  assert.equal(offeneBrowser(), 1);
  await d.quit();
  assert.equal(a.zustand.beendet, true);
  assert.equal(offeneBrowser(), 0, "nach quit ist der Browser ausgetragen");
  assert.equal(existsSync(profil), false, "Profilverzeichnis ist entfernt");
});

test("ueberwache: ein fehlschlagendes quit raeumt trotzdem auf und wirft nicht", async () => {
  const profil = neuesProfilVerzeichnis();
  const d = ueberwache(attrappe("wirft").driver, profil);
  await d.quit();
  assert.equal(offeneBrowser(), 0);
  assert.equal(existsSync(profil), false);
});

test("schliesseAlleBrowser: schliesst alle offenen und meldet ihre Anzahl", async () => {
  const p1 = neuesProfilVerzeichnis();
  const p2 = neuesProfilVerzeichnis();
  const a1 = attrappe();
  const a2 = attrappe();
  ueberwache(a1.driver, p1);
  ueberwache(a2.driver, p2);
  assert.equal(offeneBrowser(), 2);
  assert.equal(await schliesseAlleBrowser(), 2);
  assert.equal(a1.zustand.beendet, true);
  assert.equal(a2.zustand.beendet, true);
  assert.equal(offeneBrowser(), 0);
  assert.equal(existsSync(p1), false);
  assert.equal(existsSync(p2), false);
});

test("schliesseAlleBrowser: ein haengender Browser blockiert das Beenden nicht", async () => {
  const profil = neuesProfilVerzeichnis();
  ueberwache(attrappe("haengt").driver, profil);
  const t0 = Date.now();
  await schliesseAlleBrowser();
  // Die Frist im Modul liegt bei 8 s je Browser; ohne sie waere hier Schluss.
  assert.ok(Date.now() - t0 < 11_000, "das Schliessen gibt nach der Frist auf");
  assert.equal(offeneBrowser(), 0);
});

test("ohne offene Browser ist nichts zu tun", async () => {
  assert.equal(await schliesseAlleBrowser(), 0);
});
