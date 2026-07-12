import logger from "../logger.js";
export const handleErrors = (err, req, res, next) => {
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
  console.log(err);
  return res.status(500).json({
    status: "failed",
    message: err.message,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "SOMETHING WENT WRONG",
    },
  });
};
