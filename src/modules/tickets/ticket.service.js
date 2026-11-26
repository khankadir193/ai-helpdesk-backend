import ApiError from "../../utils/ApiError.js";
import categoryService from "../categories/category.service.js";
import ticketRepository from "./ticket.repository.js";
import permissions from "../../utils/permissions.js";
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
 *
 * @param {string|number|null} categoryId
 * @returns {Promise<object|null>}
 */
async function validateTicketCategory(categoryId) {
  if (categoryId === undefined || categoryId === null || categoryId === "") {
    return null;
  }
  return categoryService.ensureCategoryIsActive(categoryId);
}

/**
 * Decide whether a user may see/manage a ticket.
 *
 * @param {{ id: string|number, role: string }} user
 * @param {object} ticket
 * @returns {Promise<boolean>}
 */
async function canAccessTicket(user, ticket) {
  const scope = await permissions.getTicketScope(user.role, "view_tickets");
  return permissions.ticketInScope(scope, user, ticket);
}

/**
 * Convert a joined repository row into the public API shape.
 *
 * @param {object} row
 * @returns {object}
 */
function serializeTicket(row) {
  if (!row) return null;
  const customerId = row.customer_id ?? null;
  const agentId = row.agent_id ?? row.assigned_agent_id ?? null;
  const categoryId = row.category_id ?? null;

  let parsedAttachments = [];
  if (Array.isArray(row.attachments)) {
    parsedAttachments = row.attachments;
  } else if (typeof row.attachments === "string") {
    try {
      parsedAttachments = JSON.parse(row.attachments);
    } catch {
      parsedAttachments = [];
    }
  }

  return {
    id: String(row.id),
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    source: row.source || "Email",
    tags: Array.isArray(row.tags) ? row.tags : [],
    attachments: parsedAttachments,
    customer_id: customerId ? String(customerId) : null,
    assigned_agent_id: agentId ? String(agentId) : null,
    category_id: categoryId ? String(categoryId) : null,
    customer: {
      id: customerId ? String(customerId) : null,
      name: row.customer_name ?? null,
      email: row.customer_email ?? null,
    },
    assigned_agent: agentId
      ? {
          id: String(agentId),
          name: row.agent_name ?? null,
          email: row.agent_email ?? null,
        }
      : null,
    category: categoryId
      ? {
          id: String(categoryId),
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
 * Normalize a priority value.
 *
 * @param {string|undefined} value
 * @returns {string}
 */
function normalizePriority(value) {
  if (value === undefined || value === null || value === "") return "MEDIUM";
  const normalized = String(value).trim().toUpperCase();
  if (!TICKET_PRIORITIES.includes(normalized)) {
    throw new ApiError(
      422,
      `priority must be one of ${TICKET_PRIORITIES.join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * Normalize status value.
 */
function normalizeStatus(value) {
  if (value === undefined || value === null || value === "") return "OPEN";
  const normalized = String(value).trim().toUpperCase();
  if (!TICKET_STATUSES.includes(normalized)) {
    throw new ApiError(
      422,
      `status must be one of ${TICKET_STATUSES.join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * Normalize source value.
 *
 * @param {string|undefined} value
 * @param {string} [defaultSource="Email"]
 * @returns {string}
 */
function normalizeSource(value, defaultSource = "Email") {
  if (value === undefined || value === null || value === "") return defaultSource;
  const normalized = String(value).trim();
  const allowed = ["Email", "Phone", "Chat", "Web", "Portal"];
  const matched = allowed.find((item) => item.toLowerCase() === normalized.toLowerCase());
  return matched || defaultSource;
}

/**
 * Create a new ticket and record the TICKET_CREATED audit entry.
 * Supports customer self-creation or staff logging on behalf of customer.
 *
 * @param {{
 *   user: object,
 *   title: string,
 *   description: string,
 *   customer_id?: string|number,
 *   customer_name?: string,
 *   customer_email?: string,
 *   category_id?: string|number|null,
 *   priority?: string,
 *   status?: string,
 *   assigned_agent_id?: string|number|null,
 *   source?: string,
 *   tags?: string[]|string,
 *   attachments?: any[]
 * }} data
 * @returns {Promise<object>}
 */
async function createTicket(data) {
  const { user } = data;
  const isStaff = user && (user.role === "ADMIN" || user.role === "AGENT");

  const title = String(data.title || "").trim();
  const description = String(data.description || "").trim();

  if (!title) {
    throw new ApiError(422, "Ticket subject / title is required.");
  }
  if (!description) {
    throw new ApiError(422, "Ticket description is required.");
  }

  // Enforce customer constraints: cannot set customer_id, status, assignee, or tags
  if (!isStaff) {
    if (data.customer_id !== undefined && data.customer_id !== null) {
      const err = new ApiError(422, "Validation failed");
      err.errors = [
        { field: "customer_id", message: "Customers cannot specify customer_id" },
      ];
      throw err;
    }
    if (data.status && String(data.status).toUpperCase() !== "OPEN") {
      throw new ApiError(403, "Forbidden. Customers cannot set ticket status.");
    }
    if (data.assigned_agent_id !== undefined && data.assigned_agent_id !== null && data.assigned_agent_id !== "") {
      throw new ApiError(403, "Forbidden. Customers cannot assign tickets.");
    }
    if (data.tags && (Array.isArray(data.tags) ? data.tags.length > 0 : String(data.tags).trim().length > 0)) {
      throw new ApiError(403, "Forbidden. Customers cannot set ticket tags.");
    }
  }

  let finalCustomerId = null;
  if (!isStaff) {
    // Customer can only create tickets for themselves
    finalCustomerId = user.id;
  } else {
    // Staff can provide customer_id or customer_email + customer_name
    if (data.customer_id) {
      finalCustomerId = validateModelId(data.customer_id);
      const existing = await ticketRepository.findUserById(finalCustomerId);
      if (!existing) {
        throw new ApiError(404, "Customer not found.");
      }
    } else if (data.customer_email) {
      const email = String(data.customer_email).trim().toLowerCase();
      const existing = await ticketRepository.findUserByEmail(email);
      if (existing) {
        finalCustomerId = existing.id;
      } else {
        const name = String(data.customer_name || email.split("@")[0]).trim();
        const createdCustomer = await ticketRepository.insertCustomerUser({ name, email });
        finalCustomerId = createdCustomer.id;
      }
    } else {
      finalCustomerId = user.id;
    }
  }

  const normalizedPriority = normalizePriority(data.priority);
  const normalizedStatus = "OPEN";
  const effectiveSource = normalizeSource(data.source, !isStaff ? "Portal" : "Email");

  let normalizedTags = [];
  if (isStaff) {
    if (Array.isArray(data.tags)) {
      normalizedTags = data.tags.map((t) => String(t).trim()).filter(Boolean);
    } else if (typeof data.tags === "string") {
      normalizedTags = data.tags.split(",").map((t) => t.trim()).filter(Boolean);
    }
  }

  // Validate active category
  await validateTicketCategory(data.category_id);

  const ticket = await ticketRepository.withTransaction(async (client) => {
    const inserted = await ticketRepository.insertTicket(
      {
        title,
        description,
        customer_id: finalCustomerId,
        category_id: data.category_id || null,
        priority: normalizedPriority,
        status: normalizedStatus,
        assigned_agent_id: null,
        source: effectiveSource,
        tags: normalizedTags,
        attachments: [],
      },
      client,
    );

    await ticketRepository.insertTicketHistory(
      {
        ticketId: inserted.id,
        changedBy: user.id,
        action: "TICKET_CREATED",
        fieldName: "status",
        oldValue: null,
        newValue: normalizedStatus,
      },
      client,
    );

    const detail = await ticketRepository.findTicketById(inserted.id, client);
    return serializeTicket(detail ?? inserted);
  });

  return ticket;
}

/**
 * Build WHERE conditions for listing tickets.
 */
function buildTicketQueryConditions({ user, viewScope, tab, q, status, priority, categoryId, assignedAgentId, dateRange, from, to }) {
  const conditions = [];
  const values = [];

  // Base scope based on permissions
  if (viewScope === "OWN") {
    values.push(user.id);
    conditions.push(`t.customer_id = $${values.length}`);
  } else if (viewScope === "ASSIGNED") {
    values.push(user.id);
    conditions.push(`t.assigned_agent_id = $${values.length}`);
  } else if (viewScope === "NONE") {
    conditions.push("FALSE");
  }

  // Tab filter
  if (tab === "mine") {
    if (user.role === "CUSTOMER") {
      values.push(user.id);
      conditions.push(`t.customer_id = $${values.length}`);
    } else {
      values.push(user.id);
      conditions.push(`t.assigned_agent_id = $${values.length}`);
    }
  } else if (tab === "unassigned") {
    conditions.push("t.assigned_agent_id IS NULL");
  }

  // Search query (subject, ID, customer name/email)
  if (q && String(q).trim()) {
    const cleanQ = String(q).trim();
    const idMatch = cleanQ.match(/^(?:TCK-)?(\d+)$/i);
    if (idMatch) {
      values.push(idMatch[1]);
      values.push(`%${cleanQ}%`);
      conditions.push(`(t.id = $${values.length - 1} OR t.title ILIKE $${values.length})`);
    } else {
      values.push(`%${cleanQ}%`);
      conditions.push(`(t.title ILIKE $${values.length} OR c.name ILIKE $${values.length} OR c.email ILIKE $${values.length})`);
    }
  }

  // Status filter (single or comma-separated)
  if (status !== undefined && status !== "") {
    const rawStatuses = String(status).split(",").map((s) => s.trim().toUpperCase());
    for (const s of rawStatuses) {
      if (!TICKET_STATUSES.includes(s)) {
        throw new ApiError(400, `Invalid status filter value: ${s}`);
      }
    }
    values.push(rawStatuses);
    conditions.push(`t.status = ANY($${values.length}::varchar[])`);
  }

  // Priority filter (single or comma-separated)
  if (priority !== undefined && priority !== "") {
    const rawPriorities = String(priority).split(",").map((p) => p.trim().toUpperCase());
    for (const p of rawPriorities) {
      if (!TICKET_PRIORITIES.includes(p)) {
        throw new ApiError(400, `Invalid priority filter value: ${p}`);
      }
    }
    values.push(rawPriorities);
    conditions.push(`t.priority = ANY($${values.length}::varchar[])`);
  }

  // Category filter (single or comma-separated)
  if (categoryId !== undefined && categoryId !== "") {
    const rawCats = String(categoryId).split(",").map((c) => c.trim());
    const validCatIds = [];
    for (const c of rawCats) {
      if (!/^\d+$/.test(c) || Number(c) <= 0) {
        throw new ApiError(400, `Invalid category_id filter value: ${c}`);
      }
      validCatIds.push(Number(c));
    }
    values.push(validCatIds);
    conditions.push(`t.category_id = ANY($${values.length}::bigint[])`);
  }

  // Assigned Agent filter (Admin-only)
  if (assignedAgentId !== undefined && assignedAgentId !== "") {
    if (user.role !== "ADMIN") {
      throw new ApiError(403, "Only admins can filter tickets by assigned agent.");
    }
    const cleanAgent = String(assignedAgentId).trim().toLowerCase();
    if (cleanAgent === "unassigned" || cleanAgent === "none") {
      conditions.push("t.assigned_agent_id IS NULL");
    } else if (/^\d+$/.test(cleanAgent)) {
      values.push(validateModelId(cleanAgent));
      conditions.push(`t.assigned_agent_id = $${values.length}`);
    } else {
      throw new ApiError(400, "Invalid assigned_agent_id filter.");
    }
  }

  // Date range filter
  if (dateRange) {
    const cleanRange = String(dateRange).trim().toLowerCase();
    if (cleanRange === "today") {
      conditions.push("t.created_at >= CURRENT_DATE");
    } else if (cleanRange === "yesterday") {
      conditions.push("t.created_at >= CURRENT_DATE - INTERVAL '1 day' AND t.created_at < CURRENT_DATE");
    } else if (cleanRange === "last_7_days" || cleanRange === "7d") {
      conditions.push("t.created_at >= NOW() - INTERVAL '7 days'");
    } else if (cleanRange === "last_30_days" || cleanRange === "30d") {
      conditions.push("t.created_at >= NOW() - INTERVAL '30 days'");
    } else if (cleanRange === "last_3_months" || cleanRange === "3m") {
      conditions.push("t.created_at >= NOW() - INTERVAL '90 days'");
    } else if (cleanRange === "custom" && (from || to)) {
      if (from) {
        values.push(new Date(from).toISOString());
        conditions.push(`t.created_at >= $${values.length}`);
      }
      if (to) {
        values.push(new Date(to).toISOString());
        conditions.push(`t.created_at <= $${values.length}`);
      }
    }
  }

  const where = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";
  return { where, values };
}

/**
 * List tickets according to caller's role plus filters.
 */
async function listTickets({
  user,
  tab,
  q,
  status,
  priority,
  categoryId,
  assignedAgentId,
  dateRange,
  from,
  to,
  sort = "created_at",
  order = "desc",
  page = 1,
  limit = 20,
}) {
  const viewScope = await permissions.getTicketScope(user.role, "view_tickets");

  const { where, values } = buildTicketQueryConditions({
    user,
    viewScope,
    tab,
    q,
    status,
    priority,
    categoryId,
    assignedAgentId,
    dateRange,
    from,
    to,
  });

  const total = await ticketRepository.countTickets({ where, values });

  const rows = await ticketRepository.listTickets({
    where,
    values,
    sort,
    order: order.toUpperCase(),
    limit,
    offset: (page - 1) * limit,
  });

  // Base scope for tab counts (without tab or pagination constraints)
  const baseScope = [];
  const baseValues = [];
  if (viewScope === "OWN") {
    baseValues.push(user.id);
    baseScope.push(`t.customer_id = $${baseValues.length}`);
  } else if (viewScope === "ASSIGNED") {
    baseValues.push(user.id);
    baseScope.push(`(t.assigned_agent_id = $${baseValues.length} OR t.assigned_agent_id IS NULL)`);
  } else if (viewScope === "NONE") {
    baseScope.push("FALSE");
  }
  const baseWhere = baseScope.length > 0 ? baseScope.join(" AND ") : "TRUE";

  const counts = await ticketRepository.getTabCounts({
    baseWhere,
    baseValues,
    userId: user.id,
    role: user.role,
  });

  return {
    tickets: rows.map(serializeTicket),
    pagination: {
      page,
      limit,
      total_items: total,
      total_pages: Math.ceil(total / limit),
    },
    counts,
  };
}

/**
 * Export tickets matching filters to RFC 4180 CSV string.
 */
async function exportTicketsCsv({ user, tab, q, status, priority, categoryId, assignedAgentId, dateRange, from, to }) {
  const viewScope = await permissions.getTicketScope(user.role, "view_tickets");
  if (viewScope === "NONE") {
    throw new ApiError(403, "Forbidden. You do not have permission to export tickets.");
  }

  if (user.role === "CUSTOMER") {
    throw new ApiError(403, "Forbidden. Customers cannot export tickets.");
  }

  let effectiveTab = tab;
  let effectiveAgentId = assignedAgentId;
  if (viewScope === "ASSIGNED") {
    effectiveTab = "mine";
    effectiveAgentId = user.id;
  }

  const { where, values } = buildTicketQueryConditions({
    user,
    viewScope,
    tab: effectiveTab,
    q,
    status,
    priority,
    categoryId,
    assignedAgentId: effectiveAgentId,
    dateRange,
    from,
    to,
  });

  const rows = await ticketRepository.listTickets({
    where,
    values,
    sort: "created_at",
    order: "DESC",
  });

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return "\"\"";
    const str = String(val).replace(/"/g, "\"\"");
    return `"${str}"`;
  };

  const headers = [
    "ID",
    "Subject",
    "Customer",
    "Customer Email",
    "Priority",
    "Status",
    "Assigned Agent",
    "Category",
    "Created",
    "Updated",
  ];

  const csvRows = rows.map((r) => [
    escapeCsv(`TCK-${r.id}`),
    escapeCsv(r.title),
    escapeCsv(r.customer_name || ""),
    escapeCsv(r.customer_email || ""),
    escapeCsv(r.priority),
    escapeCsv(r.status),
    escapeCsv(r.agent_name || "Unassigned"),
    escapeCsv(r.category_name || "General"),
    escapeCsv(r.created_at ? new Date(r.created_at).toISOString() : ""),
    escapeCsv(r.updated_at ? new Date(r.updated_at).toISOString() : ""),
  ]);

  return [headers.map(escapeCsv).join(","), ...csvRows.map((row) => row.join(","))].join("\r\n");
}

/**
 * Get one ticket by ID.
 */
async function getTicketById(id, user) {
  const row = await ticketRepository.findTicketById(id);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!(await canAccessTicket(user, row))) {
    throw new ApiError(403, "Forbidden. You are not authorized to view this ticket.");
  }

  const serialized = serializeTicket(row);
  if (user && user.role === "CUSTOMER") {
    serialized.tags = [];
    serialized.assigned_agent_id = null;
    serialized.assigned_agent = null;
    serialized.assigned_agent_name = null;
    serialized.assigned_agent_email = null;
  }
  return serialized;
}

/**
 * Update editable ticket fields.
 */
async function updateTicket(id, user, data) {
  const changes = await ticketRepository.withTransaction(async (client) => {
    const row = await ticketRepository.lockTicketById(id, client);

    if (!row) {
      throw new ApiError(404, "Ticket not found.");
    }
    if (!(await canAccessTicket(user, row))) {
      throw new ApiError(403, "Forbidden. You are not authorized to update this ticket.");
    }
    if (row.status === "CLOSED") {
      throw new ApiError(409, "Cannot update a CLOSED ticket.");
    }
    if (user.role === "CUSTOMER") {
      if (row.status !== "OPEN") {
        throw new ApiError(
          403,
          "Forbidden. You can only edit your ticket while its status is OPEN.",
        );
      }
      if (data.status !== undefined || data.assigned_agent_id !== undefined || data.tags !== undefined || data.priority !== undefined) {
        throw new ApiError(403, "Forbidden. Customers cannot modify ticket status, priority, assignee, or tags.");
      }
    }
    if (user.role === "AGENT" && data.assigned_agent_id !== undefined && data.assigned_agent_id !== null && String(data.assigned_agent_id) !== String(user.id)) {
      throw new ApiError(403, "Forbidden. Support agents may only assign tickets to themselves.");
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
      const normalized = data.category_id === null || data.category_id === "" ? null : String(data.category_id);
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

    if (data.source !== undefined && user.role !== "CUSTOMER") {
      fields.source = String(data.source).trim();
    }

    if (data.tags !== undefined) {
      let tagsArray = [];
      if (Array.isArray(data.tags)) {
        tagsArray = data.tags.map((t) => String(t).trim()).filter(Boolean);
      } else if (typeof data.tags === "string") {
        tagsArray = data.tags.split(",").map((t) => t.trim()).filter(Boolean);
      }
      fields.tags = tagsArray;
    }

    if (data.attachments !== undefined && Array.isArray(data.attachments)) {
      fields.attachments = JSON.stringify(data.attachments);
    }

    if (Object.keys(fields).length === 0) {
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
 * Update ticket status.
 */
async function updateTicketStatus(id, user, nextStatus) {
  const normalized = String(nextStatus || "").trim().toUpperCase();
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

    const statusScope = await permissions.getTicketScope(user.role, "update_status");
    if (statusScope === "NONE") {
      throw new ApiError(
        403,
        "Forbidden. You do not have permission to change the ticket status.",
      );
    }
    if (!permissions.ticketInScope(statusScope, user, row)) {
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
          `Allowed transitions: ${ALLOWED_TRANSITIONS[row.status].join(", ") || "none"}.`,
      );
    }

    const updated = await ticketRepository.updateTicketStatus(
      id,
      normalized,
      client,
    );

    if (!updated) {
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
 * Assign or reassign a ticket.
 */
async function updateTicketAssignment(id, user, assignedAgentId) {
  const canAssign = await permissions.hasPermission(user.role, "assign_reassign_tickets");
  if (!canAssign && user.role !== "ADMIN") {
    throw new ApiError(
      403,
      "Forbidden. You do not have permission to assign tickets.",
    );
  }

  // Agent self-assign check (can claim unassigned to self)
  if (user.role === "AGENT" && String(assignedAgentId) !== String(user.id)) {
    throw new ApiError(
      403,
      "Support agents may only assign tickets to themselves.",
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
      if (agent.role !== "AGENT" && agent.role !== "ADMIN") {
        throw new ApiError(400, "The assigned user must have AGENT role.");
      }
      if (!agent.is_active) {
        throw new ApiError(400, "Cannot assign a deactivated agent.");
      }
    }

    const oldAgentId = row.assigned_agent_id === null ? null : String(row.assigned_agent_id);
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
 * Delete a single ticket (Admin only).
 */
async function deleteTicket(id, user) {
  if (user.role !== "ADMIN") {
    throw new ApiError(403, "Forbidden. Only administrators can delete tickets.");
  }

  const ticket = await ticketRepository.findTicketById(id);
  if (!ticket) {
    throw new ApiError(404, "Ticket not found.");
  }

  await ticketRepository.withTransaction(async (client) => {
    await ticketRepository.deleteTicketById(id, client);
  });

  return { success: true };
}

/**
 * Bulk update status.
 */
async function bulkUpdateStatus(ticketIds, status, user) {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new ApiError(400, "ticket_ids array is required.");
  }

  const normalized = normalizeStatus(status);
  const statusScope = await permissions.getTicketScope(user.role, "update_status");
  if (statusScope === "NONE") {
    throw new ApiError(403, "Forbidden. You do not have permission to update status.");
  }

  const successfulIds = [];
  const failedIds = [];

  for (const id of ticketIds) {
    try {
      await updateTicketStatus(id, user, normalized);
      successfulIds.push(String(id));
    } catch (err) {
      failedIds.push({ id: String(id), error: err.message });
    }
  }

  return {
    updated_count: successfulIds.length,
    successful_ids: successfulIds,
    failed_ids: failedIds,
  };
}

/**
 * Bulk update assignment.
 */
async function bulkUpdateAssignment(ticketIds, assignedAgentId, user) {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new ApiError(400, "ticket_ids array is required.");
  }

  const canAssign = await permissions.hasPermission(user.role, "assign_reassign_tickets");
  if (!canAssign && user.role !== "ADMIN") {
    throw new ApiError(403, "Forbidden. You do not have permission to assign tickets.");
  }

  if (user.role === "AGENT" && assignedAgentId !== null && String(assignedAgentId) !== String(user.id)) {
    throw new ApiError(403, "Forbidden. Support agents may only assign tickets to themselves.");
  }

  const successfulIds = [];
  const failedIds = [];

  for (const id of ticketIds) {
    try {
      await updateTicketAssignment(id, user, assignedAgentId);
      successfulIds.push(String(id));
    } catch (err) {
      failedIds.push({ id: String(id), error: err.message });
    }
  }

  return {
    updated_count: successfulIds.length,
    successful_ids: successfulIds,
    failed_ids: failedIds,
  };
}

/**
 * Bulk delete tickets (Admin only).
 */
async function bulkDeleteTickets(ticketIds, user) {
  if (user.role !== "ADMIN") {
    throw new ApiError(403, "Forbidden. Only administrators can delete tickets.");
  }

  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new ApiError(400, "ticket_ids array is required.");
  }

  const normalizedIds = ticketIds.map((id) => validateModelId(id));

  await ticketRepository.withTransaction(async (client) => {
    await ticketRepository.bulkDeleteTickets(normalizedIds, client);
  });

  return {
    deleted_count: normalizedIds.length,
    deleted_ids: normalizedIds,
  };
}

/**
 * Search customers.
 */
async function searchCustomers(query, user) {
  if (user.role !== "ADMIN" && user.role !== "AGENT") {
    throw new ApiError(403, "Forbidden. Staff access required.");
  }
  const customers = await ticketRepository.searchCustomers(query);
  return customers.map((c) => ({
    id: String(c.id),
    name: c.name,
    email: c.email,
    total_tickets: c.total_tickets,
  }));
}

/**
 * Get active agents with open ticket counts.
 */
async function getAgentsWithOpenCounts(user) {
  if (user.role !== "ADMIN" && user.role !== "AGENT") {
    throw new ApiError(403, "Forbidden. Staff access required.");
  }
  const agents = await ticketRepository.getAgentsWithOpenCounts();
  return agents.map((a) => ({
    id: String(a.id),
    name: a.name,
    email: a.email,
    open_tickets_count: a.open_tickets_count,
  }));
}

/**
 * Audit history for a ticket.
 */
async function getTicketHistory(id, user) {
  const historyScope = await permissions.getTicketScope(user.role, "ticket_history");
  if (historyScope === "NONE") {
    throw new ApiError(
      403,
      "Forbidden. Ticket history is only available to support staff.",
    );
  }

  const row = await ticketRepository.findTicketById(id);

  if (!row) {
    throw new ApiError(404, "Ticket not found.");
  }
  if (!permissions.ticketInScope(historyScope, user, row)) {
    throw new ApiError(403, "Forbidden. You are not authorized to view this ticket.");
  }

  const entries = await ticketRepository.listTicketHistory(id);

  return entries.map((entry) => ({
    id: String(entry.id),
    action: entry.action,
    field_name: entry.field_name,
    old_value: entry.old_value,
    new_value: entry.new_value,
    changed_by: entry.changed_by_id
      ? {
          id: String(entry.changed_by_id),
          name: entry.changed_by_name,
        }
      : null,
    created_at: entry.created_at,
  }));
}

export default {
  serializeTicket,
  validateTicketCategory,
  canAccessTicket,
  createTicket,
  listTickets,
  exportTicketsCsv,
  getTicketById,
  updateTicket,
  updateTicketStatus,
  updateTicketAssignment,
  deleteTicket,
  bulkUpdateStatus,
  bulkUpdateAssignment,
  bulkDeleteTickets,
  searchCustomers,
  getAgentsWithOpenCounts,
  getTicketHistory,
};
