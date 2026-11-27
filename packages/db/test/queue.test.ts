import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import { QUEUE_NAME, enqueueRun } from "../src/queue.js";

describe("enqueueRun", () => {
  it("adds an extract job keyed by run id with a single attempt", async () => {
    const add = vi.fn(async () => ({}));
    await enqueueRun({ add } as unknown as Queue, "run-1");
    expect(QUEUE_NAME).toBe("extraction");
    expect(add).toHaveBeenCalledWith(
      "extract",
      { runId: "run-1" },
      { jobId: "run-1", attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 },
    );
  });
});
