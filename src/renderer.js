import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import { config } from './config.js';
import { formatMoney, formatPercentChange } from './format.js';

// Assets are located relative to this module / the installed package, never the
// process working directory. chart.js does not export its package.json, so we
// resolve its main entry (dist/chart.cjs) and read the sibling UMD bundle.
const templatePathDefault = config.templatePath;
const chartBundlePathDefault = path.join(path.dirname(createRequire(import.meta.url).resolve('chart.js')), 'chart.umd.js');
const safeJson = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
})[character]);

const DAILY_KEEP_TOGETHER_MAX_ROWS = 14;

export async function buildHtmlReport(reportData, { templatePath = templatePathDefault, chartBundlePath = chartBundlePathDefault, chartJsBundle } = {}) {
  const [templateSource, chartBundle] = await Promise.all([
    fs.readFile(templatePath, 'utf8'),
    chartJsBundle === undefined ? fs.readFile(chartBundlePath, 'utf8') : Promise.resolve(chartJsBundle),
  ]);
  // An isolated Handlebars instance, so the currency-bound helper never leaks globally.
  const handlebars = Handlebars.create();
  const { currency } = reportData.metadata;
  handlebars.registerHelper('money', (value) => formatMoney(value, currency));
  const template = handlebars.compile(templateSource, { strict: true });
  const chartData = {
    dailyLabels: reportData.dailyTrend.map((item) => item.date),
    dailyRevenue: reportData.dailyTrend.map((item) => item.revenue),
    dailyOrders: reportData.dailyTrend.map((item) => item.totalOrders),
    productLabels: reportData.topProducts.map((item) => item.product),
    productRevenue: reportData.topProducts.map((item) => item.revenue),
    categoryLabels: reportData.categoryRevenue.map((item) => item.category),
    categoryRevenue: reportData.categoryRevenue.map((item) => item.revenue),
  };

  const revenueChange = formatPercentChange(reportData.summary.revenueChangePercent, 'N/A (no previous-period revenue)');
  const ordersChange = formatPercentChange(reportData.summary.ordersChangePercent, 'N/A (no previous-period orders)');

  return template({
    ...reportData,
    chartJsBundle: chartBundle,
    chartDataJson: safeJson(chartData),
    currencyJson: safeJson(reportData.metadata.currency),
    generatedDisplay: new Date(reportData.metadata.generatedAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC',
    revenueChangeLabel: revenueChange.label,
    revenueChangeClass: `delta-${revenueChange.direction}`,
    ordersChangeLabel: ordersChange.label,
    ordersChangeClass: `delta-${ordersChange.direction}`,
    // Short daily tables stay together on one page; long custom periods may span pages
    // (column headings repeat on each page).
    dailySectionClass: reportData.dailyTrend.length <= DAILY_KEEP_TOGETHER_MAX_ROWS ? 'keep-together' : 'allow-split',
  });
}

const BROWSER_HELP = [
  'Could not start a Chrome/Chromium browser for PDF rendering.',
  'Install the browser Puppeteer expects:  npx puppeteer browsers install chrome',
  'or point to an existing Chrome/Chromium with PUPPETEER_EXECUTABLE_PATH=/path/to/chrome.',
  'On Linux containers / running as root also set PUPPETEER_NO_SANDBOX=true.',
].join(' ');

export function browserLaunchOptions() {
  const options = { headless: true, args: [] };
  if (config.puppeteerNoSandbox) options.args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (config.chromeExecutablePath) options.executablePath = config.chromeExecutablePath;
  return options;
}

// The print layout (A4 minus the 12 mm side margins from `@page`) in CSS pixels.
// The page is laid out at exactly this width BEFORE the charts are drawn, so the
// charts are rasterised at the size they will be printed at (the old 1280 px screen
// layout drew 611 px canvases that were then squeezed into 323 px print columns).
const PRINT_CONTENT_WIDTH_PX = Math.floor(((210 - 2 * 12) / 25.4) * 96);
const CHART_SETTLE_ATTEMPTS = 3;

const nextFrames = (page, count = 2) => page.evaluate((frames) => new Promise((resolve) => {
  const step = (remaining) => (remaining === 0 ? resolve() : requestAnimationFrame(() => step(remaining - 1)));
  step(frames);
}), count);

function diagnostics({ browserErrors, chartStatus }) {
  const parts = [];
  if (chartStatus) parts.push(`Chart status: ${JSON.stringify(chartStatus)}`);
  if (browserErrors.length) parts.push(`Browser errors: ${browserErrors.join(' | ')}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Render the report to a PDF with a deterministic chart lifecycle:
 *  1. emulate print media and set the print-width viewport BEFORE any chart exists;
 *  2. wait for fonts and for the page's own chart script;
 *  3. redraw every chart at the final layout, verify each one (sized to its container,
 *     not blank) and snapshot it to a static PNG in a single synchronous task;
 *  4. only then call page.pdf().
 * Any browser error or unverified chart fails the render with diagnostics instead of
 * silently producing a PDF with missing or distorted charts.
 */
export async function renderPdf(reportData, outputPath, options = {}) {
  const absoluteOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  const html = await buildHtmlReport(reportData, options);
  const chartTimeoutMs = options.chartTimeoutMs ?? config.pdfChartTimeoutMs;
  let browser;

  try {
    try {
      browser = await puppeteer.launch(browserLaunchOptions());
    } catch (error) {
      throw new Error(`${BROWSER_HELP} (${error.message.split('\n')[0]})`);
    }
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('error', (error) => browserErrors.push(`page crashed: ${error.message}`));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) browserErrors.push(`console.${message.type()}: ${message.text()}`);
    });
    // The report is fully self-contained; block any network request so a missing
    // local asset can never silently depend on the internet.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().startsWith('data:') || request.url() === 'about:blank') return request.continue();
      browserErrors.push(`blocked external request: ${request.url().slice(0, 120)}`);
      return request.abort();
    });

    // 1. Final (print) layout first, charts second.
    await page.emulateMediaType('print');
    await page.setViewport({ width: PRINT_CONTENT_WIDTH_PX, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });

    // 2. Fonts and the page's own chart script.
    await page.evaluate(() => document.fonts.ready.then(() => true));
    try {
      await page.waitForFunction(() => window.__REPORT_CHARTS_READY === true || Boolean(window.__REPORT_CHARTS_ERROR), { timeout: chartTimeoutMs });
    } catch {
      throw new Error(`Charts did not finish initialising within ${chartTimeoutMs} ms.${diagnostics({ browserErrors })}`);
    }
    const chartError = await page.evaluate(() => window.__REPORT_CHARTS_ERROR || null);
    if (chartError) throw new Error(`Chart rendering failed: ${chartError}.${diagnostics({ browserErrors })}`);

    // 3. Redraw at the final layout, verify, and freeze to static images.
    let frozen;
    for (let attempt = 1; attempt <= CHART_SETTLE_ATTEMPTS; attempt += 1) {
      await nextFrames(page);
      frozen = await page.evaluate(() => window.__freezeReportCharts());
      if (frozen.ok) break;
    }
    if (!frozen?.ok) {
      throw new Error(`Charts could not be verified before printing (${CHART_SETTLE_ATTEMPTS} attempts).${diagnostics({ browserErrors, chartStatus: frozen?.status })}`);
    }
    const clipped = frozen.status.filter((entry) => entry.clipped).map((entry) => entry.id);
    if (clipped.length) console.warn(`[Renderer] Chart content touches the edge and may be clipped: ${clipped.join(', ')}`);
    if (browserErrors.some((entry) => entry.startsWith('pageerror') || entry.startsWith('page crashed'))) {
      throw new Error(`The page reported errors while rendering.${diagnostics({ browserErrors, chartStatus: frozen.status })}`);
    }
    await nextFrames(page);

    // 4. Print.
    await page.pdf({
      path: absoluteOutputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%;font-size:8px;color:#64748b;padding:0 12mm;text-align:right;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' },
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const stat = await fs.stat(absoluteOutputPath);
  if (stat.size < 1000) throw new Error(`Generated PDF is unexpectedly small (${stat.size} bytes).`);
  const header = (await fs.readFile(absoluteOutputPath)).subarray(0, 5).toString('ascii');
  if (header !== '%PDF-') throw new Error('Generated file is not a valid PDF.');
  return absoluteOutputPath;
}
