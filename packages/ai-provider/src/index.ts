import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";
import type { EmbeddingModel, LanguageModel } from "ai";

export type LLMProvider = "openai" | "anthropic" | "google" | "ollama";
export type EmbedProvider = "openai" | "google" | "ollama";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getLLM(): LanguageModel {
  const provider = (process.env.LLM_PROVIDER ?? "openai") as LLMProvider;
  const model = process.env.LLM_MODEL;

  switch (provider) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireEnv("OPENAI_API_KEY"),
        project: process.env.OPENAI_PROJECT_KEY,
        organization: process.env.OPENAI_ORGANIZATION_KEY,
      });
      return client(model ?? "gpt-4o-mini");
    }
    case "anthropic": {
      const client = createAnthropic({
        apiKey: requireEnv("ANTHROPIC_API_KEY"),
      });
      return client(model ?? "claude-sonnet-4-6");
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: requireEnv("GOOGLE_API_KEY"),
      });
      return client(model ?? "gemini-2.5-pro");
    }
    case "ollama": {
      const client = createOllama({
        baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434/api",
      });
      return client(model ?? "gemma3:4b");
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${String(provider)}`);
  }
}

export function getEmbedder(): EmbeddingModel<string> {
  const provider = (process.env.EMBED_PROVIDER ?? "openai") as EmbedProvider;
  const model = process.env.EMBED_MODEL;

  switch (provider) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireEnv("OPENAI_API_KEY"),
        project: process.env.OPENAI_PROJECT_KEY,
        organization: process.env.OPENAI_ORGANIZATION_KEY,
      });
      return client.textEmbeddingModel(model ?? "text-embedding-3-large");
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: requireEnv("GOOGLE_API_KEY"),
      });
      return client.textEmbeddingModel(model ?? "text-embedding-004");
    }
    case "ollama": {
      const client = createOllama({
        baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434/api",
      });
      return client.textEmbeddingModel(model ?? "embeddinggemma");
    }
    default:
      throw new Error(`Unknown EMBED_PROVIDER: ${String(provider)}`);
  }
}
