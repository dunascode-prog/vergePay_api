// Writes an audit_logs row. Pass the same client as the change being
// audited so the audit row commits or rolls back together with it.
export async function writeAudit(
  client,
  { actorId, entityType, entityId, action, before = null, after = null },
) {
  await client.query(
    `
    INSERT INTO audit_logs (
        actor_id,
        entity_type,
        entity_id,
        action,
        before_state,
        after_state
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      actorId,
      entityType,
      entityId,
      action,
      before && JSON.stringify(before),
      after && JSON.stringify(after),
    ],
  );
}
