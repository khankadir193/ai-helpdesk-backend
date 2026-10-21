import ApiError from "../utils/ApiError.js";

/**
 * Express middleware factory that validates `req.body` against a plain-object
 * schema and attaches the validated (and possibly coerced) value back onto
 * `req.body`.
 *
 * Schema shape:
 *   {
 *     [fieldName]: {
 *       type       : "string" | "number" | "boolean",
 *       required   : boolean,
 *       minLength  : number,   // strings only
 *       maxLength  : number,   // strings only
 *       pattern    : RegExp,   // strings only
 *       message    : string,   // custom error message for pattern failures
 *     }
 *   }
 *
 * Returns a 422 Unprocessable Entity with a structured `errors` array on
 * the first validation failure.
 */
function validate(schema) {
  return (req, _res, next) => {
    const body = req.body ?? {};
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const raw = body[field];
      const missing = raw === undefined || raw === null || raw === "";

      if (rules.required && missing) {
        errors.push({ field, message: `${field} is required` });
        continue;
      }

      // Skip further checks for optional absent fields
      if (missing) continue;

      if (rules.type === "string") {
        if (typeof raw !== "string") {
          errors.push({ field, message: `${field} must be a string` });
          continue;
        }

        const value = raw.trim();

        if (rules.minLength !== undefined && value.length < rules.minLength) {
          errors.push({
            field,
            message:
              rules.minLengthMessage ??
              `${field} must be at least ${rules.minLength} characters`,
          });
        }

        if (rules.maxLength !== undefined && value.length > rules.maxLength) {
          errors.push({
            field,
            message:
              rules.maxLengthMessage ??
              `${field} must be at most ${rules.maxLength} characters`,
          });
        }

        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push({
            field,
            message: rules.message ?? `${field} is invalid`,
          });
        }
      }
    }

    if (errors.length > 0) {
      const err = new ApiError(422, "Validation failed");
      err.errors = errors;
      return next(err);
    }

    next();
  };
}

export default validate;
