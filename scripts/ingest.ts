/**
 * Ingest script — turns a tenant's knowledge documents into a searchable
 * vector index. Run it whenever you add/update the business knowledge:
 *
 *   npm run ingest                # ingests the TENANT from .env
 *   TENANT=acme npm run ingest    # ingests a specific tenant
 *
 * It reads every .md / .txt file under tenants/<tenant>/knowledge/, splits
 * them into overlapping chunks, embeds each chunk, and writes the index to
 * data/<tenant>/kb-index.json (consumed by src/engine/retrieval.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { env, paths } from "../src/config.js";
import { embedBatch, usingProviderEmbeddings } from "../src/engine/embeddings.js";
import { knowledge, newId } from "../src/engine/storage.js";
import type { KnowledgeChunk } from "../src/types.js";

const CHUNK_SIZE = 900;    // characters per chunk (roughly a few paragraphs)
const CHUNK_OVERLAP = 150; // characters shared between neighbors for continuity

function listKnowledgeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listKnowledgeFiles(full));
    else if (/\.(md|markdown|txt)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** Split on paragraph boundaries, then pack into ~CHUNK_SIZE windows. */
function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";

  for (const para of paragraphs) {
    if ((buf + "\n\n" + para).length > CHUNK_SIZE && buf) {
      chunks.push(buf.trim());
      // start next buffer with a tail overlap for context continuity
      buf = buf.slice(Math.max(0, buf.length - CHUNK_OVERLAP)) + "\n\n" + para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  // Hard-split any oversized single paragraph.
  const final: string[] = [];
  for (const c of chunks) {
    if (c.length <= CHUNK_SIZE * 1.5) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        final.push(c.slice(i, i + CHUNK_SIZE));
      }
    }
  }
  return final;
}

async function main(): Promise<void> {
  const tenant = env.tenant;
  const kbDir = paths.tenantKnowledge(tenant);

  console.log(`\n[ingest] Tenant: ${tenant}`);
  console.log(`[ingest] Knowledge dir: ${kbDir}`);
  console.log(
    `[ingest] Embeddings: ${usingProviderEmbeddings() ? "provider" : "local (offline)"}\n`,
  );

  const files = listKnowledgeFiles(kbDir);
  if (files.length === 0) {
    console.warn("[ingest] No .md/.txt knowledge files found. Nothing to index.");
    knowledge.save(tenant, []);
    return;
  }

  // 1. Read + chunk every document.
  const pending: { source: string; text: string }[] = [];
  for (const file of files) {
    const source = path.relative(kbDir, file);
    const raw = fs.readFileSync(file, "utf8");
    const chunks = chunkText(raw);
    console.log(`[ingest] ${source}: ${chunks.length} chunk(s)`);
    for (const text of chunks) pending.push({ source, text });
  }

  // 2. Embed in batches (keeps provider requests reasonable).
  const BATCH = 32;
  const index: KnowledgeChunk[] = [];
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const vectors = await embedBatch(slice.map((s) => s.text));
    slice.forEach((s, j) => {
      index.push({
        id: newId("kb_"),
        source: s.source,
        text: s.text,
        embedding: vectors[j] ?? [],
      });
    });
    console.log(`[ingest] embedded ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
  }

  // 3. Persist.
  knowledge.save(tenant, index);
  console.log(`\n[ingest] ✅ Wrote ${index.length} chunks -> ${knowledge.file(tenant)}\n`);
}

main().catch((err) => {
  console.error("[ingest] FAILED:", err);
  process.exit(1);
});
