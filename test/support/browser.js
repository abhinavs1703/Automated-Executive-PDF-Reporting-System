import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../src/renderer.js';

/**
 * Probe whether a real Chrome/Chromium can be launched with the project's
 * configuration. Returns { available: true } or { available: false, reason }.
 * When REQUIRE_REAL_PDF=true the real-rendering tests FAIL instead of skipping,
 * so CI can never silently pass without exercising the browser.
 */
export async function probeBrowser() {
  let browser;
  try {
    browser = await puppeteer.launch(browserLaunchOptions());
    return { available: true };
  } catch (error) {
    return { available: false, reason: `No usable Chrome/Chromium (${error.message.split('\n')[0]})` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export const requireRealPdf = process.env.REQUIRE_REAL_PDF === 'true';
