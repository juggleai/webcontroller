import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.CONTROLWEB_HOST?.trim() || "127.0.0.1";
const requestedPort = Number(process.env.CONTROLWEB_PORT || 4177);
const port = Number.isSafeInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
  ? requestedPort
  : 4177;

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/sse.js", ["sse.js", "text/javascript; charset=utf-8"]],
  ["/remote-session-state.js", ["remote-session-state.js", "text/javascript; charset=utf-8"]],
  ["/remote-session-stream.js", ["remote-session-stream.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createControlWebServer() {
  return createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }

    const asset = files.get(pathname);
    if (!asset) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    try {
      const body = await readFile(path.join(root, asset[0]));
      response.writeHead(200, {
        "content-type": asset[1],
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src https: http://127.0.0.1:* http://localhost:*",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'self'",
        ].join("; "),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Failed to load page");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createControlWebServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`JuggleWork Desktop control diagnostics: http://${host}:${actualPort}`);
  });
}
