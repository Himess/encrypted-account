// F0.12b local server: serves bench/proof/dist; /coi/ with COOP/COEP headers, /plain/ without headers.
//   node bench/proof/serve.mjs [port]   (default 8787; listens on 0.0.0.0)
// localhost is a secure context; opening the page from a phone via the LAN address needs the browser's "treat as secure" setting.
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const SAVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "results", "proof-bench");
const PORT = Number(process.argv[2] ?? 8787);

/** POST /save: stores the measurement JSON as results/proof-bench/<variant>-<time>.json (only on this local server). */
function save(req, res) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 2_000_000) req.destroy();
  });
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      if (j.schema !== "encrypted-account/proof-bench/v1") throw new Error("unexpected schema");
      fs.mkdirSync(SAVE_DIR, { recursive: true });
      const name = `${j.variant === "coi" ? "coi" : "plain"}-${String(j.startedAtUtc ?? Date.now()).replace(/[:.]/g, "-")}.json`;
      fs.writeFileSync(path.join(SAVE_DIR, name), JSON.stringify(j, null, 2));
      console.log(`saved: results/proof-bench/${name}`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ saved: name }));
    } catch (e) {
      res.writeHead(400).end(String(e?.message ?? e));
    }
  });
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/save") return save(req, res);
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (p.includes("..")) return res.writeHead(400).end();
    let file = path.join(DIST, p);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith("/")) return res.writeHead(301, { Location: url.pathname + "/" }).end();
      file = path.join(file, "index.html");
    }
    if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
    const headers = { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" };
    if (url.pathname.startsWith("/coi/")) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "0.0.0.0", () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    console.log(`ready: http://localhost:${PORT}/  (LAN: ${lan.map((a) => `http://${a}:${PORT}/`).join(", ") || "none"})`);
  });
