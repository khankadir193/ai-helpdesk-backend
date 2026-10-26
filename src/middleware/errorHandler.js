import ApiError from "../utils/ApiError.js";

function errorHandler(error, _req, res, _next) {
  let apiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    apiError = new ApiError(400, "Malformed JSON in request body");
  } else {
    apiError = new ApiError(500, "Internal server error");
  }

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
