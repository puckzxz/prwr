import { describe, expect, it } from "vitest";
import { normalizeReadiness } from "../src/readiness-config.js";
import { MAX_TIMER_MS } from "../src/timing.js";

describe("readiness configuration", () => {
  it("defaults to no readiness check", () => {
    expect(normalizeReadiness(undefined, "api")).toBeNull();
    expect(normalizeReadiness(null, "api")).toBeNull();
  });

  it("normalizes TCP checks with a local host and bounded polling defaults", () => {
    expect(normalizeReadiness({ type: "tcp", port: 5432 }, "database")).toEqual({
      type: "tcp", host: "127.0.0.1", port: 5432, timeoutMs: 10000, intervalMs: 100
    });
    expect(normalizeReadiness({ type: "tcp", host: " ::1 ", port: 65535, timeoutMs: 20000, intervalMs: 250 }, "api"))
      .toEqual({ type: "tcp", host: "::1", port: 65535, timeoutMs: 20000, intervalMs: 250 });
  });

  it("normalizes HTTP and HTTPS URLs and explicit timings", () => {
    expect(normalizeReadiness({ type: "http", url: "http://localhost:3000/health", intervalMs: 10 }, "api"))
      .toEqual({ type: "http", url: "http://localhost:3000/health", timeoutMs: 10000, intervalMs: 10 });
    expect(normalizeReadiness({ type: "http", url: "https://localhost", timeoutMs: MAX_TIMER_MS }, "api"))
      .toMatchObject({ url: "https://localhost/", timeoutMs: MAX_TIMER_MS });
  });

  it.each(["tcp", [], 4, false, { type: "unknown" }, {}].map((value) => ({ value })))
    ("rejects malformed checks: $value", ({ value }) => {
    expect(() => normalizeReadiness(value, "api")).toThrow(/Invalid process "api": readyWhen/);
  });

  it.each([undefined, 0, -1, 65536, 1.5, "5432", NaN])("rejects invalid TCP ports: %j", (port) => {
    expect(() => normalizeReadiness({ type: "tcp", port }, "api")).toThrow(/port must be an integer between 1 and 65535/);
  });

  it.each(["", "  ", 4, null])("rejects invalid TCP hosts: %j", (host) => {
    expect(() => normalizeReadiness({ type: "tcp", host, port: 3000 }, "api")).toThrow(/host must be a non-empty string/);
  });

  it.each(["timeoutMs", "intervalMs"])("rejects invalid %s values", (field) => {
    for (const value of [null, "10", 0, -1, 1.5, MAX_TIMER_MS + 1, Infinity, NaN]) {
      expect(() => normalizeReadiness({ type: "tcp", port: 3000, [field]: value }, "api"))
        .toThrow(new RegExp(`${field} must be an integer between`));
    }
  });

  it.each([
    { type: "tcp", port: 3000, url: "http://localhost" },
    { type: "http", url: "http://localhost", port: 3000 },
    { type: "tcp", port: 3000, timeoutMS: 10 }
  ])("rejects fields from another check or misspelled fields: %j", (value) => {
    expect(() => normalizeReadiness(value, "api")).toThrow(/unknown field/);
  });

  it.each([undefined, 4, "", "/health", "ftp://localhost", "http://user:secret-value@localhost/health"])
    ("rejects malformed or credential URLs without echoing their contents: %j", (url) => {
      try {
        normalizeReadiness({ type: "http", url }, "api");
        throw new Error("Expected URL validation to fail.");
      } catch (error) {
        expect((error as Error).message).toMatch(/readyWhen.url must be/);
        expect((error as Error).message).not.toContain("secret-value");
      }
    });
});
