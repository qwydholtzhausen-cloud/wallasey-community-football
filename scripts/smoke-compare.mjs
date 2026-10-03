// Compares two smoke-test runs screen by screen: the full text of each
// screen, and how many pixels of each screenshot differ.
//   node scripts/smoke-compare.mjs <before-dir> <after-dir>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const [a, b] = process.argv.slice(2);
const names = readdirSync(a).filter((f) => f.endsWith(".png") && !f.startsWith("FAILED"));
const browser = await chromium.launch();
const page = await browser.newPage();
let changed = 0;
for (const png of names) {
  const txt = png.replace(/\.png$/, ".txt");
  if (!existsSync(`${b}/${png}`)) { console.log(`MISSING  ${png}`); changed++; continue; }
  const ta = existsSync(`${a}/${txt}`) ? readFileSync(`${a}/${txt}`, "utf8") : "";
  const tb = existsSync(`${b}/${txt}`) ? readFileSync(`${b}/${txt}`, "utf8") : "";
  const la = ta.split("\n"), lb = tb.split("\n");
  const textDiff = la.filter((l, i) => l !== lb[i]).length + Math.abs(la.length - lb.length);
  const pct = await page.evaluate(async ([x, y]) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [i1, i2] = await Promise.all([load(x), load(y)]);
    const c = document.createElement("canvas"); c.width = i1.width; c.height = i1.height;
    const g = c.getContext("2d");
    g.drawImage(i1, 0, 0); const d1 = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height); g.drawImage(i2, 0, 0); const d2 = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let k = 0; k < d1.length; k += 4) if (Math.abs(d1[k] - d2[k]) + Math.abs(d1[k + 1] - d2[k + 1]) + Math.abs(d1[k + 2] - d2[k + 2]) > 30) n++;
    return (100 * n) / (d1.length / 4);
  }, [`data:image/png;base64,${readFileSync(`${a}/${png}`).toString("base64")}`, `data:image/png;base64,${readFileSync(`${b}/${png}`).toString("base64")}`]);
  const same = textDiff === 0 && pct < 0.5;
  if (!same) changed++;
  console.log(`${same ? "SAME   " : "CHANGED"}  ${png.replace(".png", "")}  text lines changed: ${textDiff}, pixels changed: ${pct.toFixed(2)}%`);
  if (textDiff) la.forEach((l, i) => { if (l !== lb[i]) console.log(`           - ${l.slice(0, 90)}\n           + ${(lb[i] ?? "").slice(0, 90)}`); });
}
await browser.close();
console.log(`\n${names.length - changed}/${names.length} screens the same.`);
