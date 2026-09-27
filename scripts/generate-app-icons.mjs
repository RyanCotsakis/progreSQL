// Reuse the app's Lucide artwork; browser rendering produces opaque PNGs for iOS.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dumbbell } from "lucide-react";
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const svg = renderToStaticMarkup(
  createElement(
    "svg",
    { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 512 512" },
    createElement("rect", { width: 512, height: 512, fill: "#176b4f" }),
    createElement(Dumbbell, {
      x: 96,
      y: 96,
      width: 320,
      height: 320,
      color: "white",
      strokeWidth: 2,
    }),
  ),
);
mkdirSync("public", { recursive: true });
writeFileSync("public/favicon.svg", svg + "\n");
const browser = await chromium.launch({
  channel: process.env.PW_CHROMIUM_CHANNEL,
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [size, name] of [
    [180, "apple-touch-icon"],
    [192, "icon-192"],
    [512, "icon-512"],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    await page.screenshot({ path: `public/${name}.png` });
  }
} finally {
  await browser.close();
}
