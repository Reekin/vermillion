export type MobileRoute = { page: "sessions" } | { page: "session"; sessionId: string } | { page: "inbox"; workspaceId?: string; itemKey?: string };

export function parseMobileRoute(hash: string): MobileRoute {
  try {
    const [page, id, item] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    if (page === "session" && id) return { page, sessionId: id };
    if (page === "inbox") return { page, workspaceId: id || undefined, itemKey: item || undefined };
  } catch { /* A malformed external link opens the list. */ }
  return { page: "sessions" };
}

export const sessionHash = (sessionId: string) => "#/session/" + encodeURIComponent(sessionId);
export const listHash = (page: "sessions" | "inbox") => "#/" + page;
