import { contextBridge, ipcRenderer } from "electron";
import type {
  SessionClientApi,
  SessionEventHandler,
  SessionEventPush,
  SessionRpcRequest,
  SessionRpcResponse
} from "@vermillion/shared";
import {
  safeParseSessionEventPushBatch,
  zSessionReadProgress,
  safeParseSessionEventPush,
  safeParseSessionRpcResponse
} from "@vermillion/shared";
import {
  SESSION_IPC_EVENTS_PUSH_CHANNEL,
  SESSION_IPC_READ_PROGRESS_CHANNEL,
  SESSION_IPC_MATERIALIZE_ATTACHMENT_CHANNEL,
  SESSION_IPC_PICK_ENGINE_PROGRAM_CHANNEL,
  SESSION_IPC_REQUEST_CHANNEL,
  SESSION_IPC_WRITE_CLIPBOARD_TEXT_CHANNEL,
  SESSION_IPC_WRITE_CLIPBOARD_IMAGE_CHANNEL,
  WORKBENCH_IPC_EVENT_CHANNEL,
  WORKBENCH_IPC_REQUEST_CHANNEL
} from "./ipc-channels.js";

type SessionLocalAssetsApi = {
  materializeAttachmentDataUri: (input: {
    attachmentId: string;
    dataUri: string;
    mimeType: string;
    name?: string;
  }) => Promise<{
    bytesWritten: number;
    displayUri: string;
    filePath: string;
  }>;
};

type SessionDesktopApi = {
  pickEngineProgramPath: (engineId: string) => Promise<{
    canceled: boolean;
    path?: string;
  }>;
  writeClipboardText: (text: string) => Promise<void>;
  writeClipboardImage: (source: string) => Promise<{ width: number; height: number }>;
};

const handlersBySubscriptionId = new Map<string, Set<SessionEventHandler>>();

const deliverPush = (push: SessionEventPush): void => {
  const handlers = handlersBySubscriptionId.get(push.subscriptionId);
  if (!handlers || handlers.size === 0) {
    return;
  }
  for (const handler of handlers) {
    handler(push);
  }
};

ipcRenderer.on(SESSION_IPC_EVENTS_PUSH_CHANNEL, (_event, payload: unknown) => {
  const channel =
    typeof payload === "object" && payload !== null
      ? (payload as { channel?: unknown }).channel
      : undefined;
  if (channel === "session.events.batch") {
    const parsedBatch = safeParseSessionEventPushBatch(payload);
    if (!parsedBatch.success) {
      return;
    }
    for (const push of parsedBatch.data.pushes) {
      deliverPush(push);
    }
    return;
  }
  const parsed = safeParseSessionEventPush(payload);
  if (parsed.success) {
    deliverPush(parsed.data);
  }
});

const request = async (payload: SessionRpcRequest): Promise<SessionRpcResponse> => {
  const raw = (await ipcRenderer.invoke(
    SESSION_IPC_REQUEST_CHANNEL,
    payload
  )) as unknown;
  const parsed = safeParseSessionRpcResponse(raw);
  if (!parsed.success) {
    throw new Error("Electron IPC returned an invalid SessionRpcResponse payload.");
  }
  return parsed.data;
};

const ensureOk = <T extends SessionRpcResponse>(
  response: T,
  expectedMethod: SessionRpcRequest["method"]
): T => {
  if (response.method !== expectedMethod) {
    throw new Error(
      `Electron IPC method mismatch. expected=${expectedMethod} actual=${response.method}`
    );
  }
  if (!response.ok) {
    throw new Error(`[${response.method}] ${response.error.code}: ${response.error.message}`);
  }
  return response;
};

const subscribe: SessionClientApi["subscribe"] = async (params, handler) => {
  const response = ensureOk(await request({
    id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    method: "events.subscribe",
    params
  }), "events.subscribe") as Extract<SessionRpcResponse, { method: "events.subscribe"; ok: true }>;

  const subscriptionId = response.result.subscriptionId;
  const handlerSet = handlersBySubscriptionId.get(subscriptionId) ?? new Set();
  handlerSet.add(handler);
  handlersBySubscriptionId.set(subscriptionId, handlerSet);

  return {
    subscriptionId,
    unsubscribe: async () => {
      // Keep the handler registered while main drains any queued pushes for this
      // subscription as part of the unsubscribe RPC.
      ensureOk(
        await request({
          id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          method: "events.unsubscribe",
          params: { subscriptionId }
        }),
        "events.unsubscribe"
      );

      const existing = handlersBySubscriptionId.get(subscriptionId);
      if (existing) {
        existing.delete(handler);
        if (existing.size === 0) {
          handlersBySubscriptionId.delete(subscriptionId);
        }
      }
    }
  };
};

const api: SessionClientApi = {
  request,
  subscribe,
  subscribeReadProgress: (handler) => {
    const listener = (_event: unknown, payload: unknown) => {
      const parsed = zSessionReadProgress.safeParse(payload);
      if (parsed.success) handler(parsed.data);
    };
    ipcRenderer.on(SESSION_IPC_READ_PROGRESS_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(SESSION_IPC_READ_PROGRESS_CHANNEL, listener); };
  }
};

const localAssetsApi: SessionLocalAssetsApi = {
  materializeAttachmentDataUri: async (input) =>
    (await ipcRenderer.invoke(
      SESSION_IPC_MATERIALIZE_ATTACHMENT_CHANNEL,
      input
    )) as Awaited<ReturnType<SessionLocalAssetsApi["materializeAttachmentDataUri"]>>
};

const desktopApi: SessionDesktopApi = {
  pickEngineProgramPath: async (engineId) =>
    (await ipcRenderer.invoke(
      SESSION_IPC_PICK_ENGINE_PROGRAM_CHANNEL,
      engineId
    )) as Awaited<ReturnType<SessionDesktopApi["pickEngineProgramPath"]>>,
  writeClipboardText: async (text) => {
    await ipcRenderer.invoke(SESSION_IPC_WRITE_CLIPBOARD_TEXT_CHANNEL, text);
  },
  writeClipboardImage: async (source) =>
    (await ipcRenderer.invoke(
      SESSION_IPC_WRITE_CLIPBOARD_IMAGE_CHANNEL,
      source
    )) as { width: number; height: number }
};

contextBridge.exposeInMainWorld("session", api);
contextBridge.exposeInMainWorld("sessionLocalAssets", localAssetsApi);
contextBridge.exposeInMainWorld("sessionDesktop", desktopApi);
const domainEventListeners = new Set<(event: unknown) => void>();
ipcRenderer.on(WORKBENCH_IPC_EVENT_CHANNEL, (_event, payload: unknown) => {
  for (const listener of domainEventListeners) listener(payload);
});

contextBridge.exposeInMainWorld("vermillion", {
  request: (payload: { method: string; params: unknown }) =>
    ipcRenderer.invoke(WORKBENCH_IPC_REQUEST_CHANNEL, payload),
  onEvent: (listener: (event: unknown) => void) => {
    domainEventListeners.add(listener);
    return () => {
      domainEventListeners.delete(listener);
    };
  }
});
