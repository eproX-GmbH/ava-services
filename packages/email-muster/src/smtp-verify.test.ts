import { test } from "node:test";
import assert from "node:assert/strict";
import { klassifiziereRcpt } from "./smtp-verify";

test("RCPT-Antworten: Adresse vs. Richtlinie", () => {
  assert.equal(klassifiziereRcpt(250, "250 2.1.5 Recipient OK"), "existiert");
  assert.equal(klassifiziereRcpt(550, "550 5.1.1 User unknown"), "existiert_nicht");
  assert.equal(klassifiziereRcpt(550, "550 5.4.1 Recipient address rejected: Access denied."), "existiert_nicht", "Microsoft: unbekannter Nutzer");
  assert.equal(klassifiziereRcpt(550, "550 5.7.1 Service unavailable, Client host [1.2.3.4] blocked using Spamhaus."), "gesperrt");
  assert.equal(klassifiziereRcpt(550, "550 5.7.606 Access denied, banned sending IP [1.2.3.4]"), "gesperrt");
  assert.equal(klassifiziereRcpt(554, "554 Your access to this mail system has been rejected due to the sending MTA's poor reputation."), "gesperrt");
  assert.equal(klassifiziereRcpt(451, "451 4.7.1 Greylisted, try again later"), "unbekannt");
  assert.equal(klassifiziereRcpt(550, "550 No such user here"), "existiert_nicht");
  // IONOS (Befund eproX 2026-10-21): Sperre fuer Privat-IPs ohne 5.7.x, nur ein Link.
  assert.equal(klassifiziereRcpt(554, "554 For explanation visit https://postmaster.1und1.de/en/case?c=r0602&i=ip&v=1.2.3.4"), "gesperrt");
  assert.equal(klassifiziereRcpt(550, "550 5.1.1 <x@y.de>: Recipient address rejected: User unknown in virtual mailbox table"), "existiert_nicht");
  assert.equal(klassifiziereRcpt(550, "550 Requested action not taken: mailbox unavailable"), "existiert_nicht");
  // 55x ohne jeden Empfaengerbezug ist kein Urteil ueber die Adresse.
  assert.equal(klassifiziereRcpt(550, "550 Service unavailable"), "unbekannt");
  assert.equal(klassifiziereRcpt(554, "554 Transaction failed"), "gesperrt");
});
