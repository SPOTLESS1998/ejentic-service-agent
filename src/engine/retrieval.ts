/**
 * RAG retrieval — the anti-hallucination core.
 *
 * The orchestrator asks retrieval for the most relevant knowledge chunks for a
 * question. If the best score is below the tenant's `minConfidence`, the agent
 * is NOT allowed to answer from the model's imagination — it escalates to a
 * human instead. This is what stops "confident but untrue" replies.
 *
 * SCORING — hybrid (semantic + lexical):
 *   Pure vector cosine is unreliable with the offline bag-of-words embedder: a
 *   short on-topic question can score LOWER than a long off-topic one. So we
 *   combine two signals:
 *     • cosine   — semantic similarity of the embeddings
 *     • lexical  — fraction of the question's MEANINGFUL words that appear in
 *                  the chunk (stopwords removed, light singularization)
 *   Offline we lean on lexical (reliable); with a real embeddings provider we
 *   lean on cosine (higher quality). This keeps the confidence gate honest:
 *   "what services do you offer?" scores high, "price of tomatoes in Kano?"
 *   scores near zero and correctly escalates.
 *
 * The KB index is produced offline by scripts/ingest.ts and cached in memory.
 */
import { cosineSimilarity, embed, usingProviderEmbeddings } from "./embeddings.js";
import { knowledge } from "./storage.js";
import type { KnowledgeChunk, RetrievalResult } from "../types.js";

// In-memory cache of the loaded index, keyed by tenant.
const indexCache = new Map<string, KnowledgeChunk[]>();
// Cache of per-chunk content-word sets (parallel to the index), keyed by tenant.
const lexCache = new Map<string, Set<string>[]>();

/**
 * Multilingual stopwords: high-frequency function/greeting words across the 5
 * supported languages. Removing these stops filler like "abeg", "how", "wetin"
 * from drowning out the meaningful term ("services").
 */
const STOPWORDS = new Set<string>([
  // English
  "the", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "am", "be",
  "do", "does", "did", "you", "your", "we", "it", "this", "that", "what", "how", "can",
  "could", "would", "should", "me", "my", "our", "us", "they", "them", "with", "at", "as",
  "by", "from", "about", "tell", "please", "want", "need", "get", "give", "so", "if", "but",
  "not", "no", "yes", "ok", "okay", "hi", "hello", "hey", "there", "have", "has", "will",
  // Nigerian Pidgin
  "abeg", "wetin", "dey", "na", "far", "make", "una", "oga", "sabi", "biko", "fit", "go",
  "come", "wan", "wey", "dem", "how",
  // Yoruba
  "bawo", "se", "ni", "mo", "fe", "jowo", "ki", "kilode", "pele", "mi",
  // Igbo
  "kedu", "ka", "gini", "maka",
  // Hausa
  "sannu", "yaya", "ina", "kana", "don", "allah", "ya", "ka", "menene",
]);

/** Cheap, stable tokenizer mirroring the embedder's. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Light singularization so "services"~"service", "agents"~"agent". */
function singular(w: string): string {
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Meaningful content words: tokenized, stopword-filtered, singularized. */
function contentWords(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(singular)
    .filter((t) => t.length > 1);
}

/** Fraction of the query's content words that appear in the chunk's word set. */
function lexicalCoverage(queryWords: string[], chunkWords: Set<string>): number {
  if (queryWords.length === 0) return 0;
  const uniqueQuery = [...new Set(queryWords)];
  let hits = 0;
  for (const w of uniqueQuery) if (chunkWords.has(w)) hits++;
  return hits / uniqueQuery.length;
}

export function loadIndex(tenant: string): KnowledgeChunk[] {
  const cached = indexCache.get(tenant);
  if (cached) return cached;
  const chunks = knowledge.load(tenant);
  indexCache.set(tenant, chunks);
  // Precompute each chunk's content-word set for fast lexical scoring.
  lexCache.set(tenant, chunks.map((c) => new Set(contentWords(c.text))));
  return chunks;
}

/** Force a reload after re-ingesting (called by the admin /reindex route). */
export function invalidateIndex(tenant: string): void {
  indexCache.delete(tenant);
  lexCache.delete(tenant);
}

export function indexSize(tenant: string): number {
  return loadIndex(tenant).length;
}

/**
 * Retrieve the top-k chunks for a query, sorted by hybrid score (desc).
 * Returns [] if the tenant has no ingested knowledge yet.
 */
export async function retrieve(
  tenant: string,
  query: string,
  k = 4,
): Promise<RetrievalResult[]> {
  const index = loadIndex(tenant);
  if (index.length === 0) return [];
  const chunkWordSets = lexCache.get(tenant) ?? [];

  const q = await embed(query);
  const queryWords = contentWords(query);

  // Lean on lexical when offline (bag-of-words); on cosine with a real provider.
  const wCos = usingProviderEmbeddings() ? 0.6 : 0.3;
  const wLex = 1 - wCos;

  const scored: RetrievalResult[] = index.map((chunk, i) => {
    const cosine = cosineSimilarity(q, chunk.embedding);
    const lexical = lexicalCoverage(queryWords, chunkWordSets[i] ?? new Set());
    return { chunk, score: wCos * cosine + wLex * lexical };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** The single best score — used by the confidence gate. */
export function topScore(results: RetrievalResult[]): number {
  return results.length > 0 ? (results[0]?.score ?? 0) : 0;
}

/**
 * Build the grounded context block injected into the system prompt, plus the
 * distinct source names (for transparent citation back to the user).
 */
export function buildContext(results: RetrievalResult[]): {
  context: string;
  sources: string[];
} {
  if (results.length === 0) return { context: "", sources: [] };

  const sources = [...new Set(results.map((r) => r.chunk.source))];
  const context = results
    .map((r, i) => `[[${i + 1}]] (source: ${r.chunk.source})\n${r.chunk.text}`)
    .join("\n\n");

  return { context, sources };
}
