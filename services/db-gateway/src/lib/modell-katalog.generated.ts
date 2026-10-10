// ERZEUGT von scripts/modell-katalog-export.mjs — nicht von Hand ändern.
// Quelle: packages/ai-provider/src/catalog.ts (role llm, nur mit Werkzeugen).

export interface ModellKatalogEintrag {
  provider: string;
  id: string;
  label: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number;
  costClass: "free" | "cheap" | "mid" | "high";
  recommended: boolean;
  tier: 1 | 2 | 3 | 4;
}

export const MODELL_KATALOG: readonly ModellKatalogEintrag[] = [
  {
    "provider": "ollama",
    "id": "qwen3:8b",
    "label": "Qwen 3 8B (lokal, ab 16 GB RAM)",
    "tools": true,
    "vision": false,
    "contextWindow": 40000,
    "costClass": "free",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "ollama",
    "id": "gemma4:e2b",
    "label": "Gemma 4 E2B (lokal, ab 8 GB RAM, multimodal, kompakt)",
    "tools": true,
    "vision": true,
    "contextWindow": 128000,
    "costClass": "free",
    "recommended": false,
    "tier": 1
  },
  {
    "provider": "ollama",
    "id": "gemma4:e4b",
    "label": "Gemma 4 E4B (lokal, 16-24 GB RAM, multimodal + OCR)",
    "tools": true,
    "vision": true,
    "contextWindow": 128000,
    "costClass": "free",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "ollama",
    "id": "qwen3:14b",
    "label": "Qwen 3 14B (lokal, 16+ GB RAM — stark bei komplexen Recherchen)",
    "tools": true,
    "vision": false,
    "contextWindow": 40000,
    "costClass": "free",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "ollama",
    "id": "gemma4:12b",
    "label": "Gemma 4 12B (lokal, 16+ GB RAM, multimodal, 256K)",
    "tools": true,
    "vision": true,
    "contextWindow": 256000,
    "costClass": "free",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "ollama",
    "id": "gemma4:26b",
    "label": "Gemma 4 26B MoE (lokal, ≥24 GB unified memory)",
    "tools": true,
    "vision": true,
    "contextWindow": 256000,
    "costClass": "free",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "ollama",
    "id": "gemma4:31b",
    "label": "Gemma 4 31B (lokal, Workstation ≥32 GB, multimodal)",
    "tools": true,
    "vision": true,
    "contextWindow": 256000,
    "costClass": "free",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "ollama",
    "id": "qwen3:30b",
    "label": "Qwen 3 30B-A3B MoE (lokal, Sweet Spot M-Series ≥32 GB)",
    "tools": true,
    "vision": false,
    "contextWindow": 256000,
    "costClass": "free",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "ollama",
    "id": "llama3.3:70b",
    "label": "Llama 3.3 70B (lokal, Workstation ≥48 GB RAM)",
    "tools": true,
    "vision": false,
    "contextWindow": 128000,
    "costClass": "free",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-6-astra",
    "label": "GPT-6 Astra (frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-6.1-sol",
    "label": "GPT-6.1 Sol (neu)",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-6-sol",
    "label": "GPT-6 Sol",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-6-luna",
    "label": "GPT-6 Luna (guenstig)",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "cheap",
    "recommended": true,
    "tier": 3
  },
  {
    "provider": "openai",
    "id": "gpt-5.6-sol",
    "label": "GPT-5.6 Sol (frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5.6-terra",
    "label": "GPT-5.6 Terra",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5.6-luna",
    "label": "GPT-5.6 Luna (guenstig)",
    "tools": true,
    "vision": true,
    "contextWindow": 1050000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "openai",
    "id": "gpt-5.5-pro",
    "label": "GPT-5.5 Pro (frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5.5",
    "label": "GPT-5.5",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5.4-pro",
    "label": "GPT-5.4 Pro",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5.4",
    "label": "GPT-5.4",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5.4-mini",
    "label": "GPT-5.4 mini",
    "tools": true,
    "vision": true,
    "contextWindow": 400000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "openai",
    "id": "gpt-5.4-nano",
    "label": "GPT-5.4 nano",
    "tools": true,
    "vision": true,
    "contextWindow": 400000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 1
  },
  {
    "provider": "openai",
    "id": "gpt-5-pro",
    "label": "GPT-5 Pro",
    "tools": true,
    "vision": true,
    "contextWindow": 400000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5",
    "label": "GPT-5",
    "tools": true,
    "vision": true,
    "contextWindow": 400000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "gpt-5-mini",
    "label": "GPT-5 mini",
    "tools": true,
    "vision": true,
    "contextWindow": 400000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "openai",
    "id": "gpt-5-nano",
    "label": "GPT-5 nano",
    "tools": true,
    "vision": true,
    "contextWindow": 400000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 1
  },
  {
    "provider": "openai",
    "id": "gpt-4.1",
    "label": "GPT-4.1",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "openai",
    "id": "gpt-4.1-mini",
    "label": "GPT-4.1 mini",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "openai",
    "id": "gpt-4.1-nano",
    "label": "GPT-4.1 nano",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 1
  },
  {
    "provider": "openai",
    "id": "gpt-4o",
    "label": "GPT-4o",
    "tools": true,
    "vision": true,
    "contextWindow": 128000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "openai",
    "id": "gpt-4o-mini",
    "label": "GPT-4o mini",
    "tools": true,
    "vision": true,
    "contextWindow": 128000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "openai",
    "id": "o3",
    "label": "o3 (reasoning)",
    "tools": true,
    "vision": false,
    "contextWindow": 200000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "openai",
    "id": "o4-mini",
    "label": "o4-mini (reasoning)",
    "tools": true,
    "vision": true,
    "contextWindow": 200000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "openai",
    "id": "o3-mini",
    "label": "o3-mini (reasoning)",
    "tools": true,
    "vision": false,
    "contextWindow": 200000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "anthropic",
    "id": "claude-fable-5-1",
    "label": "Claude Fable 5.1 (frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-5-5",
    "label": "Claude Opus 5.5 (neu)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-fable-5",
    "label": "Claude Fable 5 (frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-5",
    "label": "Claude Opus 5",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-5-5",
    "label": "Claude Sonnet 5.5 (neu)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": true,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-5",
    "label": "Claude Sonnet 5",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-8",
    "label": "Claude Opus 4.8",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-7",
    "label": "Claude Opus 4.7",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-4-6",
    "label": "Claude Sonnet 4.6",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "anthropic",
    "id": "claude-haiku-4-5",
    "label": "Claude Haiku 4.5",
    "tools": true,
    "vision": true,
    "contextWindow": 200000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-6",
    "label": "Claude Opus 4.6 (legacy)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "label": "Claude Sonnet 4.5 (legacy)",
    "tools": true,
    "vision": true,
    "contextWindow": 200000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-5",
    "label": "Claude Opus 4.5 (legacy)",
    "tools": true,
    "vision": true,
    "contextWindow": 200000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-1",
    "label": "Claude Opus 4.1 (legacy)",
    "tools": true,
    "vision": true,
    "contextWindow": 200000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "google",
    "id": "gemini-3.8-flash",
    "label": "Gemini 3.8 Flash",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": true,
    "tier": 3
  },
  {
    "provider": "google",
    "id": "gemini-3.6-flash",
    "label": "Gemini 3.6 Flash",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "google",
    "id": "gemini-3.5-flash",
    "label": "Gemini 3.5 Flash",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "google",
    "id": "gemini-3.5-flash-lite",
    "label": "Gemini 3.5 Flash-Lite",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "google",
    "id": "gemini-3.7-flash",
    "label": "Gemini 3.7 Flash",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "google",
    "id": "gemini-3.1-pro-preview",
    "label": "Gemini 3.1 Pro (preview, frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "google",
    "id": "gemini-3-pro-preview",
    "label": "Gemini 3 Pro (preview)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "high",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "google",
    "id": "gemini-3-flash-preview",
    "label": "Gemini 3 Flash (preview)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "google",
    "id": "gemini-3.1-flash-lite",
    "label": "Gemini 3.1 Flash-Lite",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "google",
    "id": "gemini-2.5-pro",
    "label": "Gemini 2.5 Pro (nur Bestandskonten)",
    "tools": true,
    "vision": true,
    "contextWindow": 2000000,
    "costClass": "mid",
    "recommended": false,
    "tier": 4
  },
  {
    "provider": "google",
    "id": "gemini-2.5-flash",
    "label": "Gemini 2.5 Flash",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "google",
    "id": "gemini-2.5-flash-lite",
    "label": "Gemini 2.5 Flash-Lite",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "google",
    "id": "gemini-2.0-flash",
    "label": "Gemini 2.0 Flash (legacy)",
    "tools": true,
    "vision": true,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "mistral",
    "id": "mistral-large-latest",
    "label": "Mistral Large 4",
    "tools": true,
    "vision": true,
    "contextWindow": 262000,
    "costClass": "mid",
    "recommended": true,
    "tier": 3
  },
  {
    "provider": "mistral",
    "id": "mistral-medium-latest",
    "label": "Mistral Medium 3.5 (frontier multimodal)",
    "tools": true,
    "vision": true,
    "contextWindow": 262000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "mistral",
    "id": "mistral-small-latest",
    "label": "Mistral Small 4",
    "tools": true,
    "vision": true,
    "contextWindow": 262000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "mistral",
    "id": "ministral-14b-latest",
    "label": "Ministral 3 14B",
    "tools": true,
    "vision": true,
    "contextWindow": 262000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "mistral",
    "id": "ministral-8b-latest",
    "label": "Ministral 3 8B",
    "tools": true,
    "vision": true,
    "contextWindow": 262000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 1
  },
  {
    "provider": "mistral",
    "id": "ministral-3b-latest",
    "label": "Ministral 3 3B",
    "tools": true,
    "vision": true,
    "contextWindow": 262000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 1
  },
  {
    "provider": "mistral",
    "id": "pixtral-large-latest",
    "label": "Pixtral Large (legacy vision)",
    "tools": true,
    "vision": true,
    "contextWindow": 128000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "mistral",
    "id": "codestral-latest",
    "label": "Codestral (code completion)",
    "tools": true,
    "vision": false,
    "contextWindow": 262000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  },
  {
    "provider": "mistral",
    "id": "devstral-medium-latest",
    "label": "Devstral 2 (frontier code agent)",
    "tools": true,
    "vision": false,
    "contextWindow": 262000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "deepseek",
    "id": "deepseek-v4-pro",
    "label": "DeepSeek V4 Pro",
    "tools": true,
    "vision": false,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "deepseek",
    "id": "deepseek-v4-flash",
    "label": "DeepSeek V4 Flash (sehr guenstig)",
    "tools": true,
    "vision": false,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": true,
    "tier": 2
  },
  {
    "provider": "xai",
    "id": "grok-4.6",
    "label": "Grok 4.6 (frontier)",
    "tools": true,
    "vision": true,
    "contextWindow": 500000,
    "costClass": "mid",
    "recommended": true,
    "tier": 4
  },
  {
    "provider": "xai",
    "id": "grok-4.5",
    "label": "Grok 4.5",
    "tools": true,
    "vision": true,
    "contextWindow": 500000,
    "costClass": "mid",
    "recommended": false,
    "tier": 3
  },
  {
    "provider": "qwen",
    "id": "qwen3.8-max",
    "label": "Qwen3.8 Max",
    "tools": true,
    "vision": false,
    "contextWindow": 1000000,
    "costClass": "mid",
    "recommended": true,
    "tier": 4
  },
  {
    "provider": "qwen",
    "id": "qwen3.8-flash",
    "label": "Qwen3.8 Flash (guenstig)",
    "tools": true,
    "vision": false,
    "contextWindow": 1000000,
    "costClass": "cheap",
    "recommended": false,
    "tier": 2
  }
];
