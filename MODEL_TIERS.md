# Model Tiers

> Quality buckets for the LLMs AVA can route to. Used by the multi-tenant
> persist-bus to decide when an incoming write should overwrite an
> existing one (a tier-S verdict must not be replaced by a tier-C verdict
> just because tier-C ran 5 minutes later).

## Tier numerics

| Tier | # | Meaning |
|---|---|---|
| **S** | 4 | Premium / frontier reasoning. Best quality on German B2B extraction, structured-JSON adherence, multi-step reasoning. |
| **A** | 3 | High. Last-gen frontier flagships, current strong "default" hosted models, the largest local models we ship. |
| **B** | 2 | Mid. Reliable but visibly lower quality on multi-step extraction. Usable as a starter; should never overwrite an A or S. |
| **C** | 1 | Small / local-default. Free Ollama tier. Good first-launch experience, but never overwrites better data. |

Numeric is what the comparison logic uses; letters are for humans.

## Decision matrix at write time

For LLM-driven persist (company-profile, contact, website-judge, evaluation):

```
existing row absent           → WRITE
incoming.tier > existing.tier → WRITE  (upgrade)
incoming.tier = existing.tier → WRITE only if existing.updatedAt > 30 days
incoming.tier < existing.tier → SKIP   (would downgrade)
```

For non-LLM stages (structured-content, publication, raw SERP):

```
existing row absent           → WRITE
existing.updatedAt > 30 days  → WRITE  (refresh)
existing.updatedAt ≤ 30 days  → SKIP   (fresh)
```

## Current classifications

These are the source of truth for adding new entries — copy the closest
peer's tier when you add a model. **Every catalog entry must have a tier.**
TypeScript enforces this on `CatalogEntry`; CI fails if you forget.

### Tier S — premium

- `gpt-5.4-pro` (OpenAI)
- `gpt-5.4` (OpenAI)
- `gpt-5` (OpenAI)
- `claude-opus-4-1` (Anthropic)
- `gemini-2.5-pro` (Google)

### Tier A — high

- `gpt-4.1` (OpenAI)
- `gpt-4o` (OpenAI)
- `o3-mini` (OpenAI)
- `o4-mini` (OpenAI)
- `claude-sonnet-4-6` (Anthropic)
- `gemini-2.5-flash` (Google)
- `mistral-large-latest` (Mistral)
- `pixtral-large-latest` (Mistral)
- `gemma4:31b` (Ollama, local)
- `gemma4:26b` (Ollama, local)
- `qwen2.5:14b` (Ollama, local)

### Tier B — mid

- `gpt-5.4-mini` (OpenAI)
- `gpt-5-mini` (OpenAI)
- `gpt-4.1-mini` (OpenAI)
- `gpt-4o-mini` (OpenAI)
- `claude-haiku-4-5` (Anthropic)
- `gemini-2.0-flash` (Google)
- `mistral-small-latest` (Mistral)
- `gemma4:e4b` (Ollama, local — current default)
- `qwen2.5:7b` (Ollama, local)
- `mistral-nemo:12b` (Ollama, local)
- `llama3.1:8b` (Ollama, local)

### Tier C — small / local-default

- `gemma4:e2b` (Ollama, local)
- `gemma3:4b` (Ollama, local)
- `llama3.2:3b` (Ollama, local)
- `qwen2.5:3b` (Ollama, local)
- `ministral-8b-latest` (Mistral)

## Rubric for adding a new model

1. **What's it best benchmarked at?** German extraction tasks + structured JSON
   are the primary axes. Reasoning depth is secondary.
2. **Is it a vendor's current flagship or "default"?** Flagship → A or S.
3. **Is it a "mini" / "haiku" / "flash" / "small" variant?** Almost always B.
4. **Local model parameter count:**
   - ≥30 B parameters and instruction-tuned → A
   - 7–14 B → B
   - ≤4 B → C
5. **MoE local models** (Mixtral, Gemma 4 26B): rate by quality, not active
   parameter count. Gemma 4 26B is A despite ~4 B active params.
6. **Reasoning models** (o1/o3/o4 family): default A. Bump to S only if its
   default mode (not "thinking" mode) outperforms current S models on AVA's
   tasks — verify before promoting.

## When to update this file

- Add the model to the right `Tier X` list above
- Set `tier: <1|2|3|4>` on its `CatalogEntry`
- If unsure, default conservative (one tier lower than your best guess)
- Re-evaluate annually as benchmarks shift
