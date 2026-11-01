/**
 * Adds the performance indexes documented in docs/04 (Planned Improvements)
 * for ticket listing, filtering, and related lookups.
 *
 * Applied via `npm run db:migrate`. The legacy never-applied
 * `1729522800000_create-users-table.js` was removed because its schema
 * (uuid PK, user_role enum type) contradicted the authoritative
 * `1792999534510_initial-schema.sql` (bigint identity PK, varchar role);
 * the initial-schema migration is recorded in `pgmigrations` since it was
 * applied before node-pg-migrate bookkeeping existed.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // Customer's tickets, newest first (customer list view)
  pgm.createIndex("tickets", ["customer_id", { name: "created_at", sort: "DESC" }], {
    name: "idx_tickets_customer_created",
  });

  // Filter tickets by status
  pgm.createIndex("tickets", ["status", { name: "created_at", sort: "DESC" }], {
    name: "idx_tickets_status_created",
  });

  // Agent's assigned tickets (agent list view, optional status filter)
  pgm.createIndex("tickets", ["assigned_agent_id", "status"], {
    name: "idx_tickets_agent_status",
  });

  // Filter tickets by category
  pgm.createIndex("tickets", ["category_id"], {
    name: "idx_tickets_category",
  });

  // Load ticket comments in order (comments module — planned)
  pgm.createIndex("ticket_comments", ["ticket_id", "created_at"], {
    name: "idx_ticket_comments_ticket_created",
  });

  // Load ticket history (GET /tickets/:id/history)
  pgm.createIndex("ticket_history", ["ticket_id", { name: "created_at", sort: "DESC" }], {
    name: "idx_ticket_history_ticket_created",
  });

  // AI suggestions for a ticket (AI module — planned)
  pgm.createIndex("ai_suggestions", ["ticket_id", { name: "created_at", sort: "DESC" }], {
    name: "idx_ai_suggestions_ticket_created",
  });
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex("ai_suggestions", undefined, { name: "idx_ai_suggestions_ticket_created", ifExists: true });
  pgm.dropIndex("ticket_history", undefined, { name: "idx_ticket_history_ticket_created", ifExists: true });
  pgm.dropIndex("ticket_comments", undefined, { name: "idx_ticket_comments_ticket_created", ifExists: true });
  pgm.dropIndex("tickets", undefined, { name: "idx_tickets_category", ifExists: true });
  pgm.dropIndex("tickets", undefined, { name: "idx_tickets_agent_status", ifExists: true });
  pgm.dropIndex("tickets", undefined, { name: "idx_tickets_status_created", ifExists: true });
  pgm.dropIndex("tickets", undefined, { name: "idx_tickets_customer_created", ifExists: true });
};
