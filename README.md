# Ejentic Service Agent

A **reusable, self-contained multilingual customer-service agent** — one of Ejentic AI's
deployable client prototypes (a sibling to the RAG system and the lead-gen system).

It is built as **standalone infrastructure**: other systems (a website, an app, a
WhatsApp bridge, internal tools) call it over HTTP, or drop in a one-line widget. It is
**not** a chat widget bolted onto a single site.

The first tenant is **Ejentic AI** itself (agent name: **Nova**). Onboard a new client by
copying one folder — you never touch the engine.

---

## ✨ What it does (every feature is baked into the prototype)

| Requirement | How it's delivered |
|---|---|
| **Multilingual** (English, Nigerian Pidgin, Yoruba, Igbo, Hausa) | `engine/i18n.ts` detects the language and instructs the model to reply in kind; localized human-handoff messages included |
| **Knows the business, no hallucinating** | RAG grounding (`engine/retrieval.ts`) over the tenant's own docs; a **confidence gate** refuses to guess |
| **Unknown answer → get a human** | Below-confidence turns trigger `engine/escalation.ts`: capture name/email, **log** the conversation, **email** a live person |
| **Retains knowledge & self-improves** | 👍/👎 feedback (`engine/feedback.ts` + `engine/cache.ts`): good answers are remembered & reused, bad ones retired |
| **Token management for repeat questions** | Semantic cache serves vetted answers to near-identical questions with **zero model tokens** |
| **Infrastructure, not a bolt-on** | Standalone HTTP service (`src/server.ts`) with `/chat`, `/feedback`, `/health`, admin routes; embeddable `/widget.js` |
| **Robust & secure** | `engine/security.ts`: prompt-injection/jailbreak detection, secret/PII output redaction, per-IP rate limiting, admin-token-guarded endpoints, input validation |
| **Zero-downtime AI** | Provider fallback chain Gemini → FreeLLMAPI → NVIDIA → **offline mock** (runs with no keys) |

---

## 🏗️ Architecture: fixed Engine + per-tenant Config

```
ejentic-service-agent/
├── src/
│   ├── server.ts            HTTP service (chat, feedback, health, admin, widget)
│   ├── widget.ts            embeddable browser widget + demo page
│   ├── config.ts            env + dynamic tenant loader
│   ├── types.ts             shared contracts
│   └── engine/              ← THE BRAIN (identical for every client)
│       ├── orchestrator.ts  security → cache → retrieval → gate → LLM → sanitize → log
│       ├── providers.ts     Gemini → FreeLLMAPI → NVIDIA → offline mock
│       ├── retrieval.ts     RAG search + confidence scoring
│       ├── embeddings.ts    provider OR offline local embedder
│       ├── security.ts      injection guard, output redaction, rate limit
│       ├── i18n.ts          language detect + enforce (en/pcm/yo/ig/ha)
│       ├── cache.ts         semantic cache + learned-answer memory
│       ├── escalation.ts    lead capture + human email
│       ├── feedback.ts      👍/👎 → learning loop
│       └── storage.ts       dependency-free JSON persistence (→ swap for a DB later)
├── scripts/ingest.ts        build the knowledge index from a tenant's docs
├── tenants/
│   └── ejentic/             ← TENANT #1 (the only thing you edit to onboard)
│       ├── client.config.ts persona, languages, confidence gate, links
│       └── knowledge/       that client's business docs (*.md / *.txt)
├── Dockerfile / docker-compose.yml
└── .env.example
```

**Design principle:** the `engine/` is a product you never rewrite. Each client is just a
`tenants/<id>/` folder (config + knowledge). That's how one prototype serves many clients.

---

## 🚀 Quick start (runs offline, no API keys needed)

```bash
npm install
cp .env.example .env          # optional: add real keys later
npm run ingest                # build Nova's knowledge index
npm run dev                   # start the service on http://localhost:4000
```

Then open the demo: **http://localhost:4000/demo** and click the 💬 bubble.
Try asking in English, Pidgin, Yoruba, Igbo, or Hausa, and rate answers with 👍/👎.

> With no API keys, the **offline mock** answers strictly from retrieved knowledge, so the
> full pipeline (RAG, escalation, feedback, security, caching) works end-to-end. Add
> `GEMINI_API_KEY` (and/or the others) to `.env` for natural-language generation.

---

## 🔌 API

### `POST /chat`
```json
{ "message": "How far, wetin be your services?", "history": [] }
```
Response (`AgentTurn`):
```json
{
  "reply": "...",
  "kind": "answer | escalation | blocked | cached",
  "language": "pcm",
  "provider": "gemini | freellmapi | nvidia | mock | cache | gate | security",
  "confidence": 0.72,
  "sources": ["services.md"],
  "messageId": "msg_ab12...",
  "escalated": false
}
```

### `POST /feedback`  (the learning loop)
```json
{ "messageId": "msg_ab12...", "vote": "up" }
```

### `GET /health`
Config, configured providers, knowledge-chunk count, and learning stats.

### Admin (set `ADMIN_TOKEN` in `.env`, send header `X-Admin-Token`)
- `GET /admin/leads` — captured leads
- `POST /admin/reindex` — hot-reload the KB after re-ingesting

---

## 🧩 Embed on any website
```html
<script src="https://YOUR-AGENT-HOST/widget.js"></script>
```

---

## 🏢 Onboard a NEW client (no engine changes)
```bash
cp -r tenants/ejentic tenants/acme
# 1. edit tenants/acme/client.config.ts  (id: "acme", businessName, agentName, ...)
# 2. replace tenants/acme/knowledge/*.md with Acme's real docs
TENANT=acme npm run ingest
TENANT=acme npm run dev
```

---

## 🐳 Deploy
```bash
docker compose up --build      # builds KB index + starts the service on :4000
```
Runtime data (leads, chat logs, feedback, learned answers) persists in the `agent-data` volume.

---

## ⚙️ Configuration (`.env`)
See `.env.example`. Everything is optional; sensible offline defaults are used. Key knobs:
`TENANT`, `PORT`, `ALLOWED_ORIGINS`, `GEMINI_API_KEY`, `FREELLMAPI_KEY`, `NVIDIA_API_KEY`,
`EMBEDDINGS_API_KEY`, `SMTP_USER`/`SMTP_PASS`/`ESCALATION_INBOX`, `RATE_LIMIT_*`, `ADMIN_TOKEN`.

The tenant's **`minConfidence`** is the main anti-hallucination lever — raise it (0.6–0.75)
when using a real embeddings provider to make the agent escalate more eagerly.

---

## 🔐 Security notes
- Prompt-injection / jailbreak patterns are blocked **before** reaching the model.
- Replies are scanned and secrets (`sk-…`, `AIza…`, `nvapi-…`, bearer tokens, private keys) are redacted.
- Per-IP rate limiting throttles abuse; request bodies are size-limited and schema-validated.
- Admin endpoints require a token and are disabled unless `ADMIN_TOKEN` is set.
- The system prompt forbids revealing configuration/knowledge; low-confidence questions escalate instead of guessing.

_This is a prototype: for production, put it behind HTTPS + a WAF, and consider moving
storage from JSON files to a managed database (the `storage.ts` seam makes this a drop-in change)._
