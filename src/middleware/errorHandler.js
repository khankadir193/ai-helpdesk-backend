import ApiError from "../utils/ApiError.js";

function errorHandler(error, _req, res, _next) {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(500, "Internal server error");

  if (apiError.statusCode >= 500) {
    console.error(error);
  }

  const body = { status: "error", message: apiError.message };
  if (Array.isArray(apiError.errors)) {
    body.errors = apiError.errors;
  }

  res.status(apiError.statusCode).json(body);
}

export default errorHandler;
