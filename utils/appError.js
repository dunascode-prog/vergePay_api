export default class AppError extends Error {
  constructor({
    message,
    statusCode,
    code = "INTERNAL SERVER ERROR",
    details = null,
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}
