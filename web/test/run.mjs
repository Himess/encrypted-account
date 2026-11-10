// Bundles web/test/pin-vectors.ts for Node and runs it.   node web/test/run.mjs
import * as esbuild from "esbuild";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "web-test-")), "pin-vectors.mjs");
await esbuild.build({ entryPoints: [path.join(HERE, "pin-vectors.ts")], bundle: true, platform: "node", format: "esm", target: ["node20"], outfile: out, logLevel: "warning" });
execFileSync(process.execPath, [out], { stdio: "inherit" });
