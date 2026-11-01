import ApiError from "../../utils/ApiError.js";
import categoryService from "../categories/category.service.js";
import ticketRepository from "./ticket.repository.js";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  validateModelId,
} from "./ticket.validation.js";

/**
 * Allowed status transitions. CLOSED is terminal — no further changes.
 */
const ALLOWED_TRANSITIONS = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "IN_PROGRESS", "CLOSED"],
  CLOSED: [],
};

/**
 * Validates that a category can be used by a ticket.
 * New tickets may only reference an *active* category; existing tickets keep
 * their reference when a category later becomes inactive.
 *
 * @param {string|number|null} categoryId
 * @returns {Promise<object|null>}
 */
async function validateTicketCategory(categoryId) {
  if (categoryId === undefined || categoryId === null) {
    return null;
  }
  return categoryService.ensureCategoryIsActive(categoryId);
}

/**
 * Decide whether a user may see/manage a ticket.
 * - CUSTOMER: only tickets they created (ownership)
 * - AGENT:    only tickets currently assigned to them (FR-028)
 * - ADMIN:    every ticket
 *
 * Works on both raw repository rows (`customer_id`, `agent_id`) and mapped
 * detail objects. Uses String() comparison because BIGINT ids arrive as
 * strings from the pg driver.
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ customer_id?: any, customer?: any, agent_id?: any, assigned_agent?: any }} ticket
 * @returns {boolean}
 */
function canAccessTicket(user, ticket) {
  const customerId = String(
    ticket.customer_id ?? ticket.customer?.id ?? "",
  );
  const agentId = String(
    ticket.agent_id ?? ticket.assigned_agent_id ?? ticket.assigned_agent?.id ?? "",
  );

  switch (user.role) {
    case "ADMIN":
      return true;
    case "AGENT":
      return agentId !== "" && agentId === String(user.id);
    case "CUSTOMER":
      return customerId === String(user.id);
    default:
      return false;
  }
}

/**
 * Convert a joined repository row into the public API shape.
 * Flat foreign keys are preserved alongside nested entity summaries so
 * consumers keep using `category_id`, `customer_id`, `assigned_agent_id`.
 *
 * @param {object} row
 * @returns {object}
 */
function serializeTicket(row) {
  if (!row) return null;
  const customerId = row.customer_id ?? null;
  const agentId = row.agent_id ?? row.assigned_agent_id ?? null;
  const categoryId = row.category_id ?? null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    customer_id: customerId,
    assigned_agent_id: agentId,
    category_id: categoryId,
    customer: {
      id: customerId,
      name: row.customer_name ?? null,
      email: row.customer_email ?? null,
    },
    assigned_agent: agentId
      ? {
          id: agentId,
          name: row.agent_name ?? null,
          email: row.agent_email ?? null,
        }
      : null,
    category: categoryId
      ? {
          id: categoryId,
          name: row.category_name ?? null,
          is_active: row.category_is_active ?? null,
        }
      : null,
    resolved_at: row.resolved_at,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Normalize a priority value, falling back to the default. The route
 * validator enforces the enum for HTTP requests; the service re-checks to
 * protect direct callers of this module.
 *
 * @param {string|undefined} value
 * @returns {string}
 */
function normalizePriority(value) {
  if (value === undefined || value === null) return "MEDIUM";
  const normalized = String(value).trim();
  if (!TICKET_PRIORITIES.includes(normalized)) {
    throw new ApiError(
      422,
      `priority must be one of ${TICKET_PRIORITIES.join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * Create a new ticket and record the TICKET_CREATED audit entry in the same
 * transaction so a ticket can never exist without its history row.
 *
 * @param {{
 *   title: string,
 *   description: string,
 *   customer_id: string|number,
 *   category_id?: string|number|null,
 *   priority?: string
 * }} data
 * @returns {Promise<object>}
 */
async function createTicket({
  title,
  description,
  customer_id,
  category_id = null,
  priority = "MEDIUM",
}) {
  if (!title || !title.trim()) {
    throw new ApiError(422, "Ticket title is required.");
  }
  if (!description || !description.trim()) {
    throw new ApiError(422, "Ticket description is required.");
  }
  if (!customer_id) {
    throw new ApiError(422, "Customer ID is required.");
  }
  const normalizedPriority = normalizePriority(priority);

  // Inactive or unknown categories are rejected for new tickets.
  await validateTicketCategory(category_id);

  const ticket = await ticketRepository.withTransaction(async (client) => {
    const inserted = await ticketRepository.insertTicket(
      {
        title: title.trim(),
        description: description.trim(),
        customer_id,
        category_id: category_id ?? null,
        priority: normalizedPriority,
      },
      client,
    );

    await ticketRepository.insertTicketHistory(
      {
        ticketId: inserted.id,
        changedBy: customer_id,
        action: "TICKET_CREATED",
        fieldName: "status",
        oldValue: null,
        newValue: "OPEN",
      },
      client,
    );

    const detail = await ticketRepository.findTicketById(inserted.id, client);
    return serializeTicket(detail ?? inserted);
  });

  return ticket;
}

/**
 * List tickets according to the caller's role plus optional filters.
 *
 * Role scoping (cannot be overridden by query params):
 *  - CUSTOMER: own tickets only
 *  - AGENT:    tickets assigned to them only
 *  - ADMIN:    all tickets, may filter by assigned_agent_id
 *
 * @param {{
 *   user: object,
 *   status?: string,
 *   priority?: string,
 *   categoryId?: unknown,
 *   assignedAgentId?: unknown,
 *   sort?: string,
 *   order?: "asc"|"desc",
 *   page?: number,
 *   limit?: number
 * }} params
 * @returns {Promise<{ tickets: object[], pagination: object }>}
 */
async function listTickets({
  user,
  status,
  priority,
  categoryId,
  assignedAgentId,
  sort = "created_at",
  order = "desc",
  page = 1,
  limit = 20,
}) {
  const conditions = [];
  const values = [];

  // Explicit role scope. ADMIN can additionally filter by agent below.
  if (user.role === "CUSTOMER") {
    values.push(user.id);
    conditions.push(`t.customer_id = $${values.length}`);
  } else if (user.role === "AGENT") {
    values.push(user.id);
    conditions.push(`t.assigned_agent_id = $${values.length}`);
  }

  if (assignedAgentId !== undefined) {
    if (user.role !== "ADMIN") {
      throw new ApiError(
        403,
        "Only admins can filter tickets by assigned agent.",
      );
    }
    values.push(validateModelId(assignedAgentId));
    conditions.push(`t.assigned_agent_id = $${values.length}`);
  }

  if (status !== undefined) {
    if (!TICKET_STATUSES.includes(status)) {
      throw new ApiError(
        400,
        `status filter must be one of ${TICKET_STATUSES.join(", ")}.`,
      );
    }
    values.push(status);
    conditions.push(`t.status = $${values.length}`);
  }

  if (priority !== undefined) {
    if (!TICKET_PRIORITIES.includes(priority)) {
      throw new ApiError(
        400,
        `priority filter must be one of ${TICKET_PRIORITIES.join(", ")}.`,
      );
    }
    values.push(priority);
    conditions.push(`t.priority = $${values.length}`);
  }

  if (categoryId !== undefined) {
    values.push(validateModelId(categoryId));
    conditions.push(`t.category_id = $${values.length}`);
  }

  const where =
    conditions.length > 0 ? conditions.join(" AND ") : "TRUE";

  const total = await ticketRepository.countTickets({ where, values });

  const rows = await ticketRepository.listTickets({
    where,
    values,
    sort,
    order,
    limit,
    offset: (page - 1) * limit,
  });

  return {
    tickets: rows.map(serializeTicket),
    pagination: {
      page,
      limit,
      total_items: total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get one ticket. Ownership scoping applies: customers only see their own
 * tickets, agents only assigned ones, admins everything.
 *
 * @param {string|number} id
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<object>}
 */
async function getTicketById(id, user) {
  const row = await ticketRepository.findTicketById(id);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!canAccessTicket(user, row)) {
    throw new ApiError(403, "Forbidden. You are not authorized to view this ticket.");
  }

  return serializeTicket(row);
}

/**
 * Update editable ticket fields.
 *
 * Permission and state rules:
 *  - CLOSED tickets cannot be modified (409)
 *  - CUSTOMER: own ticket only, and only while status is OPEN
 *  - AGENT: assigned tickets only; may change priority/category only
 *  - ADMIN: any open ticket, all editable fields
 * Category changes must reference an active category; `null` clears it.
 *
 * @param {string|number} id
 * @param {{ id: string|number, role: string }} user
 * @param {{ title?, description?, category_id?, priority? }} data
 * @returns {Promise<object>}
 */
async function updateTicket(id, user, data) {
  const changes = await ticketRepository.withTransaction(async (client) => {
    // Lock the row so the status cannot flip while we compute permissions.
    const row = await ticketRepository.lockTicketById(id, client);

    if (!row) {
      throw new ApiError(404, "Ticket not found.");
    }
    if (!canAccessTicket(user, row)) {
      throw new ApiError(403, "Forbidden. You are not authorized to update this ticket.");
    }
    if (row.status === "CLOSED") {
      throw new ApiError(409, "Cannot update a CLOSED ticket.");
    }
    if (user.role === "CUSTOMER" && row.status !== "OPEN") {
      throw new ApiError(
        403,
        "Forbidden. You can only edit your ticket while its status is OPEN.",
      );
    }

    const fields = {};
    const historyEntries = [];

    if (data.title !== undefined) {
      if (user.role === "AGENT") {
        throw new ApiError(
          403,
          "Forbidden. Agents cannot edit the ticket title or description.",
        );
      }
      const normalized = String(data.title).trim();
      if (!normalized) {
        throw new ApiError(422, "Ticket title cannot be blank.");
      }
      if (normalized !== row.title) {
        fields.title = normalized;
        historyEntries.push({
          action: "TITLE_CHANGED",
          fieldName: "title",
          oldValue: row.title,
          newValue: normalized,
        });
      }
    }

    if (data.description !== undefined) {
      if (user.role === "AGENT") {
        throw new ApiError(
          403,
          "Forbidden. Agents cannot edit the ticket title or description.",
        );
      }
      const normalized = String(data.description).trim();
      if (!normalized) {
        throw new ApiError(422, "Ticket description cannot be blank.");
      }
      if (normalized !== row.description) {
        fields.description = normalized;
        historyEntries.push({
          action: "DESCRIPTION_CHANGED",
          fieldName: "description",
          oldValue: row.description,
          newValue: normalized,
        });
      }
    }

    if (data.priority !== undefined) {
      const normalized = normalizePriority(data.priority);
      if (normalized !== row.priority) {
        fields.priority = normalized;
        historyEntries.push({
          action: "PRIORITY_CHANGED",
          fieldName: "priority",
          oldValue: row.priority,
          newValue: normalized,
        });
      }
    }

    if (data.category_id !== undefined) {
      // null explicitly clears the category; a value must be active.
      const normalized = data.category_id === null
        ? null
        : String(data.category_id);
      if (normalized !== null) {
        await validateTicketCategory(normalized);
      }
      const oldCategoryId = row.category_id === null ? null : String(row.category_id);
      if (oldCategoryId !== normalized) {
        fields.category_id = normalized;
        historyEntries.push({
          action: "CATEGORY_CHANGED",
          fieldName: "category_id",
          oldValue: oldCategoryId,
          newValue: normalized,
        });
      }
    }

    if (Object.keys(fields).length === 0) {
      // Nothing actually changed — return the current ticket untouched.
      const current = await ticketRepository.findTicketById(id, client);
      return serializeTicket(current ?? row);
    }

    const updated = await ticketRepository.updateTicketFields(
      id,
      fields,
      client,
    );

    for (const entry of historyEntries) {
      await ticketRepository.insertTicketHistory(
        {
          ticketId: row.id,
          changedBy: user.id,
          ...entry,
        },
        client,
      );
    }

    return serializeTicket(updated ?? row);
  });

  return changes;
}

/**
 * Update ticket status with transition validation.
 * AGENTs may only transition tickets assigned to them; ADMINs any open
 * ticket. CLOSED tickets are terminal.
 *
 * @param {string|number} id
 * @param {{ id: string|number, role: string }} user
 * @param {string} nextStatus
 * @returns {Promise<object>}
 */
async function updateTicketStatus(id, user, nextStatus) {
  const normalized = String(nextStatus || "").trim();
  if (!TICKET_STATUSES.includes(normalized)) {
    throw new ApiError(
      422,
      `status must be one of ${TICKET_STATUSES.join(", ")}.`,
    );
  }

  const ticket = await ticketRepository.withTransaction(async (client) => {
    const row = await ticketRepository.lockTicketById(id, client);

    if (!row) {
      throw new ApiError(404, "Ticket not found.");
    }
    if (!canAccessTicket(user, row)) {
      throw new ApiError(403, "Forbidden. You are not authorized to update this ticket.");
    }
    if (row.status === "CLOSED") {
      throw new ApiError(
        409,
        "This ticket is CLOSED and its status can no longer be changed.",
      );
    }
    if (!ALLOWED_TRANSITIONS[row.status].includes(normalized)) {
      throw new ApiError(
        409,
        `Invalid status transition from ${row.status} to ${normalized}. ` +
          `Allowed transitions from ${row.status}: ` +
          `${ALLOWED_TRANSITIONS[row.status].join(", ") || "none"}.`,
      );
    }

    const updated = await ticketRepository.updateTicketStatus(
      id,
      normalized,
      client,
    );

    if (!updated) {
      // The row was locked and validated above, so a failed update can only
      // mean a concurrent modification — refused as a state conflict.
      throw new ApiError(409, "Ticket status could not be updated.");
    }

    await ticketRepository.insertTicketHistory(
      {
        ticketId: row.id,
        changedBy: user.id,
        action: "STATUS_CHANGED",
        fieldName: "status",
        oldValue: row.status,
        newValue: normalized,
      },
      client,
    );

    return serializeTicket(updated);
  });

  return ticket;
}

/**
 * Assign or reassign a ticket (ADMIN only, per route + service).
 * Target must be an existing, active user with role AGENT. Passing null
 * unassigns. Re-assigning to the current agent is a no-op returning 200.
 *
 * @param {string|number} id
 * @param {{ id: string|number, role: string }} user — actor (admin)
 * @param {string|number|null} assignedAgentId
 * @returns {Promise<object>}
 */
async function updateTicketAssignment(id, user, assignedAgentId) {
  if (user.role !== "ADMIN") {
    throw new ApiError(
      403,
      "Forbidden. Only admins can assign or reassign tickets.",
    );
  }

  const normalizedAgentId = validateModelId(assignedAgentId, {
    allowNull: true,
  });

  const ticket = await ticketRepository.withTransaction(async (client) => {
    const row = await ticketRepository.lockTicketById(id, client);

    if (!row) {
      throw new ApiError(404, "Ticket not found.");
    }

    if (normalizedAgentId !== null) {
      const agent = await ticketRepository.findUserById(normalizedAgentId, client);
      if (!agent) {
        throw new ApiError(404, "Agent not found.");
      }
      if (agent.role !== "AGENT") {
        throw new ApiError(400, "The assigned user must have the AGENT role.");
      }
      if (!agent.is_active) {
        throw new ApiError(400, "Cannot assign a deactivated agent.");
      }
    }

    const oldAgentId = row.assigned_agent_id === null
      ? null
      : String(row.assigned_agent_id);
    if (oldAgentId === normalizedAgentId) {
      const current = await ticketRepository.findTicketById(id, client);
      return serializeTicket(current ?? row);
    }

    const updated = await ticketRepository.updateTicketAssignment(
      id,
      normalizedAgentId,
      client,
    );

    if (!updated) {
      // The guarded UPDATE only fails for CLOSED tickets (or a concurrent
      // deletion); the row was locked above, so CLOSED is the real cause.
      throw new ApiError(
        409,
        "Cannot change the assignment of a CLOSED ticket.",
      );
    }

    await ticketRepository.insertTicketHistory(
      {
        ticketId: row.id,
        changedBy: user.id,
        action: "ASSIGNED",
        fieldName: "assigned_agent_id",
        oldValue: oldAgentId,
        newValue: normalizedAgentId,
      },
      client,
    );

    return serializeTicket(updated);
  });

  return ticket;
}

/**
 * Audit history for a ticket. AGENTs only see history of assigned tickets;
 * ADMINs see everything. (Customers are blocked at the route level and
 * defensively here.)
 *
 * @param {string|number} id
 * @param {{ id: string|number, role: string }} user
 * @returns {Promise<Array<object>>}
 */
async function getTicketHistory(id, user) {
  if (user.role === "CUSTOMER") {
    throw new ApiError(
      403,
      "Forbidden. Ticket history is only available to support staff.",
    );
  }

  const row = await ticketRepository.findTicketById(id);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!canAccessTicket(user, row)) {
    throw new ApiError(403, "Forbidden. You are not authorized to view this ticket.");
  }

  const entries = await ticketRepository.listTicketHistory(id);

  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    field_name: entry.field_name,
    old_value: entry.old_value,
    new_value: entry.new_value,
    changed_by: entry.changed_by_id
      ? {
          id: entry.changed_by_id,
          name: entry.changed_by_name,
        }
      : null,
    created_at: entry.created_at,
  }));
}

export default {
  validateTicketCategory,
  canAccessTicket,
  createTicket,
  listTickets,
  getTicketById,
  updateTicket,
  updateTicketStatus,
  updateTicketAssignment,
  getTicketHistory,
};
