// Serves the already-built web bundle and proxies API/WS to the ISOLATED relay on 3031.
// Exists so the browser test needs no change to packages/web/vite.config.ts.
import http from "node:http";
import net from "node:net";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const DIST = "/Users/felipemore/Projects/ZCode-Fork/packages/web/dist";
const UP_HOST = "localhost", UP_PORT = 3031, PORT = 5180;
const PROXY_PREFIXES = ["/api", "/fork/api", "/fork/ws", "/fork/relay"];
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png",
  ".jpg":"image/jpeg", ".woff2":"font/woff2", ".woff":"font/woff", ".ttf":"font/ttf",
  ".wasm":"application/wasm", ".map":"application/json", ".ico":"image/x-icon" };
const shouldProxy = (u) => PROXY_PREFIXES.some((p) => u === p || u.startsWith(p + "/") || u.startsWith(p + "?"));

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (shouldProxy(url)) {
    const up = http.request({ host: UP_HOST, port: UP_PORT, path: url, method: req.method,
      headers: { ...req.headers, host: `${UP_HOST}:${UP_PORT}` } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(`upstream: ${e.message}`); });
    req.pipe(up);
    return;
  }
  let path = normalize(decodeURIComponent(url.split("?")[0]));
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA fallback
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});

// Raw passthrough for the relay/ws upgrade.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(UP_PORT, UP_HOST, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n") +
      "\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(PORT, () => console.log(`static+proxy on http://localhost:${PORT} -> ${UP_HOST}:${UP_PORT}`));
