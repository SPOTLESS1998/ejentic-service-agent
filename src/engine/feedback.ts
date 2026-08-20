/**
 * Feedback service — turns 👍/👎 into learning.
 *
 * The client sends back the messageId it received from /chat plus a vote.
 * We look up the original transcript, record the raw vote (audit trail), and
 * then update the learned-answer memory:
 *   👍  -> cache.reinforce  (promote/strengthen this Q→A so it's reused free)
 *   👎  -> cache.weaken      (decay/remove so a bad answer won't be repeated)
 *
 * This is the autonomous growth cycle: good answers compound, bad ones fade.
 */
import { chatLogs, feedback, newId } from "./storage.js";
import * as cache from "./cache.js";
import type { FeedbackRecord, FeedbackVote } from "../types.js";

export interface FeedbackResult {
  ok: boolean;
  message: string;
}

export async function submitFeedback(
  tenant: string,
  messageId: string,
  vote: FeedbackVote,
  note?: string,
): Promise<FeedbackResult> {
  const log = chatLogs.find(tenant, messageId);
  if (!log) {
    return { ok: false, message: "Unknown messageId — nothing to rate." };
  }

  // 1. Record the raw vote (immutable audit trail).
  const record: FeedbackRecord = {
    id: newId("fb_"),
    createdAt: new Date().toISOString(),
    tenant,
    messageId,
    vote,
    note,
  };
  feedback.add(record);

  // 2. Only real, grounded answers feed the learning loop. We never learn
  //    from blocked/escalation turns (those aren't factual answers).
  const learnable = log.kind === "answer" || log.kind === "cached";
  if (learnable) {
    if (vote === "up") {
      await cache.reinforce(tenant, log.question, log.reply, log.language);
    } else {
      await cache.weaken(tenant, log.question, log.language);
    }
  }

  return {
    ok: true,
    message:
      vote === "up"
        ? "Thanks! I'll remember this answer."
        : "Thanks for the feedback — I'll stop giving that answer and learn a better one.",
  };
}
