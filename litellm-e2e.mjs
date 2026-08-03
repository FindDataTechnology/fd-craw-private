import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => console.log("[browser console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[browser pageerror]", e.message.slice(0, 300)));

await page.goto("http://localhost:3000/litellm", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const url = page.url();
const html = await page.content();
console.log("=== RESULT ===");
console.log("URL:", url);
console.log("has litellm-page:", html.includes('data-testid="litellm-page"'));
console.log("has litellm-iframe:", html.includes("litellm-iframe"));
console.log("has litellm-disabled:", html.includes("litellm-disabled"));
console.log("has openconnector-page:", html.includes("openconnector-page"));
console.log("has chat composer:", html.includes("composer"));
const main = await page.evaluate(() => {
  const m = document.querySelector("main");
  return m ? `${m.getAttribute("data-testid")} :: ${m.outerHTML.slice(0, 250)}` : "no <main>";
});
console.log("first <main>:", main);
const activeNav = await page.evaluate(() => {
  const a = document.querySelector('nav a[class*="bg-primary"]') || document.querySelector('nav a[aria-current]');
  return a ? a.getAttribute("data-testid") + " -> " + a.getAttribute("href") : "none";
});
console.log("active nav:", activeNav);
await page.screenshot({ path: "/tmp/litellm-e2e.png" });
console.log("screenshot: /tmp/litellm-e2e.png");
await browser.close();
