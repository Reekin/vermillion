import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileWorkspaceSource } from "./file-workspace-source.js";
import { connectLocalEndpoint } from "./local-endpoint.js";
import { workbenchRpc } from "./rpc.js";
import { createWorkbenchRpcHandler } from "./rpc-handler.js";
import { RoleService } from "./roles.js";
import { WorkbenchService } from "./workbench-service.js";
import { AppLauncher, resolveAppCommand } from "./app-launcher.js";

const desktopSessionMethods = ["chatTree.submit", "chatTree.retry", "chatTree.operations"];

/** Shipped role prompts sit next to this module's parent dir both in the repo (packages/workbench/roles) and in the release (resources/app/roles). */
const shippedRoleDefaultsDir = (): string | undefined => {
  const dir = fileURLToPath(new URL("../roles/", import.meta.url));
  return existsSync(dir) ? dir : undefined;
};

/**
 * vermillion <method> [json-params]
 * Same method registry as the desktop app. When the desktop is running, requests go to it over the
 * loopback endpoint (it owns the registry in memory); otherwise workbench methods run in-process.
 * Chat tree operations require the running desktop to own their background execution.
 * VERMILLION_PERSISTENCE_BASE_DIR overrides ~/.vermillion.
 */
export const runCli = async (argv: string[]): Promise<number> => {
  const [method, rawParams] = argv;
  if (!method || method === "--help" || method === "-h") {
    process.stdout.write("usage: vermillion <method> [json-params]\n\nmethods:\n" + [...Object.keys(workbenchRpc), ...desktopSessionMethods].map((m) => "  " + m).join("\n") + "\n");
    return method ? 0 : 1;
  }
  const desktopSessionMethod = desktopSessionMethods.includes(method);
  if (!Object.hasOwn(workbenchRpc, method) && !desktopSessionMethod) {
    process.stderr.write("unknown method: " + method + "\n");
    return 1;
  }
  const baseDir = process.env.VERMILLION_PERSISTENCE_BASE_DIR?.trim() || join(homedir(), ".vermillion");
  const request = { method, params: rawParams ? JSON.parse(rawParams) : {} };
  if ((method === "mission.create" || method === "mission.addRevision") &&
      (typeof request.params?.sessionId !== "string" || !request.params.sessionId.trim())) {
    process.stderr.write(method + " 必须提供当前上下文中的非空 sessionId。\n");
    return 1;
  }
  // Acceptance instances belong to the CLI's checkout/release, not a running desktop's build.
  const localAppMethod = method === "app.start" || method === "app.stop";
  const remote = localAppMethod ? undefined : await connectLocalEndpoint(baseDir);
  if (desktopSessionMethod && !remote) {
    process.stderr.write(method + " 需要运行 Vermillion 桌面应用。\n");
    return 1;
  }
  const roles = new RoleService({ globalDir: join(baseDir, "roles"), defaultsDir: shippedRoleDefaultsDir() });
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const service = remote ? undefined : new WorkbenchService({
    workspaces: createFileWorkspaceSource(join(baseDir, "workspace-registry.json")), roles,
    launcher: localAppMethod ? new AppLauncher({ command: resolveAppCommand(packageRoot), packageRoot }) : undefined
  });
  try {
    if (service) await roles.ensureGlobal();
    const handler = remote ?? createWorkbenchRpcHandler(service!);
    const response = await handler(request);
    if (!response.ok) {
      process.stderr.write(response.error + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify(response.result, null, 2) + "\n");
    return 0;
  } finally {
    service?.dispose();
  }
};
