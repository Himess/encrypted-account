// Renders web/og/og.html to web/public/og.png (1200×630, the link-preview image) with a local headless Chrome.
//   node web/og/render.mjs            (set CHROME=/path/to/chrome if it is not found)
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "public", "og.png");

const candidates = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = candidates.find((p) => fs.existsSync(p));
if (!chrome) throw new Error("Chrome not found; set CHROME=/path/to/chrome");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "og-chrome-"));
try {
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      "--window-size=1200,630",
      "--virtual-time-budget=3000",
      `--user-data-dir=${profile}`,
      `--screenshot=${OUT}`,
      pathToFileURL(path.join(HERE, "og.html")).href,
    ],
    { stdio: "ignore" },
  );
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
const png = fs.readFileSync(OUT);
console.log(`web/public/og.png · ${png.readUInt32BE(16)}×${png.readUInt32BE(20)} · ${(png.length / 1024).toFixed(0)} KB`);
