import type { SessionRuntimeService } from "./runtime-service.js";
import type { ResolvedSessionContext } from "./session-identity-registry.js";
import type { WorkspaceRegistryService } from "./workspace-registry.js";

/**
 * 轮次副作用（如撤销文件变更）作用于会话的工作目录：
 * 先取会话 metadata 的 cwd，再回退到该会话所属 workspace 的根目录。
 */
export const createSessionWorkingDirectoryResolver = (options: {
  resolveContext: (sessionId: string) => ResolvedSessionContext;
  workspaceRegistry: WorkspaceRegistryService;
  runtimeService: () => SessionRuntimeService | undefined;
}) => async (sessionId: string): Promise<string> => {
  const context = options.resolveContext(sessionId);
  const session = context.session;
  const metadataCwd =
    (session?.metadata && typeof session.metadata.cwd === "string"
      ? session.metadata.cwd
      : undefined) ??
    (context.indexEntry?.metadata && typeof context.indexEntry.metadata.cwd === "string"
      ? context.indexEntry.metadata.cwd
      : undefined);
  if (metadataCwd) {
    return metadataCwd;
  }

  const workspaceId =
    context.indexEntry?.workspaceId ??
    (session
      ? options.runtimeService()
          ?.getSnapshot()
          .conversations.find(
            (item) => item.conversationId === session.conversationId
          )?.workspaceId
      : undefined);
  if (workspaceId) {
    await options.workspaceRegistry.ready();
    const workspace = options.workspaceRegistry
      .getState()
      .workspaces.find((item) => item.workspaceId === workspaceId);
    if (workspace) {
      return workspace.absolutePath;
    }
  }

  throw new Error("Unable to resolve a working directory for this turn.");
};
