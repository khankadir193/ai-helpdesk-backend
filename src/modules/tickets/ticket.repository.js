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
 * Supports source, tags, attachments, optional initial status, and assigned agent.
 *
 * @param {{ title: string, description: string, customer_id: string|number,
 *           category_id: string|number|null, priority: string,
 *           status?: string, assigned_agent_id?: string|number|null,
 *           source?: string, tags?: string[], attachments?: any[] }} data
 * @param {object} [executor]
 * @returns {Promise<object>}
 */
async function insertTicket(data, executor = database) {
  const { rows } = await executor.query(
    `INSERT INTO tickets (
       title, description, customer_id, category_id, priority,
       status, assigned_agent_id, source, tags, attachments
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, title, description, customer_id, category_id, priority,
               status, assigned_agent_id, source, tags, attachments,
               resolved_at, closed_at, created_at, updated_at`,
    [
      data.title,
      data.description,
      data.customer_id,
      data.category_id,
      data.priority,
      data.status || "OPEN",
      data.assigned_agent_id || null,
      data.source || "Email",
      data.tags || [],
      JSON.stringify(data.attachments || []),
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
           t.source, t.tags, t.attachments,
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
            category_id, priority, status, source, tags, attachments,
            resolved_at, closed_at, created_at, updated_at
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
 *           order: "ASC"|"DESC", limit?: number, offset?: number }} params
 * @param {object} [executor]
 * @returns {Promise<Array<object>>}
 */
async function listTickets({ where, values, sort, order, limit, offset }, executor = database) {
  const limitClause =
    limit !== undefined && offset !== undefined
      ? `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`
      : "";
  const params =
    limit !== undefined && offset !== undefined
      ? [...values, limit, offset]
      : values;

  const { rows } = await executor.query(
    `${TICKET_DETAIL_SELECT}
     WHERE ${where}
     ORDER BY t.${sort} ${order}, t.id ${order}
     ${limitClause}`,
    params,
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
     JOIN users c ON c.id = t.customer_id
     LEFT JOIN users a ON a.id = t.assigned_agent_id
     LEFT JOIN categories g ON g.id = t.category_id
     WHERE ${where}`,
    values,
  );
  return rows[0].total;
}

/**
 * Get ticket counts for tabs (all, mine, unassigned) according to the user's role scope.
 *
 * @param {{ baseWhere: string, baseValues: Array, userId: string|number, role: string }} params
 * @param {object} [executor]
 * @returns {Promise<{ all: number, mine: number, unassigned: number }>}
 */
async function getTabCounts({ baseWhere, baseValues, userId, role }, executor = database) {
  let mineFilter;
  let unassignedFilter;

  if (role === "CUSTOMER") {
    mineFilter = `t.customer_id = '${userId}'`;
    unassignedFilter = "FALSE";
  } else {
    mineFilter = `t.assigned_agent_id = '${userId}'`;
    unassignedFilter = "t.assigned_agent_id IS NULL";
  }

  const query = `
    SELECT
      COUNT(*)::int AS all_count,
      COUNT(*) FILTER (WHERE ${mineFilter})::int AS mine_count,
      COUNT(*) FILTER (WHERE ${unassignedFilter})::int AS unassigned_count
    FROM tickets t
    JOIN users c ON c.id = t.customer_id
    LEFT JOIN users a ON a.id = t.assigned_agent_id
    LEFT JOIN categories g ON g.id = t.category_id
    WHERE ${baseWhere}
  `;

  const { rows } = await executor.query(query, baseValues);
  return {
    all: rows[0]?.all_count ?? 0,
    mine: rows[0]?.mine_count ?? 0,
    unassigned: rows[0]?.unassigned_count ?? 0,
  };
}

/**
 * Search customers by name or email.
 *
 * @param {string} query
 * @param {object} [executor]
 * @returns {Promise<Array<object>>}
 */
async function searchCustomers(query, executor = database) {
  const q = String(query || "").trim();
  const filter = q ? "AND (u.name ILIKE $1 OR u.email ILIKE $1)" : "";
  const params = q ? [`%${q}%`] : [];

  const { rows } = await executor.query(
    `SELECT u.id, u.name, u.email,
            COUNT(t.id)::int AS total_tickets
     FROM users u
     LEFT JOIN tickets t ON t.customer_id = u.id
     WHERE u.role = 'CUSTOMER' AND u.is_active = TRUE ${filter}
     GROUP BY u.id, u.name, u.email
     ORDER BY u.name ASC
     LIMIT 10`,
    params,
  );
  return rows;
}

/**
 * Fetch active support agents along with their current open ticket counts.
 *
 * @param {object} [executor]
 * @returns {Promise<Array<object>>}
 */
async function getAgentsWithOpenCounts(executor = database) {
  const { rows } = await executor.query(
    `SELECT u.id, u.name, u.email,
            COALESCE(COUNT(t.id) FILTER (WHERE t.status IN ('OPEN', 'IN_PROGRESS')), 0)::int AS open_tickets_count
     FROM users u
     LEFT JOIN tickets t ON t.assigned_agent_id = u.id
     WHERE u.role IN ('AGENT', 'ADMIN') AND u.is_active = TRUE
     GROUP BY u.id, u.name, u.email
     ORDER BY open_tickets_count DESC, u.name ASC
     LIMIT 50`,
  );
  return rows;
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
 * Change a ticket's status and maintain resolved_at/closed_at consistency.
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
 * Delete a single ticket and all its dependent rows inside a transaction.
 *
 * @param {string|number} id
 * @param {object} [executor]
 * @returns {Promise<boolean>}
 */
async function deleteTicketById(id, executor = database) {
  await executor.query("DELETE FROM ai_suggestions WHERE ticket_id = $1", [id]);
  await executor.query("DELETE FROM ticket_comments WHERE ticket_id = $1", [id]);
  await executor.query("DELETE FROM ticket_history WHERE ticket_id = $1", [id]);
  const { rowCount } = await executor.query("DELETE FROM tickets WHERE id = $1", [id]);
  return rowCount > 0;
}

/**
 * Delete multiple tickets and their dependent rows inside a transaction.
 *
 * @param {Array<string|number>} ids
 * @param {object} [executor]
 * @returns {Promise<number>} deleted count
 */
async function bulkDeleteTickets(ids, executor = database) {
  if (!ids || ids.length === 0) return 0;
  await executor.query("DELETE FROM ai_suggestions WHERE ticket_id = ANY($1::bigint[])", [ids]);
  await executor.query("DELETE FROM ticket_comments WHERE ticket_id = ANY($1::bigint[])", [ids]);
  await executor.query("DELETE FROM ticket_history WHERE ticket_id = ANY($1::bigint[])", [ids]);
  const { rowCount } = await executor.query(
    "DELETE FROM tickets WHERE id = ANY($1::bigint[])",
    [ids],
  );
  return rowCount;
}

/**
 * Fetch the audit history for a ticket, newest first.
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

/**
 * @param {string} email
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function findUserByEmail(email, executor = database) {
  const { rows } = await executor.query(
    "SELECT id, name, email, role, is_active FROM users WHERE LOWER(email) = LOWER($1)",
    [email],
  );
  return rows[0];
}

/**
 * Insert a customer user on the fly if needed when staff creates a ticket.
 *
 * @param {{ name: string, email: string }} data
 * @param {object} [executor]
 * @returns {Promise<object>}
 */
async function insertCustomerUser(data, executor = database) {
  const { rows } = await executor.query(
    `INSERT INTO users (name, email, password_hash, role, is_active)
     VALUES ($1, LOWER($2), 'NO_DIRECT_LOGIN_TEMP_HASH', 'CUSTOMER', TRUE)
     RETURNING id, name, email, role, is_active`,
    [data.name.trim(), data.email.trim()],
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
  getTabCounts,
  searchCustomers,
  getAgentsWithOpenCounts,
  updateTicketFields,
  updateTicketStatus,
  updateTicketAssignment,
  deleteTicketById,
  bulkDeleteTickets,
  listTicketHistory,
  findUserById,
  findUserByEmail,
  insertCustomerUser,
};
