import { describe, expect, it } from "vitest";
import { computeRisk } from "./broker-insights.service";
import type { FmcsaAuthorityData } from "./fmcsa.client";

function fmcsa(authorityStatus: FmcsaAuthorityData["authorityStatus"]): FmcsaAuthorityData {
  return { legalName: "Test Co", dba: null, address: null, phone: null, authorityStatus, authorityGrantedDate: null };
}

describe("computeRisk", () => {
  it("returns null when there is no signal at all", () => {
    expect(computeRisk(null, null)).toBeNull();
  });

  it("scores a broker with granted authority and no credit data as low risk", () => {
    const risk = computeRisk(fmcsa("granted"), null);
    expect(risk?.band).toBe("low");
  });

  it("scores a broker with revoked authority as high risk", () => {
    const risk = computeRisk(fmcsa("revoked"), null);
    expect(risk?.band).toBe("high");
    expect(risk?.factors.some((f) => f.severity === "danger")).toBe(true);
  });

  it("combines a poor credit grade with granted authority into a higher score than authority alone", () => {
    const withoutCredit = computeRisk(fmcsa("granted"), null);
    const withPoorCredit = computeRisk(fmcsa("granted"), { grade: "F", gradeSource: "Test Vendor", avgDaysToPay: 75 });

    expect(withPoorCredit!.score).toBeGreaterThan(withoutCredit!.score);
  });

  it("clamps the score to [0, 100]", () => {
    const risk = computeRisk(fmcsa("revoked"), { grade: "F", gradeSource: "Test Vendor", avgDaysToPay: 90 });
    expect(risk!.score).toBeLessThanOrEqual(100);
  });

  describe("scamLikely", () => {
    it("is false when only authority is revoked with no other bad signal", () => {
      expect(computeRisk(fmcsa("revoked"), null)?.scamLikely).toBe(false);
    });

    it("is false when credit is poor but authority is granted", () => {
      const risk = computeRisk(fmcsa("granted"), { grade: "F", gradeSource: "Test Vendor", avgDaysToPay: 90 });
      expect(risk?.scamLikely).toBe(false);
    });

    it("is true when authority is revoked AND credit is poor (two independent signals)", () => {
      const risk = computeRisk(fmcsa("revoked"), { grade: "F", gradeSource: "Test Vendor", avgDaysToPay: 90 });
      expect(risk?.scamLikely).toBe(true);
    });

    it("is true when authority is revoked AND the phone is high-risk", () => {
      const risk = computeRisk(fmcsa("revoked"), null, {
        lineType: "VOIP",
        riskLevel: "high",
        callerType: null,
        registeredOwner: null,
      });
      expect(risk?.scamLikely).toBe(true);
    });
  });
});
