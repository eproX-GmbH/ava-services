---
name: erste-schritte
description: First steps with AVA in ChatGPT. Use right after the plugin is connected or when the user asks what AVA can do.
---

# First steps with AVA

1. Call `ava_kontext` once (no question to the user). It says who the user is, which organization they belong to and what is enabled.
2. Greet the user in their language (usually German, informal "du" unless the context says otherwise) and offer three things they can try, adapted to what is enabled:
   - "Was gibt es Neues bei meinen Firmen?" → `meldungen`
   - "Welche neuen Vertriebsleiter gab es zuletzt?" → `firmen_ereignisse`
   - "Schreib eine Erstansprache an <Firma>" → skill `erstansprache`
3. If a tool answers that AVA is not yet enabled for ChatGPT in the organization, pass that message on as it is and stop; do not retry.
4. If the user has no companies yet (`meine_firmen` is empty), offer to add some: find them with `firma_suchen`, then `import_anlegen` with the companyIds. Processing runs in the AVA app on the user's computer and can take a while.

Keep it short: one sentence of introduction, three suggestions, no feature list.
