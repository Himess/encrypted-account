// F0.12b — bundles the input proof measurement page.
//   node bench/proof/build.mjs   → bench/proof/dist/{index.html, coi/, plain/, assets/bench.js, vercel.json, _headers}
// /coi/  : must be served with COOP/COEP headers (crossOriginIsolated → multi-threaded TFHE)
// /plain/: no headers (the SDK falls back to a single thread)
// Headers: vercel.json (Vercel) and _headers (Netlify / Cloudflare Pages); locally, bench/proof/serve.mjs.
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });

// Unused WASM versions (TFHE 1.5.3) and the decryption library (TKMS): the SDK loads them through dynamic import()
// calls in its version tables; they are never called for the encryption client + TFHE 1.6.2. In the bundle they are
// replaced by a stub (≈ 3.8 MB); if one is called, it rejects with an explicit error.
const stubUnused = {
  name: "stub-unused-wasm",
  setup(b) {
    b.onResolve({ filter: /^\.\/v(1\.5\.3|0\.13\.10|0\.13\.20-0)\// }, (args) => {
      const fromLoader = /loadTfheLib\.js$|loadKmsLib\.js$/.test(args.importer);
      return fromLoader ? { path: args.path, namespace: "stub" } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: `throw new Error("disabled on this measurement page: ${args.path}");`,
      loader: "js",
    }));
  },
};

const result = await esbuild.build({
  plugins: [stubUnused],
  entryPoints: [path.join(HERE, "src", "bench.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  metafile: true,
  outfile: path.join(DIST, "assets", "bench.js"),
  // A code path that only runs in a real Node process (SDK wasmBaseUrl.js); it is never called in the browser.
  external: ["node:url"],
  logLevel: "warning",
});

const page = fs.readFileSync(path.join(HERE, "src", "page.html"), "utf8");
for (const v of ["coi", "plain"]) {
  fs.mkdirSync(path.join(DIST, v), { recursive: true });
  fs.writeFileSync(path.join(DIST, v, "index.html"), page);
}
// Single file (no headers): the bundle is embedded in the HTML and opened as a file on the phone (like the Argon2id
// page). In the embedded script, "</script" is escaped so it cannot break HTML parsing ("<\/" equals "</" in JS).
const SCRIPT_TAG = '<script type="module" src="../assets/bench.js"></script>';
if (!page.includes(SCRIPT_TAG)) throw new Error("script tag not found in page.html");
const bundle = fs.readFileSync(path.join(DIST, "assets", "bench.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const single = page.replace(SCRIPT_TAG, () => `<script type="module">\n${bundle}\n</script>`);
fs.writeFileSync(path.join(DIST, "proof-bench-single-file.html"), single);
console.log(`single file: proof-bench-single-file.html ${(Buffer.byteLength(single) / 1e6).toFixed(2)} MB`);
fs.writeFileSync(
  path.join(DIST, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Input proof measurement</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px}a{display:block;margin:12px 0;font-size:18px}</style></head>
<body><h1>Input proof measurement (F0.12b)</h1><p>Open both pages, measure, and give both JSON results to Claude Code.</p>
<a href="./coi/">1 · Page with COOP/COEP headers (/coi/)</a><a href="./plain/">2 · Page without headers (/plain/)</a></body></html>\n`,
);
const COI_HEADERS = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];
fs.writeFileSync(
  path.join(DIST, "vercel.json"),
  JSON.stringify({ trailingSlash: true, headers: [{ source: "/coi/(.*)", headers: COI_HEADERS }, { source: "/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] }] }, null, 2) + "\n",
);
fs.writeFileSync(path.join(DIST, "_headers"), "/coi/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n");

const bytes = fs.statSync(path.join(DIST, "assets", "bench.js")).size;
const inputs = Object.entries(result.metafile.inputs)
  .map(([p, v]) => [p, v.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6);
console.log(`bench.js ${(bytes / 1e6).toFixed(2)} MB`);
for (const [p, b] of inputs) console.log(`  ${(b / 1e6).toFixed(2)} MB  ${p}`);
