/**
 * Security layer — the shield around the whole agent.
 *
 * Because this agent is wired into real business systems, it is a target for:
 *   • Prompt injection ("ignore previous instructions", "reveal your system prompt")
 *   • Data exfiltration (coaxing it to dump the knowledge base / secrets)
 *   • Abuse / flooding (spam, brute force)
 *
 * This module provides three defenses used by the orchestrator + server:
 *   1. inspectInput()  — screen the USER message BEFORE it reaches the model
 *   2. sanitizeOutput()— screen the MODEL reply BEFORE it reaches the user
 *   3. rateLimit()     — per-IP token-bucket throttling
 */
import { env } from "../config.js";

// ─────────────────────────────────────────────────────────────
// 1. INPUT INSPECTION — prompt-injection / jailbreak detection
// ─────────────────────────────────────────────────────────────
const INJECTION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?|rules)/i, label: "ignore-instructions" },
  { re: /disregard\s+(the\s+)?(system|previous|above)/i, label: "disregard" },
  { re: /(reveal|show|print|repeat|expose)\s+(me\s+)?(your\s+)?(system\s+prompt|instructions|prompt|rules)/i, label: "reveal-prompt" },
  { re: /what\s+(is|are)\s+your\s+(system\s+prompt|initial\s+instructions)/i, label: "ask-prompt" },
  { re: /you\s+are\s+now\s+(a|an|in)\b/i, label: "role-override" },
  { re: /\b(developer|admin|root)\s+mode\b/i, label: "mode-override" },
  { re: /\bDAN\b|do\s+anything\s+now/i, label: "dan-jailbreak" },
  { re: /pretend\s+(to\s+be|you\s+are)\b/i, label: "pretend" },
  { re: /(dump|list|export|show)\s+(the\s+)?(entire\s+)?(database|knowledge\s*base|all\s+(leads|users|emails|records))/i, label: "data-exfil" },
  { re: /(reveal|show|give)\s+(me\s+)?(the\s+)?(api\s*key|secret|password|token|env)/i, label: "secret-exfil" },
  { re: /<\/?(system|assistant|instructions)>/i, label: "role-tag-injection" },
];

export interface InputVerdict {
  allowed: boolean;
  reason?: string;
  sanitized: string;
}

export function inspectInput(raw: string): InputVerdict {
  const text = (raw ?? "").toString();

  // Hard structural limits (defense against flooding / token bombs).
  if (text.trim().length === 0) {
    return { allowed: false, reason: "empty", sanitized: "" };
  }
  if (text.length > 4000) {
    return { allowed: false, reason: "too-long", sanitized: text.slice(0, 4000) };
  }

  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) {
      return { allowed: false, reason: `injection:${label}`, sanitized: text };
    }
  }

  // Neutralize any embedded role markers before the text reaches the model.
  const sanitized = text.replace(/<\/?(system|assistant|user|instructions)>/gi, "");
  return { allowed: true, sanitized };
}

// ─────────────────────────────────────────────────────────────
// 2. OUTPUT SANITIZATION — never let secrets/PII leak outward
// ─────────────────────────────────────────────────────────────
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,          // OpenAI-style keys
  /AIza[0-9A-Za-z\-_]{20,}/g,       // Google API keys
  /nvapi-[A-Za-z0-9\-_]{20,}/g,     // NVIDIA keys
  /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

export function sanitizeOutput(reply: string): string {
  let out = reply ?? "";
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  // Strip any accidental system-prompt echo markers.
  out = out.replace(/<\/?KNOWLEDGE>/g, "");
  return out.trim();
}

// ─────────────────────────────────────────────────────────────
// 3. RATE LIMITING — per-IP fixed window
// ─────────────────────────────────────────────────────────────
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function rateLimit(key: string): RateVerdict {
  const now = Date.now();
  const max = env.security.rateLimitMax;
  const windowMs = env.security.rateLimitWindowMs;

  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;

  if (b.count > max) {
    return { allowed: false, remaining: 0, retryAfterMs: b.resetAt - now };
  }
  return { allowed: true, remaining: max - b.count, retryAfterMs: 0 };
}

/** Best-effort single-hop client key (avoids trusting spoofable XFF chains). */
export function clientKey(headers: Record<string, unknown>, socketIp?: string): string {
  const xff = (headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  const real = headers["x-real-ip"] as string | undefined;
  return xff || real || socketIp || "unknown";
}

/** Constant-time-ish admin token check for privileged endpoints. */
export function isAdmin(token: string | undefined): boolean {
  if (!env.security.adminToken) return false; // disabled unless configured
  return token === env.security.adminToken;
}
