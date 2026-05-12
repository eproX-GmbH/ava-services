# Dokumentation

Sammelstelle für alles, was den Code begleitet aber nicht ins Hauptrepo-README gehört. Reihenfolge ungefähr von „wichtig für Architekturverständnis" nach „spezialisiert".

| Datei | Was drin steht |
|---|---|
| [`DECISIONS.md`](./DECISIONS.md) | Ratifizierte D1–D11-Architekturentscheidungen — was wir warum gewählt haben (Compute-Lokalität, Cloud-Substrat-Umfang, …) |
| [`DESKTOP_DATA_FLOW.md`](./DESKTOP_DATA_FLOW.md) | Workflows W1–W25 quer durch die Pipeline, SSE-Bridge zwischen Producer und Desktop, IPC-Verträge |
| [`INVENTORY.md`](./INVENTORY.md) | Vollständige Bestandsaufnahme aller Services, ihrer Verantwortlichkeiten und Schnittstellen |
| [`PLANS.md`](./PLANS.md) | Aktive technische Feature-Pläne (Tool-Coverage-Audit, Skills-System usw.) |
| [`PLANS_chart_skill.md`](./PLANS_chart_skill.md) | Detail-Plan für das Chart-Skill (visuelle Datenauswertung im Chat) |
| [`MODEL_TIERS.md`](./MODEL_TIERS.md) | Quality-Buckets für LLMs (Tier S/A/B/C) — Source of Truth für die tier-aware-persist-Bus |
| [`SKILLS.md`](./SKILLS.md) | Skills-System: Format, Trust-Modell, Bundled-Skills |
| [`TOOLS.md`](./TOOLS.md) | Auto-generierte Referenz aller Chat-Agent-Tools (per `pnpm -F @ava/desktop tools:doc`) |
| [`ANTHROPIC_AUTH.md`](./ANTHROPIC_AUTH.md) | Anthropic-OAuth-Flow für Producer (Subscription-Token-Authentifizierung) |
| [`OLLAMA_PLAN.md`](./OLLAMA_PLAN.md) | Lokale-LLM-Strategie (Modellauswahl, Hardware-Gating) |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release-Chronik |
