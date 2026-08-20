/**
 * Shared type system for the Ejentic Service Agent.
 *
 * These types are the contract between the fixed `engine/` and the
 * per-tenant `tenants/<client>/` config. Onboarding a new client means
 * providing a `TenantConfig` + knowledge docs — never editing the engine.
 */

// ── Languages the agent supports out of the box ──
export type LanguageCode =
  | "en"      // Standard English
  | "pcm"     // Nigerian Pidgin
  | "yo"      // Yoruba
  | "ig"      // Igbo
  | "ha";     // Hausa

export const SUPPORTED_LANGUAGES: LanguageCode[] = ["en", "pcm", "yo", "ig", "ha"];

export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: "English",
  pcm: "Nigerian Pidgin",
  yo: "Yoruba",
  ig: "Igbo",
  ha: "Hausa",
};

// ── Chat message shape (provider-agnostic) ──
export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

// ── A single retrieved knowledge chunk ──
export interface KnowledgeChunk {
  id: string;
  source: string;        // filename / doc title it came from
  text: string;
  embedding: number[];   // vector (local or provider embeddings)
}

export interface RetrievalResult {
  chunk: KnowledgeChunk;
  score: number;         // cosine similarity 0..1
}

// ── Per-tenant configuration (the ONLY thing you edit per client) ──
export interface TenantConfig {
  /** Machine id, must match the folder name under /tenants. */
  id: string;
  /** Human-facing business name, e.g. "Ejentic AI". */
  businessName: string;
  /** The agent's display name / persona, e.g. "Nova". */
  agentName: string;
  /** Short brand/persona description injected into the system prompt. */
  persona: string;
  /** Languages this deployment should actively support. */
  languages: LanguageCode[];
  /** Where "talk to a human" / unknown-answer escalations are emailed. */
  escalationInbox?: string;
  /** Optional website links the agent may share (label -> url). */
  links?: Record<string, string>;
  /**
   * Confidence gate (0..1). If the best retrieval score is below this,
   * the agent refuses to guess and escalates to a human instead.
   * This is the core anti-hallucination lever.
   */
  minConfidence: number;
  /** Extra tenant-specific instructions appended to the system prompt. */
  extraInstructions?: string;
}

// ── LLM provider abstraction (fallback router implements this list) ──
export interface LlmResult {
  text: string;
  provider: string;      // which tier answered
}

export interface LlmProvider {
  name: string;
  /** Returns null if this provider is not configured/unavailable. */
  isConfigured(): boolean;
  complete(system: string, messages: ChatMessage[]): Promise<LlmResult>;
}

// ── The decision the orchestrator returns for one turn ──
export type TurnKind = "answer" | "escalation" | "blocked" | "cached";

export interface AgentTurn {
  reply: string;
  kind: TurnKind;
  language: LanguageCode;
  provider: string;          // "cache", "mock", "gemini", ...
  confidence: number;        // best retrieval score used
  sources: string[];         // doc names cited (for transparency)
  messageId: string;         // id the client sends back with 👍/👎
  escalated: boolean;
}

// ── Persistent records ──
export interface LeadRecord {
  id: string;
  createdAt: string;
  tenant: string;
  name: string;
  email: string;
  details: string;
  reason: "buy_intent" | "unknown_answer";
  question?: string;         // the question we could not answer
  language: LanguageCode;
  consent: boolean;
}

export interface ChatLogRecord {
  id: string;                // == AgentTurn.messageId
  createdAt: string;
  tenant: string;
  ip: string;
  language: LanguageCode;
  question: string;
  reply: string;
  kind: TurnKind;
  provider: string;
  confidence: number;
  sources: string[];
}

export type FeedbackVote = "up" | "down";

export interface FeedbackRecord {
  id: string;
  createdAt: string;
  tenant: string;
  messageId: string;
  vote: FeedbackVote;
  note?: string;
}

/**
 * A learned answer: when a 👍 confirms a good reply, we remember the
 * (question -> reply) pair. Future near-identical questions can be served
 * from here — saving tokens AND compounding accuracy over time.
 * A 👎 removes/decays the learned entry so bad answers don't persist.
 */
export interface LearnedAnswer {
  id: string;
  tenant: string;
  question: string;
  embedding: number[];
  reply: string;
  language: LanguageCode;
  upvotes: number;
  downvotes: number;
  updatedAt: string;
}
