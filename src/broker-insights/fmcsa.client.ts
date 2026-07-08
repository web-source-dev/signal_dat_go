/**
 * FMCSA QCMobile API client — free, official, public. Confirmed against the
 * (MIT-licensed) reference Go client at github.com/brandenco/qcmobile, which
 * documents the real endpoint paths and JSON field names used here. Field
 * *values* (e.g. exactly which strings `brokerAuthorityStatus` takes) are
 * not independently confirmed — `mapAuthorityStatus` below makes a
 * best-effort mapping and defaults to "unknown" for anything unrecognized
 * rather than guessing wrong in either direction.
 *
 * Requires a free FMCSA developer WebKey: https://mobile.fmcsa.dot.gov/QCDevsite
 */

const BASE_URL = "https://mobile.fmcsa.dot.gov/qc/services/carriers/";

interface FmcsaCarrier {
  legalName?: string;
  dbaName?: string;
  dotNumber?: number;
  phyStreet?: string;
  phyCity?: string;
  phyState?: string;
  phyZipcode?: string;
  phyCountry?: string;
  allowedToOperate?: string;
  statusCode?: string;
  brokerAuthorityStatus?: string;
  commonAuthorityStatus?: string;
  contractAuthorityStatus?: string;
  safetyRatingDate?: string;
}

interface FmcsaCarrierResponse {
  content?: { carrier?: FmcsaCarrier };
}

/** Shared by the docket-number and name search endpoints — both return `[]CarrierDetails` per the reference client's `searchResponse` type. */
interface FmcsaSearchResponse {
  content?: Array<{ carrier?: FmcsaCarrier }>;
}

export type AuthorityStatus = "granted" | "reinstated" | "revoked" | "unknown";

export interface FmcsaAuthorityData {
  legalName: string;
  dba: string | null;
  address: string | null;
  phone: null; // FMCSA's carrier record has no phone field — never available from this source
  authorityStatus: AuthorityStatus;
  authorityGrantedDate: string | null;
}

function mapAuthorityStatus(raw: string | undefined): AuthorityStatus {
  if (!raw) return "unknown";
  const normalized = raw.trim().toUpperCase();
  if (normalized === "ACTIVE" || normalized === "GRANTED") return "granted";
  if (normalized === "REINSTATED") return "reinstated";
  if (normalized === "INACTIVE" || normalized === "REVOKED" || normalized === "NONE") return "revoked";
  return "unknown";
}

function formatAddress(carrier: FmcsaCarrier): string | null {
  const parts = [carrier.phyStreet, carrier.phyCity, carrier.phyState, carrier.phyZipcode].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function toAuthorityData(carrier: FmcsaCarrier): FmcsaAuthorityData {
  return {
    legalName: carrier.legalName ?? "Unknown",
    dba: carrier.dbaName || null,
    address: formatAddress(carrier),
    phone: null,
    authorityStatus: mapAuthorityStatus(
      carrier.brokerAuthorityStatus ?? carrier.commonAuthorityStatus ?? carrier.contractAuthorityStatus
    ),
    authorityGrantedDate: null, // not present on the base carrier record; would need the /authority sub-resource
  };
}

async function fmcsaGet<T>(path: string, webKey: string): Promise<T> {
  const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}webKey=${encodeURIComponent(webKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FMCSA API request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function fetchCarrierByDot(dotNumber: string, webKey: string): Promise<FmcsaAuthorityData | null> {
  const data = await fmcsaGet<FmcsaCarrierResponse>(dotNumber, webKey);
  const carrier = data.content?.carrier;
  return carrier ? toAuthorityData(carrier) : null;
}

/** MC/docket numbers are commonly entered with an "MC-" prefix — strip to digits before calling. */
export async function fetchCarrierByMc(mcNumber: string, webKey: string): Promise<FmcsaAuthorityData | null> {
  const docketDigits = mcNumber.replace(/\D/g, "");
  if (!docketDigits) return null;

  const data = await fmcsaGet<FmcsaSearchResponse>(`docket-number/${docketDigits}`, webKey);
  const carrier = data.content?.[0]?.carrier;
  return carrier ? toAuthorityData(carrier) : null;
}

/**
 * Fallback for when no MC/DOT number is available (the common case — load
 * board listing rows rarely surface a carrier's MC number directly). Takes
 * the first match only; there's no disambiguation UI for same-named
 * carriers yet, so treat this as best-effort, not authoritative.
 */
export async function fetchCarrierByName(companyName: string, webKey: string): Promise<FmcsaAuthorityData | null> {
  const data = await fmcsaGet<FmcsaSearchResponse>(`name/${encodeURIComponent(companyName)}`, webKey);
  const carrier = data.content?.[0]?.carrier;
  return carrier ? toAuthorityData(carrier) : null;
}
