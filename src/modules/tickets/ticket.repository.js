import database from "../../config/database.js";

/**
 * Run `work(client)` inside a single PostgreSQL transaction.
 *
 * The client is passed to the callback and must be used for every related
 * query (each repository function accepts an `executor` argument for this
 * reason). On failure the transaction is rolled back and the error is
 * re-thrown; the client is always released back to the pool.
 *
 * @param {(client: import("pg").PoolClient) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
async function withTransaction(work) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Insert a new ticket. Returns the raw inserted row.
 *
 * @param {{ title: string, description: string, customer_id: string|number,
 *           category_id: string|number|null, priority: string }} data
 * @param {object} [executor]
 * @returns {Promise<object>}
 */
async function insertTicket(data, executor = database) {
  const { rows } = await executor.query(
    `INSERT INTO tickets (title, description, customer_id, category_id, priority)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, description, customer_id, category_id, priority,
               status, resolved_at, closed_at, created_at, updated_at`,
    [
      data.title,
      data.description,
      data.customer_id,
      data.category_id,
      data.priority,
    ],
  );
  return rows[0];
}

/**
 * Append one row to the immutable ticket_history audit table.
 * Non-null old_value/new_value are JSON-stringified so PostgreSQL can cast
 * them to jsonb (bare strings would be invalid JSON).
 *
 * @param {{ ticketId: string|number, changedBy: string|number|null,
 *           action: string, fieldName: string|null,
 *           oldValue: unknown, newValue: unknown }} entry
 * @param {object} [executor]
 * @returns {Promise<object>}
 */
async function insertTicketHistory(entry, executor = database) {
  const { rows } = await executor.query(
    `INSERT INTO ticket_history (ticket_id, changed_by, action, field_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, action, field_name, created_at`,
    [
      entry.ticketId,
      entry.changedBy,
      entry.action,
      entry.fieldName,
      entry.oldValue === null || entry.oldValue === undefined
        ? null
        : JSON.stringify(entry.oldValue),
      entry.newValue === null || entry.newValue === undefined
        ? null
        : JSON.stringify(entry.newValue),
    ],
  );
  return rows[0];
}

/**
 * Internal SELECT fragment joining the customer, agent, and category rows so
 * detail responses never need extra round-trips.
 */
const TICKET_DETAIL_SELECT = `
    SELECT t.id, t.title, t.description, t.priority, t.status,
           t.resolved_at, t.closed_at, t.created_at, t.updated_at,
           c.id   AS customer_id,
           c.name AS customer_name,
           c.email AS customer_email,
           a.id   AS agent_id,
           a.name AS agent_name,
           a.email AS agent_email,
           g.id   AS category_id,
           g.name AS category_name,
           g.is_active AS category_is_active
    FROM tickets t
    JOIN users c       ON c.id = t.customer_id
    LEFT JOIN users a  ON a.id = t.assigned_agent_id
    LEFT JOIN categories g ON g.id = t.category_id`;

/**
 * Fetch a single ticket with related entity names.
 *
 * @param {string|number} id
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function findTicketById(id, executor = database) {
  const { rows } = await executor.query(
    `${TICKET_DETAIL_SELECT} WHERE t.id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * Fetch a raw ticket row (no joins) and lock it for the rest of the
 * transaction, preventing concurrent status/assignment races while the
 * service validates and transitions the row.
 *
 * @param {string|number} id
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function lockTicketById(id, executor = database) {
  const { rows } = await executor.query(
    `SELECT id, title, description, customer_id, assigned_agent_id,
            category_id, priority, status, resolved_at, closed_at,
            created_at, updated_at
     FROM tickets
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return rows[0];
}

/**
 * Build a pagination listing query. Callers must pre-validate filter and
 * sort values; only parameterized values are interpolated and sort/order
 * are whitelisted by the caller.
 *
 * @param {{ where: string, values: Array, sort: string,
 *           order: "ASC"|"DESC", limit: number, offset: number }} params
 * @param {object} [executor]
 * @returns {Promise<Array<object>>}
 */
async function listTickets({ where, values, sort, order, limit, offset }, executor = database) {
  const { rows } = await executor.query(
    `${TICKET_DETAIL_SELECT}
     WHERE ${where}
     ORDER BY t.${sort} ${order}, t.id ${order}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  return rows;
}

/**
 * Count tickets for the same WHERE clause used by listTickets, so
 * pagination totals always match the filtered result set.
 *
 * @param {{ where: string, values: Array }} params
 * @param {object} [executor]
 * @returns {Promise<number>}
 */
async function countTickets({ where, values }, executor = database) {
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS total
     FROM tickets t
     WHERE ${where}`,
    values,
  );
  return rows[0].total;
}

/**
 * Update arbitrary ticket columns. `fields` maps column name to value and is
 * produced by the service after permission checks; `updated_at` is always
 * refreshed. Returns the updated detail row.
 *
 * @param {string|number} id
 * @param {Record<string, unknown>} fields
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function updateTicketFields(id, fields, executor = database) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findTicketById(id, executor);

  const setClause = columns
    .map((column, index) => `${column} = $${index + 1}`)
    .join(", ");
  const values = Object.values(fields);

  await executor.query(
    `UPDATE tickets
     SET ${setClause}, updated_at = NOW()
     WHERE id = $${values.length + 1}`,
    [...values, id],
  );

  return findTicketById(id, executor);
}

/**
 * Change a ticket's status and maintain resolved_at/closed_at consistency:
 *  - entering RESOLVED stamps resolved_at
 *  - entering CLOSED stamps closed_at and fills resolved_at only if it was
 *    still NULL (the DB CHECK requires resolved_at for CLOSED tickets)
 *  - leaving RESOLVED/CLOSED to an active status clears both timestamps
 *
 * @param {string|number} id
 * @param {string} nextStatus
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function updateTicketStatus(id, nextStatus, executor = database) {
  const { rows } = await executor.query(
    `UPDATE tickets
     SET status = $2::varchar,
         resolved_at = CASE
             WHEN $2::varchar = 'RESOLVED' THEN NOW()
             WHEN $2::varchar = 'CLOSED'   THEN COALESCE(resolved_at, NOW())
             ELSE NULL END,
         closed_at = CASE
             WHEN $2::varchar = 'CLOSED' THEN NOW()
             ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [id, nextStatus],
  );

  if (rows.length === 0) return undefined;
  return findTicketById(id, executor);
}

/**
 * Assign or unassign an agent. The WHERE clause refuses CLOSED tickets so
 * a finished ticket can never be reworked silently.
 *
 * @param {string|number} id
 * @param {string|number|null} agentId
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function updateTicketAssignment(id, agentId, executor = database) {
  const { rows } = await executor.query(
    `UPDATE tickets
     SET assigned_agent_id = $2, updated_at = NOW()
     WHERE id = $1 AND status <> 'CLOSED'
     RETURNING id`,
    [id, agentId],
  );

  if (rows.length === 0) return undefined;
  return findTicketById(id, executor);
}

/**
 * Fetch the audit history for a ticket, newest first, with the acting user
 * attached (changed_by is nullable for system events).
 *
 * @param {string|number} ticketId
 * @param {object} [executor]
 * @returns {Promise<Array<object>>}
 */
async function listTicketHistory(ticketId, executor = database) {
  const { rows } = await executor.query(
    `SELECT h.id, h.action, h.field_name, h.old_value, h.new_value,
            h.created_at,
            u.id   AS changed_by_id,
            u.name AS changed_by_name
     FROM ticket_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.ticket_id = $1
     ORDER BY h.id DESC`,
    [ticketId],
  );
  return rows;
}

/**
 * @param {string|number} userId
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function findUserById(userId, executor = database) {
  const { rows } = await executor.query(
    "SELECT id, name, email, role, is_active FROM users WHERE id = $1",
    [userId],
  );
  return rows[0];
}

export default {
  withTransaction,
  insertTicket,
  insertTicketHistory,
  findTicketById,
  lockTicketById,
  listTickets,
  countTickets,
  updateTicketFields,
  updateTicketStatus,
  updateTicketAssignment,
  listTicketHistory,
  findUserById,
};
