// F0.12 — embeds hash-wasm (argon2 + sha256 UMD builds) and the Argon2id test vectors into the bench/argon2id.page.html template.
//   node bench/build.mjs
// Outputs:
//   bench/argon2id.html                 single file that needs no network (full HTML document; opens on a phone or desktop)
//   bench/dist/argon2id.artifact.html   the same page as a claude.ai Artifact body (the skeleton is added at publish time)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const safe = (js) => js.replace(/<\/script/gi, "<\\/script");

const page = read("bench/argon2id.page.html");
const argon = safe(read("node_modules/hash-wasm/dist/argon2.umd.min.js"));
const sha = safe(read("node_modules/hash-wasm/dist/sha256.umd.min.js"));
const vectors = JSON.parse(read("sdk/test-vectors/argon2id-v1.json"));
const hwVersion = JSON.parse(read("node_modules/hash-wasm/package.json")).version;
if (hwVersion !== "4.13.0") throw new Error(`hash-wasm version is not the expected 4.13.0: ${hwVersion}`);

const body = page
  .replace("/*__HASHWASM_ARGON2__*/", () => argon)
  .replace("/*__HASHWASM_SHA256__*/", () => sha)
  .replace("/*__VECTORS__*/ null", () => JSON.stringify({ kdf: vectors.kdf, referenceKAT: vectors.referenceKAT, vectors: vectors.vectors }));
for (const ph of ["__HASHWASM_ARGON2__", "__HASHWASM_SHA256__", "__VECTORS__"]) {
  if (body.includes(ph)) throw new Error(`placeholder left over: ${ph}`);
}

// Full document: everything before <div class="wrap"> (title/meta/style) goes into head, the rest into body.
const cut = body.indexOf('<div class="wrap">');
const head = body.slice(0, cut);
const rest = body.slice(cut);
const full =
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
  `<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>\n` +
  head +
  `</head>\n<body>\n` +
  rest +
  `\n</body>\n</html>\n`;

mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "argon2id.html"), full);
writeFileSync(join(here, "dist", "argon2id.artifact.html"), body);
const sha256 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
console.log(`bench/argon2id.html                ${full.length} bytes  sha256:${sha256(full)}`);
console.log(`bench/dist/argon2id.artifact.html  ${body.length} bytes  sha256:${sha256(body)}`);
