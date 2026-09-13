import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonRpcLineClient,
  type JsonRpcLineRequestPayload,
  type JsonRpcPipelineDiagnostic
} from "../src/runtime/json-rpc-line-client.js";

class BackpressureOutput extends EventEmitter {
  public readonly chunks: string[] = [];
  public destroyed = false;
  public writableEnded = false;

  public write(chunk: string, _callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    return false;
  }
}

class FailingOutput extends EventEmitter {
  public destroyed = false;
  public writableEnded = false;

  public write(_chunk: string, callback?: (error?: Error | null) => void): boolean {
    callback?.(new Error("write exploded"));
    return true;
  }
}

const clients = new Set<JsonRpcLineClient>();
const createClient = (options: {
  ids?: Array<string | number>;
  timeoutMs?: number;
  output?: Writable;
  diagnostics?: (event: JsonRpcPipelineDiagnostic) => void;
} = {}) => {
  const input = new PassThrough();
  const output = options.output ?? new PassThrough();
  const ids = [...(options.ids ?? ["1", "2", "3"])];
  const client = new JsonRpcLineClient({
    input,
    output,
    defaultTimeoutMs: options.timeoutMs ?? 1000,
    diagnostics: options.diagnostics,
    createRequestId: () => {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("missing test request id");
      }
      return id;
    }
  });
  clients.add(client);
  return {
    client,
    input,
    output
  };
};

describe("JsonRpcLineClient", () => {
  afterEach(() => {
    for (const client of clients) client.dispose();
    clients.clear();
    vi.useRealTimers();
  });

  it("resolves responses and removes pending requests", async () => {
    const { client, input } = createClient();

    const request = client.request("ping", {
      value: 1
    });
    expect(client.getPendingCount()).toBe(1);

    input.write(JSON.stringify({ id: "1", result: { ok: true } }) + "\n");

    await expect(request).resolves.toEqual({ ok: true });
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects JSON-RPC error responses and removes pending requests", async () => {
    const { client, input } = createClient();

    const request = client.request("ping");
    input.write(
      JSON.stringify({
        id: "1",
        error: {
          code: "boom",
          message: "provider failed",
          data: {
            retry: false
          }
        }
      }) + "\n"
    );

    await expect(request).rejects.toMatchObject({
      code: "runtime_protocol_error",
      details: {
        requestId: "1",
        method: "ping",
        jsonRpcCode: "boom",
        data: {
          retry: false
        }
      }
    });
    expect(client.getPendingCount()).toBe(0);
  });

  it("times out pending requests", async () => {
    vi.useFakeTimers();
    const { client } = createClient({
      timeoutMs: 10
    });

    const request = client.request("hang");
    const rejectedRequest = expect(request).rejects.toMatchObject({
      code: "runtime_request_timeout",
      details: {
        requestId: "1",
        method: "hang",
        timeoutMs: 10
      }
    });

    await vi.advanceTimersByTimeAsync(10);
    await rejectedRequest;
    expect(client.getPendingCount()).toBe(0);
  });

  it("aborts pending requests", async () => {
    const { client } = createClient();
    const controller = new AbortController();

    const request = client.request("abortable", undefined, {
      signal: controller.signal
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "runtime_request_aborted"
    });
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects all pending requests on demand", async () => {
    const { client } = createClient();

    const first = client.request("first");
    const second = client.request("second");
    client.rejectAll(new Error("runtime exited"));

    await expect(first).rejects.toThrow("runtime exited");
    await expect(second).rejects.toThrow("runtime exited");
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects and removes pending requests when writing fails", async () => {
    const { client } = createClient({
      output: new FailingOutput() as unknown as Writable
    });

    await expect(client.request("write-fails")).rejects.toMatchObject({
      code: "runtime_write_failed",
      details: {
        requestId: "1",
        method: "write-fails"
      }
    });
    expect(client.getPendingCount()).toBe(0);
  });

  it("rejects request id collisions without writing a second request", async () => {
    const output = new BackpressureOutput();
    const { client } = createClient({
      ids: ["same", "same"],
      output: output as unknown as Writable
    });

    const first = client.request("first");
    await expect(client.request("second")).rejects.toMatchObject({
      code: "runtime_protocol_error",
      details: {
        requestId: "same",
        method: "second"
      }
    });

    expect(output.chunks).toHaveLength(1);
    client.rejectAll(new Error("cleanup"));
    await expect(first).rejects.toThrow("cleanup");
  });

  it("keeps pending requests valid through stdin backpressure", async () => {
    const output = new BackpressureOutput();
    const { client, input } = createClient({
      output: output as unknown as Writable
    });

    const request = client.request("backpressure");
    expect(output.chunks).toHaveLength(1);
    expect(client.getPendingCount()).toBe(1);

    input.write(JSON.stringify({ id: "1", result: "ok" }) + "\n");
    await expect(request).resolves.toBe("ok");
    expect(client.getPendingCount()).toBe(0);

    output.emit("drain");
  });

  it("rejects pending writes when disposed before drain", async () => {
    const output = new BackpressureOutput();
    const { client } = createClient({
      output: output as unknown as Writable
    });

    const write = client.notify("notify/slow");
    expect(output.chunks).toHaveLength(1);

    client.dispose(new Error("runtime disposed"));

    await expect(write).rejects.toThrow("runtime disposed");
  });

  it("dispatches server requests, notifications, and parse errors", async () => {
    const { client, input } = createClient();
    const requests: JsonRpcLineRequestPayload[] = [];
    const notifications: string[] = [];
    const errors: string[] = [];
    client.onRequest((payload) => requests.push(payload));
    client.onNotification((payload) => notifications.push(payload.method));
    client.onProtocolError((error) => errors.push(error.message));

    input.write(
      JSON.stringify({ id: 7, method: "server/request", params: { a: 1 } }) +
        "\n"
    );
    input.write(JSON.stringify({ method: "server/notification" }) + "\n");
    input.write("{not json}\n");

    expect(requests).toEqual([
      expect.objectContaining({
        id: 7,
        method: "server/request",
        params: {
          a: 1
        }
      })
    ]);
    expect(notifications).toEqual(["server/notification"]);
    expect(errors).toHaveLength(1);
  });
  it("reports one aggregate diagnostic per input chunk", async () => {
    const diagnostics: JsonRpcPipelineDiagnostic[] = [];
    const { client, input } = createClient({
      diagnostics: (event) => diagnostics.push(event)
    });
    client.onNotification(() => undefined);
    client.onProtocolError(() => undefined);

    input.write(
      [
        JSON.stringify({ method: "message/delta", params: { delta: "a" } }),
        JSON.stringify({ method: "terminal/output", params: { chunk: "b" } }),
        "{not json}"
      ].join("\n") + "\n"
    );
    input.write(JSON.stringify({ method: "message/delta" }) + "\n");

    const read = diagnostics.find(
      (
        event
      ): event is Extract<
        JsonRpcPipelineDiagnostic,
        { type: "read-completed" }
      > => event.type === "read-completed"
    );
    expect(read).toMatchObject({
      readSeq: 1,
      parsedLineCount: 3,
      parseErrorCount: 1,
      notificationCount: 2,
      bufferedBytesBefore: 0,
      bufferedBytesAfter: 0,
      pendingRequestCount: 0,
      methods: {
        "message/delta": 1,
        "terminal/output": 1,
        "<parse-error>": 1
      }
    });
    expect(read?.chunkBytes).toBeGreaterThan(0);
    expect(read?.syncDurationMs).toBeGreaterThanOrEqual(0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn-released",
          firstReadSeq: 1,
          lastReadSeq: 2,
          readCount: 2,
          releaseDelayMs: expect.any(Number)
        })
      ])
    );
  });

  it("keeps a large JSONL chunk to one read diagnostic", () => {
    const diagnostics: JsonRpcPipelineDiagnostic[] = [];
    const { client, input } = createClient({
      diagnostics: (event) => diagnostics.push(event)
    });
    client.onNotification(() => undefined);
    const line = JSON.stringify({
      method: "item/agentMessage/delta",
      params: { delta: "x".repeat(64) }
    });

    input.write(Array.from({ length: 3_000 }, () => line).join("\n") + "\n");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: "read-completed",
      parsedLineCount: 3_000,
      notificationCount: 3_000,
      methods: {
        "item/agentMessage/delta": 3_000
      }
    });
  });

  it("parses oversized responses off the runtime event-loop turn", async () => {
    const diagnostics: JsonRpcPipelineDiagnostic[] = [];
    const { client, input } = createClient({
      diagnostics: (event) => diagnostics.push(event)
    });
    const request = client.request("large-history");
    const result = { history: "x".repeat(300_000) };

    input.write(JSON.stringify({ id: "1", result }) + "\n");
    expect(diagnostics).toHaveLength(0);
    await expect(request).resolves.toEqual(result);
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]).toMatchObject({
      type: "read-completed",
      parsedLineCount: 1,
      methods: { "<response>": 1 }
    });
  });

  it("keeps a new connection's parser independent of a retiring worker", async () => {
    const { client, input } = createClient({ timeoutMs: 10_000 });
    const notifications: string[] = [];
    const errors: Error[] = [];
    client.onNotification(({ method }) => { notifications.push(method); });
    client.onProtocolError((error) => { errors.push(error); });
    const oldRequest = client.request("old");
    const rejected = expect(oldRequest).rejects.toThrow("reconnect");
    input.write(JSON.stringify({ id: "1", result: "x".repeat(300_000) }) +
      '\n{"method":"old/notification"}\n');
    client.dispose(new Error("reconnect"));
    const nextInput = new PassThrough();
    client.attach({ input: nextInput, output: new PassThrough() });
    const nextRequest = client.request("new");
    const result = "new".repeat(1_000_000);
    nextInput.write(JSON.stringify({ id: "2", result }) + '\n{"method":"new/notification"}\n');
    await rejected;
    await expect(nextRequest).resolves.toBe(result);
    expect(notifications).toEqual(["new/notification"]);
    expect(errors).toEqual([]);
  });

  it("continues in wire order after a malformed large line", async () => {
    const { client, input } = createClient();
    const order: string[] = [];
    client.onProtocolError(() => { order.push("error"); });
    client.onNotification(({ method }) => { order.push(method); });
    input.write('{"bad":' + "x".repeat(300_000) + '\n{"method":"after"}\n');
    await vi.waitFor(() => expect(order).toEqual(["error", "after"]));
  });

  it("receives a 26 MB history in pipe-sized chunks without second-long stalls", async () => {
    const { client, input } = createClient({ timeoutMs: 20_000 });
    const items = Array.from({ length: 26_000 }, (_, id) => ({ id, text: "x".repeat(1_000) }));
    const wire = JSON.stringify({ id: "1", result: items }) + "\n";
    let maxLagMs = 0;
    let lastTick = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxLagMs = Math.max(maxLagMs, now - lastTick);
      lastTick = now;
    }, 5);
    const startedAt = performance.now();
    try {
      const request = client.request("large-history");
      for (let offset = 0; offset < wire.length; offset += 65_536) {
        input.write(wire.slice(offset, offset + 65_536));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const result = await request as typeof items;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(result).toHaveLength(items.length);
      expect(result.at(-1)).toEqual(items.at(-1));
      expect(maxLagMs).toBeLessThan(1_000);
      console.info({ bytes: wire.length, elapsedMs: Math.round(performance.now() - startedAt),
        maxEventLoopGapMs: Math.round(maxLagMs) });
    } finally {
      clearInterval(ticker);
    }
  }, 20_000);
});
