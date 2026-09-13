import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { Worker } from "node:worker_threads";
import {
  createRuntimeNotStartedError,
  createRuntimePortError,
  createRuntimeRequestTimeoutError,
  type RuntimeOperationOptions
} from "./runtime-lifecycle.js";

export type JsonRpcLineId = string | number;

export type JsonRpcLinePayload = {
  id?: JsonRpcLineId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: string | number;
    message?: string;
    data?: unknown;
  };
};

export type JsonRpcLineRequestPayload = JsonRpcLinePayload & {
  id: JsonRpcLineId;
  method: string;
};

export type JsonRpcLineNotificationPayload = JsonRpcLinePayload & {
  method: string;
};

export type JsonRpcPipelineDiagnostic =
  | {
      type: "read-completed";
      readSeq: number;
      chunkBytes: number;
      bufferedBytesBefore: number;
      bufferedBytesAfter: number;
      parsedLineCount: number;
      parseErrorCount: number;
      notificationCount: number;
      maxNotificationListenerSyncMs: number;
      syncDurationMs: number;
      pendingRequestCount: number;
      methods: Record<string, number>;
    }
  | {
      type: "turn-released";
      firstReadSeq: number;
      lastReadSeq: number;
      readCount: number;
      releaseDelayMs: number;
    };

export type JsonRpcLineClientOptions = {
  input?: Readable;
  output?: Writable;
  defaultTimeoutMs?: number;
  createRequestId?: () => JsonRpcLineId;
  diagnostics?: (event: JsonRpcPipelineDiagnostic) => void;
};

type Listener<T> = (event: T) => void | Promise<void>;

type PendingRequest = {
  id: JsonRpcLineId;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | undefined;
  signal: AbortSignal | undefined;
};

type PendingWrite = {
  reject: (error: Error) => void;
};

type PendingReleaseProbe = {
  firstReadSeq: number;
  lastReadSeq: number;
  readCount: number;
  completedAt: number;
};

type ActiveReadDiagnostics = {
  readSeq: number;
  chunkBytes: number;
  bufferedBytesBefore: number;
  parsedLineCount: number;
  parseErrorCount: number;
  notificationCount: number;
  maxNotificationListenerSyncMs: number;
  methods: Record<string, number>;
  pendingLines: number;
  syncDurationMs: number;
  bufferedBytesAfter: number;
  completed: boolean;
};

type QueuedLine = {
  line: string;
  diagnostics?: ActiveReadDiagnostics;
};

type LineParser = {
  queue: QueuedLine[];
  pending?: QueuedLine;
  worker?: Worker;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const LARGE_JSON_PARSE_THRESHOLD = 256 * 1024;
const JSON_PARSE_WORKER = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (line) => {
    try { parentPort.postMessage({ payload: JSON.parse(line) }); }
    catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  });
`;

const localRequestId = (id: JsonRpcLineId): string => String(id);

export class JsonRpcLineClient {
  private input: Readable | undefined;
  private output: Writable | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => JsonRpcLineId;
  private readonly diagnostics: JsonRpcLineClientOptions["diagnostics"];
  private readonly requestListeners = new Set<Listener<JsonRpcLineRequestPayload>>();
  private readonly notificationListeners = new Set<
    Listener<JsonRpcLineNotificationPayload>
  >();
  private readonly protocolErrorListeners = new Set<Listener<Error>>();
  private readonly pendingById = new Map<string, PendingRequest>();
  private readonly pendingWrites = new Set<PendingWrite>();
  private readonly bufferedParts: string[] = [];
  private bufferedBytes = 0;
  private parser: LineParser = { queue: [] };
  private nextRequestId = 0;
  private nextReadSeq = 0;
  private activeReadDiagnostics: ActiveReadDiagnostics | undefined;
  private pendingReleaseProbe: PendingReleaseProbe | undefined;

  private readonly handleData = (chunk: Buffer | string): void => {
    const startedAt = performance.now();
    const activeRead: ActiveReadDiagnostics | undefined = this.diagnostics ? {
      readSeq: ++this.nextReadSeq,
      chunkBytes:
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length,
      bufferedBytesBefore: this.bufferedBytes,
      parsedLineCount: 0,
      parseErrorCount: 0,
      notificationCount: 0,
      maxNotificationListenerSyncMs: 0,
      methods: {},
      pendingLines: 0,
      syncDurationMs: 0,
      bufferedBytesAfter: 0,
      completed: false
    } : undefined;
    this.consume(chunk, activeRead);
    if (activeRead) {
      activeRead.syncDurationMs += performance.now() - startedAt;
      activeRead.bufferedBytesAfter = this.bufferedBytes;
      this.completeReadIfReady(activeRead);
    }
    this.drainQueuedLines();
  };

  private scheduleReleaseProbe(readSeq: number, completedAt: number): void {
    if (this.pendingReleaseProbe) {
      this.pendingReleaseProbe.lastReadSeq = readSeq;
      this.pendingReleaseProbe.readCount += 1;
      return;
    }

    this.pendingReleaseProbe = {
      firstReadSeq: readSeq,
      lastReadSeq: readSeq,
      readCount: 1,
      completedAt
    };
    setImmediate(() => {
      const probe = this.pendingReleaseProbe;
      this.pendingReleaseProbe = undefined;
      if (!probe) {
        return;
      }
      this.diagnostics?.({
        type: "turn-released",
        firstReadSeq: probe.firstReadSeq,
        lastReadSeq: probe.lastReadSeq,
        readCount: probe.readCount,
        releaseDelayMs: performance.now() - probe.completedAt
      });
    });
  }

  private completeReadIfReady(read: ActiveReadDiagnostics): void {
    if (read.completed || read.pendingLines > 0) return;
    read.completed = true;
    const completedAt = performance.now();
    const {
      pendingLines: _pendingLines,
      completed: _completed,
      ...diagnostic
    } = read;
    this.diagnostics?.({
      type: "read-completed",
      ...diagnostic,
      pendingRequestCount: this.pendingById.size
    });
    this.scheduleReleaseProbe(read.readSeq, completedAt);
  }

  private readonly handleInputError = (error: Error): void => {
    this.rejectAll(
      createRuntimePortError({
        code: "runtime_process_exited",
        message: "Runtime output stream failed.",
        retryable: true,
        cause: error
      })
    );
  };

  private readonly handleOutputError = (error: Error): void => {
    const writeError = createRuntimePortError({
        code: "runtime_write_failed",
        message: "Runtime input stream failed.",
        retryable: true,
        cause: error
    });
    this.rejectAll(writeError);
    this.rejectAllWrites(writeError);
  };

  public constructor(options: JsonRpcLineClientOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.diagnostics = options.diagnostics;
    this.createRequestId =
      options.createRequestId ??
      (() => {
        this.nextRequestId += 1;
        return String(this.nextRequestId);
      });
    if (options.input || options.output) {
      this.attach({
        input: options.input,
        output: options.output
      });
    }
  }

  public attach(inputOutput: {
    input?: Readable;
    output?: Writable;
  }): void {
    this.detachStreams();
    this.input = inputOutput.input;
    this.output = inputOutput.output;
    this.bufferedParts.length = 0;
    this.bufferedBytes = 0;
    this.input?.on("data", this.handleData);
    this.input?.on("error", this.handleInputError);
    this.output?.on("error", this.handleOutputError);
  }

  public dispose(error?: Error): void {
    const disposalError =
      error ??
      createRuntimePortError({
        code: "runtime_process_exited",
        message: "Runtime line client was disposed.",
        retryable: true
      });
    this.rejectAll(disposalError);
    this.rejectAllWrites(disposalError);
    this.detachStreams();
  }

  public getPendingCount(): number {
    return this.pendingById.size;
  }

  public onRequest(listener: Listener<JsonRpcLineRequestPayload>): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  public onNotification(
    listener: Listener<JsonRpcLineNotificationPayload>
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public onProtocolError(listener: Listener<Error>): () => void {
    this.protocolErrorListeners.add(listener);
    return () => {
      this.protocolErrorListeners.delete(listener);
    };
  }

  public request(
    method: string,
    params?: unknown,
    options: RuntimeOperationOptions = {}
  ): Promise<unknown> {
    if (!this.output || this.output.destroyed || this.output.writableEnded) {
      return Promise.reject(
        createRuntimeNotStartedError({
          method
        })
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(method));
    }

    const id = this.createRequestId();
    const requestId = localRequestId(id);
    if (this.pendingById.has(requestId)) {
      return Promise.reject(
        createRuntimePortError({
          code: "runtime_protocol_error",
          message: `JSON-RPC request id collision: ${requestId}.`,
          retryable: false,
          details: {
            requestId,
            method
          }
        })
      );
    }

    const payload: JsonRpcLinePayload = {
      id,
      method,
      ...(params === undefined ? {} : { params })
    };

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        resolve,
        reject,
        timeout: undefined,
        abortListener: undefined,
        signal: options.signal
      };
      this.pendingById.set(requestId, pending);
      this.installPendingGuards(requestId, pending, options);
      void this.writePayload(payload, options).catch((error: Error) => {
        this.rejectPending(requestId, this.createWriteError(error, method, id));
      });
    });
  }

  public notify(
    method: string,
    params?: unknown,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(method));
    }
    return this.write(
      {
        method,
        ...(params === undefined ? {} : { params })
      },
      options
    );
  }

  public respond(
    id: JsonRpcLineId,
    result: unknown,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError("response"));
    }
    return this.write(
      {
        id,
        result
      },
      options
    );
  }

  public respondError(
    id: JsonRpcLineId,
    error: NonNullable<JsonRpcLinePayload["error"]>,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError("response"));
    }
    return this.write(
      {
        id,
        error
      },
      options
    );
  }

  public write(
    payload: JsonRpcLinePayload,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(payload.method ?? "write"));
    }
    return this.writePayload(payload, options);
  }

  public rejectAll(error: Error): void {
    for (const requestId of [...this.pendingById.keys()]) {
      this.rejectPending(requestId, error);
    }
  }

  public rejectAllWrites(error: Error): void {
    for (const pendingWrite of [...this.pendingWrites]) {
      pendingWrite.reject(error);
    }
  }

  private detachStreams(): void {
    this.input?.off("data", this.handleData);
    this.input?.off("error", this.handleInputError);
    this.output?.off("error", this.handleOutputError);
    this.input = undefined;
    this.output = undefined;
    this.bufferedParts.length = 0;
    this.bufferedBytes = 0;
    const parser = this.parser;
    this.parser = { queue: [] };
    parser.queue.length = 0;
    parser.pending = undefined;
    void parser.worker?.terminate();
  }

  private consume(chunk: Buffer | string, diagnostics?: ActiveReadDiagnostics): void {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    let start = 0;
    for (;;) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex < 0) break;
      const tail = text.slice(start, newlineIndex);
      const line = this.bufferedParts.length > 0
        ? [...this.bufferedParts, tail].join("")
        : tail;
      this.bufferedParts.length = 0;
      this.bufferedBytes = 0;
      start = newlineIndex + 1;
      if (!line.trim()) continue;
      if (diagnostics) diagnostics.pendingLines += 1;
      this.parser.queue.push({ line, diagnostics });
    }
    if (start < text.length) {
      const remainder = text.slice(start);
      this.bufferedParts.push(remainder);
      this.bufferedBytes += Buffer.byteLength(remainder);
    }
  }

  private drainQueuedLines(): void {
    const parser = this.parser;
    if (parser.pending) return;
    while (this.parser === parser) {
      const queued = parser.queue.shift();
      if (!queued) return;
      if (Buffer.byteLength(queued.line) >= LARGE_JSON_PARSE_THRESHOLD) {
        parser.pending = queued;
        try {
          this.ensureParseWorker(parser).postMessage(queued.line);
        } catch (error) {
          this.finishLargeLine(parser, { error: String(error) });
        }
        return;
      }
      const startedAt = performance.now();
      this.handleLine(queued.line, queued.diagnostics);
      if (queued.diagnostics) queued.diagnostics.syncDurationMs += performance.now() - startedAt;
      this.finishQueuedLine(queued.diagnostics);
    }
  }

  private handleLine(line: string, diagnostics?: ActiveReadDiagnostics): void {
    let payload: JsonRpcLinePayload;
    try {
      payload = JSON.parse(line) as JsonRpcLinePayload;
    } catch (error) {
      this.handleParseError(error, line, diagnostics);
      return;
    }
    this.dispatchParsedPayload(payload, diagnostics);
  }

  private dispatchParsedPayload(
    payload: JsonRpcLinePayload,
    diagnostics?: ActiveReadDiagnostics
  ): void {
    const previousDiagnostics = this.activeReadDiagnostics;
    this.activeReadDiagnostics = diagnostics;
    try {
      if (diagnostics) diagnostics.parsedLineCount += 1;
      this.incrementActiveMethod(
        typeof payload.method === "string" ? payload.method : "<response>"
      );
      if (typeof payload.method === "string" && payload.id !== undefined) {
        this.emitRequest(payload as JsonRpcLineRequestPayload);
      } else if (typeof payload.method === "string") {
        if (this.activeReadDiagnostics) {
          this.activeReadDiagnostics.notificationCount += 1;
        }
        this.emitNotification(payload as JsonRpcLineNotificationPayload);
      } else if (payload.id !== undefined) {
        this.handleResponse(payload);
      }
    } finally {
      this.activeReadDiagnostics = previousDiagnostics;
    }
  }

  private handleParseError(
    error: unknown,
    line: string,
    diagnostics?: ActiveReadDiagnostics
  ): void {
    const previousDiagnostics = this.activeReadDiagnostics;
    this.activeReadDiagnostics = diagnostics;
    if (diagnostics) {
      diagnostics.parsedLineCount += 1;
      diagnostics.parseErrorCount += 1;
      this.incrementActiveMethod("<parse-error>");
    }
    this.emitProtocolError(
      createRuntimePortError({
        code: "runtime_protocol_error",
        message: error instanceof Error ? error.message : "Failed to parse JSON line.",
        retryable: true,
        details: {
          rawLine: line.length > 4_096 ? `${line.slice(0, 4_096)}…` : line
        },
        cause: error
      })
    );
    this.activeReadDiagnostics = previousDiagnostics;
  }

  private finishQueuedLine(diagnostics?: ActiveReadDiagnostics): void {
    if (!diagnostics) return;
    diagnostics.pendingLines -= 1;
    this.completeReadIfReady(diagnostics);
  }

  private finishLargeLine(
    parser: LineParser,
    result: { payload?: JsonRpcLinePayload; error?: string }
  ): void {
    if (this.parser !== parser || !parser.pending) return;
    const queued = parser.pending;
    const startedAt = performance.now();
    try {
      if (result.error !== undefined) {
        this.handleParseError(new Error(result.error), queued.line, queued.diagnostics);
      } else {
        this.dispatchParsedPayload(result.payload!, queued.diagnostics);
      }
    } finally {
      if (queued.diagnostics) queued.diagnostics.syncDurationMs += performance.now() - startedAt;
      parser.pending = undefined;
      if (this.parser === parser) {
        this.finishQueuedLine(queued.diagnostics);
        this.drainQueuedLines();
      }
    }
  }

  private ensureParseWorker(parser: LineParser): Worker {
    if (parser.worker) return parser.worker;
    const worker = new Worker(JSON_PARSE_WORKER, { eval: true });
    worker.on("message", (result) => {
      if (parser.worker === worker) this.finishLargeLine(parser, result);
    });
    const fail = (error: Error) => {
      if (parser.worker !== worker) return;
      parser.worker = undefined;
      this.finishLargeLine(parser, { error: error.message });
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`JSON parser worker exited with code ${code}.`)));
    worker.unref();
    parser.worker = worker;
    return worker;
  }

  private handleResponse(payload: JsonRpcLinePayload): void {
    const requestId = localRequestId(payload.id as JsonRpcLineId);
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return;
    }
    if (payload.error) {
      this.rejectPending(
        requestId,
        createRuntimePortError({
          code: "runtime_protocol_error",
          message: payload.error.message ?? "JSON-RPC request failed.",
          retryable: false,
          details: {
            requestId,
            method: pending.method,
            jsonRpcCode: payload.error.code,
            data: payload.error.data
          }
        })
      );
      return;
    }
    this.resolvePending(requestId, payload.result);
  }

  private installPendingGuards(
    requestId: string,
    pending: PendingRequest,
    options: RuntimeOperationOptions
  ): void {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs > 0) {
      pending.timeout = setTimeout(() => {
        this.rejectPending(
          requestId,
          createRuntimeRequestTimeoutError(timeoutMs, {
            requestId,
            method: pending.method
          })
        );
      }, timeoutMs);
    }

    if (options.signal) {
      const onAbort = () => {
        this.rejectPending(requestId, this.createAbortError(pending.method));
      };
      pending.abortListener = onAbort;
      options.signal.addEventListener("abort", onAbort, {
        once: true
      });
    }
  }

  private resolvePending(requestId: string, value: unknown): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingById.delete(requestId);
    this.clearPendingGuards(pending);
    pending.resolve(value);
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingById.delete(requestId);
    this.clearPendingGuards(pending);
    pending.reject(error);
  }

  private clearPendingGuards(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  private writePayload(
    payload: JsonRpcLinePayload,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    const output = this.output;
    if (!output || output.destroyed || output.writableEnded) {
      return Promise.reject(createRuntimeNotStartedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(payload.method ?? "write"));
    }

    const line = `${JSON.stringify(payload)}\n`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener: (() => void) | undefined;
      let pendingWrite: PendingWrite | undefined;
      const settle = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        output.off("drain", onDrain);
        output.off("error", onError);
        if (pendingWrite) {
          this.pendingWrites.delete(pendingWrite);
        }
        if (options.signal && abortListener) {
          options.signal.removeEventListener("abort", abortListener);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onDrain = () => settle();
      const onError = (error: Error) => settle(error);
      abortListener = () => settle(this.createAbortError(payload.method ?? "write"));
      pendingWrite = {
        reject: (error) => settle(error)
      };
      this.pendingWrites.add(pendingWrite);

      output.once("error", onError);
      if (options.signal) {
        options.signal.addEventListener("abort", abortListener, {
          once: true
        });
      }

      let accepted: boolean;
      try {
        accepted = output.write(line, (error?: Error | null) => {
          if (error) {
            settle(error);
            return;
          }
          if (accepted) {
            settle();
          }
        });
      } catch (error) {
        settle(error instanceof Error ? error : new Error("Runtime write failed."));
        return;
      }

      if (!accepted) {
        output.once("drain", onDrain);
      }
    });
  }

  private createAbortError(method: string): Error {
    return createRuntimePortError({
      code: "runtime_request_aborted",
      message: "Runtime request was aborted.",
      retryable: true,
      details: {
        method
      }
    });
  }

  private createWriteError(
    error: Error,
    method: string,
    id: JsonRpcLineId
  ): Error {
    return createRuntimePortError({
      code: "runtime_write_failed",
      message: "Failed to write JSON-RPC request to runtime.",
      retryable: true,
      details: {
        requestId: localRequestId(id),
        method
      },
      cause: error
    });
  }

  private emitRequest(payload: JsonRpcLineRequestPayload): void {
    for (const listener of this.requestListeners) {
      void Promise.resolve(listener(payload)).catch((error: unknown) => {
        this.emitProtocolError(
          error instanceof Error
            ? error
            : new Error("JSON-RPC request listener failed.")
        );
      });
    }
  }

  private emitNotification(payload: JsonRpcLineNotificationPayload): void {
    const startedAt = this.activeReadDiagnostics ? performance.now() : 0;
    for (const listener of this.notificationListeners) {
      void Promise.resolve(listener(payload)).catch((error: unknown) => {
        this.emitProtocolError(
          error instanceof Error
            ? error
            : new Error("JSON-RPC notification listener failed.")
        );
      });
    }
    if (this.activeReadDiagnostics) {
      this.activeReadDiagnostics.maxNotificationListenerSyncMs = Math.max(
        this.activeReadDiagnostics.maxNotificationListenerSyncMs,
        performance.now() - startedAt
      );
    }
  }

  private incrementActiveMethod(method: string): void {
    if (!this.activeReadDiagnostics) {
      return;
    }
    this.activeReadDiagnostics.methods[method] =
      (this.activeReadDiagnostics.methods[method] ?? 0) + 1;
  }

  private emitProtocolError(error: Error): void {
    for (const listener of this.protocolErrorListeners) {
      void Promise.resolve(listener(error));
    }
  }
}
