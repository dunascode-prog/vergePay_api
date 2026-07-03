import { v4 as uuid } from "uuid";
export const addRequestId = function (req, res, next) {
  const id = uuid();
  req.requestId = id;
  res.set("X-Request-Id", id);
  next();
};
