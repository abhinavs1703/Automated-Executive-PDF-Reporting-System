import fs from 'node:fs/promises';

/**
 * Parse a PDF with pdf.js (pure JavaScript, no system tools) and return its
 * page count, extracted text, and the embedded raster images per page
 * (Chart.js charts end up as images in Chromium's PDF output).
 *
 * For every image we also report its pixel size and how many pixels are
 * non-transparent ("opaque"), so tests can tell a drawn chart from a blank one.
 */
export async function inspectPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const pages = [];
  try {
    for (let number = 1; number <= pageCount; number += 1) {
      const page = await doc.getPage(number);
      const text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
      const ops = await page.getOperatorList();
      const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
      const images = ops.fnArray.filter((fn) => imageOps.has(fn)).length;

      const details = [];
      for (let index = 0; index < ops.fnArray.length; index += 1) {
        if (ops.fnArray[index] !== pdfjs.OPS.paintImageXObject) continue;
        const image = await new Promise((resolve) => page.objs.get(ops.argsArray[index][0], resolve));
        const channels = image.kind === 3 ? 4 : image.kind === 2 ? 3 : 1;
        let opaque = 0;
        for (let i = 0; i < image.data.length; i += channels) {
          if (channels !== 4 || image.data[i + 3] !== 0) opaque += 1;
        }
        details.push({ width: image.width, height: image.height, opaque, opaqueRatio: opaque / (image.width * image.height) });
      }
      const [x0, y0, x1, y1] = page.view;
      pages.push({ number, text, images, imageDetails: details, width: x1 - x0, height: y1 - y0 });
    }
  } finally {
    await loadingTask.destroy();
  }
  return {
    pageCount,
    pages,
    text: pages.map((p) => p.text).join('\n'),
    imageCount: pages.reduce((n, p) => n + p.images, 0),
    imageDetails: pages.flatMap((p) => p.imageDetails),
  };
}
