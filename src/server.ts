/**
 * HTTP server — exposes the agent as standalone INFRASTRUCTURE.
 *
 * This is the key architectural choice: the agent is a service other systems
 * call over HTTP (a website, a mobile app, WhatsApp bridge, internal tools),
 * NOT a widget bolted onto one site. A drop-in browser widget is also served
 * from /widget.js for the simplest possible client integration.
 *
 * Endpoints:
 *   GET  /health          liveness + config/knowledge/learning stats
 *   POST /chat            { message, history? } -> AgentTurn
 *   POST /feedback        { messageId, vote, note? } -> learning update
 *   GET  /widget.js       embeddable chat widget (vanilla JS, no build step)
 *   GET  /demo            a tiny page that loads the widget for local testing
 *   GET  /admin/leads     (admin token) captured leads
 *   POST /admin/reindex   (admin token) hot-reload the KB after re-ingest
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { env, loadTenant } from "./config.js";
import type { TenantConfig } from "./types.js";
import { handleTurn } from "./engine/orchestrator.js";
import { submitFeedback } from "./engine/feedback.js";
import { rateLimit, clientKey, isAdmin } from "./engine/security.js";
import { configuredProviders } from "./engine/providers.js";
import { indexSize, invalidateIndex } from "./engine/retrieval.js";
import * as cacheEngine from "./engine/cache.js";
import { leads } from "./engine/storage.js";
import { widgetScript, demoPage } from "./widget.js";

// ── Validation schemas ──
const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional(),
});
const feedbackSchema = z.object({
  messageId: z.string().min(1),
  vote: z.enum(["up", "down"]),
  note: z.string().max(1000).optional(),
});

async function main(): Promise<void> {
  const tenant: TenantConfig = await loadTenant();
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // ── CORS (config-driven allow-list) ──
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const allowAll = env.allowedOrigins.includes("*");
    if (allowAll) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && env.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ── Per-IP rate limiting on the whole API ──
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Static assets / health are cheap; still counted, but limit is generous.
    const key = clientKey(req.headers as Record<string, unknown>, req.socket.remoteAddress ?? undefined);
    const verdict = rateLimit(key);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", Math.ceil(verdict.retryAfterMs / 1000).toString());
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }
    next();
  });

  // ── Health ──
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      tenant: { id: tenant.id, businessName: tenant.businessName, agentName: tenant.agentName },
      languages: tenant.languages,
      providers: { configured: configuredProviders(), fallback: "mock (offline) always available" },
      knowledgeChunks: indexSize(tenant.id),
      learning: cacheEngine.stats(tenant.id),
      minConfidence: tenant.minConfidence,
    });
  });

  // ── Chat ──
  app.post("/chat", async (req: Request, res: Response) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const ip = clientKey(req.headers as Record<string, unknown>, req.socket.remoteAddress ?? undefined);
    try {
      const turn = await handleTurn({
        tenant,
        message: parsed.data.message,
        history: parsed.data.history,
        ip,
      });
      res.json(turn);
    } catch (err) {
      console.error("[/chat] error:", err);
      res.status(500).json({ error: "The agent had trouble. Please try again." });
    }
  });

  // ── Feedback (the learning loop) ──
  app.post("/feedback", async (req: Request, res: Response) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid feedback", details: parsed.error.flatten() });
    }
    const result = await submitFeedback(
      tenant.id,
      parsed.data.messageId,
      parsed.data.vote,
      parsed.data.note,
    );
    res.status(result.ok ? 200 : 404).json(result);
  });

  // ── Embeddable widget + demo page ──
  app.get("/widget.js", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.send(widgetScript(tenant));
  });
  app.get("/demo", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(demoPage(tenant));
  });

  // ── Admin (guarded by ADMIN_TOKEN; disabled if unset) ──
  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!isAdmin(req.header("X-Admin-Token"))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  }
  app.get("/admin/leads", requireAdmin, (_req: Request, res: Response) => {
    res.json(leads.all(tenant.id));
  });
  app.post("/admin/reindex", requireAdmin, (_req: Request, res: Response) => {
    invalidateIndex(tenant.id);
    res.json({ ok: true, knowledgeChunks: indexSize(tenant.id) });
  });

  app.listen(env.port, () => {
    console.log(`\n🤖 ${tenant.agentName} — ${tenant.businessName} customer-service agent`);
    console.log(`   Listening on http://localhost:${env.port}`);
    console.log(`   Demo:   http://localhost:${env.port}/demo`);
    console.log(`   Health: http://localhost:${env.port}/health`);
    console.log(`   Providers: ${configuredProviders().join(", ") || "none (offline mock)"} `);
    console.log(`   Knowledge chunks: ${indexSize(tenant.id)} (run \`npm run ingest\` to (re)build)\n`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
