import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import aiProvider from "./ai.provider.js";
import categoryService from "../categories/category.service.js";
import ticketRepository from "../tickets/ticket.repository.js";
import ticketService from "../tickets/ticket.service.js";
import { TICKET_PRIORITIES } from "../tickets/ticket.validation.js";

const CLASSIFICATION_SUGGESTION_TYPE = "CLASSIFICATION";
const PRIORITY_SUGGESTION_TYPE = "PRIORITY";
const CLASSIFICATION_PROVIDER = "groq";
const PRIORITY_PROVIDER = "groq";

/** Cap sent/parsed free text so prompts and stored results stay bounded. */
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_REASON_LENGTH = 1000;

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

export default {
  classifyTicket,
  suggestTicketPriority,
  serializeSuggestion,
  // Exported for targeted tests of the pure validation logic.
  validateClassificationResponse,
  buildClassificationMessages,
  validatePriorityResponse,
  buildPriorityMessages,
};
