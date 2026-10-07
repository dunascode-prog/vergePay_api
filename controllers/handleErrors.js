import logger from "../logger.js";
import { BadRequestError, PayloadTooLargeError } from "../utils/errorStr.js";

export const handleErrors = (err, req, res, next) => {
  // A body that isn't valid JSON is the client's mistake, not a server
  // failure (express.json raises it before any handler runs).
  if (err.type === "entity.parse.failed") {
    err = new BadRequestError({ message: "The request body isn't valid JSON." });
  }
  // over a body parser's limit (a photo over 2 MB, say)
  if (err.type === "entity.too.large") {
    err = new PayloadTooLargeError({ message: "That file is too large." });
  }
  logger.error({
    requestId: req.requestId,
    message: err.message,
    // stack: err.stack,
    code: err.code,
    statusCode: err.statusCode,
  });
  if (err.isOperational) {
    if (err.code === "CONFLICT") {
      return res.status(err.statusCode).json({
        status: "failed",
        error: {
          code: err.code,
          field: err.field,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      });
    }
    return res.status(err.statusCode).json({
      status: "failed",
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
  }
  // The details stay in the server log; the client never sees internal
  // messages such as SQL or parser errors (API doc 1.5).
  console.log(err);
  return res.status(500).json({
    status: "failed",
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "SOMETHING WENT WRONG",
    },
  });
};
