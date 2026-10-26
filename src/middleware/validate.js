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
function validate(schema, options = {}) {
  return (req, _res, next) => {
    if (
      req.body === null ||
      typeof req.body !== "object" ||
      Array.isArray(req.body)
    ) {
      const err = new ApiError(422, "Validation failed");
      err.errors = [{ field: "_body", message: "Request body must be a JSON object" }];
      return next(err);
    }

    const body = req.body ?? {};
    const errors = [];

    // Check for empty body when disallowed
    if (options.disallowEmpty && Object.keys(body).length === 0) {
      const err = new ApiError(422, "Validation failed");
      err.errors = [{ field: "_body", message: "Request body cannot be empty" }];
      return next(err);
    }

    // Check requireAtLeastOneOf
    if (
      Array.isArray(options.requireAtLeastOneOf) &&
      options.requireAtLeastOneOf.length > 0
    ) {
      const hasAny = options.requireAtLeastOneOf.some(
        (field) => body[field] !== undefined
      );
      if (!hasAny) {
        const err = new ApiError(422, "Validation failed");
        err.errors = [
          {
            field: "_body",
            message: `At least one of [${options.requireAtLeastOneOf.join(
              ", "
            )}] must be provided`,
          },
        ];
        return next(err);
      }
    }

    // Check for unknown fields if rejectUnknown is enabled
    if (options.rejectUnknown) {
      const allowedFields = new Set(Object.keys(schema));
      for (const key of Object.keys(body)) {
        if (!allowedFields.has(key)) {
          errors.push({ field: key, message: `Unknown field: ${key}` });
        }
      }
    }

    for (const [field, rules] of Object.entries(schema)) {
      const raw = body[field];
      const isAbsent = raw === undefined;
      const isNull = raw === null;

      if (rules.required && (isAbsent || isNull || raw === "")) {
        errors.push({ field, message: `${field} is required` });
        continue;
      }

      // If field is optional and absent, skip
      if (isAbsent) continue;

      // If field is nullable and null, skip further validation
      if (rules.nullable && isNull) continue;

      if (!rules.nullable && isNull) {
        errors.push({ field, message: `${field} cannot be null` });
        continue;
      }

      if (rules.type === "boolean") {
        if (typeof raw !== "boolean") {
          errors.push({ field, message: `${field} must be a boolean` });
        }
        continue;
      }

      if (rules.type === "string") {
        if (typeof raw !== "string") {
          errors.push({ field, message: `${field} must be a string` });
          continue;
        }

        const value = raw.trim();

        if (rules.required && value.length === 0) {
          errors.push({
            field,
            message: `${field} cannot be empty or whitespace only`,
          });
          continue;
        }

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
