import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clearRequests } from "../src/lib/api";

afterEach(() => {
  clearRequests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("request failures", () => {
  it("explains an uncertain save without retrying the mutation", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      api("/api/actions", { action: "workout.members" }),
    ).rejects.toThrow("Your changes may have been saved.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops a stalled request and reports the timeout", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_path, init) => {
        requestSignal = init.signal;
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const result = expect(api("/api/data")).rejects.toThrow(
      "The server took too long to respond.",
    );
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    expect(requestSignal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves cancellation when the account is cleared", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const result = expect(api("/api/data")).rejects.toMatchObject({
      name: "AbortError",
    });
    clearRequests();
    await result;
  });

  it("keeps server validation messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Record not found." }), {
            status: 404,
          }),
        ),
    );
    await expect(api("/api/actions", {})).rejects.toThrow("Record not found.");
  });

  it("explains a non-JSON server response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })),
    );
    await expect(api("/api/data")).rejects.toThrow("unreadable response");
  });
});
