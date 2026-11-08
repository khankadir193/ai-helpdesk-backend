import database from "../../config/database.js";

/**
 * User service — read-only helpers for the user module.
 * The module intentionally exposes no account-management operations;
 * writes (registration, deactivation) remain the responsibility of the
 * auth module.
 */

/**
 * List the active support agents for the Admin assignment workflow.
 * Only users with role AGENT whose account is currently active are
 * returned, exposing just the fields the ticket-assignment UI needs:
 *   { id, name, email }
 * Password hashes, timestamps, and non-agent roles are never returned.
 *
 * Sorted by name (case-insensitive) with id as a deterministic tie-breaker.
 * Database failures are not swallowed — they surface as the standard 500
 * envelope via the global error handler, like every other module.
 *
 * @returns {Promise<Array<{ id: string, name: string, email: string }>>}
 */
async function listAgents() {
  const { rows } = await database.query(
    `SELECT id::text AS id, name, email
     FROM users
     WHERE role = 'AGENT' AND is_active = TRUE
     ORDER BY lower(name) ASC, id ASC`,
  );
  return rows;
}

export default {
  listAgents,
};
