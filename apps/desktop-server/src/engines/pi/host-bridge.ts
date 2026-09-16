import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { JsonValue } from "../../codex-app-server-generated/serde_json/JsonValue.js";
import type { HostToolRegistry } from "../../host-tools.js";

export type PiHostBridge = {
  url: string;
  token: string;
  close: () => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const respond = (
  response: { statusCode: number; setHeader(name: string, value: string): void; end(payload?: string): void },
  statusCode: number,
  payload?: string
): void => {
  response.statusCode = statusCode;
  if (payload !== undefined) {
    response.setHeader("content-type", "application/json");
  }
  response.end(payload);
};

/**
 * pi 进程里的扩展要调用工作台宿主工具，而它不在工作台进程内，
 * 因此装配单元开一个只绑定回环地址、带一次性令牌的入口。
 */
export const startPiHostBridge = async (options: {
  engineId: string;
  hostTools: HostToolRegistry;
}): Promise<PiHostBridge> => {
  const token = randomUUID();
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST") {
      respond(response, 405);
      return;
    }
    let body = "";
    request.on("data", (chunk: unknown) => {
      body += String(chunk);
    });
    request.on("end", () => {
      void (async () => {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          respond(response, 400, JSON.stringify({ ok: false, error: "invalid json" }));
          return;
        }
        if (!isRecord(payload) || payload.token !== token) {
          respond(response, 403, JSON.stringify({ ok: false, error: "invalid token" }));
          return;
        }
        const name = typeof payload.name === "string" ? payload.name : "";
        const namespace = typeof payload.namespace === "string" ? payload.namespace : undefined;
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        const providerSessionId =
          typeof payload.providerSessionId === "string" ? payload.providerSessionId : "";
        const tool = options.hostTools.resolve({
          ...(namespace ? { namespace } : {}),
          name,
          context: { engineId: options.engineId, sessionId }
        });
        if (!tool) {
          respond(
            response,
            404,
            JSON.stringify({ ok: false, error: `unknown host tool ${name}` })
          );
          return;
        }
        try {
          const result = await tool.handle({
            definition: {
              namespace: tool.namespace,
              name: tool.name,
              description: tool.description,
              inputSchema: {} as JsonValue,
              deferLoading: tool.deferLoading
            },
            arguments: (payload.arguments ?? {}) as JsonValue,
            context: {
              engineId: options.engineId,
              sessionId,
              providerSessionId
            }
          });
          respond(response, 200, JSON.stringify({ ok: true, result }));
        } catch (error) {
          respond(
            response,
            200,
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = (
    server as unknown as { address(): { port?: number } | string | null }
  ).address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
};
