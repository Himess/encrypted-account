// Local server for the web demo (127.0.0.1 only): builds web/dist, serves it with COOP/COEP headers.
//   node web/serve.mjs [port]                → plain local preview, use a browser wallet such as MetaMask
//   node web/serve.mjs [port] --devwallet    → end-to-end testing without a browser extension: injects a test
//                                              wallet whose key (SEPOLIA_UITEST_KEY in .env.sepolia, Sepolia only)
//                                              stays in this Node process; the page only sees an EIP-1193 shim.
//   … --minify                               → serve the minified production bundle instead of the debug build
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { build } from "./build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(HERE, "dist");
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8790);
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN = 11155111;

await build({ minify: process.argv.includes("--minify") });

// ── optional dev wallet (never prints the key)
let wallet = null;
let provider = null;
if (process.argv.includes("--devwallet")) {
  const envPath = path.join(ROOT, ".env.sepolia");
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (!line || line.startsWith("#") || eq <= 0) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(env.SEPOLIA_UITEST_KEY ?? "")) {
    provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: ethers.Network.from(CHAIN) });
    wallet = new ethers.NonceManager(new ethers.Wallet(env.SEPOLIA_UITEST_KEY, provider));
    console.log(`dev wallet: ${await wallet.getAddress()} (Sepolia only; the key stays in this process)`);
  } else {
    console.log("dev wallet: no SEPOLIA_UITEST_KEY in .env.sepolia — run: npx hardhat run scripts/sepolia/uitest-wallet.ts");
  }
}

const SHIM = `(() => {
  const listeners = {};
  window.ethereum = {
    isDevWallet: true,
    async request({ method, params }) {
      const r = await fetch("/__dev/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: params || [] }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; if (j.error.data) e.data = j.error.data; throw e; }
      return j.result;
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener() {},
  };
  console.log("[dev wallet] injected");
})();`;

async function devRpc(method, params) {
  const addr = await wallet.getAddress();
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [addr];
    case "eth_chainId":
      return "0xaa36a7";
    case "net_version":
      return String(CHAIN);
    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain":
      return null;
    case "eth_sendTransaction": {
      const t = params[0] ?? {};
      const big = (v) => (v === undefined || v === null ? undefined : BigInt(v));
      try {
        const resp = await wallet.sendTransaction({
          to: t.to,
          data: t.data,
          value: big(t.value) ?? 0n,
          gasLimit: big(t.gas ?? t.gasLimit),
          maxFeePerGas: big(t.maxFeePerGas),
          maxPriorityFeePerGas: big(t.maxPriorityFeePerGas),
          type: 2,
          chainId: CHAIN,
        });
        console.log(`  dev wallet sent ${resp.hash}`);
        return resp.hash;
      } catch (e) {
        wallet.reset();
        throw e;
      }
    }
    case "eth_signTypedData_v4": {
      const td = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const types = { ...td.types };
      delete types.EIP712Domain;
      return await wallet.signer.signTypedData(td.domain, types, td.message);
    }
    case "personal_sign":
      return await wallet.signer.signMessage(ethers.getBytes(params[0]));
    default:
      return await provider.send(method, params);
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  try {
    if (wallet && url.pathname === "/__dev/shim.js") {
      res.writeHead(200, { ...head, "Content-Type": TYPES[".js"] });
      return res.end(SHIM);
    }
    if (wallet && url.pathname === "/__dev/rpc" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { method, params } = JSON.parse(body);
      let out;
      try {
        out = { result: await devRpc(method, params) };
      } catch (e) {
        out = { error: { code: e?.code === "ACTION_REJECTED" ? 4001 : -32000, message: String(e?.shortMessage ?? e?.message ?? e).slice(0, 500), data: e?.data ?? e?.info?.error?.data } };
      }
      res.writeHead(200, { ...head, "Content-Type": "application/json" });
      return res.end(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    // clean URLs like Vercel: / → index.html, /app → app.html
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!path.extname(p) && fs.existsSync(path.join(DIST, `${p.replace(/^\/+/, "")}.html`))) p = `${p}.html`;
    const file = path.join(DIST, path.normalize(p).replace(/^([/\\])+/, ""));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, head);
      return res.end("not found");
    }
    let data = fs.readFileSync(file);
    if (wallet && p === "/app.html") {
      data = Buffer.from(String(data).replace("</head>", '<script src="/__dev/shim.js"></script>\n</head>'));
    }
    res.writeHead(200, { ...head, "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(500, head);
    res.end(String(e?.message ?? e));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`web demo: http://localhost:${PORT}/${wallet ? "  (dev wallet on)" : ""}`));
