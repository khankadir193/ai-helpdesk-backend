import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import ticketService from "../tickets/ticket.service.js";
import ticketRepository from "../tickets/ticket.repository.js";

/**
 * Serialize a joined comment row into the public API shape.
 *
 * @param {object} row
 * @returns {object}
 */
function serializeComment(row) {
  return {
    id: row.id,
    ticket_id: row.ticket_id ?? row.ticketId,
    author_id: row.author_id,
    author: {
      id: row.author_id,
      name: row.author_name ?? null,
    },
    message: row.message,
    is_internal: row.is_internal,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Fetch a comment with its author name.
 *
 * @param {string|number} commentId
 * @param {object} [executor]
 * @returns {Promise<object|undefined>}
 */
async function findCommentById(commentId, executor = database) {
  const { rows } = await executor.query(
    `SELECT c.id, c.ticket_id, c.author_id, c.message, c.is_internal,
            c.created_at, c.updated_at,
            u.name AS author_name
     FROM ticket_comments c
     JOIN users u ON u.id = c.author_id
     WHERE c.id = $1`,
    [commentId],
  );
  return rows[0];
}

/**
 * Assert that the caller may see/append to a ticket.
 * - CUSTOMER: own tickets only (FR-013)
 * - AGENT:    tickets assigned to them only (FR-028)
 * - ADMIN:    every ticket (FR-045)
 *
 * @param {string|number} ticketId
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<object>} the joined ticket row
 */
async function assertTicketAccess(ticketId, user) {
  const ticket = await ticketRepository.findTicketById(ticketId);

  if (!ticket) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!ticketService.canAccessTicket(user, ticket)) {
    throw new ApiError(
      403,
      "Forbidden. You are not authorized to access this ticket.",
    );
  }
  return ticket;
}

/**
 * List the comments of one ticket.
 * Customers receive the conversation without internal notes (FR-014 keeps
 * AI suggestions separate; FR-022 gives agents/admins the full history).
 *
 * @param {string|number} ticketId
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<Array<object>>}
 */
async function listComments(ticketId, user) {
  await assertTicketAccess(ticketId, user);

  const values = [ticketId];
  let filter = "";
  if (user.role === "CUSTOMER") {
    filter = " AND c.is_internal = false";
  }

  const { rows } = await database.query(
    `SELECT c.id, c.ticket_id, c.author_id, c.message, c.is_internal,
            c.created_at, c.updated_at,
            u.name AS author_name
     FROM ticket_comments c
     JOIN users u ON u.id = c.author_id
     WHERE c.ticket_id = $1${filter}
     ORDER BY c.id ASC`,
    values,
  );

  return rows.map(serializeComment);
}

/**
 * Add a comment (reply) to a ticket. Customer and agent comments are
 * permitted on any ticket they can access (FR-012 / FR-023); admins may
 * comment anywhere.
 * Customers cannot create internal comments — `is_internal: true` is a 403.
 *
 * @param {string|number} ticketId
 * @param {{ id: string|number, role: string }} user
 * @param {{ message: string, is_internal?: boolean }} data
 * @returns {Promise<object>}
 */
async function addComment(ticketId, user, { message, is_internal = false }) {
  const normalizedMessage = String(message ?? "").trim();
  if (!normalizedMessage) {
    throw new ApiError(422, "Comment message cannot be empty.");
  }

  if (Boolean(is_internal) && user.role === "CUSTOMER") {
    throw new ApiError(
      403,
      "Forbidden. Customers cannot create internal comments.",
    );
  }

  const ticket = await assertTicketAccess(ticketId, user);

  const { rows } = await database.query(
    `INSERT INTO ticket_comments (ticket_id, author_id, message, is_internal)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [ticket.id, user.id, normalizedMessage, Boolean(is_internal)],
  );

  const comment = await findCommentById(rows[0].id);
  return serializeComment(comment);
}

export default {
  listComments,
  addComment,
};
