/* Writing markups back into the PDF with pdf-lib.

   Two things happen on every save:
     - markups are drawn into the page content, so any viewer shows them
     - the markup model is embedded in the document catalog, so re-opening the
       file in Redline PDF gives you fully editable markups again
*/
'use strict';

(function (RP) {

  const MARKUP_KEY = 'RedlineMarkup';

  function lib() {
    if (!window.PDFLib) throw new Error('pdf-lib failed to load');
    return window.PDFLib;
  }

  function colorOf(hex) {
    const { r, g, b } = RP.hexToRgbUnit(hex || '#ff2f2f');
    return lib().rgb(r, g, b);
  }

  // -------------------------------------------------------------------------
  // Embedded markup model
  // -------------------------------------------------------------------------

  function embedMarkup(pdfDoc, payload) {
    const { PDFName, PDFHexString } = lib();
    pdfDoc.catalog.set(PDFName.of(MARKUP_KEY), PDFHexString.fromText(JSON.stringify(payload)));
  }

  function readMarkupFromDoc(pdfDoc) {
    try {
      const { PDFName } = lib();
      const value = pdfDoc.catalog.get(PDFName.of(MARKUP_KEY));
      if (!value || typeof value.decodeText !== 'function') return null;
      return JSON.parse(value.decodeText());
    } catch (err) {
      return null;
    }
  }

  /** Current /Contents refs of a page, as strings, in order. */
  function contentRefsOf(page) {
    const { PDFName, PDFArray } = lib();
    const contents = page.node.get(PDFName.of('Contents'));
    if (!contents) return [];
    if (contents instanceof PDFArray) return contents.asArray().map((ref) => ref.toString());
    return [contents.toString()];
  }

  function annotRefsOf(page) {
    const { PDFName, PDFArray } = lib();
    const annots = page.node.get(PDFName.of('Annots'));
    if (!annots) return [];
    if (annots instanceof PDFArray) return annots.asArray().map((ref) => ref.toString());
    return [annots.toString()];
  }

  /**
   * Remove content streams and annotations that a previous Redline save added,
   * so re-saving an already-marked-up file never double-stamps the markups.
   */
  function stripPreviousMarkup(pdfDoc, pages, previous) {
    if (!previous) return;
    const { PDFName, PDFArray } = lib();

    const dropFrom = (page, key, doomed) => {
      if (!doomed || !doomed.length) return;
      const doomedSet = new Set(doomed);
      const value = page.node.get(PDFName.of(key));
      if (!value) return;
      if (value instanceof PDFArray) {
        const keep = value.asArray().filter((ref) => !doomedSet.has(ref.toString()));
        page.node.set(PDFName.of(key), pdfDoc.context.obj(keep));
      } else if (doomedSet.has(value.toString())) {
        page.node.set(PDFName.of(key), pdfDoc.context.obj([]));
      }
    };

    pages.forEach((page, index) => {
      dropFrom(page, 'Contents', (previous.contentRefs || {})[index]);
      dropFrom(page, 'Annots', (previous.annotRefs || {})[index]);
    });
  }

  /**
   * Bytes with everything a previous Redline save stamped taken back out, and
   * the embedded model dropped from the catalog.
   *
   * The page manager rebuilds the document by copying pages, and a copied page
   * carries its baked-in markup content with it — which the next save would
   * stamp on top of. Rebuilding from these bytes instead keeps that from
   * happening. Returns the input untouched when there is nothing to strip.
   */
  async function stripToBaseBytes(bytes) {
    const { PDFDocument, PDFName } = lib();
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const previous = readMarkupFromDoc(pdfDoc);
    if (!previous) return bytes;
    stripPreviousMarkup(pdfDoc, pdfDoc.getPages(), previous);
    pdfDoc.catalog.delete(PDFName.of(MARKUP_KEY));
    return pdfDoc.save({ useObjectStreams: false });
  }

  async function readEmbeddedMarkup(bytes) {
    try {
      const { PDFDocument, PDFName } = lib();
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const value = pdfDoc.catalog.get(PDFName.of(MARKUP_KEY));
      if (!value) return null;
      const text = typeof value.decodeText === 'function' ? value.decodeText() : String(value);
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.annotations)) return null;
      return parsed;
    } catch (err) {
      console.warn('No re-editable markup found in this PDF', err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Geometry helpers for pdf-lib drawing
  // -------------------------------------------------------------------------

  /** Revision-cloud outline as an SVG path in a y-down local space. */
  function cloudPath(w, h, radius) {
    const r = Math.max(5, radius);
    const stepsX = Math.max(1, Math.round(w / (r * 1.8)));
    const stepsY = Math.max(1, Math.round(h / (r * 1.8)));
    const dx = w / stepsX;
    const dy = h / stepsY;
    const pts = [];
    for (let i = 0; i < stepsX; i += 1) pts.push([i * dx + dx / 2, 0]);
    for (let i = 0; i < stepsY; i += 1) pts.push([w, i * dy + dy / 2]);
    for (let i = stepsX - 1; i >= 0; i -= 1) pts.push([i * dx + dx / 2, h]);
    for (let i = stepsY - 1; i >= 0; i -= 1) pts.push([0, i * dy + dy / 2]);

    const bulge = Math.max(dx, dy) * 0.31;
    let path = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const midX = (a[0] + b[0]) / 2;
      const midY = (a[1] + b[1]) / 2;
      const nx = -(b[1] - a[1]);
      const ny = (b[0] - a[0]);
      const len = Math.hypot(nx, ny) || 1;
      const cx = midX + (nx / len) * bulge;
      const cy = midY + (ny / len) * bulge;
      path += ` Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
    }
    return path + ' Z';
  }

  function drawArrowHead(page, from, to, color, width) {
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const len = Math.max(7, width * 3.6);
    const spread = 0.42;
    for (const sign of [-1, 1]) {
      page.drawLine({
        start: { x: to[0], y: to[1] },
        end: {
          x: to[0] - len * Math.cos(angle + sign * spread),
          y: to[1] - len * Math.sin(angle + sign * spread)
        },
        thickness: width,
        color
      });
    }
  }

  // -------------------------------------------------------------------------
  // Main export
  // -------------------------------------------------------------------------

  // The screen's font stacks, mapped onto the standard 14 fonts every PDF
  // reader already has. Nothing here is embedded as a file, so a stamped sheet
  // stays small and opens the same everywhere.
  const STANDARD_FONTS = {
    'sans:regular': 'Helvetica', 'sans:bold': 'HelveticaBold',
    'serif:regular': 'TimesRoman', 'serif:bold': 'TimesRomanBold',
    'mono:regular': 'Courier', 'mono:bold': 'CourierBold'
  };

  function fontKeyOf(annot) {
    const family = (annot && annot.fontFamily) || 'sans';
    return (STANDARD_FONTS[family + ':regular'] ? family : 'sans') + (annot && annot.bold ? ':bold' : ':regular');
  }

  async function buildPdf(opts) {
    const options = opts || {};
    const { PDFDocument, StandardFonts, BlendMode, PDFName, PDFString, PDFHexString } = lib();
    // Which document to export is settled here and never re-read, so an export
    // that outlives a tab switch still writes the drawing it was asked for.
    const store = options.store || RP.store;
    if (!store.docBytes) throw new Error('No source document in memory');

    const pdfDoc = await PDFDocument.load(store.docBytes, { ignoreEncryption: true, updateMetadata: false });
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Only the faces this drawing actually uses get embedded — the standard 14
    // are cheap but they are still objects in someone's file.
    const textFonts = {};
    for (const key of new Set(store.annotations
      .filter((a) => a.type === 'text' || a.type === 'callout')
      .map(fontKeyOf))) {
      const name = STANDARD_FONTS[key];
      if (name) textFonts[key] = await pdfDoc.embedFont(StandardFonts[name]);
    }
    const fontFor = (annot) => textFonts[fontKeyOf(annot)] || font;

    const pages = pdfDoc.getPages();

    // If this file was saved by Redline before, drop what we stamped last time.
    stripPreviousMarkup(pdfDoc, pages, readMarkupFromDoc(pdfDoc));
    const refsBefore = pages.map((page) => ({
      contents: new Set(contentRefsOf(page)),
      annots: new Set(annotRefsOf(page))
    }));

    for (const annot of store.annotations) {
      const page = pages[annot.page];
      if (!page) continue;
      const color = colorOf(annot.color);
      const width = Math.max(0.4, annot.width || 2);
      const opacity = annot.opacity === undefined ? 1 : annot.opacity;

      switch (annot.type) {
        case 'highlight': {
          for (const rect of annot.rects || []) {
            page.drawRectangle({
              x: rect.x, y: rect.y, width: rect.w, height: rect.h,
              color, opacity: opacity || 0.4, blendMode: BlendMode.Multiply
            });
          }
          break;
        }

        /* Same `rects` as a highlight, one rule per run of words. PDF space
           has y running *up*, so the strikeout sits 0.45 of the way up each
           run (the 0.55-from-the-top the canvas draws) and the underline sits
           just below its foot. Thickness comes from `RP.render.ruleWeight`,
           shared with the canvas so the two cannot drift apart. */
        case 'strikeout':
        case 'underline': {
          for (const rect of annot.rects || []) {
            if (!rect || rect.w < 0.2) continue;
            const weight = RP.render.ruleWeight(rect);
            const y = annot.type === 'strikeout'
              ? rect.y + rect.h * 0.45
              : rect.y - Math.max(0.4, rect.h * 0.08);
            page.drawLine({
              start: { x: rect.x, y },
              end: { x: rect.x + rect.w, y },
              thickness: weight, color, opacity, lineCap: 0
            });
          }
          break;
        }

        /* Opaque by construction — that is the difference between this and a
           filled `rect`, which exports at a quarter opacity. It hides the
           marks underneath from the eye and from nothing else: the text
           objects are still in the content stream and still extractable. */
        case 'cover': {
          page.drawRectangle({
            x: annot.x, y: annot.y, width: annot.w, height: annot.h,
            color, opacity: opacity === undefined ? 1 : opacity
          });
          break;
        }

        case 'pen': {
          const pts = annot.points || [];
          for (let i = 1; i < pts.length; i += 1) {
            page.drawLine({
              start: { x: pts[i - 1][0], y: pts[i - 1][1] },
              end: { x: pts[i][0], y: pts[i][1] },
              thickness: width, color, opacity, lineCap: 1
            });
          }
          break;
        }

        case 'line':
        case 'arrow': {
          page.drawLine({
            start: { x: annot.x1, y: annot.y1 },
            end: { x: annot.x2, y: annot.y2 },
            thickness: width, color, opacity, lineCap: 1
          });
          if (annot.type === 'arrow') {
            drawArrowHead(page, [annot.x1, annot.y1], [annot.x2, annot.y2], color, width);
          }
          break;
        }

        case 'rect': {
          page.drawRectangle({
            x: annot.x, y: annot.y, width: annot.w, height: annot.h,
            borderColor: color, borderWidth: width, opacity: annot.fill ? opacity * 0.25 : 0,
            color: annot.fill ? color : undefined,
            borderOpacity: opacity
          });
          break;
        }

        case 'ellipse': {
          page.drawEllipse({
            x: annot.x + annot.w / 2, y: annot.y + annot.h / 2,
            xScale: Math.max(0.5, annot.w / 2), yScale: Math.max(0.5, annot.h / 2),
            borderColor: color, borderWidth: width,
            color: annot.fill ? color : undefined,
            opacity: annot.fill ? opacity * 0.25 : 0,
            borderOpacity: opacity
          });
          break;
        }

        case 'cloud': {
          page.drawSvgPath(cloudPath(annot.w, annot.h, 9), {
            x: annot.x,
            y: annot.y + annot.h,
            borderColor: color,
            borderWidth: width,
            borderOpacity: opacity,
            scale: 1
          });
          break;
        }

        case 'text': {
          const size = annot.fontSize || 12;
          const textFont = fontFor(annot);
          const lines = String(annot.text || '').split('\n');
          lines.forEach((line, i) => {
            page.drawText(line, {
              x: annot.x,
              y: annot.y - size * 0.85 - i * size * 1.25,
              size, font: textFont, color, opacity
            });
          });
          break;
        }

        case 'callout': {
          const box = { x: annot.x, y: annot.y, w: annot.w, h: annot.h };
          page.drawRectangle({
            x: box.x, y: box.y, width: box.w, height: box.h,
            color: lib().rgb(1, 1, 1), opacity: 0.85,
            borderColor: color, borderWidth: width, borderOpacity: opacity
          });
          // Same edge anchor the screen uses, so exports match what you drew.
          const anchor = RP.render.calloutAnchor(annot);
          page.drawLine({
            start: { x: anchor[0], y: anchor[1] },
            end: { x: annot.tipX, y: annot.tipY },
            thickness: width, color, opacity
          });
          drawArrowHead(page, anchor, [annot.tipX, annot.tipY], color, width);
          // Same wrap and inset the screen uses, so a saved sheet reads the
          // way it was drawn; a line that will not fit is dropped rather than
          // stamped under the box.
          const size = annot.fontSize || 11;
          const pad = RP.render.CALLOUT_PAD;
          const textFont = fontFor(annot);
          const textColor = colorOf(annot.textColor || RP.render.DEFAULT_TEXT_COLOR);
          const lines = RP.render.wrapLines(annot.text || '', RP.render.calloutTextWidth(box.w),
            (s) => textFont.widthOfTextAtSize(s, size));
          lines.forEach((line, i) => {
            if (!line) return;
            const lineTop = box.y + box.h - pad - i * size * RP.render.CALLOUT_LINE;
            if (lineTop - size < box.y) return;
            page.drawText(line, {
              x: box.x + pad, y: lineTop - size * 0.85, size, font: textFont, color: textColor
            });
          });
          break;
        }

        case 'measure': {
          page.drawLine({
            start: { x: annot.x1, y: annot.y1 },
            end: { x: annot.x2, y: annot.y2 },
            thickness: width, color, opacity
          });
          const angle = Math.atan2(annot.y2 - annot.y1, annot.x2 - annot.x1) + Math.PI / 2;
          const tick = 5;
          for (const p of [[annot.x1, annot.y1], [annot.x2, annot.y2]]) {
            page.drawLine({
              start: { x: p[0] - Math.cos(angle) * tick, y: p[1] - Math.sin(angle) * tick },
              end: { x: p[0] + Math.cos(angle) * tick, y: p[1] + Math.sin(angle) * tick },
              thickness: width, color, opacity
            });
          }
          const label = annot.label || store.formatLength(RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2));
          const size = 9;
          const textWidth = font.widthOfTextAtSize(label, size);
          const cx = (annot.x1 + annot.x2) / 2;
          const cy = (annot.y1 + annot.y2) / 2 + 6;
          page.drawRectangle({
            x: cx - textWidth / 2 - 3, y: cy - 2, width: textWidth + 6, height: size + 4,
            color: lib().rgb(1, 1, 1), opacity: 0.88, borderColor: color, borderWidth: 0.5
          });
          page.drawText(label, { x: cx - textWidth / 2, y: cy + 1, size, font, color: lib().rgb(0.08, 0.09, 0.11) });
          break;
        }

        case 'note': {
          const s = 16;
          const x = annot.x;
          const y = annot.y - s;
          page.drawRectangle({
            x, y, width: s, height: s,
            color, borderColor: lib().rgb(0.25, 0.2, 0.05), borderWidth: 0.7, opacity: 1
          });
          for (let i = 0; i < 3; i += 1) {
            page.drawLine({
              start: { x: x + 3, y: y + s - 4 - i * 3.4 },
              end: { x: x + s - 3, y: y + s - 4 - i * 3.4 },
              thickness: 0.7, color: lib().rgb(0.2, 0.16, 0.04)
            });
          }
          // Real PDF annotation so other viewers surface the comment text.
          if (annot.note) {
            try {
              const dict = pdfDoc.context.obj({
                Type: PDFName.of('Annot'),
                Subtype: PDFName.of('Text'),
                Name: PDFName.of('Comment'),
                Rect: [x, y, x + s + 4, y + s + 4],
                Contents: PDFHexString.fromText(annot.note),
                T: PDFString.of(annot.author || 'Redline PDF'),
                F: 4,
                C: [RP.hexToRgbUnit(annot.color).r, RP.hexToRgbUnit(annot.color).g, RP.hexToRgbUnit(annot.color).b]
              });
              page.node.addAnnot(pdfDoc.context.register(dict));
            } catch (err) {
              console.warn('Could not attach a native PDF comment', err);
            }
          }
          break;
        }

        default:
          break;
      }
    }

    if (options.embed !== false) {
      const contentRefs = {};
      const annotRefs = {};
      pages.forEach((page, index) => {
        const addedContents = contentRefsOf(page).filter((ref) => !refsBefore[index].contents.has(ref));
        const addedAnnots = annotRefsOf(page).filter((ref) => !refsBefore[index].annots.has(ref));
        if (addedContents.length) contentRefs[index] = addedContents;
        if (addedAnnots.length) annotRefs[index] = addedAnnots;
      });
      embedMarkup(pdfDoc, Object.assign(store.serialize(), { contentRefs, annotRefs }));
    }
    pdfDoc.setProducer('Redline PDF');
    pdfDoc.setModificationDate(new Date());
    void boldFont;
    return pdfDoc.save({ useObjectStreams: false });
  }

  function wrapText(text, font, size, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // -------------------------------------------------------------------------
  // Markup summary exports
  // -------------------------------------------------------------------------

  function summaryRows(target) {
    const store = target || RP.store;
    return store.annotations
      .slice()
      .sort((a, b) => a.page - b.page || b.created - a.created)
      .map((annot, i) => {
        const box = RP.render.bbox(annot);
        let detail = '';
        if (annot.type === 'note') detail = annot.note || '';
        else if (annot.type === 'text' || annot.type === 'callout') detail = annot.text || '';
        else if (annot.type === 'highlight' || annot.type === 'strikeout' || annot.type === 'underline') {
          detail = annot.text || annot.note || '';
        }
        else if (annot.type === 'measure') {
          detail = annot.label || store.formatLength(RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2));
          if (annot.note) detail += ' — ' + annot.note;
        } else detail = annot.note || '';
        return {
          index: i + 1,
          page: annot.page + 1,
          type: store.typeLabel(annot.type),
          detail,
          author: annot.author || '',
          created: RP.fmtDate(annot.created),
          location: 'x ' + Math.round(box.x) + ', y ' + Math.round(box.y)
        };
      });
  }

  function toCsv(target) {
    const store = target || RP.store;
    const rows = summaryRows(store);
    const header = ['#', 'Page', 'Type', 'Comment', 'Author', 'Created', 'Location (pt)'];
    const esc = (value) => {
      const str = String(value === undefined || value === null ? '' : value);
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([row.index, row.page, row.type, row.detail, row.author, row.created, row.location].map(esc).join(','));
    }
    return lines.join('\r\n');
  }

  async function buildReportPdf(target) {
    const store = target || RP.store;
    const { PDFDocument, StandardFonts, rgb } = lib();
    const rows = summaryRows(store);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 46;
    const cols = [30, 34, 92, 250, 86]; // #, page, type, comment, date
    let page = null;
    let y = 0;

    const newPage = (first) => {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      if (first) {
        page.drawText('Markup summary', { x: margin, y: y - 6, size: 18, font: bold, color: rgb(0.08, 0.09, 0.11) });
        page.drawText(store.docName || '', { x: margin, y: y - 26, size: 10, font, color: rgb(0.42, 0.45, 0.5) });
        page.drawText(rows.length + ' markups · exported ' + RP.fmtDate(Date.now()),
          { x: margin, y: y - 40, size: 9, font, color: rgb(0.42, 0.45, 0.5) });
        y -= 66;
      }
      // header row
      page.drawRectangle({ x: margin, y: y - 16, width: pageWidth - margin * 2, height: 18, color: rgb(0.93, 0.94, 0.96) });
      let x = margin + 4;
      ['#', 'Pg', 'Type', 'Comment', 'Created'].forEach((label, i) => {
        page.drawText(label, { x, y: y - 11, size: 8.5, font: bold, color: rgb(0.25, 0.28, 0.33) });
        x += cols[i];
      });
      y -= 26;
    };

    newPage(true);

    for (const row of rows) {
      const detailLines = wrapText(row.detail || '—', font, 9, cols[3] - 8).slice(0, 4);
      const rowHeight = Math.max(16, detailLines.length * 11 + 5);
      if (y - rowHeight < margin) newPage(false);

      let x = margin + 4;
      const cells = [String(row.index), String(row.page), row.type];
      cells.forEach((value, i) => {
        page.drawText(value, { x, y: y - 9, size: 9, font, color: rgb(0.12, 0.14, 0.18) });
        x += cols[i];
      });
      detailLines.forEach((line, i) => {
        page.drawText(line, { x, y: y - 9 - i * 11, size: 9, font, color: rgb(0.12, 0.14, 0.18) });
      });
      x += cols[3];
      page.drawText(row.created, { x, y: y - 9, size: 8, font, color: rgb(0.45, 0.48, 0.53) });

      y -= rowHeight;
      page.drawLine({
        start: { x: margin, y: y + 4 },
        end: { x: pageWidth - margin, y: y + 4 },
        thickness: 0.4, color: rgb(0.85, 0.87, 0.9)
      });
    }

    return doc.save();
  }

  RP.exporter = {
    buildPdf,
    readEmbeddedMarkup,
    stripToBaseBytes,
    toCsv,
    buildReportPdf,
    summaryRows
  };

})(window.RP);
