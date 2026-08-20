/**
 * Storage layer — deliberately dependency-free JSON persistence.
 *
 * Why files instead of a DB? This prototype must be ONE deployable unit a
 * client can `docker run` with zero external services. Each collection is a
 * JSON file under /data/<tenant>/. Swapping this module for Prisma/Postgres
 * later is trivial because the rest of the engine only touches these funcs.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "../config.js";
import type {
  LeadRecord,
  ChatLogRecord,
  FeedbackRecord,
  LearnedAnswer,
  KnowledgeChunk,
} from "../types.js";

export function newId(prefix = ""): string {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function tenantDataDir(tenant: string): string {
  return path.join(paths.dataDir, tenant);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function fileFor(tenant: string, name: string): string {
  return path.join(tenantDataDir(tenant), `${name}.json`);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  // Write to temp then rename = atomic-ish, avoids corruption on crash.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function append<T>(tenant: string, name: string, record: T): T {
  const file = fileFor(tenant, name);
  const list = readJson<T[]>(file, []);
  list.push(record);
  writeJson(file, list);
  return record;
}

// ── Leads ──
export const leads = {
  add: (r: LeadRecord) => append(r.tenant, "leads", r),
  all: (tenant: string) => readJson<LeadRecord[]>(fileFor(tenant, "leads"), []),
};

// ── Chat logs (full transcript, for audit + learning) ──
export const chatLogs = {
  add: (r: ChatLogRecord) => append(r.tenant, "chatlogs", r),
  all: (tenant: string) => readJson<ChatLogRecord[]>(fileFor(tenant, "chatlogs"), []),
  find: (tenant: string, id: string) =>
    readJson<ChatLogRecord[]>(fileFor(tenant, "chatlogs"), []).find((c) => c.id === id),
};

// ── Feedback (👍/👎) ──
export const feedback = {
  add: (r: FeedbackRecord) => append(r.tenant, "feedback", r),
  all: (tenant: string) => readJson<FeedbackRecord[]>(fileFor(tenant, "feedback"), []),
};

// ── Learned answers (the self-improvement memory) ──
export const learned = {
  all: (tenant: string) => readJson<LearnedAnswer[]>(fileFor(tenant, "learned"), []),
  save: (tenant: string, list: LearnedAnswer[]) => writeJson(fileFor(tenant, "learned"), list),
  upsert: (tenant: string, entry: LearnedAnswer) => {
    const list = learned.all(tenant);
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    learned.save(tenant, list);
    return entry;
  },
  remove: (tenant: string, id: string) => {
    const list = learned.all(tenant).filter((e) => e.id !== id);
    learned.save(tenant, list);
  },
};

// ── Knowledge base index (embedded chunks produced by the ingest script) ──
export const knowledge = {
  file: (tenant: string) => fileFor(tenant, "kb-index"),
  load: (tenant: string) => readJson<KnowledgeChunk[]>(fileFor(tenant, "kb-index"), []),
  save: (tenant: string, chunks: KnowledgeChunk[]) => writeJson(fileFor(tenant, "kb-index"), chunks),
  exists: (tenant: string) => fs.existsSync(fileFor(tenant, "kb-index")),
};
