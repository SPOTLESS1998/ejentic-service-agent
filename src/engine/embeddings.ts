/**
 * Embeddings — turns text into vectors so we can measure semantic similarity.
 * Used by RAG retrieval, the token-saving cache, and learned answers.
 *
 * Two modes, chosen automatically:
 *  1. PROVIDER: if EMBEDDINGS_API_KEY is set, call an OpenAI-compatible
 *     /embeddings endpoint (better quality).
 *  2. LOCAL (default): a deterministic hashing bag-of-words embedder that
 *     needs no network or key — so the whole product works fully offline.
 */
import { env } from "../config.js";

const LOCAL_DIM = 512;

/** Cheap, stable tokenizer: lowercase words, strip punctuation. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** FNV-1a hash -> stable bucket index for a token. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % LOCAL_DIM;
}

/** Deterministic local embedding: hashed bag-of-words, L2-normalized. */
function localEmbed(text: string): number[] {
  const vec = new Array<number>(LOCAL_DIM).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const idx = hashToken(tok);
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  return l2normalize(vec);

}

export function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity for already-normalized (or not) vectors, 0..1-ish. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

async function providerEmbed(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${env.embeddings.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.embeddings.key}`,
    },
    body: JSON.stringify({ model: env.embeddings.model, input: texts }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Embeddings API error (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => l2normalize(d.embedding));
}

/** True when a real provider is configured. */
export function usingProviderEmbeddings(): boolean {
  return Boolean(env.embeddings.key);
}

/** Embed a batch of texts (provider if configured, else local). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (usingProviderEmbeddings()) {
    try {
      return await providerEmbed(texts);
    } catch (err) {
      console.warn("[embeddings] provider failed, falling back to local:", err);
    }
  }
  return texts.map(localEmbed);
}

/** Embed a single text. */
export async function embed(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  return v ?? localEmbed(text);
}
