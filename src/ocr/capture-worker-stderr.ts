/**
 * Keep Tesseract worker output off the terminal.
 *
 * Bun ignores Worker `stderr: true` and still inherits the console fd, so each
 * worker runs a prelude that posts console output back as a side-channel
 * message. Node can also expose `worker.stderr`; both paths feed the same hook.
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export type WorkerLineHandler = (nodeWorker: object, line: string) => void;

const lineHandlers = new Set<WorkerLineHandler>();

/**
 * Subscribe to captured worker console lines. The node worker instance is the
 * same object stored on a tesseract.js worker as `.worker`.
 */
export function onWorkerLine(handler: WorkerLineHandler): () => void {
  lineHandlers.add(handler);
  return () => {
    lineHandlers.delete(handler);
  };
}

function dispatchLine(nodeWorker: object, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  for (const handler of lineHandlers) {
    handler(nodeWorker, trimmed);
  }
}

function consumeStream(nodeWorker: object, stream: NodeJS.ReadableStream | null | undefined): void {
  if (!stream || typeof stream.on !== "function") return;
  let pending = "";
  stream.on("data", (chunk: unknown) => {
    pending += String(chunk);
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const part of parts) {
      dispatchLine(nodeWorker, part);
    }
  });
}

type WorkerMessage = { __ssmStderr?: unknown };

interface WorkerLike {
  stderr?: NodeJS.ReadableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  on(event: string | symbol, listener: (...args: unknown[]) => void): WorkerLike;
}

interface WorkerConstructor {
  new (filename: string | URL, options?: Record<string, unknown>): WorkerLike;
  prototype: { on: WorkerLike["on"] };
}

const workerThreads = require("worker_threads") as { Worker: WorkerConstructor };
const nodeWorkerThreads = require("node:worker_threads") as { Worker: WorkerConstructor };
const OriginalWorker = workerThreads.Worker;

function isStderrMessage(message: unknown): message is { __ssmStderr: string } {
  return Boolean(message && typeof message === "object" && typeof (message as WorkerMessage).__ssmStderr === "string");
}

class CapturingWorker extends OriginalWorker {
  constructor(filename: string | URL, options: Record<string, unknown> = {}) {
    super(filename, { ...options, stderr: true, stdout: true });
    consumeStream(this, this.stderr);
    consumeStream(this, this.stdout);
    super.on("message", (message: unknown) => {
      if (!isStderrMessage(message)) return;
      for (const part of message.__ssmStderr.split(/\r?\n/)) {
        dispatchLine(this, part);
      }
    });
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === "message" && typeof listener === "function") {
      const userHandler = listener as (message: unknown) => void;
      return super.on(event, (message: unknown) => {
        if (isStderrMessage(message)) return;
        userHandler(message);
      }) as this;
    }
    return super.on(event, listener) as this;
  }
}

workerThreads.Worker = CapturingWorker;
if (nodeWorkerThreads !== workerThreads) {
  nodeWorkerThreads.Worker = CapturingWorker;
}

let cachedWorkerPath: string | null = null;

/**
 * Worker script tesseract.js should spawn. Console writes become `__ssmStderr`
 * messages so they never reach the inherited terminal fd.
 */
export function getCaptureWorkerPath(): string {
  if (cachedWorkerPath) return cachedWorkerPath;

  const originalWorkerPath = require.resolve("tesseract.js/src/worker-script/node/index.js");
  const dest = join(tmpdir(), "screenshot-memory-tesseract-worker.cjs");
  const source = `const { parentPort, workerData } = require("worker_threads");
function report(args) {
  const text = args.map((part) => {
    if (typeof part === "string") return part;
    if (part instanceof Error) return part.message;
    return String(part);
  }).join(" ");
  try { parentPort.postMessage({ __ssmStderr: text }); } catch (_) {}
}
console.error = (...args) => { report(args); };
console.warn = (...args) => { report(args); };
console.log = (...args) => { report(args); };
if (workerData && workerData.captureOnly) {
  parentPort.on("message", () => {
    console.error("Image too small to scale!! (2x36 vs min width of 3)");
    console.error("Line cannot be recognized!!");
    process.exit(0);
  });
} else {
  require(${JSON.stringify(originalWorkerPath)});
}
`;
  writeFileSync(dest, source, "utf8");
  cachedWorkerPath = dest;
  return dest;
}
