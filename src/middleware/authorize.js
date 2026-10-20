import ApiError from "../utils/ApiError.js";

function authorize(..._roles) {
  return (_req, _res, next) => {
    next(new ApiError(501, "Authorization is not configured"));
  };
}

export default authorize;
