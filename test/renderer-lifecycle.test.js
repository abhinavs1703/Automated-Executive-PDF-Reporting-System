import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions, buildHtmlReport, renderPdf } from '../src/renderer.js';
import { getReportData } from '../src/analytics.js';
import { createDatabase } from '../src/db.js';
import { inspectPdf } from './support/pdf-inspect.js';
import { probeBrowser, requireRealPdf } from './support/browser.js';
import { tempDir } from './support/helpers.js';

/*
 * Regression tests for the chart rendering lifecycle (draw at the final print layout,
 * verify, freeze to static images, then print). They use a real browser and are
 * SKIPPED (= unverified) when none is available; REQUIRE_REAL_PDF=true makes that a failure.
 */
const browser = await probeBrowser();
const skip = browser.available ? false : (requireRealPdf ? false : `UNVERIFIED - ${browser.reason}`);

function database(withOrders = true) {
  const db = createDatabase(':memory:');
  if (withOrders) {
    const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
    insert.run('Ada', 'Ultra-wide Monitor', 499, '2026-09-28T09:00:00.000Z', 'Displays');
    insert.run('Bo', 'Mechanical Keyboard', 129.99, '2026-09-29T09:00:00.000Z', 'Accessories');
    insert.run('Cy', 'Wireless Mouse', 49.99, '2026-10-01T09:00:00.000Z', 'Accessories');
    // Long names are the realistic way charts get clipped.
    insert.run('Di', 'Noise-Cancelling Headphones', 219, '2026-10-02T09:00:00.000Z', 'Audio');
    insert.run('Ed', 'Extra-Large Ergonomic Standing Desk Converter Pro', 300, '2026-10-03T09:00:00.000Z', 'Workspace');
  }
  return db;
}
const periodData = (db) => getReportData({ database: db, startDate: '2026-09-28', endDate: '2026-10-04' });

async function withPage(html, width, run) {
  const instance = await puppeteer.launch(browserLaunchOptions());
  try {
    const page = await instance.newPage();
    await page.emulateMediaType('print');
    await page.setViewport({ width, height: 1200 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__REPORT_CHARTS_READY === true);
    return await run(page);
  } finally { await instance.close(); }
}

test('freezing re-draws every chart at the CURRENT layout, not at the layout used when the page loaded', { skip }, async () => {
  const db = database();
  try {
    const html = await buildHtmlReport(periodData(db));
    await withPage(html, 1280, async (page) => {
      const drawnAtLoad = await page.evaluate(() => document.querySelector('.chart-area').clientWidth);
      assert.equal(drawnAtLoad, 611, 'sanity: the page first drew charts at the wide layout');

      await page.setViewport({ width: 703, height: 1200 }); // the print column layout
      const result = await page.evaluate(() => window.__freezeReportCharts());
      assert.equal(result.ok, true, JSON.stringify(result.status));
      assert.equal(result.images, 4);
      for (const chart of result.status) {
        assert.deepEqual(chart.problems, [], `${chart.id}: ${chart.problems.join(', ')}`);
        assert.ok(Math.abs(chart.cssWidth - 323) <= 1, `${chart.id} drawn at the print column width (got ${chart.cssWidth})`);
        assert.ok(Math.abs(chart.bitmapWidth - 2 * chart.cssWidth) <= 2, `${chart.id} rendered at 2x for print sharpness (bitmap ${chart.bitmapWidth})`);
        assert.ok(chart.painted > 1000, `${chart.id} has content`);
        assert.equal(chart.clipped, false, `${chart.id} content is clipped at a canvas edge`);
      }
    });
  } finally { db.close(); }
});

test('every product keeps its axis label even in the worst case (8 products, long names); no auto-skipping', { skip }, async () => {
  const db = createDatabase(':memory:');
  try {
    const names = ['Noise-Cancelling Headphones', 'Ultra-wide Monitor', 'USB-C Multi-Port Dock', 'Mechanical Keyboard',
      'Extra-Large Ergonomic Standing Desk Converter Pro', 'Wireless Mouse', 'Ergonomic Desk Mat', 'Premium Laptop Stand With Cooling'];
    const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
    names.forEach((name, index) => insert.run('Customer', name, 500 - index * 40, '2026-09-30T09:00:00.000Z', 'Category'));
    const data = periodData(db);
    assert.equal(data.topProducts.length, 8);
    const html = await buildHtmlReport(data);
    await withPage(html, 703, async (page) => {
      const result = await page.evaluate(() => {
        window.__renderReportCharts();
        const chart = window.Chart.getChart('productRevenueChart');
        return { shown: chart.scales.y.ticks.length };
      });
      assert.equal(result.shown, 8, `labels shown: ${result.shown} of 8`);
    });
  } finally { db.close(); }
});

test('after freezing, charts are static images: later layout changes cannot clear or redraw them', { skip }, async () => {
  const db = database();
  try {
    const html = await buildHtmlReport(periodData(db));
    await withPage(html, 703, async (page) => {
      assert.equal((await page.evaluate(() => window.__freezeReportCharts())).ok, true);
      const snapshot = () => page.evaluate(() => ({
        images: [...document.querySelectorAll('img.chart-image')].map((img) => ({ complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, len: img.src.length })),
        visibleCanvases: [...document.querySelectorAll('canvas')].filter((c) => getComputedStyle(c).display !== 'none').length,
      }));
      const before = await snapshot();
      assert.equal(before.images.length, 4);
      assert.equal(before.visibleCanvases, 0);
      assert.ok(before.images.every((img) => img.complete && img.w > 0 && img.h > 0));

      await page.setViewport({ width: 500, height: 800 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(await snapshot(), before, 'images are untouched by layout changes');
    });
  } finally { db.close(); }
});

test('a chart script error fails the render with a clear message (no silent chart-less PDF)', { skip }, async () => {
  const db = database();
  const dir = await tempDir();
  try {
    const failing = 'window.Chart = function Chart() { throw new Error("stub chart failure"); };';
    await assert.rejects(
      renderPdf(periodData(db), path.join(dir, 'broken.pdf'), { chartJsBundle: failing }),
      /Chart rendering failed: stub chart failure/,
    );
    assert.deepEqual(await fs.readdir(dir), [], 'no PDF is written when charts fail');
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('blank charts are detected before printing and reported with per-chart diagnostics', { skip }, async () => {
  const db = database();
  const dir = await tempDir();
  try {
    // A Chart implementation that sizes the canvas but never draws: the exact "blank chart" failure mode.
    const blank = `window.Chart = class { constructor(canvas) { this.canvas = canvas; this.currentDevicePixelRatio = 1;
      canvas.width = canvas.parentElement.clientWidth; canvas.height = canvas.parentElement.clientHeight; } destroy() {} };`;
    await assert.rejects(
      renderPdf(periodData(db), path.join(dir, 'blank.pdf'), { chartJsBundle: blank }),
      (error) => {
        assert.match(error.message, /Charts could not be verified before printing/);
        assert.match(error.message, /canvas is blank/);
        assert.match(error.message, /dailyRevenueChart/);
        return true;
      },
    );
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('an empty reporting period (no data for the category doughnut) still renders a valid PDF', { skip }, async () => {
  const db = database(false);
  const dir = await tempDir();
  try {
    const pdfPath = await renderPdf(periodData(db), path.join(dir, 'empty.pdf'));
    const pdf = await inspectPdf(pdfPath);
    assert.match(pdf.text, /No orders were recorded/);
    assert.ok(pdf.imageCount >= 3, `expected the trend charts to be embedded, got ${pdf.imageCount}`);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('repeated renders in one process are consistent (no state leaks between renders)', { skip }, async () => {
  const db = database();
  const dir = await tempDir();
  try {
    const data = periodData(db);
    const counts = [];
    for (let run = 0; run < 4; run += 1) {
      const pdf = await inspectPdf(await renderPdf(data, path.join(dir, `run-${run}.pdf`)));
      const charts = pdf.imageDetails.slice(0, 4);
      for (const chart of charts) {
        assert.ok(chart.width >= 630 && chart.width <= 660 && chart.height >= 470 && chart.height <= 490, `unexpected chart bitmap (expected ~2x of a 323x240 print container) ${chart.width}x${chart.height}`);
      }
      counts.push([pdf.imageCount, pdf.pages[0].images, charts.map((i) => `${i.width}x${i.height}`).join(',')].join('|'));
    }
    assert.equal(new Set(counts).size, 1, `renders differed: ${counts.join(' ; ')}`);
    assert.ok(Number(counts[0].split('|')[1]) === 4, 'all four charts are on page 1');
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
