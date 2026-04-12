// exaroton Cloudflare Worker
// Supports session auth plus transparent proxying for JSON, text, and binary file responses.

const EXAROTON_BASE = "https://api.exaroton.com/v1";
const SESSION_TTL = 60 * 60 * 8;

// Fallbacks for local editing/testing. In production, prefer Worker secrets/vars.
const FALLBACK_EXAROTON_TOKEN =
  "6gGA6EU7HBoLOhgl8DEOwXPLaKza9GCNRDJP0lXY87P6e0bJnOXhtG42GBJvXBbw9Md1l74MH5tWzy3o2XHCfvuPng11AeRQrIJZ";
const FALLBACK_PASSWORD_HASH = "20072007den";
const FALLBACK_SESSION_SECRET = "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-Token, Content-Disposition",
  "Access-Control-Expose-Headers":
    "Content-Type, Content-Length, Content-Disposition, X-Proxy-Target",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function getConfig(env) {
  const exarotonToken = env.EXAROTON_TOKEN || FALLBACK_EXAROTON_TOKEN;
  const passwordHash = env.PASSWORD_HASH || FALLBACK_PASSWORD_HASH;
  const sessionSecret =
    env.SESSION_SECRET || FALLBACK_SESSION_SECRET || exarotonToken + passwordHash;

  return { exarotonToken, passwordHash, sessionSecret };
}

async function signToken(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createSession(secret) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = `expires:${expires}`;
  const signature = await signToken(payload, secret);
  return `${expires}.${signature}`;
}

async function verifySession(token, secret) {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [expiresRaw, signature] = parts;
  const expires = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expires)) return false;
  if (Math.floor(Date.now() / 1000) > expires) return false;

  const expected = await signToken(`expires:${expires}`, secret);
  return expected === signature;
}

async function sha256Hex(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function copyProxyResponseHeaders(sourceHeaders) {
  const headers = new Headers(CORS_HEADERS);
  const passthroughNames = [
    "content-type",
    "content-length",
    "content-disposition",
    "cache-control",
    "etag",
    "last-modified",
    "content-encoding",
  ];

  for (const name of passthroughNames) {
    const value = sourceHeaders.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}

function buildUpstreamHeaders(request, token) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);

  const forwardNames = ["accept", "content-type", "if-match", "if-none-match", "range"];
  for (const name of forwardNames) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (!headers.has("accept")) {
    headers.set("Accept", "*/*");
  }

  return headers;
}

function upstreamUrlFromRequest(requestUrl, path) {
  const apiPath = path.replace(/^\/proxy/, "");
  return `${EXAROTON_BASE}${apiPath}${requestUrl.search}`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { exarotonToken, passwordHash, sessionSecret } = getConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return jsonResponse({
        success: true,
        message: "exaroton worker is active",
        proxy: "/proxy/*",
      });
    }

    if (path === "/auth" && request.method === "POST") {
      try {
        const body = await request.json();
        const password = `${body?.password || ""}`;
        const inputHash = await sha256Hex(password);

        if (password === passwordHash || inputHash === passwordHash) {
          const token = await createSession(sessionSecret);
          return jsonResponse({ success: true, token });
        }

        return jsonResponse({ success: false, error: "Неверный пароль" }, 401);
      } catch {
        return jsonResponse({ success: false, error: "Bad Request" }, 400);
      }
    }

    if (path === "/verify" && request.method === "GET") {
      const token = request.headers.get("X-Session-Token");
      const valid = await verifySession(token, sessionSecret);
      return jsonResponse({ success: valid });
    }

    if (!path.startsWith("/proxy/")) {
      return jsonResponse({ success: false, error: "Not Found" }, 404);
    }

    const sessionToken = request.headers.get("X-Session-Token");
    if (!(await verifySession(sessionToken, sessionSecret))) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const targetUrl = upstreamUrlFromRequest(url, path);
    const upstreamHeaders = buildUpstreamHeaders(request, exarotonToken);
    const requestInit = {
      method: request.method,
      headers: upstreamHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
      redirect: "follow",
    };

    try {
      const upstreamResponse = await fetch(targetUrl, requestInit);
      const responseHeaders = copyProxyResponseHeaders(upstreamResponse.headers);
      responseHeaders.set("X-Proxy-Target", targetUrl);

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: `Proxy Error: ${error instanceof Error ? error.message : String(error)}`,
        },
        502
      );
    }
  },
};
