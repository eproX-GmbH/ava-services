---
name: personalwechsel
description: Answer questions about personnel and management changes at the user's companies, e.g. "Welche neuen Vertriebsleiter gab es?", "Wo hat die Geschäftsführung gewechselt?", "Wer hat bei X die IT verlassen?".
---

# Personnel changes

1. Make ONE call to `firmen_ereignisse` across all of the user's companies (no `companyIds`), unless the user names a company.
   - Map the question to `gruppen` and `ebene`: "Vertriebsleiter" → `gruppen: ["vertrieb"]`, `ebene: "leitung"`; "Geschäftsführer" → `gruppen: ["geschaeftsfuehrung"]`; "IT" → `["it"]`.
   - `seitTage`: default 90; "dieses Jahr" = days since 1 January; "zuletzt" = 90.
   - `arten` only if the question restricts it ("verlassen" → `["verlassen"]`).
   - Do not use `meldungen` for this: news are only the personal selection and miss older changes.
2. Answer as a table `| Firma | Person | Wechsel | Wann |`:
   - Wechsel = "neu als …", "verlassen (…)" or "vorher → jetzt"
   - Wann = date plus "laut Profil" (zeitpunktArt `laut_profil`), "laut Register" (`register`) or "bemerkt am" (`erstmals_gesehen`, `festgestellt`)
   - Source URL as a link where available
3. No result → say so and name the period searched; offer a longer period.
4. Mention people only as far as the question needs it. Offer a first outreach for interesting changes (skill `erstansprache`).
