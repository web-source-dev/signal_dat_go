import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports ok with a timestamp", () => {
    const result = new HealthController().check();
    expect(result.status).toBe("ok");
    expect(new Date(result.timestamp).toString()).not.toBe("Invalid Date");
  });
});
