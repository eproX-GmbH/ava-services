// S1 — SKILL.md parser.
//
// Splits a file into a YAML frontmatter object + the markdown body.
// The frontmatter block is delimited by `---` on its own lines, must
// be at the very top of the file, and is parsed with the `yaml` lib.
//
// Returns { frontmatter, body } or throws a parser error with a
// German message — the loader catches and logs.

import { parse as parseYaml } from "yaml";

export interface ParsedSkill {
  frontmatter: unknown;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

export function parseSkillFile(raw: string): ParsedSkill {
  const trimmed = raw.replace(/^﻿/, "");
  const match = FRONTMATTER_RE.exec(trimmed);
  if (!match) {
    throw new SkillParseError(
      "Datei beginnt nicht mit einem YAML-Frontmatter-Block (--- … ---)",
    );
  }
  const [, yamlText, body] = match;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(yamlText ?? "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SkillParseError(`YAML-Frontmatter ungültig: ${msg}`);
  }
  if (frontmatter === null || typeof frontmatter !== "object") {
    throw new SkillParseError(
      "YAML-Frontmatter muss ein Objekt mit Feldern sein (kein Skalar / keine Liste)",
    );
  }
  return { frontmatter, body: (body ?? "").trim() };
}
