// Bundles the Sepolia web demo.
//   node web/build.mjs   → web/dist/{index.html, assets/app.js, assets/style.css, web/public/*, vercel.json, _headers}
// A Vercel project link in web/dist/.vercel survives rebuilds.
// Served with COOP/COEP headers (crossOriginIsolated → multi-threaded TFHE); without them the SDK falls back to a
// single thread, which also works (measured in F0.12b).
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");

// Unused WASM versions (TFHE 1.5.3) and the user-decryption library (TKMS): the SDK reaches them through dynamic
// import() calls in its version tables, but the encrypt client with TFHE 1.6.2 never calls them (public decryption
// goes through the relayer). They are replaced by a stub that rejects with an explicit error if ever called.
const stubUnused = {
  name: "stub-unused-wasm",
  setup(b) {
    b.onResolve({ filter: /^\.\/v(1\.5\.3|0\.13\.10|0\.13\.20-0)\// }, (args) => {
      const fromLoader = /loadTfheLib\.js$|loadKmsLib\.js$/.test(args.importer);
      return fromLoader ? { path: args.path, namespace: "stub" } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: `throw new Error("not bundled in the web demo: ${args.path}");`,
      loader: "js",
    }));
  },
};

const HEADERS = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

export async function build({ minify = true } = {}) {
  fs.mkdirSync(DIST, { recursive: true });
  for (const name of fs.readdirSync(DIST)) {
    if (name !== ".vercel") fs.rmSync(path.join(DIST, name), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
  await esbuild.build({
    plugins: [stubUnused],
    entryPoints: [path.join(HERE, "src", "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify,
    sourcemap: !minify,
    legalComments: "none",
    outfile: path.join(DIST, "assets", "app.js"),
    external: ["node:url"], // SDK code path that only runs under Node
    logLevel: "warning",
  });
  fs.copyFileSync(path.join(HERE, "src", "style.css"), path.join(DIST, "assets", "style.css"));
  fs.copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
  const PUBLIC = path.join(HERE, "public"); // static files served from the site root (og.png)
  if (fs.existsSync(PUBLIC)) fs.cpSync(PUBLIC, DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, "vercel.json"), JSON.stringify({ headers: [{ source: "/(.*)", headers: HEADERS }] }, null, 2) + "\n");
  fs.writeFileSync(path.join(DIST, "_headers"), "/*\n" + HEADERS.map((h) => `  ${h.key}: ${h.value}`).join("\n") + "\n");
  return fs.statSync(path.join(DIST, "assets", "app.js")).size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = await build();
  console.log(`web/dist ready · app.js ${(bytes / 1e6).toFixed(2)} MB`);
}
