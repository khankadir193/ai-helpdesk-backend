import ApiError from "../utils/ApiError.js";

function authenticate(_req, _res, next) {
  next(new ApiError(501, "Authentication is not configured"));
}

export default authenticate;
