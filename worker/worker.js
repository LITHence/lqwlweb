// 领启未来 API Proxy — Cloudflare Worker
// 作用：转发浏览器请求到 07future API，解决 CORS + 注入 Cookie

const API_BASE = "https://api.07future.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-LQ-Cookie",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", service: "lqwl-proxy" });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleProxy(request, url);
    }

    return json({ error: "Not Found" }, 404);
  },
};

async function handleProxy(request, url) {
  const cookie = request.headers.get("X-LQ-Cookie");
  if (!cookie) {
    return json({ error: "Missing X-LQ-Cookie header" }, 401);
  }

  const upstream = API_BASE + url.pathname + url.search;

  const headers = new Headers();
  headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", "lingqiweilai/7.3.8 okhttp/4.12.0");

  const init = { method: request.method, headers };

  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.text();
    if (body) init.body = body;
  }

  try {
    const resp = await fetch(upstream, init);
    const setCookie = resp.headers.get("set-cookie");
    const respHeaders = new Headers(CORS_HEADERS);
    respHeaders.set("Content-Type", resp.headers.get("Content-Type") || "application/json");
    if (setCookie) respHeaders.set("X-LQ-New-Cookie", setCookie);
    return new Response(await resp.text(), { status: resp.status, headers: respHeaders });
  } catch (err) {
    return json({ error: "Upstream failed", detail: err.message }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
