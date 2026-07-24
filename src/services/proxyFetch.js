/**
 * Outbound HTTP fetch with optional residential proxy chain.
 * FMCSA QCMobile returns 403 from many regions without a US egress.
 */
import http from "node:http";
import tls from "node:tls";
import { URL } from "node:url";
import { fetch as undiciFetch, ProxyAgent } from "undici";

function buildProxyUrl({ host, port, username, password }) {
  if (!host || !port) return null;
  const auth =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : "";
  return `http://${auth}${host}:${port}`;
}

function parseProxy(entry) {
  const parsed = new URL(entry.url);
  return {
    label: entry.label,
    url: entry.url,
    host: parsed.hostname,
    port: Number(parsed.port || 80),
    username: parsed.username ? decodeURIComponent(parsed.username) : "",
    password: parsed.password ? decodeURIComponent(parsed.password) : "",
  };
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

function basicAuthHeader(username, password) {
  if (!username) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function summarizeProxyError(err) {
  return err?.message || err?.cause?.message || err?.cause?.code || err?.code || String(err);
}

/**
 * Open an HTTP CONNECT tunnel and surface proxy status (407 etc.) clearly.
 * Tries plain HTTP to the proxy first, then TLS (HTTPS proxy) if needed.
 */
function connectTunnel(proxy, targetHost, targetPort, timeoutMs = 15000) {
  const headers = {
    Host: `${targetHost}:${targetPort}`,
    Connection: "close",
  };
  const auth = basicAuthHeader(proxy.username, proxy.password);
  if (auth) headers["Proxy-Authorization"] = auth;

  function attempt(useTls) {
    return new Promise((resolve, reject) => {
      const onConnect = (res, socket, head) => {
        if (res.statusCode !== 200) {
          const realm = res.headers?.["proxy-authenticate"] || "";
          socket.destroy();
          const err = new Error(`CONNECT ${res.statusCode}${realm ? ` (${realm})` : ""}`);
          err.code = res.statusCode === 407 ? "PROXY_AUTH_REQUIRED" : "PROXY_CONNECT_FAILED";
          err.status = res.statusCode;
          reject(err);
          return;
        }
        if (head?.length) socket.unshift(head);
        resolve(socket);
      };

      if (!useTls) {
        const req = http.request({
          host: proxy.host,
          port: proxy.port,
          method: "CONNECT",
          path: `${targetHost}:${targetPort}`,
          headers,
          timeout: timeoutMs,
        });
        req.on("connect", onConnect);
        req.on("timeout", () => {
          req.destroy();
          reject(Object.assign(new Error("CONNECT timeout"), { code: "PROXY_TIMEOUT" }));
        });
        req.on("error", (err) => {
          reject(
            Object.assign(new Error(`CONNECT error: ${err.message}`), {
              code: err.code || "PROXY_CONNECT_FAILED",
              cause: err,
            })
          );
        });
        req.end();
        return;
      }

      const socket = tls.connect({
        host: proxy.host,
        port: proxy.port,
        servername: proxy.host,
        timeout: timeoutMs,
        rejectUnauthorized: false,
      });

      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => {
        socket.destroy();
        reject(Object.assign(new Error("CONNECT TLS timeout"), { code: "PROXY_TIMEOUT" }));
      });
      socket.on("error", (err) => {
        reject(
          Object.assign(new Error(`CONNECT TLS error: ${err.message}`), {
            code: err.code || "PROXY_CONNECT_FAILED",
            cause: err,
          })
        );
      });
      socket.on("secureConnect", () => {
        const payload =
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n") +
          `\r\n\r\n`;
        socket.write(payload);
      });

      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const splitAt = buffer.indexOf("\r\n\r\n");
        if (splitAt < 0) return;
        const head = buffer.subarray(0, splitAt).toString("utf8");
        const rest = buffer.subarray(splitAt + 4);
        const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(head);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
        const headersObj = {};
        for (const line of head.split("\r\n").slice(1)) {
          const idx = line.indexOf(":");
          if (idx > 0) headersObj[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        socket.removeAllListeners("data");
        onConnect({ statusCode, headers: headersObj }, socket, rest);
      });
    });
  }

  return attempt(false).catch((httpErr) => {
    // HTTPS proxies often fail plain HTTP with SSL/protocol errors — retry over TLS.
    if (!/SSL|EPROTO|WRONG_VERSION|ECONNRESET/i.test(`${httpErr.code || ""} ${httpErr.message || ""}`)) {
      throw httpErr;
    }
    console.warn(`[proxyFetch] ${proxy.label} plain CONNECT failed (${summarizeProxyError(httpErr)}) — retrying as HTTPS proxy`);
    return attempt(true);
  });
}

function headersToObject(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** Decode HTTP/1.1 chunked transfer body into raw bytes. */
function decodeChunkedBody(buf) {
  const chunks = [];
  let offset = 0;
  while (offset < buf.length) {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeLine = buf.subarray(offset, lineEnd).toString("utf8").split(";", 1)[0].trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw Object.assign(new Error(`Invalid chunk size: ${sizeLine}`), { code: "BAD_CHUNKED_BODY" });
    }
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size > buf.length) {
      throw Object.assign(new Error("Truncated chunked body"), { code: "TRUNCATED_CHUNKED_BODY" });
    }
    chunks.push(buf.subarray(offset, offset + size));
    offset += size + 2; // skip chunk data + trailing CRLF
  }
  return Buffer.concat(chunks);
}

function decodeHttpBody(bodyBuf, responseHeaders) {
  const encoding = String(responseHeaders["transfer-encoding"] || "").toLowerCase();
  if (encoding.includes("chunked")) {
    return decodeChunkedBody(bodyBuf);
  }
  const lengthHeader = responseHeaders["content-length"];
  if (lengthHeader != null && lengthHeader !== "") {
    const length = Number.parseInt(String(lengthHeader), 10);
    if (Number.isFinite(length) && length >= 0) {
      return bodyBuf.subarray(0, Math.min(length, bodyBuf.length));
    }
  }
  return bodyBuf;
}

/** HTTPS GET/POST through an established CONNECT socket. */
function httpsOverSocket(socket, url, options = {}) {
  const parsed = new URL(url);
  const method = (options.method || "GET").toUpperCase();
  const headers = {
    Host: parsed.host,
    Connection: "close",
    ...headersToObject(options.headers),
  };

  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      {
        socket,
        servername: parsed.hostname,
        timeout: 20000,
      },
      () => {
        const headerLines = Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n");
        const body = options.body ? String(options.body) : "";
        const contentLength = Buffer.byteLength(body);
        const payload =
          `${method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n` +
          `${headerLines}\r\n` +
          (body && !/content-length:/i.test(headerLines) ? `Content-Length: ${contentLength}\r\n` : "") +
          `\r\n` +
          body;

        secure.write(payload);
      }
    );

    let raw = Buffer.alloc(0);
    secure.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
    });
    secure.on("end", () => {
      try {
        const splitAt = raw.indexOf("\r\n\r\n");
        if (splitAt < 0) {
          reject(Object.assign(new Error("Invalid HTTP response via proxy"), { code: "BAD_UPSTREAM_RESPONSE" }));
          return;
        }
        const head = raw.subarray(0, splitAt).toString("utf8");
        const bodyBuf = raw.subarray(splitAt + 4);
        const lines = head.split("\r\n");
        const statusLine = lines[0] || "";
        const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i.exec(statusLine);
        const status = match ? Number(match[1]) : 502;
        const statusText = match ? match[2] : "";
        const responseHeaders = {};
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(":");
          if (idx < 0) continue;
          responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        const decodedBody = decodeHttpBody(bodyBuf, responseHeaders);
        resolve(
          new Response(decodedBody, {
            status,
            statusText,
            headers: responseHeaders,
          })
        );
      } catch (err) {
        reject(err);
      }
    });
    secure.on("timeout", () => {
      secure.destroy();
      reject(Object.assign(new Error("Upstream timeout via proxy"), { code: "UPSTREAM_TIMEOUT" }));
    });
    secure.on("error", (err) => {
      reject(
        Object.assign(new Error(`Upstream error via proxy: ${err.message}`), {
          code: err.code || "UPSTREAM_ERROR",
          cause: err,
        })
      );
    });
  });
}

async function fetchViaConnectProxy(proxy, url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw Object.assign(new Error("Only https URLs are supported via CONNECT proxy"), { code: "UNSUPPORTED_URL" });
  }
  const socket = await connectTunnel(proxy, parsed.hostname, 443);
  try {
    return await httpsOverSocket(socket, url, options);
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

async function fetchViaUndiciProxy(proxy, url, options = {}) {
  const token = basicAuthHeader(proxy.username, proxy.password);
  const dispatcher = token
    ? new ProxyAgent({ uri: `http://${proxy.host}:${proxy.port}`, token })
    : new ProxyAgent(proxy.url);
  try {
    return await undiciFetch(url, { ...options, dispatcher });
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

export async function proxyFetch(url, options = {}) {
  const { retryStatusCodes, ...fetchOptions } = options;
  const retryCodes = retryStatusCodes || [403, 429];
  const proxies = getProxyChain().map(parseProxy);

  console.log(
    "[proxyFetch] start",
    JSON.stringify({
      url: String(url).replace(/webKey=[^&]+/i, "webKey=***"),
      proxyCount: proxies.length,
      proxies: proxies.map((p) => `${p.label}@${p.host}:${p.port}`),
      allowDirect: process.env.ALLOW_DIRECT_FETCH === "true",
    })
  );

  if (proxies.length === 0) {
    console.warn("[proxyFetch] no proxies configured — using direct fetch");
    return globalThis.fetch(url, fetchOptions);
  }

  let lastError = null;
  const failures = [];

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const hasMore = i < proxies.length - 1;

    // Prefer manual CONNECT so 407/auth failures are readable in logs.
    try {
      console.log(`[proxyFetch] trying ${proxy.label} via CONNECT ${proxy.host}:${proxy.port}`);
      const res = await fetchViaConnectProxy(proxy, url, fetchOptions);
      const shouldRetry = hasMore && (retryCodes.includes(res.status) || res.status >= 500);
      if (shouldRetry) {
        console.warn(`[proxyFetch] ${proxy.label} returned HTTP ${res.status} — trying next proxy`);
        failures.push(`${proxy.label}: HTTP ${res.status}`);
        lastError = Object.assign(new Error(`HTTP ${res.status} via ${proxy.label}`), {
          code: res.status === 403 ? "FMCSA_FORBIDDEN" : "PROXY_HTTP_ERROR",
          status: res.status,
        });
        continue;
      }
      if (res.ok) console.log(`[proxyFetch] OK via ${proxy.label} (CONNECT)`);
      else console.warn(`[proxyFetch] ${proxy.label} final HTTP ${res.status}`);
      return res;
    } catch (connectErr) {
      const detail = summarizeProxyError(connectErr);
      console.error(`[proxyFetch] ${proxy.label} failed:`, detail);
      failures.push(`${proxy.label}: ${detail}`);
      lastError = Object.assign(new Error(`Proxy ${proxy.label} failed: ${detail}`), {
        cause: connectErr,
        code: connectErr.code || "PROXY_FETCH_FAILED",
        status: connectErr.status,
      });

      // Auth rejection won't succeed via undici either — move on.
      if (connectErr.code === "PROXY_AUTH_REQUIRED" || connectErr.status === 407) {
        continue;
      }
    }

    // Fallback: undici ProxyAgent (some providers behave differently).
    try {
      console.log(`[proxyFetch] retrying ${proxy.label} via undici ProxyAgent`);
      const res = await fetchViaUndiciProxy(proxy, url, fetchOptions);
      const shouldRetry = hasMore && (retryCodes.includes(res.status) || res.status >= 500);
      if (shouldRetry) {
        console.warn(`[proxyFetch] ${proxy.label} (undici) returned HTTP ${res.status} — trying next proxy`);
        failures.push(`${proxy.label}/undici: HTTP ${res.status}`);
        lastError = Object.assign(new Error(`HTTP ${res.status} via ${proxy.label}`), {
          code: res.status === 403 ? "FMCSA_FORBIDDEN" : "PROXY_HTTP_ERROR",
          status: res.status,
        });
        continue;
      }
      if (res.ok) console.log(`[proxyFetch] OK via ${proxy.label} (undici)`);
      return res;
    } catch (undiciErr) {
      const detail = summarizeProxyError(undiciErr);
      console.error(`[proxyFetch] ${proxy.label} undici failed:`, detail);
      failures.push(`${proxy.label}/undici: ${detail}`);
      lastError = Object.assign(new Error(`Proxy ${proxy.label} failed: ${detail}`), {
        cause: undiciErr,
        code: undiciErr.cause?.code || undiciErr.code || "PROXY_FETCH_FAILED",
      });
    }
  }

  if (process.env.ALLOW_DIRECT_FETCH === "true") {
    console.warn("[proxyFetch] all proxies failed — falling back to direct fetch");
    return globalThis.fetch(url, fetchOptions);
  }

  const summary = failures.join(" | ") || "All proxy attempts failed";
  console.error("[proxyFetch] all proxies failed:", summary);
  const authFailure = failures.find((line) => /407|PROXY_AUTH|not in your list/i.test(line));
  throw Object.assign(new Error(authFailure || lastError?.message || summary), {
    cause: lastError,
    code: authFailure ? "PROXY_AUTH_REQUIRED" : lastError?.code || "PROXY_FETCH_FAILED",
    status: authFailure ? 407 : lastError?.status,
    details: failures,
  });
}
