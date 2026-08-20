/**
 * Escalation — the "don't hallucinate, get a human" path.
 *
 * Triggered when either:
 *   • retrieval confidence is below the tenant's minConfidence (unknown answer), or
 *   • the visitor expresses buy-intent and volunteers contact details.
 *
 * It (1) records a lead, (2) emails the tenant's human inbox, and (3) leaves
 * the transcript logged for follow-up. Email is best-effort: if SMTP is not
 * configured, the lead + log are still captured so nothing is ever lost.
 */
import nodemailer from "nodemailer";
import { env } from "../config.js";
import { leads, newId } from "./storage.js";
import type { LanguageCode, LeadRecord, TenantConfig } from "../types.js";

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  if (!env.smtp.user || !env.smtp.pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    });
  }
  return transporter;
}

/** Very light extractor so the agent can capture details from free text. */
export function extractContact(text: string): { email?: string; name?: string } {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  // "my name is X" / "I am X" / "this is X"
  const name =
    text.match(/(?:my name is|i am|i'm|this is)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i)?.[1];
  return { email, name };
}

export interface EscalationInput {
  tenant: TenantConfig;
  name: string;
  email: string;
  details: string;
  question?: string;
  reason: LeadRecord["reason"];
  language: LanguageCode;
}

export async function escalate(input: EscalationInput): Promise<LeadRecord> {
  const lead: LeadRecord = {
    id: newId("lead_"),
    createdAt: new Date().toISOString(),
    tenant: input.tenant.id,
    name: input.name || "Unknown",
    email: input.email || "unknown@unknown",
    details: input.details,
    reason: input.reason,
    question: input.question,
    language: input.language,
    consent: true, // they volunteered contact details asking to be reached
  };

  // 1. Persist the lead (never lost, even if email fails).
  leads.add(lead);
  console.log(`[escalation] lead captured (${lead.reason}) for tenant ${lead.tenant}: ${lead.email}`);

  // 2. Best-effort email to the human inbox.
  const tx = getTransporter();
  const inbox = input.tenant.escalationInbox || env.smtp.escalationInbox;
  if (tx && inbox) {
    const subject =
      input.reason === "unknown_answer"
        ? `🟡 ${input.tenant.businessName}: question the agent couldn't answer`
        : `🟢 ${input.tenant.businessName}: new lead from the agent`;
    try {
      await tx.sendMail({
        from: `"${input.tenant.agentName} (Agent)" <${env.smtp.user}>`,
        to: inbox,
        subject,
        text:
          `Reason: ${input.reason}\n` +
          `Name: ${lead.name}\n` +
          `Email: ${lead.email}\n` +
          `Language: ${lead.language}\n` +
          (input.question ? `Question: ${input.question}\n` : "") +
          `Details: ${input.details}\n` +
          `Time: ${lead.createdAt}\n`,
      });
      console.log(`[escalation] notified human inbox: ${inbox}`);
    } catch (err) {
      console.warn("[escalation] email failed (lead still saved):", err);
    }
  } else {
    console.log("[escalation] SMTP not configured — skipping email, lead saved.");
  }

  return lead;
}
