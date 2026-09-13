import type { SessionClientApi } from "@vermillion/shared";
import type { SessionRpcRequest, SessionRpcResponse } from "@vermillion/workbench/client";

declare global {
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

  interface Window {
    session?: SessionClientApi;
    sessionLocalAssets?: SessionLocalAssetsApi;
    sessionDesktop?: SessionDesktopApi;
    vermillion?: {
      request: (payload: SessionRpcRequest) => Promise<SessionRpcResponse>;
      onEvent: (listener: (event: unknown) => void) => () => void;
    };
  }
}

export {};
