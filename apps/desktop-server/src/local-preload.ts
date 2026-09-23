import type {
  SessionClientApi,
  SessionRpcRequest,
  SessionRpcResponse
} from "@vermillion/shared";
import { createWorkbenchRpcHandler } from "./session-rpc-handler.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionShellService } from "./session-shell-service.js";

type IdFactory = () => string;

export type LocalDesktopPreloadOptions = {
  createSubscriptionId?: IdFactory;
};

const createOpaqueId = (): string =>
  `local-sub-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

export const createLocalDesktopPreloadApi = (
  service: SessionRuntimeService | SessionShellService,
  options: LocalDesktopPreloadOptions = {}
): SessionClientApi => {
  const createSubscriptionId =
    options.createSubscriptionId ?? createOpaqueId;
  const rpc = createWorkbenchRpcHandler(service, {
    createSubscriptionId
  });

  return {
    subscribeReadProgress: (handler) => "subscribeReadProgress" in service ? service.subscribeReadProgress(handler) : () => {},
    request: async (request: SessionRpcRequest): Promise<SessionRpcResponse> =>
      rpc.handleRequest(request),
    subscribe: async (params, handler) => {
      const subscriptionId = params.subscriptionId ?? createSubscriptionId();
      const unsubscribe = service.subscribeFromCursor(
        (envelope) => {
          handler(rpc.createEventPush(subscriptionId, envelope));
        },
        {
          fromCursor: params.fromCursor,
          filter: params.filter
        }
      );

      return {
        subscriptionId,
        unsubscribe: async () => {
          unsubscribe();
        }
      };
    }
  };
};
