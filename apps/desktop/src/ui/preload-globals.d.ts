import type { WorkbenchClientApi } from "@vermillion/shared";
import type { WorkbenchRpcRequest, WorkbenchRpcResponse } from "@vermillion/workbench";

declare global {
  type WorkbenchLocalAssetsApi = {
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

  type WorkbenchDesktopApi = {
    pickEngineProgramPath: (engineId: string) => Promise<{
      canceled: boolean;
      path?: string;
    }>;
    writeClipboardText: (text: string) => Promise<void>;
  };

  interface Window {
    workbench?: WorkbenchClientApi;
    workbenchLocalAssets?: WorkbenchLocalAssetsApi;
    workbenchDesktop?: WorkbenchDesktopApi;
    vermillion?: { request: (payload: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse> };
  }
}

export {};
