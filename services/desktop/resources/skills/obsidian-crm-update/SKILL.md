---
name: obsidian-crm-update
description: >
  Aktualisiert YAML-Frontmatter-Felder in einer Obsidian-Vault-Notiz
  (CRM, Projektliste, Personen-Profile). Aktiviere bei Anfragen wie
  „setze Status von X in Obsidian auf …", „Frontmatter von Notiz Y
  ändern", „in meinem Vault aktualisieren", „Follow-Up im Obsidian-CRM
  korrigieren".
language: de
b2b-scope: internal
allowed-tools:
  - obsidian_search
  - obsidian_list_notes
  - obsidian_introspect_folder
  - obsidian_list_tags
  - obsidian_search_by_tag
  - obsidian_get_note
  - obsidian_create_note
  - obsidian_update_frontmatter
  - obsidian_append_to_note
  - obsidian_delete_note
  - ask_user_choice
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
---

# Obsidian-CRM-Update (festes 4-Schritt-Playbook)

Du arbeitest in einem Obsidian-Vault, in dem Notizen mit YAML-Frontmatter
als CRM, Pipeline oder Projektübersicht dienen. Halte dich strikt an die
Reihenfolge unten. Frag den User NICHT zurück, solange du Schritte selbst
per Tool auflösen kannst.

## 1. Notiz finden

- Wenn der User einen Ordner kennt („im CRM-Ordner", „in /Projekte"):
  `obsidian_list_notes` mit `path=<ordner>`. Schneller + zielsicherer
  als Volltext-Suche, weil keine Body-Treffer reinrutschen.
- Wenn nur ein Personen-/Firmenname genannt wird: `obsidian_search`
  mit dem Namen als Query. Filter danach manuell auf Path-Pattern
  (z. B. nur `CRM/*.md`-Treffer behalten).
- Mehrere Treffer mit demselben Titel → `ask_user_choice` mit Path
  + Auszug aus dem Frontmatter, damit der User die richtige aussucht.

## 2. Frontmatter-Konvention lernen (Ordner-Schema)

Bevor du eine einzelne Note öffnest, mach dir die Ordner-Konvention
klar — Obsidian hat kein zentrales Schema, aber Notes innerhalb eines
Ordners folgen üblicherweise dem gleichen Frontmatter-Muster.

`obsidian_introspect_folder` mit `folder=<ordner>` aufrufen — das
sampled bis zu 20 Notes parallel und aggregiert:
- alle Frontmatter-Keys + wie oft sie vorkommen,
- inferierte Typen (string / number / boolean / array / date),
- 3 Beispiel-Werte pro Key.

So weißt du sofort: gibt's das Feld „Status" überhaupt? Heißt es
„Stage" oder „Pipeline-Stage"? Sind Tags ein Array oder ein
kommaseparierter String? Erspart dir mehrere `get_note`-Roundtrips.

Wenn du danach noch konkret ein Beispiel der aktuellen Werte einer
spezifischen Note brauchst (z. B. für ein Update, das nur einen Wert
in einem Array hinzufügt), nutze zusätzlich `obsidian_get_note`.

## Tag-basierte Filterung

Wenn der User mit Tags arbeitet („zeig mir alle #lead-Notes"):
`obsidian_search_by_tag` mit dem Tag-Namen (mit oder ohne `#`-Prefix).
Wenn du nicht weißt welche Tags es gibt: `obsidian_list_tags` listet
alle Tags im Vault mit der jeweiligen Count.

## 3. Frontmatter patchen

`obsidian_update_frontmatter` mit `path` + `properties`. Properties als
FLAT-Map:

```json
{
  "Status": "Aktiv",
  "Follow-Up": "2026-07-16",
  "Tags": ["lead", "b2b"]
}
```

Tags / Multi-Select: schick die VOLLSTÄNDIGE neue Liste, nicht nur
das neue Element. Das Tool ersetzt den Wert komplett (replace, kein
append).

## 4. Bestätigen + zusammenfassen

Wenn das Tool ohne Warning durchläuft: knappe Erfolgsmeldung im Stil
„`Aktualisiert in CRM/Kerstin Komarnicki.md`: Status=Aktiv,
Follow-Up=2026-07-16".

Wenn `warnings` zurückkommen (z. B. „Frontmatter-Key X konnte nicht
gesetzt werden"): zitiere sie einzeilig.

## Sonderfälle

### Note existiert noch nicht

`obsidian_create_note` mit `parent=<ordner>`, `title=<name>`,
`content="---\n<frontmatter>\n---\n\n<body>"`. Achtung: die initialen
Frontmatter-Werte müssen IM CONTENT mitgegeben werden (YAML-Header
zwischen `---`-Zeilen), weil `create_note` keine Properties-Param hat.
Danach mit `update_frontmatter` weitere Felder setzen.

### Lösch-Auftrag („Lösche die alte Notiz X")

`obsidian_delete_note` mit `path` + optional `rationale`. Das Tool
zeigt dem User die Vorschau und holt Confirm. WICHTIG: Obsidian REST-
API hat **keinen Trash** — wenn der User keinen externen Backup-Pfad
(Sync, iCloud, Git) hat, ist die Notiz weg. Vor dem Aufruf bei
wertvollem Inhalt zusätzlich im Chat nachfragen.

## Fehlerdiagnose bei „HTTP 200 aber nicht übernommen"

Wenn `obsidian_update_frontmatter` oder `obsidian_delete_note` einen
Fehler wirft, der „nicht übernommen" oder „existiert immer noch"
enthält: Sag dem User ohne Umschweife:

> Der genutzte Obsidian-API-Key hat vermutlich nur Lese-Berechtigung.
> Bitte in Obsidian → Settings → Local REST API einen API-Key mit
> vollem Scope (Read + Write) erzeugen und in AVA neu hinterlegen.

Probiere NICHT, durch Property-Variation, Path-Casing oder Retry zu
umgehen — das ist eine Berechtigungsfrage, kein Mapping-Bug.

## Abschluss-Bericht

Nach erfolgreichem Update:

```
Aktualisiert in [Obsidian/CRM]:
- Kerstin Komarnicki.md: Status = Aktiv, Follow-Up = 2026-07-16
- Sascha Beckmann.md: Tags = [lead, b2b, kalt]
```
