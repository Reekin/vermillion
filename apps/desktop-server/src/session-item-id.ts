/**
 * Entity ids for engine items are scoped by session: fork members replay the same rollout item
 * ids, so the session id keeps their entities apart.
 *
 * The live event path and the history hydration path both build ids through these helpers, so one
 * engine item always lands on one entity no matter which path observed it first.
 */
export const sessionItemId = (sessionId: string, itemId: string): string =>
  `${sessionId}:${itemId}`;

/**
 * User messages carry the id the workbench assigned when sending (`clientUserMessageId`), which the
 * engine stores next to the item id and returns on later reads. Prefer it over the generated item
 * id so the local echo and the hydrated copy of one prompt share an entity.
 */
export const engineItemKey = (item: {
  id: string;
  clientId?: string | null;
}): string => {
  const clientId = typeof item.clientId === "string" ? item.clientId.trim() : "";
  return clientId.length > 0 ? clientId : item.id;
};
