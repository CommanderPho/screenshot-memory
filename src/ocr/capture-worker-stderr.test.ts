import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { getCaptureWorkerPath, onWorkerLine } from "./capture-worker-stderr.js";

const require = createRequire(import.meta.url);

describe("worker stderr capture", () => {
  test("posts console warnings instead of writing them to the terminal", async () => {
    const lines: string[] = [];
    const unsubscribe = onWorkerLine((_worker, line) => {
      lines.push(line);
    });

    const { Worker } = require("worker_threads") as {
      new (filename: string, options?: { workerData?: { captureOnly?: boolean } }): {
        on(event: "message", listener: (message: unknown) => void): void;
        on(event: "error", listener: (err: Error) => void): void;
        on(event: "exit", listener: (code: number) => void): void;
        postMessage(value: unknown): void;
      };
    };

    const worker = new Worker(getCaptureWorkerPath(), { workerData: { captureOnly: true } });
    worker.on("message", () => {});
    worker.postMessage("go");
    const exitCode = await new Promise<number>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("exit", resolve);
    });

    unsubscribe();
    expect(exitCode).toBe(0);
    expect(lines).toContain("Image too small to scale!! (2x36 vs min width of 3)");
    expect(lines).toContain("Line cannot be recognized!!");
  });
});
