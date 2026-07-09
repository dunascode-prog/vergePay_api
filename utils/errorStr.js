import AppError from "./appError.js";

export class BadRequestError extends AppError {
  constructor({ message = "Bad request", details = null } = {}) {
    super({
      message: message,
      statusCode: 400,
      code: "BAD_REQUEST",
      details: details,
    });
  }
}
export class UnauthorizedError extends AppError {
  constructor({ message = "Unauthorized" } = {}) {
    super({ message: message, statusCode: 401, code: "UNAUTHORIZED" });
  }
}

export class ForbiddenError extends AppError {
  constructor({ message = "Forbidden" } = {}) {
    super({ message: message, statusCode: 403, code: "FORBIDDEN" });
  }
}

export class NotFoundError extends AppError {
  constructor({ message = "Resource not found" } = {}) {
    super({ message: message, statusCode: 404, code: "NOT_FOUND" });
  }
}

export class ConflictError extends AppError {
  constructor({ message = "Resource already exists" } = {}) {
    super({ message: message, statusCode: 409, code: "CONFLICT" });
  }
}

export class ValidationError extends AppError {
  constructor({ message = "Validation failed", details = null } = {}) {
    super({
      message: message,
      statusCode: 422,
      code: "VALIDATION_ERROR",
      details: details,
    });
  }
}

export class TooManyRequestsError extends AppError {
  constructor({ message = "Too many requests" } = {}) {
    super({
      message: message,
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      details: details,
    });
  }
}

export class InternalServerError extends AppError {
  constructor({ message = "Internal server error" } = {}) {
    super({ message: message, statusCode: 500, code: "INTERNAL_SERVER_ERROR" });
  }
}
