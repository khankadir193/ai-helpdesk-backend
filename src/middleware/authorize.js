const ApiError = require("../utils/ApiError");

function authorize(..._roles) {
  return (_req, _res, next) => {
    next(new ApiError(501, "Authorization is not configured"));
  };
}

module.exports = authorize;
