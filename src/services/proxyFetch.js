/**
 * Outbound HTTP fetch with optional residential proxy chain.
 * FMCSA QCMobile returns 403 from many regions without a US egress.
 */
import { fetch as undiciFetch, ProxyAgent } from "undici";

function buildProxyUrl({ host, port, username, password }) {
  if (!host || !port) return null;
  const auth =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : "";
  return `http://${auth}${host}:${port}`;
}

export function getProxyChain() {
  const chain = [];

  if (process.env.HTTP_PROXY_URL) {
    chain.push({ label: "primary", url: process.env.HTTP_PROXY_URL });
  }

  const primary = buildProxyUrl({
    host: process.env.HTTP_PROXY_HOST,
    port: process.env.HTTP_PROXY_PORT,
    username: process.env.HTTP_PROXY_USERNAME,
    password: process.env.HTTP_PROXY_PASSWORD,
  });
  if (primary) chain.push({ label: process.env.HTTP_PROXY_NAME || "primary", url: primary });

  const backup = buildProxyUrl({
    host: process.env.HTTP_PROXY_BACKUP_HOST,
    port: process.env.HTTP_PROXY_BACKUP_PORT,
    username: process.env.HTTP_PROXY_BACKUP_USERNAME,
    password: process.env.HTTP_PROXY_BACKUP_PASSWORD,
  });
  if (backup) chain.push({ label: process.env.HTTP_PROXY_BACKUP_NAME || "backup", url: backup });

  return chain;
}

export async function proxyFetch(url, options = {}) {
  const { retryStatusCodes, ...fetchOptions } = options;
  const retryCodes = retryStatusCodes || [403, 429];
  const proxies = getProxyChain();

  if (proxies.length === 0) {
    return globalThis.fetch(url, fetchOptions);
  }

  let lastError = null;

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const hasMore = i < proxies.length - 1;

    try {
      const dispatcher = new ProxyAgent(proxy.url);
      const res = await undiciFetch(url, { ...fetchOptions, dispatcher });

      const shouldRetry = hasMore && (retryCodes.includes(res.status) || res.status >= 500);
      if (shouldRetry) {
        console.warn("[proxyFetch] %s returned %s for %s — trying next proxy", proxy.label, res.status, url);
        lastError = new Error(`HTTP ${res.status} via ${proxy.label}`);
        continue;
      }

      if (res.ok || !hasMore) {
        if (res.ok) console.log("[proxyFetch] OK via %s", proxy.label);
        return res;
      }

      return res;
    } catch (err) {
      console.warn("[proxyFetch] %s error: %s", proxy.label, err.message);
      lastError = err;
    }
  }

  if (process.env.ALLOW_DIRECT_FETCH === "true") {
    console.warn("[proxyFetch] all proxies failed — falling back to direct fetch");
    return globalThis.fetch(url, fetchOptions);
  }

  throw lastError || new Error("All proxy attempts failed");
}
