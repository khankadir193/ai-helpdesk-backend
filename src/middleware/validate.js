const ApiError = require("../utils/ApiError");

function validate(_schema) {
  return (_req, _res, next) => {
    next(new ApiError(501, "Request validation is not configured"));
  };
}

module.exports = validate;
