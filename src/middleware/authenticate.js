const ApiError = require("../utils/ApiError");

function authenticate(_req, _res, next) {
  next(new ApiError(501, "Authentication is not configured"));
}

module.exports = authenticate;
