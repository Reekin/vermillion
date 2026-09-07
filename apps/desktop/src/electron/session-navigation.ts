import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { createSessionRuntimeService } from "@vermillion/desktop-server";
import { zSessionNavigation, type SessionNavigationPort } from "@vermillion/workbench";

type SessionShell = ReturnType<typeof createSessionRuntimeService>;

/** Navigation belongs to a source turn; each record is written once and published by atomic rename. */
export const createSessionNavigation = (shell: SessionShell, baseDir: string): SessionNavigationPort => {
  const directory = (sessionId: string, turnId: string): string => join(
    baseDir, "session-navigation", createHash("sha256").update(JSON.stringify([sessionId, turnId])).digest("hex")
  );
  const resolveSession = async (sessionId: string) => {
    await shell.ensureSessionLoadedForRead(sessionId, { force: shell.isSessionPartiallyHydrated(sessionId) });
    const snapshot = shell.getSnapshot();
    const session = snapshot.sessions.find((item) => item.sessionId === sessionId);
    if (!session) throw new Error("Unknown session: " + sessionId);
    const workspaceId = snapshot.conversations.find((item) => item.conversationId === session.conversationId)?.workspaceId;
    if (!workspaceId) throw new Error("Session has no workspace: " + sessionId);
    return { session, workspaceId };
  };
  return {
    create: async ({ sessionId, targetSessionId, reason }) => {
      const source = await resolveSession(sessionId);
      const target = await resolveSession(targetSessionId);
      const browserItem = await shell.getSessionBrowserItem(targetSessionId);
      const turn = shell.getSnapshot().turns.filter((item) => item.sessionId === sessionId).at(-1);
      if (!turn) throw new Error("Source session has no turn: " + sessionId);
      const navigation = zSessionNavigation.parse({
        navigationId: "navigation-" + randomUUID(),
        sessionId,
        turnId: turn.turnId,
        targetSessionId,
        targetWorkspaceId: target.workspaceId,
        title: target.session.title ?? browserItem?.title ?? targetSessionId,
        role: typeof target.session.metadata?.role === "string" ? target.session.metadata.role : "design-partner",
        reason: reason?.trim() || undefined
      });
      const dir = directory(sessionId, turn.turnId);
      await mkdir(dir, { recursive: true });
      const path = join(dir, navigation.navigationId + ".json");
      await writeFile(path + ".tmp", JSON.stringify(navigation, null, 2) + "\n", "utf8");
      await rename(path + ".tmp", path);
      return { navigation, workspaceId: source.workspaceId };
    },
    list: async ({ sessionId, turnId }) => {
      const dir = directory(sessionId, turnId);
      let files: string[];
      try { files = await readdir(dir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) =>
        zSessionNavigation.parse(JSON.parse(await readFile(join(dir, name), "utf8")))
      ));
    }
  };
};
