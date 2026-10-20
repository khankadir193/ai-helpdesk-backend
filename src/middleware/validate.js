import ApiError from "../utils/ApiError.js";

function validate(_schema) {
  return (_req, _res, next) => {
    next(new ApiError(501, "Request validation is not configured"));
  };
}

export default validate;
