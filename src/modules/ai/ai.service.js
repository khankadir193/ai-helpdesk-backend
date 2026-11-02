import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import aiProvider from "./ai.provider.js";
import categoryService from "../categories/category.service.js";
import commentService from "../comments/comment.service.js";
import ticketRepository from "../tickets/ticket.repository.js";
import ticketService from "../tickets/ticket.service.js";
import { TICKET_PRIORITIES } from "../tickets/ticket.validation.js";

const CLASSIFICATION_SUGGESTION_TYPE = "CLASSIFICATION";
const PRIORITY_SUGGESTION_TYPE = "PRIORITY";
const REPLY_DRAFT_SUGGESTION_TYPE = "REPLY_DRAFT";
const SUMMARY_SUGGESTION_TYPE = "SUMMARY";
const CLASSIFICATION_PROVIDER = "groq";
const PRIORITY_PROVIDER = "groq";
const REPLY_DRAFT_PROVIDER = "groq";
const SUMMARY_PROVIDER = "groq";

/** Cap sent/parsed free text so prompts and stored results stay bounded. */
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_REASON_LENGTH = 1000;

// Reply-draft and summary bounds: prompts and stored results stay bounded
// and the customer-visible conversation never contains internal comments.
const MAX_DRAFT_LENGTH = 4000;
const MAX_CONVERSATION_COMMENTS = 20;
const MAX_CONVERSATION_LENGTH = 6000;

// Summary bounds: each generated part and each list item is capped so a
// stored summary result stays bounded no matter how verbose the model is.
const MAX_SUMMARY_TEXT_LENGTH = 2000;
const MAX_SUMMARY_ITEM_LENGTH = 500;
const MAX_SUMMARY_ITEMS = 12;

/**
 * Classification suggestions below this confidence level are still returned
 * and stored (status PENDING) — the caller decides — because the ticket is
 * never modified automatically. The threshold is only used to log a warning
 * server-side.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Serialize an ai_suggestions row into the public API shape.
 *
 * @param {object} row
 * @returns {object}
 */
function serializeSuggestion(row) {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    suggestion_type: row.suggestion_type,
    provider: row.provider,
    model_name: row.model_name,
    status: row.status,
    result: row.result,
    created_at: row.created_at,
  };
}

/**
 * Build the messages sent to the AI provider. Only the ticket title and
 * description are shared (docs/07 — send the minimum needed fields); no
 * customer identity, emails, comments, or internal data.
 *
 * @param {{ title: string, description: string }} ticket
 * @param {Array<{ id: string|number, name: string }>} categories
 * @returns {{ system: string, user: string }}
 */
function buildClassificationMessages(ticket, categories) {
  const description = String(ticket.description ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);
  const categoryList = categories.map((category) => category.name).join("\n- ");

  const system =
    "You are a support ticket classifier for a help desk. " +
    "Classify the ticket into exactly one category from the provided list. " +
    "Respond ONLY with a JSON object and nothing else, using exactly this shape: " +
    "{\"suggestedCategory\": \"<one of the allowed categories>\", " +
    "\"confidence\": <number between 0 and 1>, " +
    "\"reason\": \"<one short sentence explaining the choice>\"}. " +
    "suggestedCategory must match an allowed category name exactly. " +
    "confidence must be a number from 0 to 1. Never invent categories.";

  const user =
    `Ticket title:\n${ticket.title}\n\n` +
    `Ticket description:\n${description}\n\n` +
    "Allowed active categories (choose exactly one):\n- " +
    `${categoryList}`;

  return { system, user };
}

/**
 * Parse and strictly validate the raw AI response.
 * AI output is untrusted input (docs/07): every field is type-checked and
 * the suggested name must match one of the current ACTIVE categories exactly
 * (case-insensitive). Returns the validated classification or throws 502.
 *
 * @param {string} content
 * @param {Array<{ id: string|number, name: string }>} categories
 * @returns {{ result: object, suggestedCategoryId: string }}
 */
function validateClassificationResponse(content, categories) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ApiError(502, "AI returned a non-JSON classification response.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(502, "AI returned an invalid classification response.");
  }

  const rawName = parsed.suggestedCategory;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new ApiError(502, "AI returned an invalid category name.");
  }

  const confidence = parsed.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new ApiError(
      502,
      "AI returned an invalid confidence value. Must be a number between 0 and 1.",
    );
  }

  const reason = parsed.reason;
  if (typeof reason !== "string") {
    throw new ApiError(502, "AI returned an invalid reason. Must be a string.");
  }

  // Restricted to the active categories fetched from PostgreSQL.
  const matched = categories.find(
    (category) =>
      category.name.toLowerCase() === rawName.trim().toLowerCase(),
  );
  if (!matched) {
    throw new ApiError(
      502,
      "AI suggested a category that is not in the active category list.",
    );
  }

  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    // Stored as PENDING and surfaced to the caller — never auto-applied.
    console.warn(
      `[AI module] Classification for ticket produced low confidence: ${confidence}`,
    );
  }

  return {
    result: {
      suggestedCategory: matched.name,
      suggestedCategoryId: String(matched.id),
      confidence,
      reason: reason.trim().slice(0, MAX_REASON_LENGTH),
    },
    suggestedCategoryId: String(matched.id),
  };
}

/**
 * Build the messages sent to the AI provider for a priority suggestion.
 * Same data-minimisation rule as classification: only title and description
 * are shared; no customer identity, emails, comments, or internal data.
 * The priority levels come from TICKET_PRIORITIES so prompt and validation
 * share one source of truth.
 *
 * @param {{ title: string, description: string }} ticket
 * @returns {{ system: string, user: string }}
 */
function buildPriorityMessages(ticket) {
  const description = String(ticket.description ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);
  const priorityList = TICKET_PRIORITIES.join(", ");

  const system =
    "You are a support ticket priority assessor for a help desk. " +
    "Assess the urgency of the ticket and suggest exactly one priority level. " +
    "Respond ONLY with a JSON object and nothing else, using exactly this shape: " +
    "{\"suggestedPriority\": \"<one of: LOW, MEDIUM, HIGH, URGENT>\", " +
    "\"confidence\": <number between 0 and 1>, " +
    "\"reason\": \"<one short sentence explaining the choice>\"}. " +
    "suggestedPriority must be exactly one of the allowed priority levels. " +
    "confidence must be a number from 0 to 1. Never invent priorities.";

  const user =
    `Ticket title:\n${ticket.title}\n\n` +
    `Ticket description:\n${description}\n\n` +
    `Allowed priorities (choose exactly one):\n- ${priorityList}`;

  return { system, user };
}

/**
 * Parse and strictly validate the raw AI priority response.
 * AI output is untrusted input (docs/07): every field is type-checked and
 * the suggested priority must match one of the allowed levels exactly
 * (case-insensitive). Returns the validated priority or throws 502.
 *
 * @param {string} content
 * @returns {{ suggestedPriority: string, confidence: number, reason: string }}
 */
function validatePriorityResponse(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ApiError(502, "AI returned a non-JSON priority response.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(502, "AI returned an invalid priority response.");
  }

  const rawPriority = parsed.suggestedPriority;
  if (typeof rawPriority !== "string" || rawPriority.trim().length === 0) {
    throw new ApiError(502, "AI returned an invalid priority name.");
  }

  // Restricted to the existing ticket priority levels only.
  const normalized = rawPriority.trim().toUpperCase();
  if (!TICKET_PRIORITIES.includes(normalized)) {
    throw new ApiError(
      502,
      "AI suggested a priority that is not one of the allowed priority levels.",
    );
  }

  const confidence = parsed.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new ApiError(
      502,
      "AI returned an invalid confidence value. Must be a number between 0 and 1.",
    );
  }

  const reason = parsed.reason;
  if (typeof reason !== "string") {
    throw new ApiError(502, "AI returned an invalid reason. Must be a string.");
  }

  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    // Stored as PENDING and surfaced to the caller — never auto-applied.
    console.warn(
      `[AI module] Priority suggestion for ticket produced low confidence: ${confidence}`,
    );
  }

  return {
    suggestedPriority: normalized,
    confidence,
    reason: reason.trim().slice(0, MAX_REASON_LENGTH),
  };
}

/**
 * Build the messages sent to the AI provider for a customer-facing reply
 * draft. Context is limited to the ticket title/description, metadata the
 * agent already shares with the customer (category name and priority), and
 * the customer-visible comment thread produced by
 * commentService.listCustomerVisibleComments (internal notes are never
 * included — docs/07). No customer identity data is sent.
 *
 * The prompt explicitly forbids invented solutions or claims that actions
 * were completed; the model returns ONLY {"draft": "..."}.
 *
 * @param {{ title: string, description: string, categoryName: string|null,
 *           priority: string }} ticket
 * @param {Array<{ message: string, author_role: string }>} comments
 * @returns {{ system: string, user: string }}
 */
function buildReplyDraftMessages(ticket, comments) {
  const description = String(ticket.description ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);

  const system =
    "You are a support agent writing the next customer-facing reply for a " +
    "help desk ticket. The reply will be reviewed and edited by a human " +
    "agent before it is sent. " +
    "Rules for the draft: " +
    "- Base the reply ONLY on the ticket and conversation provided. Never " +
    "invent solutions, reasons, timelines, refunds, or facts. " +
    "- Never claim that an investigation, fix, or any action has already " +
    "been completed unless the conversation shows it. You may say what the " +
    "support team will do next when that is a known process. " +
    "- If information is missing, ask one or two specific questions instead " +
    "of guessing. " +
    "- Acknowledge the customer's issue politely and keep the reply " +
    "concise (at most 200 words), plain text. " +
    "Respond ONLY with a JSON object and nothing else, using exactly this " +
    "shape: {\"draft\": \"<the reply text>\"}. Never write anything outside the JSON object.";

  const lines = [
    "Ticket title:",
    ticket.title,
    "",
    "Ticket description:",
    description,
    "",
    `Ticket category: ${ticket.categoryName ?? "not assigned"}`,
    `Ticket priority: ${ticket.priority}`,
    "",
  ];

  if (comments.length === 0) {
    lines.push(
      "Customer conversation: (no customer-visible comments yet; draft the first reply based on the ticket details above)",
    );
  } else {
    // Keep the most recent MAX_CONVERSATION_COMMENTS messages, then spend
    // the total character budget from the newest message backwards so an
    // oversized thread truncates its oldest turns — the newest context is
    // the most relevant for the next reply. The kept turns are emitted in
    // chronological order.
    const turns = [];
    let budget = MAX_CONVERSATION_LENGTH;
    for (const comment of [...comments.slice(-MAX_CONVERSATION_COMMENTS)].reverse()) {
      if (budget <= 0) break;
      const message = String(comment.message ?? "").slice(0, budget);
      budget -= message.length;
      const role =
        comment.author_role === "CUSTOMER" ? "Customer" : "Support agent";
      turns.push({ role, message });
    }
    turns.reverse();
    lines.push("Customer conversation (oldest first):");
    lines.push(...turns.map((turn) => `${turn.role}: ${turn.message}`));
  }

  return { system, user: lines.join("\n") };
}

/**
 * Parse and strictly validate the raw AI reply-draft response.
 * AI output is untrusted input (docs/07): only the exact shape
 * {"draft": "<non-empty string>"} is accepted, and the text is trimmed,
 * length-capped, and length-checked. A whitespace-only or oversized-to-
 * empty draft is rejected with 502 and nothing is stored.
 *
 * @param {string} content
 * @returns {{ result: object, draft: string }}
 */
function validateReplyDraftResponse(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ApiError(502, "AI returned a non-JSON reply draft response.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(502, "AI returned an invalid reply draft response.");
  }

  const rawDraft = parsed.draft;
  if (typeof rawDraft !== "string") {
    throw new ApiError(502, "AI returned an invalid reply draft. Must be a string.");
  }

  const draft = rawDraft.trim().slice(0, MAX_DRAFT_LENGTH);
  if (!draft) {
    throw new ApiError(502, "AI returned an empty reply draft.");
  }

  return { result: { draft }, draft };
}

/**
 * Build the messages sent to the AI provider for an internal conversation
 * summary. Context mirrors the reply draft: ticket title/description,
 * metadata the agent already sees (category name, priority, status), and the
 * customer-visible comment thread from
 * commentService.listCustomerVisibleComments (internal notes are never
 * included — docs/07). No customer identity data is sent.
 *
 * The prompt explicitly separates known facts (given ticket fields and
 * performed actions visible in the conversation) from unknown information
 * and forbids invented solutions or completed troubleshooting steps.
 * The model returns ONLY the {"mainIssue"| "details" | "troubleshootingDone"
 * | "currentStatus" | "nextSteps"} JSON object.
 *
 * @param {{ title: string, description: string, categoryName: string|null,
 *           priority: string, status: string }} ticket
 * @param {Array<{ message: string, author_role: string }>} comments
 * @returns {{ system: string, user: string }}
 */
function buildSummaryMessages(ticket, comments) {
  const description = String(ticket.description ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);

  const system =
    "You are a support ticket summarizer for a help desk. Your summary is " +
    "read by support agents to understand a ticket without reading every " +
    "comment. " +
    "Rules for the summary: " +
    "- Base the summary ONLY on the ticket information and the conversation " +
    "provided. Never invent solutions, reasons, timelines, refunds, or " +
    "facts. " +
    "- currentStatus must state the ticket's current status using the exact " +
    "status value provided below, plus a short statement of where the issue " +
    "currently stands. " +
    "- troubleshootingDone must list only steps the conversation shows were " +
    "ACTUALLY performed by the customer or support. If none are shown, " +
    "return an empty array. Never invent completed actions or steps. " +
    "- If information is missing or unknown, leave it out of details and " +
    "nextSteps instead of guessing; unknown things are never claimed as " +
    "completed. " +
    "- Keep it concise, plain text, no markdown headings: mainIssue at most " +
    "2 sentences; each list item at most 40 words; at most 8 items per " +
    "list; currentStatus at most 2 sentences; at most 8 nextSteps items. " +
    "Respond ONLY with a JSON object and nothing else, using exactly this " +
    "shape: {\"mainIssue\": \"<the customer's main issue in one or two " +
    "sentences>\", " +
    "\"details\": [\"<important detail>\", \"...\"], " +
    "\"troubleshootingDone\": [\"<a step that was actually performed>\", " +
    "\"...\"], " +
    "\"currentStatus\": \"<the current status value and where the issue " +
    "stands>\", " +
    "\"nextSteps\": [\"<a pending action or next step>\", \"...\"]}. " +
    "Every value must be a string or an array of strings. Never write " +
    "anything outside the JSON object.";

  const lines = [
    "Ticket title:",
    ticket.title,
    "",
    "Ticket description:",
    description,
    "",
    `Ticket category: ${ticket.categoryName ?? "not assigned"}`,
    `Ticket priority: ${ticket.priority}`,
    `Ticket status: ${ticket.status}`,
    "",
  ];

  if (comments.length === 0) {
    lines.push(
      "Conversation: (no comments yet; summarize the issue from the ticket details above)",
    );
  } else {
    // Same trimming strategy as the reply draft: keep the most recent
    // MAX_CONVERSATION_COMMENTS messages and spend the total character
    // budget from the newest message backwards so an oversized thread
    // truncates its oldest turns. The kept turns are emitted in
    // chronological order.
    const turns = [];
    let budget = MAX_CONVERSATION_LENGTH;
    for (const comment of [...comments.slice(-MAX_CONVERSATION_COMMENTS)].reverse()) {
      if (budget <= 0) break;
      const message = String(comment.message ?? "").slice(0, budget);
      budget -= message.length;
      const role =
        comment.author_role === "CUSTOMER" ? "Customer" : "Support agent";
      turns.push({ role, message });
    }
    turns.reverse();
    lines.push("Conversation (oldest first):");
    lines.push(...turns.map((turn) => `${turn.role}: ${turn.message}`));
  }

  return { system, user: lines.join("\n") };
}

/**
 * Parse and strictly validate the raw AI summary response.
 * AI output is untrusted input (docs/07): every field is type-checked,
 * trimmed, and length-capped. mainIssue and each list item must be
 * non-empty strings after trimming; list fields (details,
 * troubleshootingDone, nextSteps) must be arrays. Returns the validated
 * summary or throws 502 so nothing invalid is ever stored.
 *
 * @param {string} content
 * @returns {{ result: object }}
 */
function validateSummaryResponse(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ApiError(502, "AI returned a non-JSON summary response.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(502, "AI returned an invalid summary response.");
  }

  /**
   * Validate one string field (trimmed, capped, non-empty).
   *
   * @param {string} name
   * @param {unknown} value
   * @returns {string}
   */
  function requireText(name, value) {
    if (typeof value !== "string") {
      throw new ApiError(502, `AI returned an invalid ${name}. Must be a string.`);
    }
    const text = value.trim().slice(0, MAX_SUMMARY_TEXT_LENGTH);
    if (!text) {
      throw new ApiError(502, `AI returned an empty ${name}.`);
    }
    return text;
  }

  /**
   * Validate one array field (strings only, each non-empty after trimming
   * and length-capped; the whole array is capped at MAX_SUMMARY_ITEMS).
   *
   * @param {string} name
   * @param {unknown} value
   * @returns {string[]}
   */
  function requireTextList(name, value) {
    if (!Array.isArray(value)) {
      throw new ApiError(
        502,
        `AI returned an invalid ${name}. Must be an array of strings.`,
      );
    }
    return value.slice(0, MAX_SUMMARY_ITEMS).map((item) => {
      if (typeof item !== "string") {
        throw new ApiError(
          502,
          `AI returned an invalid ${name}. Every item must be a string.`,
        );
      }
      const text = item.trim().slice(0, MAX_SUMMARY_ITEM_LENGTH);
      if (!text) {
        throw new ApiError(
          502,
          `AI returned an empty item in ${name}. Items must be non-empty strings.`,
        );
      }
      return text;
    });
  }

  const mainIssue = requireText("mainIssue", parsed.mainIssue);
  const details = requireTextList("details", parsed.details);
  const troubleshootingDone = requireTextList(
    "troubleshootingDone",
    parsed.troubleshootingDone,
  );
  const currentStatus = requireText("currentStatus", parsed.currentStatus);
  const nextSteps = requireTextList("nextSteps", parsed.nextSteps);

  return {
    result: {
      mainIssue,
      details,
      troubleshootingDone,
      currentStatus,
      nextSteps,
    },
  };
}

/**
 * Classify a ticket with an AI provider and store the suggestion.
 *
 * Authorization: AGENT (assigned tickets only) or ADMIN (all). The ticket,
 * its active category names, and the id of the acting user are resolved from
 * PostgreSQL — never from the request body. The suggestion is stored in
 * ai_suggestions with status PENDING. The ticket row itself is NEVER
 * modified: category, priority, status, and assignment all require an
 * explicit human action (docs/07).
 *
 * @param {string|number} ticketId — validated positive integer (route level)
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<object>} the stored suggestion (API shape)
 */
async function classifyTicket(ticketId, user) {
  const row = await ticketRepository.findTicketById(ticketId);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!ticketService.canAccessTicket(user, row)) {
    throw new ApiError(
      403,
      "Forbidden. You are not authorized to access this ticket.",
    );
  }

  // Active categories for the classifier. Non-admin roles always receive
  // active-only categories, which is exactly what prompt/whitelist need.
  const categories = await categoryService.listCategories({ role: "AGENT" });
  if (categories.length === 0) {
    throw new ApiError(
      503,
      "AI classification is unavailable because no active categories exist.",
    );
  }

  const messages = buildClassificationMessages(
    { title: row.title, description: row.description },
    categories,
  );

  const { content, model } = await aiProvider.generateCompletion({
    ...messages,
    operation: "classification request",
  });
  const classification = validateClassificationResponse(content, categories);

  const { rows } = await database.query(
    `INSERT INTO ai_suggestions
       (ticket_id, requested_by, suggestion_type, result, provider, model_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
     RETURNING id, ticket_id, suggestion_type, result, provider, model_name,
               status, created_at`,
    [
      String(row.id),
      user.id,
      CLASSIFICATION_SUGGESTION_TYPE,
      JSON.stringify(classification.result),
      CLASSIFICATION_PROVIDER,
      model,
    ],
  );

  return serializeSuggestion(rows[0]);
}

/**
 * Suggest a ticket priority with an AI provider and store the suggestion.
 *
 * Authorization and ticket resolution are identical to classifyTicket:
 * AGENT (assigned tickets only) or ADMIN (all). The suggestion is stored in
 * ai_suggestions with suggestion_type PRIORITY and status PENDING. The
 * ticket's actual priority is NEVER modified: applying a suggested
 * priority is an explicit human action through the ticket update endpoint
 * (docs/07).
 *
 * @param {string|number} ticketId — validated positive integer (route level)
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<object>} the stored suggestion (API shape)
 */
async function suggestTicketPriority(ticketId, user) {
  const row = await ticketRepository.findTicketById(ticketId);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!ticketService.canAccessTicket(user, row)) {
    throw new ApiError(
      403,
      "Forbidden. You are not authorized to access this ticket.",
    );
  }

  // Guard against empty input (docs/07 — AI input is untrusted too). A
  // degraded or hand-migrated row with blank text must fail safely instead
  // of prompting the provider with an empty request.
  const title = String(row.title ?? "").trim();
  const description = String(row.description ?? "").trim();
  if (!title || !description) {
    throw new ApiError(
      422,
      "Ticket title and description are required for a priority suggestion.",
    );
  }

  const messages = buildPriorityMessages({ title, description });

  const { content, model } = await aiProvider.generateCompletion({
    ...messages,
    operation: "priority suggestion request",
  });
  const priority = validatePriorityResponse(content);

  const { rows } = await database.query(
    `INSERT INTO ai_suggestions
       (ticket_id, requested_by, suggestion_type, result, provider, model_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
     RETURNING id, ticket_id, suggestion_type, result, provider, model_name,
               status, created_at`,
    [
      String(row.id),
      user.id,
      PRIORITY_SUGGESTION_TYPE,
      JSON.stringify({
        suggestedPriority: priority.suggestedPriority,
        currentPriority: row.priority,
        confidence: priority.confidence,
        reason: priority.reason,
      }),
      PRIORITY_PROVIDER,
      model,
    ],
  );

  return serializeSuggestion(rows[0]);
}

/**
 * Generate a customer-facing reply draft for support agents (REPLY_DRAFT).
 *
 * Authorization and ticket resolution are identical to classifyTicket:
 * AGENT (assigned tickets only) or ADMIN (all). The draft is generated ONLY
 * (docs/07): it is stored in ai_suggestions with status PENDING and never
 * converted into a ticket comment, and the ticket's status, priority, and
 * category are never changed. Promoting the draft into a comment is an
 * explicit human action by the agent.
 *
 * @param {string|number} ticketId — validated positive integer (route level)
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<object>} the stored suggestion (API shape)
 */
async function generateReplyDraft(ticketId, user) {
  const row = await ticketRepository.findTicketById(ticketId);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!ticketService.canAccessTicket(user, row)) {
    throw new ApiError(
      403,
      "Forbidden. You are not authorized to access this ticket.",
    );
  }

  // Guard against empty input (docs/07 — AI input is untrusted too), same
  // blank-row protection as the priority suggestion.
  const title = String(row.title ?? "").trim();
  const description = String(row.description ?? "").trim();
  if (!title || !description) {
    throw new ApiError(
      422,
      "Ticket title and description are required for a reply draft.",
    );
  }

  // Customer-visible conversation only (internal notes excluded); bounded
  // by buildReplyDraftMessages. A ticket without comments drafts its first
  // reply from the title and description alone.
  const comments = await commentService.listCustomerVisibleComments(row.id);

  const messages = buildReplyDraftMessages(
    {
      title,
      description,
      categoryName: row.category_name ?? null,
      priority: row.priority,
    },
    comments,
  );

  const { content, model } = await aiProvider.generateCompletion({
    ...messages,
    operation: "reply draft request",
  });
  const replyDraft = validateReplyDraftResponse(content);

  const { rows } = await database.query(
    `INSERT INTO ai_suggestions
       (ticket_id, requested_by, suggestion_type, result, provider, model_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
     RETURNING id, ticket_id, suggestion_type, result, provider, model_name,
               status, created_at`,
    [
      String(row.id),
      user.id,
      REPLY_DRAFT_SUGGESTION_TYPE,
      JSON.stringify(replyDraft.result),
      REPLY_DRAFT_PROVIDER,
      model,
    ],
  );

  return serializeSuggestion(rows[0]);
}

/**
 * Generate an internal conversation summary for support agents (SUMMARY).
 *
 * Authorization and ticket resolution are identical to classifyTicket:
 * AGENT (assigned tickets only) or ADMIN (all). The summary is generated
 * ONLY (docs/07): it is stored in ai_suggestions with status PENDING and it
 * never modifies the ticket — status, priority, category, and assignment
 * are untouched, and no comment is created automatically.
 *
 * @param {string|number} ticketId — validated positive integer (route level)
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<object>} the stored suggestion (API shape)
 */
async function generateSummary(ticketId, user) {
  const row = await ticketRepository.findTicketById(ticketId);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!ticketService.canAccessTicket(user, row)) {
    throw new ApiError(
      403,
      "Forbidden. You are not authorized to access this ticket.",
    );
  }

  // Guard against empty input (docs/07 — AI input is untrusted too), same
  // blank-row protection as the priority suggestion and reply draft.
  const title = String(row.title ?? "").trim();
  const description = String(row.description ?? "").trim();
  if (!title || !description) {
    throw new ApiError(
      422,
      "Ticket title and description are required for a conversation summary.",
    );
  }

  // Customer-visible conversation only (internal notes excluded); bounded
  // by buildSummaryMessages. A ticket without comments is summarized from
  // the ticket details alone.
  const comments = await commentService.listCustomerVisibleComments(row.id);

  const messages = buildSummaryMessages(
    {
      title,
      description,
      categoryName: row.category_name ?? null,
      priority: row.priority,
      status: row.status,
    },
    comments,
  );

  const { content, model } = await aiProvider.generateCompletion({
    ...messages,
    operation: "conversation summary request",
  });
  const summary = validateSummaryResponse(content);

  const { rows } = await database.query(
    `INSERT INTO ai_suggestions
       (ticket_id, requested_by, suggestion_type, result, provider, model_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
     RETURNING id, ticket_id, suggestion_type, result, provider, model_name,
               status, created_at`,
    [
      String(row.id),
      user.id,
      SUMMARY_SUGGESTION_TYPE,
      JSON.stringify({
        ...summary.result,
        // Known fact from the ticket row — not AI output — so consumers can
        // compare the model's currentStatus narrative against the real value.
        ticketStatus: row.status,
      }),
      SUMMARY_PROVIDER,
      model,
    ],
  );

  return serializeSuggestion(rows[0]);
}

export default {
  classifyTicket,
  suggestTicketPriority,
  generateReplyDraft,
  generateSummary,
  serializeSuggestion,
  // Exported for targeted tests of the pure validation logic.
  validateClassificationResponse,
  buildClassificationMessages,
  validatePriorityResponse,
  buildPriorityMessages,
  validateReplyDraftResponse,
  buildReplyDraftMessages,
  validateSummaryResponse,
  buildSummaryMessages,
};
