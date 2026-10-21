import authService from "./auth.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * POST /api/v1/auth/register
 *
 * Request body (validated upstream by the `validate` middleware):
 *   { name: string, email: string, password: string }
 *
 * Response 201:
 *   { status: "success", data: { user: { id, name, email, role, created_at } } }
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  const user = await authService.registerUser({ name, email, password });

  res.status(201).json({
    status: "success",
    data: { user },
  });
});

export default { register };
