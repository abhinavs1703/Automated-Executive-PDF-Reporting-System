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
 * REAL-BROWSER layout regression tests: currency formatting as it appears in the PDF and
 * pagination of the tables. Skipped (= unverified) without a browser; REQUIRE_REAL_PDF=true
 * turns that into a failure.
 */
const browser = await probeBrowser();
const skip = browser.available ? false : (requireRealPdf ? false : `UNVERIFIED - ${browser.reason}`);

const PERIOD = { startDate: '2026-09-28', endDate: '2026-10-04' };

/** `count` products with distinct, awkward amounts (one-decimal, whole, thousands) across the period. */
const PERIOD_DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
function databaseWithProducts(count) {
  const db = createDatabase(':memory:');
  const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
  const amounts = [2266.3, 33.9, 1500, 67.8, 949.5, 12.1, 3050.75, 480];
  for (let i = 0; i < count; i += 1) {
    insert.run(`Customer ${i}`, `Product-${String(i + 1).padStart(2, '0')} Widget`, amounts[i % amounts.length], `${PERIOD_DAYS[i % 7]}T09:00:00.000Z`, `Category ${i % 3}`);
  }
  return db;
}

async function render(db, period = PERIOD) {
  const dir = await tempDir();
  try {
    const pdfPath = await renderPdf(getReportData({ database: db, ...period }), path.join(dir, 'report.pdf'));
    return await inspectPdf(pdfPath);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const pageIndexOf = (pdf, needle) => pdf.pages.findIndex((page) => page.text.includes(needle));

test('every monetary value in the PDF has a thousands separator and exactly two decimals', { skip }, async () => {
  const db = databaseWithProducts(8);
  try {
    const pdf = await render(db);
    const text = pdf.text.replace(/\s+/g, ' ');
    const amounts = text.match(/USD [\d,]+(\.\d*)?/g);
    assert.ok(amounts.length >= 20, `found ${amounts.length} amounts`);
    for (const amount of amounts) assert.match(amount, /^USD \d{1,3}(,\d{3})*\.\d{2}$/, `badly formatted amount in PDF: ${amount}`);
    assert.match(text, /USD 3,050\.75/);
    assert.match(text, /USD 33\.90/);
    assert.match(text, /USD 12\.10/);
    assert.doesNotMatch(text, /NaN|undefined/);
  } finally { db.close(); }
});

for (const productCount of [1, 3, 6, 8]) {
  test(`Top products table is never split (${productCount} product${productCount > 1 ? 's' : ''}): title, headings and all rows share one page`, { skip }, async () => {
    const db = databaseWithProducts(productCount);
    try {
      const pdf = await render(db);
      const titlePage = pageIndexOf(pdf, 'Top products');
      assert.ok(titlePage >= 0, 'section title is present');
      const text = pdf.pages[titlePage].text.replace(/\s+/g, ' ');
      assert.match(text, /Product Category Orders Avg\. order Revenue/, 'column headings are on the same page as the title');
      for (let i = 1; i <= productCount; i += 1) {
        assert.ok(text.includes(`Product-${String(i).padStart(2, '0')} Widget`), `row ${i} is on the page that holds the title (page ${titlePage + 1})`);
      }
      // No product row may appear on any other page.
      pdf.pages.forEach((page, index) => {
        if (index !== titlePage) assert.ok(!/Product-\d\d Widget/.test(page.text), `product row leaked onto page ${index + 1}`);
      });
    } finally { db.close(); }
  });
}

test('typical report: page 1 holds header, KPIs and all four charts; page 2 holds both tables; no near-empty pages', { skip }, async () => {
  const db = databaseWithProducts(8);
  try {
    const pdf = await render(db);
    assert.equal(pdf.pageCount, 2, `expected 2 pages, got ${pdf.pageCount}`);
    assert.ok(pdf.pages[0].images >= 4, 'all four charts are on page 1');
    assert.match(pdf.pages[0].text, /Weekly Executive Business Report/);
    assert.match(pdf.pages[0].text, /Total revenue/i);
    assert.ok(!pdf.pages[0].text.includes('Top products'), 'tables are not squeezed onto page 1');

    const page2 = pdf.pages[1].text.replace(/\s+/g, ' ');
    assert.match(page2, /^\s*Top products/, 'page 2 starts with the Top products section');
    assert.match(page2, /Daily summary/);
    for (const date of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      assert.ok(page2.includes(`${date} `), `daily row ${date} is on page 2`);
    }
    assert.match(page2, /Comparison baseline/);
    assert.match(page2, /2 \/ 2/, 'page numbering is preserved');
    assert.match(pdf.pages[0].text, /1 \/ 2/);
  } finally { db.close(); }
});

test('a long custom period (31 days): the Daily summary spans pages and its column headings repeat on each', { skip }, async () => {
  const db = databaseWithProducts(8);
  const insert = db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)');
  for (let day = 1; day <= 30; day += 1) {
    insert.run('Daily', 'Product-01 Widget', 10 + day, `2026-09-${String(day).padStart(2, '0')}T09:00:00.000Z`, 'Category 0');
  }
  try {
    const pdf = await render(db, { startDate: '2026-09-01', endDate: '2026-10-01' });
    assert.ok(pdf.pageCount >= 3, `a 31-day table needs several pages, got ${pdf.pageCount}`);

    const rowsOn = (page) => (page.text.match(/ 2026-(09|10)-\d\d /g) || []).length;
    const dailyPages = pdf.pages.filter((page) => /Date \(UTC\) Orders Revenue/.test(page.text.replace(/\s+/g, ' ')) || rowsOn(page) >= 3);
    assert.ok(dailyPages.length >= 2, 'the daily table spans at least two pages');
    for (const page of pdf.pages.slice(1)) {
      if (rowsOn(page) >= 1) {
        assert.match(page.text.replace(/\s+/g, ' '), /Date \(UTC\) Orders Revenue/, `page ${page.number} has daily rows but no column headings`);
      }
    }
    // Every day appears exactly once in the table.
    const all = pdf.pages.slice(1).map((p) => p.text).join(' ');
    for (let day = 1; day <= 30; day += 1) {
      const date = `2026-09-${String(day).padStart(2, '0')}`;
      assert.equal(all.split(` ${date} `).length - 1, 1, `${date} appears once`);
    }
    // No page is left with a lone straggler row after the table breaks.
    const lastDailyPage = [...pdf.pages].reverse().find((page) => rowsOn(page) >= 1);
    assert.ok(rowsOn(lastDailyPage) >= 2, `the last page of the table has only ${rowsOn(lastDailyPage)} row(s)`);
  } finally { db.close(); }
});

test('large amounts fit inside the KPI cards without wrapping or overflow', { skip }, async () => {
  const db = createDatabase(':memory:');
  db.prepare('INSERT INTO orders (customer, product, amount, created_at, category) VALUES (?, ?, ?, ?, ?)')
    .run('Whale', 'Enterprise Licence', 12345678.9, '2026-09-30T09:00:00.000Z', 'Software');
  try {
    const html = await buildHtmlReport(getReportData({ database: db, ...PERIOD }));
    const instance = await puppeteer.launch(browserLaunchOptions());
    try {
      const page = await instance.newPage();
      await page.emulateMediaType('print');
      await page.setViewport({ width: 703, height: 1200 });
      await page.setContent(html, { waitUntil: 'load' });
      const cards = await page.evaluate(() => [...document.querySelectorAll('.kpi-value')].map((el) => ({
        text: el.textContent, fits: el.scrollWidth <= el.clientWidth, singleLine: el.getBoundingClientRect().height < 40,
      })));
      assert.equal(cards[0].text, 'USD 12,345,678.90');
      assert.equal(cards[2].text, 'USD 12,345,678.90');
      for (const card of cards) {
        assert.ok(card.fits, `"${card.text}" overflows its KPI card`);
        assert.ok(card.singleLine, `"${card.text}" wraps onto several lines`);
      }
    } finally { await instance.close(); }
  } finally { db.close(); }
});
