import userService from "./user.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/v1/users/agents
 * Admin only — directory of active AGENT accounts for ticket assignment.
 *
 * Response 200:
 *   { status: "success",
 *     data: { agents: [{ id, name, email }, ...] } }
 */
const listAgents = asyncHandler(async (req, res) => {
  const agents = await userService.listAgents();

  res.status(200).json({
    status: "success",
    data: { agents },
  });
});

export default {
  listAgents,
};
