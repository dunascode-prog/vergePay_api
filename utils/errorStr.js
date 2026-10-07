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
// An upload that's too big or not an accepted type.
export class PayloadTooLargeError extends AppError {
  constructor({ message = "That file is too large." } = {}) {
    super({ message, statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  }
}
export class UnsupportedMediaTypeError extends AppError {
  constructor({ message = "That file type isn't supported." } = {}) {
    super({ message, statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
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
  constructor({ message = "Resource already exists", field = null } = {}) {
    super({
      message: message,
      statusCode: 409,
      code: "CONFLICT",
      field: field,
    });
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

export class KycRequiredError extends AppError {
  constructor({
    message = "Identity verification is required before you can move money.",
  } = {}) {
    super({ message, statusCode: 403, code: "KYC_REQUIRED" });
  }
}

export class InsufficientFundsError extends AppError {
  constructor({ message = "Insufficient funds.", details = null } = {}) {
    super({ message, statusCode: 422, code: "INSUFFICIENT_FUNDS", details });
  }
}

export class TooManyRequestsError extends AppError {
  constructor({ message = "Too many requests", details = null } = {}) {
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

export class DatabaseError extends AppError {
  constructor({ message = "A database error occurred.", details = null } = {}) {
    super({
      message,
      statusCode: 500,
      code: "DATABASE_ERROR",
      details,
    });
  }
}
export class ServiceUnavailableError extends AppError {
  constructor({
    message = "Service temporarily unavailable.",
    details = null,
  } = {}) {
    super({
      message,
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      details,
    });
  }
}
export class TokenExpiredError extends AppError {
  constructor({
    message = "Your session has expired. Please log in again.",
    details = null,
  } = {}) {
    super({
      message,
      statusCode: 401,
      code: "TOKEN_EXPIRED",
      details,
    });
  }
}

// 403, not 401: the session is valid, and the UI refreshes on 401. The
// client should ask for a 2FA code and call POST /v1/auth/2fa/verify.
export class TwoFactorRequiredError extends AppError {
  constructor({ message = "Two-factor confirmation required." } = {}) {
    super({ message, statusCode: 403, code: "TWO_FACTOR_REQUIRED" });
  }
}

export class InvalidTwoFactorCodeError extends AppError {
  constructor({ message = "That two-factor code isn't valid. Codes change every 30 seconds and each works once." } = {}) {
    super({ message, statusCode: 422, code: "INVALID_TWO_FACTOR_CODE" });
  }
}
