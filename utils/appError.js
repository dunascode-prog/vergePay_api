export default class AppError extends Error {
  constructor({
    message,
    statusCode = 500,
    code = "INTERNAL_SERVER_ERROR",
    details = null,
    field = null,
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.field = field;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}
