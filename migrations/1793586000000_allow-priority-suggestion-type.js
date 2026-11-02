/**
 * Allows 'PRIORITY' values in ai_suggestions.suggestion_type so the AI
 * priority suggestion feature (POST /api/v1/tickets/:id/ai/priority) can
 * store its PENDING suggestions in the existing ai_suggestions table.
 *
 * The original CHECK only allowed ('CLASSIFICATION', 'SUMMARY',
 * 'REPLY_DRAFT'); every other ai_suggestions rule (result JSONB-object
 * CHECK, review consistency CHECK, status CHECK) already supports the new
 * suggestion type unchanged.
 *
 * Applied via `npm run db:migrate`.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.dropConstraint("ai_suggestions", "ai_suggestions_suggestion_type_check");
  pgm.addConstraint("ai_suggestions", "ai_suggestions_suggestion_type_check", {
    check:
      "suggestion_type IN ('CLASSIFICATION', 'SUMMARY', 'REPLY_DRAFT', 'PRIORITY')",
  });
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  // PRIORITY rows must be removed before the narrower CHECK is restored,
  // otherwise the ADD CONSTRAINT below fails with a constraint violation.
  pgm.sql("DELETE FROM ai_suggestions WHERE suggestion_type = 'PRIORITY'");
  pgm.dropConstraint("ai_suggestions", "ai_suggestions_suggestion_type_check");
  pgm.addConstraint("ai_suggestions", "ai_suggestions_suggestion_type_check", {
    check: "suggestion_type IN ('CLASSIFICATION', 'SUMMARY', 'REPLY_DRAFT')",
  });
};
