/**
 * Central configuration: reads environment + loads the active tenant.
 *
 * The engine reads everything through this module, so nothing in engine/
 * hardcodes a provider key, a port, or a business detail.
 */
import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TenantConfig } from "./types.js";

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  tenant: process.env.TENANT || "ejentic",
  port: num(process.env.PORT, 4000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  gemini: {
    key: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  },
  freellmapi: {
    key: process.env.FREELLMAPI_KEY || "",
    baseUrl: (process.env.FREELLMAPI_BASE_URL || "http://localhost:3001/v1").replace(/\/+$/, ""),
  },
  nvidia: {
    key: process.env.NVIDIA_API_KEY || "",
    model: process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct",
  },
  embeddings: {
    key: process.env.EMBEDDINGS_API_KEY || "",
    baseUrl: (process.env.EMBEDDINGS_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.EMBEDDINGS_MODEL || "text-embedding-3-small",
  },
  smtp: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    escalationInbox: process.env.ESCALATION_INBOX || process.env.SMTP_USER || "",
  },
  security: {
    rateLimitMax: num(process.env.RATE_LIMIT_MAX, 30),
    rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    adminToken: process.env.ADMIN_TOKEN || "",
  },
};

// Absolute paths anchored at the repo root (this file lives in /src).
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const paths = {
  root: ROOT,
  tenants: path.join(ROOT, "tenants"),
  dataDir: path.join(ROOT, "data"),
  tenantDir: (id: string) => path.join(ROOT, "tenants", id),
  tenantKnowledge: (id: string) => path.join(ROOT, "tenants", id, "knowledge"),
};

/**
 * Dynamically import the active tenant's config module.
 * A tenant folder must export `config: TenantConfig` (default or named).
 */
export async function loadTenant(id: string = env.tenant): Promise<TenantConfig> {
  const file = path.join(paths.tenantDir(id), "client.config.ts");
  const mod = await import(pathToFileURL(file).href);
  const cfg: TenantConfig = mod.config ?? mod.default;
  if (!cfg || cfg.id !== id) {
    throw new Error(
      `Tenant "${id}" config missing or its id does not match folder name (got "${cfg?.id}").`,
    );
  }
  return cfg;
}
