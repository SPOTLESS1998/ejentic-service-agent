/**
 * Semantic cache + learned-answer memory — token savings AND self-improvement.
 *
 * Two jobs, one mechanism (vector similarity over past questions):
 *
 *  A) TOKEN SAVINGS: before calling any LLM, check whether a semantically
 *     near-identical question already has a trusted answer. If so, serve it
 *     from memory — zero model tokens spent on repetitive questions.
 *
 *  B) SELF-IMPROVEMENT: a 👍 promotes an answer into the learned memory (or
 *     strengthens it); a 👎 weakens/removes it. Over time the agent serves more
 *     from vetted memory and less from raw generation — a healthy growth loop.
 *
 * Backed by storage.learned (JSON). Similarity via the shared embedder.
 */
import { cosineSimilarity, embed } from "./embeddings.js";
import { learned, newId } from "./storage.js";
import type { LanguageCode, LearnedAnswer } from "../types.js";

// A question must be THIS similar to a learned one to be served from cache.
const CACHE_HIT_THRESHOLD = 0.92;
// Net votes below this => the entry is considered unreliable and skipped.
const MIN_NET_VOTES = 0;

export interface CacheHit {
  entry: LearnedAnswer;
  score: number;
}

/**
 * Look for a trusted, semantically-matching learned answer.
 * Returns null on miss (caller then goes to retrieval + LLM).
 */
export async function lookup(
  tenant: string,
  question: string,
  lang: LanguageCode,
): Promise<CacheHit | null> {
  const entries = learned.all(tenant).filter(
    (e) => e.language === lang && e.upvotes - e.downvotes >= MIN_NET_VOTES,
  );
  if (entries.length === 0) return null;

  const q = await embed(question);
  let best: CacheHit | null = null;
  for (const entry of entries) {
    const score = cosineSimilarity(q, entry.embedding);
    if (!best || score > best.score) best = { entry, score };
  }

  if (best && best.score >= CACHE_HIT_THRESHOLD) return best;
  return null;
}

/**
 * Record that a (question -> reply) pair was confirmed good (👍).
 * If a near-duplicate learned entry exists, strengthen it; else create one.
 */
export async function reinforce(
  tenant: string,
  question: string,
  reply: string,
  lang: LanguageCode,
): Promise<LearnedAnswer> {
  const q = await embed(question);

  // Merge into an existing very-similar entry if present.
  const existing = learned.all(tenant).filter((e) => e.language === lang);
  for (const e of existing) {
    if (cosineSimilarity(q, e.embedding) >= CACHE_HIT_THRESHOLD) {
      e.upvotes += 1;
      e.reply = reply; // keep the most recently confirmed phrasing
      e.updatedAt = new Date().toISOString();
      return learned.upsert(tenant, e);
    }
  }

  const entry: LearnedAnswer = {
    id: newId("ans_"),
    tenant,
    question,
    embedding: q,
    reply,
    language: lang,
    upvotes: 1,
    downvotes: 0,
    updatedAt: new Date().toISOString(),
  };
  return learned.upsert(tenant, entry);
}

/**
 * Apply a 👎 to whatever learned entry produced/matches this question.
 * Weakens it; if it falls too far, it is removed so bad answers don't persist.
 */
export async function weaken(
  tenant: string,
  question: string,
  lang: LanguageCode,
): Promise<void> {
  const q = await embed(question);
  const entries = learned.all(tenant).filter((e) => e.language === lang);

  let target: LearnedAnswer | null = null;
  let bestScore = 0;
  for (const e of entries) {
    const s = cosineSimilarity(q, e.embedding);
    if (s > bestScore) {
      bestScore = s;
      target = e;
    }
  }
  if (!target || bestScore < CACHE_HIT_THRESHOLD) return;

  target.downvotes += 1;
  target.updatedAt = new Date().toISOString();

  if (target.upvotes - target.downvotes < -1) {
    learned.remove(tenant, target.id); // demonstrably bad -> forget it
  } else {
    learned.upsert(tenant, target);
  }
}

/** Stats for the /health + admin endpoints. */
export function stats(tenant: string): {
  learnedCount: number;
  totalUpvotes: number;
  totalDownvotes: number;
} {
  const all = learned.all(tenant);
  return {
    learnedCount: all.length,
    totalUpvotes: all.reduce((s, e) => s + e.upvotes, 0),
    totalDownvotes: all.reduce((s, e) => s + e.downvotes, 0),
  };
}
