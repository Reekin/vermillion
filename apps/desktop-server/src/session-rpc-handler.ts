import type {
  SessionEventPush,
  SessionRpcRequest,
  SessionRpcResponse
} from "@vermillion/shared";
import {
  parseSessionEventPush,
  parseSessionRpcRequest,
  parseSessionRpcResponse
} from "@vermillion/shared";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionShellService } from "./session-shell-service.js";
import { SessionBrowserCursorStaleError } from "./session-browser-read-model.js";

type Clock = () => string;
type IdFactory = () => string;

export type SessionRpcHandlerOptions = {
  now?: Clock;
  createSubscriptionId?: IdFactory;
};

const createOpaqueId = (): string =>
  `subscription-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const toErrorResponse = (
  request: SessionRpcRequest,
  code: string,
  message: string,
  details?: Record<string, unknown>
): SessionRpcResponse =>
  parseSessionRpcResponse({
    id: request.id,
    method: request.method,
    ok: false,
    error: {
      code,
      message,
      details
    }
  });

export const createWorkbenchRpcHandler = (
  service: SessionRuntimeService | SessionShellService,
  options: SessionRpcHandlerOptions = {}
) => {
  const now = options.now ?? (() => new Date().toISOString());
  const createSubscriptionId =
    options.createSubscriptionId ?? createOpaqueId;
  const shellService = (
    "listWorkspaces" in service ? service : undefined
  ) as SessionShellService | undefined;

  return {
    async handleRequest(input: SessionRpcRequest): Promise<SessionRpcResponse> {
      const request = parseSessionRpcRequest(input);
      try {
        switch (request.method) {
          case "engine.list":
            if (!shellService) {
              return toErrorResponse(
                request,
                "ENGINE_REGISTRY_UNAVAILABLE",
                "Engine APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                engines: shellService.listEngines()
              }
            });
          case "engine.getSurface":
            if (!shellService) {
              return toErrorResponse(
                request,
                "ENGINE_SURFACE_UNAVAILABLE",
                "Engine surface APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                surface: shellService.getEngineSurface(request.params.engineId)
              }
            });
          case "engine.listModels":
            if (!shellService) {
              return toErrorResponse(
                request,
                "ENGINE_MODEL_CATALOG_UNAVAILABLE",
                "Engine model catalog APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                catalog: await shellService.listEngineModels(request.params.engineId)
              }
            });
          case "engine.select":
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: service.selectEngine(request.params)
            });
          case "settings.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SETTINGS_UNAVAILABLE",
                "Settings APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.getSettings()
            });
          case "settings.update":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SETTINGS_UNAVAILABLE",
                "Settings APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.updateSettings(request.params)
            });
          case "domain.snapshot":
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: service.getSnapshotResult()
            });
          case "session.list":
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                sessions: service.listSessions(request.params)
              }
            });
          case "workspace.list": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            const result = await shellService.listWorkspaces();
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result
            });
          }
          case "workspace.pickDirectory": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.pickWorkspaceDirectory()
            });
          }
          case "workspace.add": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            const workspace = await shellService.addWorkspace(request.params);
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                workspace
              }
            });
          }
          case "workspace.remove": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.removeWorkspace(request.params.workspaceId)
            });
          }
          case "workspace.select":
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.selectWorkspace(request.params.workspaceId)
            });
          case "sessionBrowser.list":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.listBrowserSessions(request.params)
            });
          case "sessionBrowser.repair":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.repairSessionBrowser(request.params.workspaceIds)
            });
          case "sessionBrowser.create":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.createBrowserSession(request.params)
            });
          case "sessionBrowser.open":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: request.params.forceProviderHydration
                ? await shellService.openSession(request.params.sessionId, {
                    forceProviderHydration: true
                  })
                : await shellService.openSession(request.params.sessionId)
            });
          case "sessionBrowser.activate":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: request.params.focusTree
                ? await shellService.activateSession(request.params.sessionId, { focusTree: true })
                : await shellService.activateSession(request.params.sessionId)
            });
          case "sessionBrowser.loadOlder":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.loadOlderSessionTurns(request.params)
            });
          case "sessionBrowser.getActions":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.getSessionActions(request.params.sessionId)
            });
          case "sessionBrowser.runAction":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.runSessionAction(request.params)
            });
          case "chat.getCapabilities":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CHAT_UNAVAILABLE",
                "Chat capability APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                capabilities: await shellService.getChatCapabilities(
                  request.params.sessionId
                )
              }
            });
          case "skills.list":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SKILLS_UNAVAILABLE",
                "Skills APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                skills: await shellService.listSkills(request.params)
              }
            });
          case "chatTree.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CHAT_TREE_UNAVAILABLE",
                "Chat tree APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                chatTree: await shellService.getChatTree(request.params.sessionId)
              }
            });
          case "chatTree.submit":
            if (!shellService) return toErrorResponse(request, "CHAT_TREE_UNAVAILABLE", "Chat tree is unavailable.");
            return parseSessionRpcResponse({
              id: request.id, method: request.method, ok: true,
              result: shellService.submitChatTreeSend(request.params)
            });
          case "chatTree.retry":
            if (!shellService) return toErrorResponse(request, "CHAT_TREE_UNAVAILABLE", "Chat tree is unavailable.");
            return parseSessionRpcResponse({
              id: request.id, method: request.method, ok: true,
              result: shellService.retryChatTreeSend(request.params)
            });
          case "chatTree.operations":
            if (!shellService) return toErrorResponse(request, "CHAT_TREE_UNAVAILABLE", "Chat tree is unavailable.");
            return parseSessionRpcResponse({
              id: request.id, method: request.method, ok: true,
              result: shellService.getChatTreeOperations(request.params)
            });
          case "chatTree.prepareSend":
            if (!shellService) return toErrorResponse(request, "CHAT_TREE_UNAVAILABLE", "Chat tree is unavailable.");
            return parseSessionRpcResponse({
              id: request.id, method: request.method, ok: true,
              result: await shellService.prepareChatTreeSend(request.params)
            });
          case "chatTree.jump":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CHAT_TREE_UNAVAILABLE",
                "Chat tree APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.jumpChatTree(request.params)
            });
          case "delegation.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "DELEGATION_UNAVAILABLE",
                "Delegation APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                delegation: await shellService.getDelegation(request.params.sessionId)
              }
            });
          case "worktree.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKTREE_UNAVAILABLE",
                "Worktree APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                worktree: await shellService.getWorktree(request.params.sessionId)
              }
            });
          case "checkpoint.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CHECKPOINT_UNAVAILABLE",
                "Checkpoint APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                checkpoint: await shellService.getCheckpoint(request.params.sessionId)
              }
            });
          case "diagnostics.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "DIAGNOSTICS_UNAVAILABLE",
                "Diagnostics APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                diagnostics: await shellService.getDiagnostics(request.params.sessionId)
              }
            });
          case "diagnostics.write":
            if (!shellService) {
              return toErrorResponse(
                request,
                "DIAGNOSTIC_LOG_UNAVAILABLE",
                "Diagnostic log APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.writeDiagnosticLog(request.params)
            });
          case "backgroundRun.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "BACKGROUND_RUN_UNAVAILABLE",
                "Background run APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                backgroundRun: await shellService.getBackgroundRun(request.params.sessionId)
              }
            });
          case "errorLog.write":
            if (!shellService) {
              return toErrorResponse(
                request,
                "ERROR_LOG_UNAVAILABLE",
                "Error log APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.writeErrorLog(request.params)
            });
          case "file.runAction":
            if (!shellService) {
              return toErrorResponse(
                request,
                "FILE_ACTION_UNAVAILABLE",
                "File action APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.runFileAction(request.params)
            });
          case "codex.hookActivity.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CODEX_HOOK_ACTIVITY_UNAVAILABLE",
                "Codex hook activity APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.getCodexHookActivity(request.params)
            });
          case "codex.turnChanges.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CODEX_TURN_CHANGES_UNAVAILABLE",
                "Codex turn-change APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.getCodexTurnChanges(request.params)
            });
          case "codex.turnChanges.undo":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CODEX_TURN_CHANGES_UNAVAILABLE",
                "Codex turn-change APIs are unavailable for this runtime service."
              );
            }
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.undoCodexTurnChanges(request.params)
            });
          case "runtime.command": {
            const receipt = await service.executeCommand(request.params.envelope);
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: receipt
            });
          }
          case "events.replay": {
            const replayResult = service.replayResult({
              fromCursor: request.params.fromCursor,
              toCursor: request.params.toCursor,
              filter: request.params.filter
            });
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                status: replayResult.status,
                reason: replayResult.reason,
                replayed: replayResult.replayed,
                fromCursor: request.params.fromCursor,
                toCursor: request.params.toCursor,
                envelopes: replayResult.envelopes
              }
            });
          }
          case "events.subscribe":
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                endpoint: "/events",
                subscriptionId:
                  request.params.subscriptionId ?? createSubscriptionId(),
                fromCursor: request.params.fromCursor
              }
            });
          case "events.unsubscribe":
            return parseSessionRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                endpoint: "/events",
                unsubscribed: true,
                subscriptionId: request.params.subscriptionId
              }
            });
          default: {
            const exhaustive: never = request;
            return exhaustive;
          }
        }
      } catch (error) {
        if (error instanceof SessionBrowserCursorStaleError) {
          return toErrorResponse(request, error.code, error.message, {
            failedAt: now()
          });
        }
        return toErrorResponse(
          request,
          "WORKBENCH_REQUEST_FAILED",
          error instanceof Error ? error.message : "Unknown workbench request error",
          {
            failedAt: now()
          }
        );
      }
    },

    createEventPush(
      subscriptionId: string,
      envelope: SessionEventPush["envelope"]
    ): SessionEventPush {
      return parseSessionEventPush({
        channel: "session.events",
        subscriptionId,
        envelope
      });
    }
  };
};
