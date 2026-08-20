/**
 * LLM provider router — zero-downtime fallback chain.
 *
 * Preserves the Ejentic pattern: Gemini → FreeLLMAPI gateway → NVIDIA.
 * Adds an always-available offline MOCK provider so the whole product runs
 * and demos with NO API keys (it answers strictly from the RAG context it
 * is given, which keeps behavior honest even without a real model).
 *
 * Every provider implements the same `complete(system, messages)` contract,
 * so the orchestrator never cares which tier actually answered.
 */
import { env } from "../config.js";
import type { ChatMessage, LlmProvider, LlmResult } from "../types.js";

function toOpenAIMessages(system: string, messages: ChatMessage[]) {
  return [{ role: "system", content: system }, ...messages];
}

/** Shared OpenAI-compatible chat call (FreeLLMAPI + NVIDIA both use this). */
async function openAICompatibleChat(opts: {
  url: string;
  apiKey: string;
  system: string;
  messages: ChatMessage[];
  model?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {
    messages: toOpenAIMessages(opts.system, opts.messages),
    temperature: 0.5,
    max_tokens: 1024,
  };
  if (opts.model) body.model = opts.model;

  const resp = await fetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as any;
  if (!resp.ok) {
    throw new Error(
      `OpenAI-compatible error (${resp.status}): ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty completion");
  return text;
}

// ── Tier 1: Google Gemini ──
const geminiProvider: LlmProvider = {
  name: "gemini",
  isConfigured: () => Boolean(env.gemini.key),
  async complete(system, messages): Promise<LlmResult> {
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent?key=${env.gemini.key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
        }),
      },
    );
    const data = (await resp.json()) as any;
    if (!resp.ok) throw new Error(`Gemini error: ${JSON.stringify(data).slice(0, 200)}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no text");
    return { text, provider: "gemini" };
  },
};

// ── Tier 2: FreeLLMAPI gateway (auto-routes free providers) ──
const freellmapiProvider: LlmProvider = {
  name: "freellmapi",
  isConfigured: () => Boolean(env.freellmapi.key),
  async complete(system, messages): Promise<LlmResult> {
    const text = await openAICompatibleChat({
      url: `${env.freellmapi.baseUrl}/chat/completions`,
      apiKey: env.freellmapi.key,
      system,
      messages, // no model => gateway auto-routes
    });
    return { text, provider: "freellmapi" };
  },
};

// ── Tier 3: NVIDIA (single-provider last resort) ──
const nvidiaProvider: LlmProvider = {
  name: "nvidia",
  isConfigured: () => Boolean(env.nvidia.key),
  async complete(system, messages): Promise<LlmResult> {
    const text = await openAICompatibleChat({
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: env.nvidia.key,
      model: env.nvidia.model,
      system,
      messages,
    });
    return { text, provider: "nvidia" };
  },
};

/**
 * Tier 4: Offline MOCK — always available, no key required.
 * It does NOT invent facts: it echoes the grounded context it was handed,
 * so an unconfigured install still behaves honestly (and tests are stable).
 */
const mockProvider: LlmProvider = {
  name: "mock",
  isConfigured: () => true,
  async complete(system, messages): Promise<LlmResult> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const q = lastUser?.content ?? "";

    // The orchestrator embeds retrieved knowledge between these markers. The
    // system prompt may MENTION the tag name in its rules, so we grab the LAST
    // <KNOWLEDGE>…</KNOWLEDGE> block (the real context is always appended last)
    // to avoid accidentally echoing the instruction text.
    const blocks = [...system.matchAll(/<KNOWLEDGE>([\s\S]*?)<\/KNOWLEDGE>/g)];
    const ctx = blocks.length ? (blocks[blocks.length - 1]?.[1] ?? "").trim() : "";

    if (!ctx) {
      return {
        text: "[offline mode] I don't have grounded knowledge for that yet.",
        provider: "mock",
      };
    }
    // Return the most relevant lines from context (strip source markers).
    const cleaned = ctx
      .replace(/\[\[\d+\]\]\s*\(source:[^)]*\)/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" ");
    return {
      text: `Based on our information: ${cleaned}${q ? "" : ""}`,
      provider: "mock",
    };
  },
};

// Ordered fallback chain. Mock is always last so there is ALWAYS an answer path.
const CHAIN: LlmProvider[] = [
  geminiProvider,
  freellmapiProvider,
  nvidiaProvider,
  mockProvider,
];

/** Which real (non-mock) providers are configured — for /health. */
export function configuredProviders(): string[] {
  return CHAIN.filter((p) => p.name !== "mock" && p.isConfigured()).map((p) => p.name);
}

/**
 * Try each configured provider in order; return the first success.
 * Falls through to the offline mock so a reply is guaranteed.
 */
export async function complete(system: string, messages: ChatMessage[]): Promise<LlmResult> {
  const errors: string[] = [];
  for (const provider of CHAIN) {
    if (!provider.isConfigured()) continue;
    try {
      return await provider.complete(system, messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${msg}`);
      console.warn(`[providers] ${provider.name} failed -> next tier.`, msg);
    }
  }
  // Should be unreachable (mock never throws), but stay safe.
  throw new Error(`All providers failed: ${errors.join(" | ")}`);
}
