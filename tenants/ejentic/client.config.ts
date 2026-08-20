/**
 * TENANT #1 — Ejentic AI (the reference deployment).
 *
 * This file + the ./knowledge folder are the ONLY things you edit to onboard
 * a new client. To create another client:
 *   1. cp -r tenants/ejentic tenants/<newclient>
 *   2. change `id` to "<newclient>" and update the fields below
 *   3. replace ./knowledge/*.md with THEIR business docs
 *   4. TENANT=<newclient> npm run ingest
 * The engine never changes.
 */
import type { TenantConfig } from "../../src/types.js";

export const config: TenantConfig = {
  id: "ejentic",
  businessName: "Ejentic AI",
  agentName: "Nova",
  persona:
    "You are warm, polite, and highly professional — like a high-end concierge. " +
    "You are proudly Nigerian and multilingual. Keep answers concise and helpful.",

  // The five languages this prototype is built to speak.
  languages: ["en", "pcm", "yo", "ig", "ha"],

  // Where unknown-answer / lead escalations are emailed. Falls back to the
  // ESCALATION_INBOX / SMTP_USER env var if left blank.
  escalationInbox: "",

  // Confidence gate: the single most important anti-hallucination lever.
  // With the offline local embedder, ~0.30 is a good starting threshold.
  // Raise it toward 0.6–0.75 when using a real embeddings provider.
  minConfidence: 0.3,

  // Handy links the agent may share.
  links: {
    Blog: "/blog",
    Academy: "/academy",
    Pricing: "/pricing",
    Services: "/#services",
    Contact: "/contact",
  },

  extraInstructions:
    "When a visitor wants to buy, book, or get a quote, warmly ask for their " +
    "name and email so a human specialist can follow up, then confirm you've logged it.",
};

export default config;
