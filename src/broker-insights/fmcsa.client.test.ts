import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCarrierByDot, fetchCarrierByMc } from "./fmcsa.client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOnce(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
    })
  );
}

describe("fmcsa.client", () => {
  it("maps a DOT-number lookup response to FmcsaAuthorityData", async () => {
    mockFetchOnce({
      content: {
        carrier: {
          legalName: "Acme Logistics LLC",
          dbaName: "Acme Freight",
          dotNumber: 123456,
          phyStreet: "1 Main St",
          phyCity: "Dallas",
          phyState: "TX",
          phyZipcode: "75201",
          brokerAuthorityStatus: "ACTIVE",
        },
      },
      retrievalDate: "2026-01-01",
    });

    const result = await fetchCarrierByDot("123456", "test-key");
    expect(result).toEqual({
      legalName: "Acme Logistics LLC",
      dba: "Acme Freight",
      address: "1 Main St, Dallas, TX, 75201",
      phone: null,
      authorityStatus: "granted",
      authorityGrantedDate: null,
    });
  });

  it("strips non-digit characters from an MC number before querying the docket endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ content: [{ carrier: { legalName: "Test Carrier", brokerAuthorityStatus: "INACTIVE" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCarrierByMc("MC-654321", "test-key");

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("docket-number/654321"));
    expect(result?.authorityStatus).toBe("revoked");
  });

  it("returns null when FMCSA has no record for the carrier", async () => {
    mockFetchOnce({ content: [] });
    expect(await fetchCarrierByMc("999999", "test-key")).toBeNull();
  });

  it("throws when the FMCSA API responds with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" })
    );
    await expect(fetchCarrierByDot("123456", "test-key")).rejects.toThrow("503");
  });
});
