// Shared request-validation helpers.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// Turns a ZodError into { field: [messages] }, including unknown keys
// rejected by a strict schema.
export function validationDetails(error) {
  const details = { ...error.flatten().fieldErrors };
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        details[key] = ["This field cannot be updated here."];
      }
    }
  }
  return details;
}
