// Bundles the Sepolia site: a landing page (index.html, no wallet code) and the app (app.html, served at /app).
//   node web/build.mjs   → web/dist/{index.html, app.html, assets/*, web/public/*, vercel.json, _headers}
// Asset names carry a content hash, so they can be cached forever; a Vercel project link in web/dist/.vercel survives
// rebuilds. Served with COOP/COEP headers (crossOriginIsolated → multi-threaded TFHE); without them the SDK falls back
// to a single thread, which also works (measured in F0.12b).
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

// The decrypt bundle: no TFHE at all (user decryption only needs the KMS library).
const stubTfhe = {
  name: "stub-tfhe",
  setup(b) {
    b.onResolve({ filter: /^\.\/v1\.(5\.3|6\.2)\// }, (args) =>
      /loadTfheLib\.js$/.test(args.importer) ? { path: args.path, namespace: "stub" } : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: `throw new Error("not bundled in the decrypt module: ${args.path}");`,
      loader: "js",
    }));
  },
};

const ISOLATION = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];
const PAGES = ["index.html", "app.html"];

export async function build({ minify = true } = {}) {
  fs.mkdirSync(DIST, { recursive: true });
  for (const name of fs.readdirSync(DIST)) {
    if (name !== ".vercel") fs.rmSync(path.join(DIST, name), { recursive: true, force: true });
  }
  const result = await esbuild.build({
    plugins: [stubUnused],
    entryPoints: {
      landing: path.join(HERE, "src", "landing.ts"),
      app: path.join(HERE, "src", "app.tsx"),
      "landing-style": path.join(HERE, "src", "styles", "landing.css"),
      "app-style": path.join(HERE, "src", "styles", "app.css"),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022", "safari16"],
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".woff2": "file" },
    entryNames: "[name]-[hash]",
    assetNames: "fonts/[name]-[hash]",
    outdir: path.join(DIST, "assets"),
    metafile: true,
    minify,
    sourcemap: !minify,
    legalComments: "none",
    external: ["node:url"], // SDK code path that only runs under Node
    logLevel: "warning",
  });

  // entry name → hashed file, then point the pages at the hashed files
  const out = {};
  for (const [file, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue;
    const base = path.basename(file);
    const name = base.replace(/-[A-Z0-9]{8}\.(js|css)$/, "");
    out[`${name}.${path.extname(base).slice(1)}`] = `/assets/${base}`;
  }
  // User decryption (Zama's KMS client) is a separate bundle, loaded only when an heir reveals its balance. It keeps
  // the KMS library and leaves out every TFHE version (it never encrypts).
  const dec = await esbuild.build({
    plugins: [stubTfhe],
    entryPoints: { decrypt: path.join(HERE, "src", "decrypt.ts") },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022", "safari16"],
    entryNames: "[name]-[hash]",
    outdir: path.join(DIST, "assets"),
    metafile: true,
    minify,
    sourcemap: !minify,
    legalComments: "none",
    external: ["node:url"],
    logLevel: "warning",
  });
  for (const file of Object.keys(dec.metafile.outputs)) {
    if (file.endsWith(".js")) out["decrypt.js"] = `/assets/${path.basename(file)}`;
  }

  const refs = {
    "/assets/landing.js": out["landing.js"],
    "/assets/landing.css": out["landing-style.css"],
    "/assets/app.js": out["app.js"],
    "/assets/app.css": out["app-style.css"],
    "/assets/decrypt.js": out["decrypt.js"],
  };
  for (const page of PAGES) {
    let html = fs.readFileSync(path.join(HERE, page), "utf8");
    for (const [from, to] of Object.entries(refs)) {
      if (!to) throw new Error(`build: no output for ${from}`);
      html = html.split(`"${from}"`).join(`"${to}"`);
    }
    fs.writeFileSync(path.join(DIST, page), html);
  }

  const PUBLIC = path.join(HERE, "public"); // static files served from the site root (favicon, og.png)
  if (fs.existsSync(PUBLIC)) fs.cpSync(PUBLIC, DIST, { recursive: true });

  const vercel = {
    cleanUrls: true,
    trailingSlash: false,
    headers: [
      { source: "/(.*)", headers: ISOLATION },
      { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ],
  };
  fs.writeFileSync(path.join(DIST, "vercel.json"), JSON.stringify(vercel, null, 2) + "\n");
  fs.writeFileSync(path.join(DIST, "_headers"), "/*\n" + ISOLATION.map((h) => `  ${h.key}: ${h.value}`).join("\n") + "\n");

  const size = (k) => fs.statSync(path.join(DIST, out[k].slice(1))).size;
  return { app: size("app.js"), landing: size("landing.js"), decrypt: size("decrypt.js"), files: out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await build();
  console.log(`web/dist ready · app.js ${(r.app / 1e6).toFixed(2)} MB · decrypt.js ${(r.decrypt / 1e6).toFixed(2)} MB (on demand) · landing.js ${(r.landing / 1e3).toFixed(1)} kB`);
}
