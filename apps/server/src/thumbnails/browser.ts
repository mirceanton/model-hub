import { chromium, type Browser } from "playwright";

let browserPromise: Promise<Browser> | null = null;

/** Lazily launches a single warm Chromium instance, reused across thumbnail jobs. */
export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}
