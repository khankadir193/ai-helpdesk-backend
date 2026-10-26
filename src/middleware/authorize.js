import ApiError from "../utils/ApiError.js";

function authorize(...roles) {
  const allowedRoles = roles.map((r) => String(r).toUpperCase());

  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, "Authentication required."));
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      return next(
        new ApiError(403, "Forbidden. You do not have permission to perform this action.")
      );
    }

    next();
  };
}

export default authorize;
