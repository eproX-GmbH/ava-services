---
name: erstansprache
description: Write a first outreach e-mail or LinkedIn message to a company or person with AVA's data, in one pass. Use whenever the user asks for an Erstansprache, Akquise-Mail, Kaltakquise, LinkedIn message or a follow-up to a company.
---

# First outreach (Erstansprache) in one pass

Goal: the FIRST draft already uses everything AVA knows. Do not ask the user for data that AVA has, and do not ask whether to use more data.

## 1. Collect (no questions to the user)

1. `ava_kontext` if not loaded yet: it contains the user's own offering (Idealkundenprofil: Angebot, Nutzen, Kundenbeispiele) and remembered style wishes.
2. Company unknown → `firma_suchen`; take the clear match, ask only if several companies fit.
3. In parallel:
   - `firma_lesen` with bereiche `["profil", "register", "publikationen", "kunden", "fluktuation", "notizen"]`
   - `firmen_ereignisse` with `companyIds: [id]`, `seitTage: 365`
   - `meldungen` with `companyIds: [id]` and `seit` 90 days ago
   - `firma_kontakte` only if a recipient is needed and the user did not name an address
4. If `verarbeitung.stand` is `fehlt`: call `import_anlegen` with the companyId, tell the user the company is being prepared in AVA, and write the draft from the register data you have.

## 2. Choose the hooks (Aufhänger)

Rank facts by strength and freshness, take the best 2–4:
- personnel change of the recipient (≤ 180 days strongest), then other leadership changes
- news (Meldungen) of the last 90 days
- annual accounts with change vs. prior year (revenue, employees; ≥ 10 % is strong)
- products and customers from the website profile, expansion or hiring signals

Never invent facts. A date with zeitpunktArt `erstmals_gesehen` or `festgestellt` is when AVA noticed it, not the real date: say "kürzlich", not the date.

## 3. Recipient

- Named person → use them. Only a role ("an den Vertriebsleiter") → pick the matching current person from `firma_kontakte` (leadership first) and name them in your answer without asking.
- E-mail with `emailArt: "abgeleitet"` is derived from the company pattern: use it, but say in one short note that it is derived.

## 4. Write

- Language German, **Sie**, do not ask Du/Sie (unless the remembered style says Du).
- Structure: occasion (strongest hook) → thesis (what it means for the recipient) → benefit in one sentence, with a customer example from the user's offering if it fits → small concrete proposal → exactly ONE question.
- Length: e-mail 60–200 words (aim for 120–180), LinkedIn 25–110 words, subject with a concrete reference.
- A concrete fact must appear in the first two sentences; use at least two facts.
- No filler ("Ich hoffe, es geht Ihnen gut", "innovative Lösung", "Synergie", "Win-win", "Mein Name ist …"), no self-introduction first, no list of all facts, no placeholders like [Name].
- No surveillance tone: "Mir ist aufgefallen, dass Sie die Vertriebsleitung neu besetzt haben" — yes; "Wir haben Ihre Personalwechsel ausgewertet" — no.
- Sign with the user's name from the context, never with a company team name.
- If the user's offering is missing in the context: ask ONE short question for offering, benefit and a reference customer, then write.

## 5. Check once, then answer

Before answering, check your draft against section 4 (facts used, fact in the first two sentences, length, no filler, no placeholders). If something fails, revise ONCE, without asking.

Answer format:
1. **Aufhänger** — short list: fact · source (link if there is one) · date
2. The draft: subject line, then the text (LinkedIn: as a quote block)
3. At most one sentence on which hook could be swapped

If the user corrects the style in general ("kürzer", "immer mit Zahlen", "nie mit einer Frage enden"), apply it now and for the rest of the conversation.
