import { homedir } from "node:os";
import { join } from "node:path";
import { createFileWorkspaceSource } from "./file-workspace-source.js";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";
import { createWorkbenchRpcHandler } from "./rpc-handler.js";
import { WorkbenchService } from "./workbench-service.js";

/**
 * vermillion <method> [json-params]
 * Same service and method registry as the desktop app; agents use this to read state and move work items.
 * VERMILLION_PERSISTENCE_BASE_DIR overrides ~/.vermillion.
 */
export const runCli = async (argv: string[]): Promise<number> => {
  const [method, rawParams] = argv;
  if (!method || method === "--help" || method === "-h") {
    process.stdout.write("usage: vermillion <method> [json-params]\n\nmethods:\n" + Object.keys(workbenchRpc).map((m) => "  " + m).join("\n") + "\n");
    return method ? 0 : 1;
  }
  if (!(method in workbenchRpc)) {
    process.stderr.write("unknown method: " + method + "\n");
    return 1;
  }
  const baseDir = process.env.VERMILLION_PERSISTENCE_BASE_DIR?.trim() || join(homedir(), ".vermillion");
  const service = new WorkbenchService({ workspaces: createFileWorkspaceSource(join(baseDir, "workspace-registry.json")) });
  try {
    const handler = createWorkbenchRpcHandler(service);
    const response = await handler({ method: method as WorkbenchRpcMethod, params: rawParams ? JSON.parse(rawParams) : {} });
    if (!response.ok) {
      process.stderr.write(response.error + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify(response.result, null, 2) + "\n");
    return 0;
  } finally {
    service.dispose();
  }
};
