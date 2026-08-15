/* Headless verification of the parts that do not need a browser:
     - the pdf-lib export path (every markup type -> a valid PDF)
     - re-save idempotency (markups must not double-stamp)
     - the revision-compare maths (dilation, alignment, blob cleanup)

   Run with:  node test/verify.js          (from the project root)
   Requires:  npm install
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PDFLib = require(path.join(ROOT, 'node_modules', 'pdf-lib'));

let failures = 0;
function check(label, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? '  — ' + detail : ''}`);
}

// --- load the renderer modules in this realm --------------------------------
// (a vm context would give pdf-lib objects from a different realm, which breaks
//  its `instanceof` argument checks, so we run the sources in-process instead)

/**
 * A 2D context stub good enough to lay text out with: `measureText` models a
 * proportional font at half an em per character, so it scales with `font` the
 * way a real one does. That is what makes the callout fitting checks below
 * mean anything — the bug they cover was measuring and drawing disagreeing.
 */
function measuringContext(record) {
  let fontSize = 11;
  let bold = false;
  const noop = () => {};
  return {
    get font() { return (bold ? '700 ' : '') + fontSize + 'px sans-serif'; },
    set font(value) {
      bold = /(^|\s)(bold|[6-9]00)(\s|$)/.test(value);
      fontSize = parseFloat(String(value).replace(/^\s*[0-9]{3}\s+/, '')) || fontSize;
    },
    measureText: (text) => ({ width: String(text).length * (bold ? 0.56 : 0.5) * fontSize }),
    fillText(text, x, y) {
      if (record) record.push({ kind: 'text', text, x, y, size: fontSize, bold, fill: this.fillStyle });
    },
    strokeRect(x, y, w, h) { if (record) record.push({ kind: 'box', x, y, w, h }); },
    fillRect: noop,
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, arc: noop, ellipse: noop,
    stroke: noop, fill: noop, setLineDash: noop, rect: noop,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    globalAlpha: 1, textBaseline: '', globalCompositeOperation: ''
  };
}

global.window = global;
global.window.PDFLib = PDFLib;
global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
/* `viewer.whenIdle` defers layer building through this where the browser has
   it. Run synchronously here so the queue can be stepped and inspected; the
   scheduling decisions being checked are the ones made *before* it, and an
   idle callback in the middle only makes them harder to see. */
global.requestIdleCallback = (fn) => { fn({ timeRemaining: () => 50 }); };
// app.js registers a DOMContentLoaded handler at load time and nothing else.
global.addEventListener = () => {};
global.document = {
  createElement: () => ({
    style: {}, appendChild() {}, setAttribute() {}, addEventListener() {},
    getContext: () => measuringContext()
  }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: {
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {}, appendChild() {}
  }
};

const globalEval = eval; // indirect eval => runs in global scope
for (const file of ['util.js', 'appearance.js', 'store.js', 'render.js', 'compare.js', 'exporter.js', 'pages.js',
  'print.js', 'annots.js', 'views.js', 'viewer.js', 'snapshot.js', 'textsel.js', 'clip.js',
  'tools.js', 'sidebar.js', 'pdfjs-loader.js', 'edit.js', 'app.js']) {
  globalEval(fs.readFileSync(path.join(ROOT, 'src', 'js', file), 'utf8'));
}
const RP = global.RP;

// --- build a source PDF to mark up ------------------------------------------

async function makeSourcePdf() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < 2; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText('Panel schedule sheet ' + (i + 1), { x: 60, y: 700, size: 18, font });
    page.drawRectangle({ x: 60, y: 300, width: 300, height: 200, borderWidth: 1, borderColor: PDFLib.rgb(0, 0, 0) });
  }
  return doc.save();
}

function sampleAnnotations() {
  return [
    { page: 0, type: 'highlight', color: '#ffdd00', opacity: 0.4, rects: [{ x: 60, y: 690, w: 200, h: 16 }], text: 'Panel schedule' },
    { page: 0, type: 'note', color: '#ffcf3d', x: 400, y: 700, note: 'Confirm breaker sizes with vendor' },
    { page: 0, type: 'pen', color: '#ff2f2f', width: 2, opacity: 1, points: [[100, 400], [140, 430], [180, 405], [220, 445]] },
    { page: 0, type: 'line', color: '#ff2f2f', width: 2, opacity: 1, x1: 80, y1: 200, x2: 300, y2: 260 },
    { page: 0, type: 'arrow', color: '#ff2f2f', width: 2, opacity: 1, x1: 320, y1: 200, x2: 460, y2: 280 },
    { page: 0, type: 'rect', color: '#2f8fff', width: 2, opacity: 1, x: 80, y: 500, w: 160, h: 90, fill: false },
    { page: 0, type: 'ellipse', color: '#38d16a', width: 2, opacity: 1, x: 280, y: 500, w: 150, h: 80 },
    { page: 1, type: 'cloud', color: '#ff2f2f', width: 2, opacity: 1, x: 90, y: 320, w: 260, h: 160, note: 'Rev C change' },
    { page: 1, type: 'text', color: '#ff2f2f', fontSize: 14, opacity: 1, x: 100, y: 620, text: 'VERIFY ON SITE\nsecond line' },
    { page: 1, type: 'callout', color: '#ff9500', width: 1.5, opacity: 1, x: 320, y: 560, w: 180, h: 60, tipX: 240, tipY: 480, text: 'Feeder routed above ceiling', fontSize: 10 },
    { page: 1, type: 'measure', color: '#c04aff', width: 1.5, opacity: 1, x1: 100, y1: 200, x2: 400, y2: 200 },
    // Non-default typefaces, so the export has to reach past Helvetica.
    { page: 1, type: 'callout', color: '#ff9500', width: 1.5, opacity: 1, x: 320, y: 300, w: 180, h: 40, tipX: 260, tipY: 250, text: 'Serif bold callout', fontSize: 10, fontFamily: 'serif', bold: true, textColor: '#0044cc' },
    { page: 1, type: 'text', color: '#2f8fff', fontSize: 11, opacity: 1, x: 100, y: 120, text: 'MONO NOTE', fontFamily: 'mono' },
    // The text markups from a selection. Strikeout and underline share the
    // highlight's `rects`, and a cover is an opaque box — all three are new in
    // 0.5.0 and all three are silently dropped on save if the exporter has no
    // case for them, which is exactly the failure this list exists to catch.
    { page: 0, type: 'strikeout', color: '#ff2f2f', opacity: 1, rects: [{ x: 60, y: 660, w: 180, h: 12 }], text: 'SUPERSEDED' },
    { page: 0, type: 'underline', color: '#2f8fff', opacity: 1, rects: [{ x: 60, y: 630, w: 140, h: 12 }, { x: 60, y: 612, w: 90, h: 12 }], text: 'see note 4' },
    { page: 1, type: 'cover', color: '#ffffff', opacity: 1, x: 420, y: 640, w: 120, h: 30 },
    // The vertex-list markups. Like the text three above, these are silently
    // dropped on save if the exporter has no case for them — and the area
    // additionally exercises `drawSvgPath`, which is the only pdf-lib call
    // that fills an arbitrary polygon.
    { page: 0, type: 'polyline', color: '#ff9500', width: 2, opacity: 1, points: [[60, 120], [140, 180], [220, 130], [300, 190]] },
    { page: 1, type: 'polylength', color: '#38d16a', width: 1.5, opacity: 1, points: [[80, 560], [200, 560], [200, 640], [320, 640]] },
    { page: 1, type: 'area', color: '#2f8fff', width: 1.5, opacity: 1, fill: true, points: [[380, 120], [520, 120], [520, 230], [430, 260], [380, 200]] },
    // A bow-tie, so the export path actually takes the refusal branch rather
    // than only the happy one.
    { page: 0, type: 'area', color: '#c04aff', width: 1.5, opacity: 1, points: [[420, 380], [540, 380], [420, 450], [540, 450]] }
  ].map((a, i) => Object.assign({
    id: 'mk' + i, created: Date.now(), modified: Date.now(), author: 'Tester', note: a.note || '',
    // A resolved and a rejected item in the sample set, so the export path
    // actually draws the fade and the rejected rule rather than only the
    // default case. Most stay open, which is also the shape of a real review.
    status: i === 3 ? 'closed' : (i === 7 ? 'rejected' : 'open')
  }, a));
}

// --- tests ------------------------------------------------------------------

async function testExport() {
  console.log('\nExport pipeline');
  const source = await makeSourcePdf();

  RP.store.docBytes = source;
  RP.store.docName = 'sheet.pdf';
  RP.store.annotations = sampleAnnotations();
  RP.store.scale = { pdfLength: 300, realLength: 7.5, unit: 'm' };

  const saved = await RP.exporter.buildPdf({});
  check('every markup type exports without throwing', saved.length > 0, saved.length + ' bytes');
  check('output is a PDF', Buffer.from(saved.slice(0, 5)).toString() === '%PDF-');

  const reopened = await PDFLib.PDFDocument.load(saved);
  check('page count preserved', reopened.getPageCount() === 2);

  // A markup drawn in a non-default face has to be stamped in that face, not
  // silently flattened back to Helvetica. These are the standard 14, so they
  // are named in the file rather than embedded as font programs.
  const named = Buffer.from(saved).toString('latin1');
  check('a serif bold callout stamps a serif bold font', /Times[-# ]?Bold/.test(named));
  check('a mono typewriter note stamps a mono font', /\/Courier/.test(named));
  check('unused faces are not embedded', !/Times-Italic|Helvetica-Oblique/.test(named));

  /* A takeoff is only worth anything if the paper says what the screen said.
     The reading is built by `RP.render.readingOf`, which the canvas, the markup
     list and the CSV also quote — so reading it back off the stamped page is
     what proves the exporter is quoting it too and has not grown its own
     arithmetic. The bow-tie is in the sample set for the same reason: its
     refusal has to survive the trip onto paper rather than being filled in
     with a shoelace difference nobody can check. */
  const stampedText = await pageLabel(saved, 1);
  if (stampedText !== null) {
    const areaMarkup = RP.store.annotations.find((a) => a.type === 'area' && a.page === 1);
    const runMarkup = RP.store.annotations.find((a) => a.type === 'polylength');
    check('an area is stamped with the reading the screen shows',
      RP.render.readingLines(areaMarkup, RP.store).every((line) => stampedText.includes(line)),
      stampedText);
    check('and a run with its total',
      stampedText.includes(RP.render.readingOf(runMarkup, RP.store)));
    const crossedText = await pageLabel(saved, 0);
    check('a bow-tie is stamped as having no area, not as a plausible number',
      /crosses itself/.test(crossedText || ''));
  }

  const embedded = await RP.exporter.readEmbeddedMarkup(saved);
  check('markup model round-trips for re-editing',
    !!embedded && embedded.annotations.length === RP.store.annotations.length,
    embedded ? embedded.annotations.length + ' markups recovered' : 'nothing recovered');
  check('measurement scale round-trips',
    !!embedded && embedded.scale && embedded.scale.realLength === 7.5);
  // Set a markup closed, save, reopen — it has to still be closed, or the
  // punch list resets itself every time the drawing is handed over.
  check('review status round-trips through a save',
    !!embedded &&
    embedded.annotations.filter((a) => a.status === 'closed').length === 1 &&
    embedded.annotations.filter((a) => a.status === 'rejected').length === 1,
    embedded ? JSON.stringify(RP.store.statusCounts(embedded.annotations)) : 'nothing recovered');
  check('content stream refs recorded for idempotent re-save',
    !!embedded && embedded.contentRefs && Object.keys(embedded.contentRefs).length === 2);

  // Re-saving an already-saved file must not stack a second copy of the marks.
  RP.store.docBytes = saved;
  const resaved = await RP.exporter.buildPdf({});
  const countStreams = async (bytes) => {
    const doc = await PDFLib.PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
      const contents = page.node.get(PDFLib.PDFName.of('Contents'));
      return contents && contents.asArray ? contents.asArray().length : 1;
    });
  };
  const before = await countStreams(saved);
  const after = await countStreams(resaved);
  check('re-save does not double-stamp markups',
    JSON.stringify(before) === JSON.stringify(after),
    'streams per page ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after));

  const report = await RP.exporter.buildReportPdf();
  check('markup summary report builds', report.length > 0, report.length + ' bytes');
  const csv = RP.exporter.toCsv();
  check('CSV has a row per markup', countCsvRecords(csv) === RP.store.annotations.length + 1,
    countCsvRecords(csv) + ' records incl. header');
  check('CSV escapes multi-line text', csv.includes('"VERIFY ON SITE'));
  check('CSV carries a status column',
    csv.split('\r\n')[0].split(',')[3] === 'Status' &&
    /(^|,)Closed(,|$)/m.test(csv) && /(^|,)Rejected(,|$)/m.test(csv));

  // Anything we write has to be readable by a normal PDF engine, not just ours.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) {
    check('pdf.js available for cross-checking', false, 'pdfjs-dist not found — run npm install');
    return;
  }
  const parsed = await pdfjs.getDocument({ data: new Uint8Array(saved), useWorkerFetch: false, isEvalSupported: false }).promise;
  check('pdf.js can parse the exported file', parsed.numPages === 2);
  const page1 = await parsed.getPage(1);
  const nativeAnnots = await page1.getAnnotations();
  check('sticky notes become real PDF comments',
    nativeAnnots.some((a) => /breaker sizes/.test((a.contentsObj && a.contentsObj.str) || a.contents || '')),
    nativeAnnots.length + ' native annotations on page 1');
  const text = await (await parsed.getPage(2)).getTextContent();
  check('typewriter text is real selectable text',
    text.items.some((item) => (item.str || '').includes('VERIFY ON SITE')));

  fs.mkdirSync(path.join(ROOT, 'test', 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test', 'out', 'marked-up.pdf'), Buffer.from(saved));
  fs.writeFileSync(path.join(ROOT, 'test', 'out', 'report.pdf'), Buffer.from(report));
}

/**
 * Page management. The order maths is pure, so most of this is exact-value
 * checking; the rebuild is exercised against real pdf-lib output because the
 * page-aliasing and double-stamping traps only show up there.
 */
async function testPageManagement() {
  console.log('\nPage management');
  const { ops, buildBytes, remapAnnotations } = RP.pages;
  const srcIndexes = (order) => JSON.stringify(order.map((item) => item.srcIndex));

  const order = ops.fromDocument(4);
  check('a fresh document starts as the identity order',
    order.length === 4 && order.every((item, i) => item.src === 'base' && item.srcIndex === i && item.rot === 0));

  const removed = ops.remove(order, [1]);
  check('delete drops the page and closes the gap',
    srcIndexes(removed.order) === '[0,2,3]' && JSON.stringify(removed.map) === '[0,-1,1,2]');

  const up = ops.move(order, [3], 0);
  check('a page dragged to the top lands there',
    srcIndexes(up.order) === '[3,0,1,2]' && JSON.stringify(up.map) === '[1,2,3,0]');

  const down = ops.move(order, [0], 3);
  check('a page dragged down accounts for the gap it leaves behind',
    srcIndexes(down.order) === '[1,2,0,3]', srcIndexes(down.order));

  const block = ops.move(order, [0, 1], 4);
  check('a multi-page selection stays together when moved',
    srcIndexes(block.order) === '[2,3,0,1]', srcIndexes(block.order));

  const dup = ops.duplicate(order, [1]);
  check('duplicate files the copy right after its original',
    srcIndexes(dup.order) === '[0,1,1,2,3]' && dup.order[1].uid !== dup.order[2].uid &&
    dup.clones.length === 1 && dup.clones[0].from === 1 && dup.clones[0].to === 2);

  const rot = ops.rotate(order, [0, 2], -90);
  check('rotation is stored as a normalised 0-359 delta',
    rot.order[0].rot === 270 && rot.order[2].rot === 270 && rot.order[1].rot === 0);
  check('rotating twice more comes back to zero',
    ops.rotate(ops.rotate(rot.order, [0], 90).order, [0], 90).order[0].rot === 90);

  const ins = ops.insert(order, 2, ops.blank(612, 792));
  check('a blank page pushes the pages after it along',
    ins.order.length === 5 && ins.order[2].blank.w === 612 &&
    JSON.stringify(ins.map) === '[0,1,3,4]');

  // --- annotations follow their pages ---------------------------------------
  const sample = () => [{ id: 'a', page: 0 }, { id: 'b', page: 1 }, { id: 'c', page: 3 }];
  const kept = remapAnnotations(sample(), removed.map, removed.clones);
  check('markups on a deleted page are deleted with it',
    kept.length === 2 && !kept.some((a) => a.id === 'b'));
  check('markups after the deleted page shift down',
    kept.find((a) => a.id === 'c').page === 2);
  check('markups follow a page that was moved',
    remapAnnotations(sample(), up.map, up.clones).find((a) => a.id === 'c').page === 0);

  const cloned = remapAnnotations([{ id: 'b', page: 1, type: 'note' }], dup.map, dup.clones);
  check('duplicating a page duplicates its markups under new ids',
    cloned.length === 2 && cloned[0].page === 1 && cloned[1].page === 2 && cloned[0].id !== cloned[1].id);

  // --- the rebuild itself ---------------------------------------------------
  const threePager = await PDFLib.PDFDocument.create();
  const font = await threePager.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) {
    threePager.addPage([600, 800]).drawText('SHEET-' + (i + 1), { x: 60, y: 700, size: 24, font });
  }
  const baseThree = await threePager.save();

  const built = await buildBytes(baseThree, [
    ops.descriptor('base', 2, 0),
    ops.descriptor('base', 0, 90),
    ops.descriptor('base', 0, 0),
    ops.blank(300, 400)
  ], null);
  const rebuilt = await PDFLib.PDFDocument.load(built);
  check('the rebuild produces exactly the pages asked for', rebuilt.getPageCount() === 4);
  const angles = rebuilt.getPages().map((page) => page.getRotation().angle);
  check('a duplicated page rotates independently of its twin',
    angles[1] === 90 && angles[2] === 0, 'rotations ' + JSON.stringify(angles));
  const blankSize = rebuilt.getPage(3).getSize();
  check('the blank page is the size it was asked for',
    Math.round(blankSize.width) === 300 && Math.round(blankSize.height) === 400);
  check('rebuilding an empty order is refused',
    await rejects(() => buildBytes(baseThree, [], null)));
  check('a descriptor pointing past the end of its source is refused',
    await rejects(() => buildBytes(baseThree, [ops.descriptor('base', 9, 0)], null)));

  const pdfjs = await loadPdfjs();
  if (pdfjs) {
    const parsed = await pdfjs.getDocument({ data: new Uint8Array(built), useWorkerFetch: false, isEvalSupported: false }).promise;
    const first = await (await parsed.getPage(1)).getTextContent();
    check('reordering actually moves the page content, not just the label',
      first.items.some((item) => (item.str || '').includes('SHEET-3')),
      first.items.map((i) => i.str).join('').trim());
    check('pdf.js reads the rebuilt rotation off page 2',
      (await parsed.getPage(2)).rotate === 90);
  }

  // --- a page edit on an already-saved file must not double-stamp ------------
  RP.store.docBytes = await makeSourcePdf();
  RP.store.docName = 'sheet.pdf';
  RP.store.scale = null;
  RP.store.annotations = sampleAnnotations();
  const onPageZero = RP.store.annotations.filter((a) => a.page === 0).length;
  const total = RP.store.annotations.length;

  const saved = await RP.exporter.buildPdf({});
  const stripped = await RP.exporter.stripToBaseBytes(saved);
  check('stripping a saved file drops the embedded markup model',
    (await RP.exporter.readEmbeddedMarkup(stripped)) === null);

  const twoPage = ops.fromDocument(2);
  const withCopy = ops.duplicate(twoPage, [0]);
  RP.store.docBytes = await buildBytes(stripped, withCopy.order, null);
  RP.store.annotations = remapAnnotations(RP.store.annotations, withCopy.map, withCopy.clones);
  check('the duplicated page brought its markups along',
    RP.store.annotations.length === total + onPageZero,
    RP.store.annotations.length + ' markups over 3 pages');

  const afterEdit = await RP.exporter.buildPdf({});
  const streamsPerPage = async (bytes) => {
    const doc = await PDFLib.PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
      const contents = page.node.get(PDFLib.PDFName.of('Contents'));
      return contents && contents.asArray ? contents.asArray().length : 1;
    });
  };
  const firstPass = await streamsPerPage(afterEdit);
  const baseline = await streamsPerPage(saved);
  check('saving after a page edit stamps each page once',
    firstPass.every((count) => count === baseline[0]),
    'streams per page ' + JSON.stringify(firstPass) + ' vs ' + baseline[0] + ' on a plain save');

  RP.store.docBytes = afterEdit;
  const secondPass = await streamsPerPage(await RP.exporter.buildPdf({}));
  check('re-saving an edited document still does not double-stamp',
    JSON.stringify(firstPass) === JSON.stringify(secondPass),
    JSON.stringify(firstPass) + ' -> ' + JSON.stringify(secondPass));

  const model = await RP.exporter.readEmbeddedMarkup(afterEdit);
  check('the re-editable model survives a page edit',
    !!model && model.annotations.length === total + onPageZero);
}

/** True when `fn` rejects — used for the guard-rail checks above. */
async function rejects(fn) {
  try { await fn(); return false; } catch (err) { return true; }
}

/**
 * Load whichever pdfjs-dist flavour is installed: v4+ is ESM (pdf.mjs), v3 is
 * CommonJS (pdf.js). The app has the same fork in src/js/pdfjs-loader.js.
 */
async function loadPdfjs() {
  // pdf.js v6 expects browser canvas globals at import time. We only parse
  // here — never rasterise — so minimal stubs are enough to get it loaded.
  if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
      constructor(init) {
        const v = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
        [this.a, this.b, this.c, this.d, this.e, this.f] = v;
      }
    };
  }
  if (typeof global.Path2D === 'undefined') {
    global.Path2D = class Path2D { addPath() {} moveTo() {} lineTo() {} closePath() {} };
  }
  if (typeof global.ImageData === 'undefined') {
    global.ImageData = class ImageData {
      constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
    };
  }

  const candidates = [
    ['legacy/build/pdf.mjs', 'esm'],
    ['build/pdf.mjs', 'esm'],
    ['legacy/build/pdf.js', 'cjs'],
    ['build/pdf.js', 'cjs']
  ];
  for (const [rel, kind] of candidates) {
    const file = path.join(ROOT, 'node_modules', 'pdfjs-dist', ...rel.split('/'));
    if (!fs.existsSync(file)) continue;
    try {
      if (kind === 'esm') {
        const mod = await import(require('url').pathToFileURL(file).href);
        if (typeof mod.getDocument === 'function') return mod;
        if (mod.default && typeof mod.default.getDocument === 'function') return mod.default;
      } else {
        const mod = require(file);
        if (typeof mod.getDocument === 'function') return mod;
      }
    } catch (err) {
      console.log('  (note: ' + rel + ' did not load — ' + err.message + ')');
    }
  }
  return null;
}

/** Count CSV records, respecting newlines inside quoted fields. */
function countCsvRecords(csv) {
  let records = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') { i += 1; continue; }
      inQuotes = !inQuotes;
      sawContent = true;
    } else if (!inQuotes && ch === '\n') {
      if (sawContent) records += 1;
      sawContent = false;
    } else if (ch !== '\r') {
      sawContent = true;
    }
  }
  if (sawContent) records += 1;
  return records;
}

function makeMask(width, height, draw) {
  const mask = new Uint8Array(width * height);
  draw((x, y) => {
    if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1;
  });
  return mask;
}

function testCompareMaths() {
  console.log('\nRevision compare engine');
  const { dilate, estimateShift, shiftMask, labelBlobs, mergeRegions } = RP.compare.internals;
  const W = 200;
  const H = 160;

  // Baseline: a horizontal line and a small box.
  const base = makeMask(W, H, (set) => {
    for (let x = 20; x < 180; x += 1) set(x, 40);
    for (let x = 30; x < 60; x += 1) { set(x, 100); set(x, 120); }
    for (let y = 100; y <= 120; y += 1) { set(30, y); set(59, y); }
  });

  // Current: same content shifted by 1px, box deleted, new blob added.
  const current = makeMask(W, H, (set) => {
    for (let x = 21; x < 181; x += 1) set(x, 41);
    for (let y = 60; y < 90; y += 1) for (let x = 130; x < 170; x += 1) set(x, y);
  });

  const shift = estimateShift(base, current, W, H);
  check('global plot shift detected', shift.dx === 1 && shift.dy === 1, JSON.stringify(shift));

  const aligned = shiftMask(base, W, H, shift.dx, shift.dy);
  const dilatedCurrent = dilate(current, W, H, 2);
  const dilatedBase = dilate(aligned, W, H, 2);

  let removed = new Uint8Array(W * H);
  let added = new Uint8Array(W * H);
  for (let i = 0; i < removed.length; i += 1) {
    removed[i] = aligned[i] && !dilatedCurrent[i] ? 1 : 0;
    added[i] = current[i] && !dilatedBase[i] ? 1 : 0;
  }

  const removedBlobs = labelBlobs(removed, W, H, 6);
  const addedBlobs = labelBlobs(added, W, H, 6);
  const regions = mergeRegions(removedBlobs, addedBlobs, 16, W, H);

  check('the shifted line is NOT reported as a change',
    !regions.some((r) => r.y < 55 && r.h < 12 && r.w > 100),
    regions.length + ' regions total');
  check('the deleted box is reported as removed',
    regions.some((r) => r.kind === 'removed' && r.x <= 32 && r.y <= 102));
  check('the new blob is reported as added',
    regions.some((r) => r.kind === 'added' && r.x >= 125 && r.w >= 35));
  check('changes are clustered, not per-pixel', regions.length <= 4, regions.length + ' regions');

  // Identical pages must produce nothing at all.
  const same = mergeRegions(
    labelBlobs(new Uint8Array(W * H), W, H, 6),
    labelBlobs(new Uint8Array(W * H), W, H, 6),
    16, W, H
  );
  check('identical revisions produce zero regions', same.length === 0);

  // Speck filter: a 2x2 dot of scanner noise must be ignored.
  const speck = makeMask(W, H, (set) => { set(80, 80); set(81, 80); set(80, 81); set(81, 81); });
  check('scanner specks are filtered out', labelBlobs(speck, W, H, 8).length === 0);

  // Dilation sanity.
  const dot = makeMask(W, H, (set) => set(100, 100));
  const grown = dilate(dot, W, H, 2);
  let grownCount = 0;
  for (const v of grown) grownCount += v;
  check('dilation radius 2 grows one pixel to a 5x5 block', grownCount === 25, grownCount + ' px');
}

/* The failure this guards against: a comparison where the second file did not
   render, and every page came back "completely different" with no hint that
   anything had gone wrong. A render that fails must be reported as a failure,
   never as a wholesale change. */
function testCompareGuards() {
  console.log('\nRevision compare guards');
  const {
    fitOntoGrid, maskHealth, judgePair, inkBBox, fitCorrection,
    cropRect, regionAt, bestOffset
  } = RP.compare.internals;

  // --- fitting a differently sized sheet onto the reference grid ------------
  const fit = fitOntoGrid(400, 600, 800, 600);   // portrait page, landscape grid
  check('a mismatched sheet is fitted to the grid', Math.abs(fit.scale - 1) < 1e-9, 'scale ' + fit.scale);
  check('and centred, not pinned to a corner',
    Math.abs(fit.offsetX - 200) < 1e-9 && Math.abs(fit.offsetY) < 1e-9,
    'offset ' + fit.offsetX + ',' + fit.offsetY);

  // --- render health -------------------------------------------------------
  const blank = maskHealth({ ink: 0, width: 100, height: 100, coverage: 0 });
  const flooded = maskHealth({ ink: 9900, width: 100, height: 100, coverage: 0.99 });
  const normal = maskHealth({ ink: 2000, width: 100, height: 100, coverage: 0.2 });
  check('a page that rendered white is flagged blank', !blank.ok && blank.reason === 'blank');
  check('a page that rendered solid black is flagged flooded', !flooded.ok && flooded.reason === 'flooded');
  check('an ordinary page passes', normal.ok);

  const side = (coverage) => ({ ink: Math.round(coverage * 10000), width: 100, height: 100, coverage });
  const pair = (a, b) => ({ reference: a, other: b, hasCurrent: true, hasBase: true });

  const floodedVerdict = judgePair(pair(side(0.2), side(0.99)), true);
  check('a flooded pair is never accepted, even on the last attempt',
    !floodedVerdict.ok && floodedVerdict.reason === 'flooded');
  check('two genuinely empty pages compare as empty, not as a change',
    judgePair(pair(side(0), side(0)), true).ok === true &&
    judgePair(pair(side(0), side(0)), true).empty === true);
  check('one blank side is retried before it is believed',
    judgePair(pair(side(0.2), side(0)), false).ok === false);
  check('and is flagged when it survives the retry',
    judgePair(pair(side(0.2), side(0)), true).oneBlank === true);
  check('a good pair is accepted', judgePair(pair(side(0.2), side(0.21)), false).ok === true);

  // --- coarse alignment from the sheet border ------------------------------
  const W = 300;
  const H = 200;
  const refBox = { x: 20, y: 20, w: 200, h: 120 };

  const shifted = fitCorrection(refBox, { x: 60, y: 20, w: 200, h: 120 }, W, H);
  check('a 40px plot shift is recovered — the old ±24px search could not',
    shifted.usableShift && shifted.dx === -40 && shifted.dy === 0, JSON.stringify(shifted));
  check('and is not mistaken for a scale change', shifted.rescale === false);

  const rescaled = fitCorrection(refBox, { x: 22, y: 21, w: 196, h: 118 }, W, H);
  check('a re-plotted sheet is detected as a scale change',
    rescaled.rescale === true && rescaled.scale > 1.01 && rescaled.scale < 1.03,
    'scale ' + rescaled.scale.toFixed(4));

  const tiny = fitCorrection(refBox, { x: 10, y: 10, w: 30, h: 20 }, W, H);
  check('a lone note is not allowed to drive the alignment',
    tiny.usableShift === false && tiny.rescale === false);

  const stretched = fitCorrection(refBox, { x: 20, y: 20, w: 160, h: 120 }, W, H);
  check('a non-uniform size difference is left alone rather than guessed at',
    stretched.rescale === false);

  const bbox = inkBBox(makeMask(40, 30, (set) => { set(5, 6); set(20, 25); }), 40, 30);
  check('ink bounding box', bbox.x === 5 && bbox.y === 6 && bbox.w === 16 && bbox.h === 20 && bbox.ink === 2);
  check('an empty mask has no bounding box', inkBBox(new Uint8Array(1200), 40, 30) === null);

  // --- correlation overlap guard -------------------------------------------
  const a = new Float32Array(100);
  const b = new Float32Array(100);
  for (let i = 0; i < 10; i += 1) { a[i] = 1; b[90 + i] = 1; }
  check('a shift that throws away most of the page is refused',
    bestOffset(a, b, 95) === 0, 'chose ' + bestOffset(a, b, 95));

  // --- inspector crop maths ------------------------------------------------
  const crop = cropRect({ x: 2, y: 2, w: 10, h: 10 }, 100, 100, 26);
  check('the inspector crop is clamped at the page edge',
    crop.x === 0 && crop.y === 0 && crop.w === 38 && crop.h === 38, JSON.stringify(crop));
  const wide = cropRect({ x: 90, y: 90, w: 20, h: 20 }, 100, 100, 26);
  check('and never runs off the far edge',
    wide.x + wide.w <= 100 && wide.y + wide.h <= 100, JSON.stringify(wide));

  const regions = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 }];
  check('clicking a change picks the tightest region under the pointer',
    regionAt(regions, 15, 15, 8) === 1);
  check('clicking empty paper picks nothing', regionAt(regions, 400, 400, 8) === -1);
}

function testGeometry() {
  console.log('\nGeometry / model');
  const annot = { type: 'rect', x: 10, y: 20, w: 100, h: 50, width: 2 };
  check('bbox of a rectangle', JSON.stringify(RP.render.bbox(annot)) === JSON.stringify({ x: 10, y: 20, w: 100, h: 50 }));
  RP.render.translate(annot, 5, -5);
  check('translate moves in PDF space', annot.x === 15 && annot.y === 15);

  const pen = { type: 'pen', points: [[0, 0], [10, 10], [20, 0]] };
  const box = RP.render.bbox(pen);
  check('bbox of a freehand stroke', box.w === 20 && box.h === 10);
  RP.render.fitToBox(pen, JSON.parse(JSON.stringify(pen)), box, { x: 0, y: 0, w: 40, h: 20 });
  check('resize scales every stroke point', pen.points[1][0] === 20 && pen.points[1][1] === 20);

  // Callouts: the arrow stays pinned while the box moves.
  const callout = { type: 'callout', x: 200, y: 300, w: 160, h: 50, tipX: 100, tipY: 200, width: 1.5 };
  RP.render.translate(callout, 40, 25, 'box');
  check('moving a callout box leaves the arrow anchored',
    callout.x === 240 && callout.y === 325 && callout.tipX === 100 && callout.tipY === 200);
  RP.render.translate(callout, -40, -25, 'all');
  check('dragging the leader moves the whole callout',
    callout.x === 200 && callout.tipX === 60 && callout.tipY === 175);

  const anchor = RP.render.calloutAnchor(callout);
  check('the leader leaves the box edge facing the tip',
    anchor[0] === callout.x && anchor[1] === callout.y + callout.h / 2,
    'anchor ' + JSON.stringify(anchor));
  // (100, 320) sits inside the old box-plus-tip bounding box but is nowhere
  // near the box or the leader, so it must not register as a hit any more.
  check('the callout hit area is the box and leader, not their bounding box',
    RP.render.calloutPart(callout, 210, 320, 3) === 'box' &&
    RP.render.calloutPart(callout, 151, 272, 3) === 'leader' &&
    RP.render.calloutPart(callout, 100, 320, 4) === null);
  check('selection chrome wraps the box only',
    RP.render.selectionRect(callout).w === callout.w);

  const line = [[0, 0], [1, 0.05], [2, 0], [3, 0.04], [4, 0]];
  check('stroke simplification drops redundant points', RP.geom.simplify(line, 0.5).length < line.length);

  RP.store.scale = { pdfLength: 72, realLength: 3, unit: 'm' };
  check('calibrated measurement formatting', RP.store.formatLength(144) === '6.00 m', RP.store.formatLength(144));
  RP.store.scale = null;
  check('uncalibrated falls back to paper inches', RP.store.formatLength(72).startsWith('1.00 in'));
}

/* ---------------------------------------------------------------------------
   Polyline, run length and area

   All of it is pure maths with no DOM, which is what this harness is for. Two
   classes of failure are covered:

   - the arithmetic. A calibration is a *linear* ratio, so an area has to apply
     it twice and square the unit; applying it once is the obvious mistake and
     under-reports a room by the scale factor itself.
   - the refusal. A self-intersecting outline has no area anybody would agree
     on, and the shoelace sum returns the difference of the two lobes — a
     plausible-looking number, which is the dangerous kind on a drawing. It has
     to report that it cannot say, everywhere it reports anything.
   --------------------------------------------------------------------------- */
function testTakeoff() {
  console.log('\nPolyline, run length and area');

  const rect = [[0, 0], [100, 0], [100, 50], [0, 50]];
  check('shoelace area of a known rectangle', RP.geom.polygonArea(rect) === 5000);
  check('and of a known triangle',
    RP.geom.polygonArea([[0, 0], [60, 0], [0, 40]]) === 1200);
  // Winding must not change the answer; only `polygonCentroid` cares about it.
  check('winding the other way reports the same area',
    RP.geom.polygonArea(rect.slice().reverse()) === 5000);

  check('perimeter closes the shape', RP.geom.polygonPerimeter(rect) === 300);
  check('an open run does not', RP.geom.polylineLength(rect) === 250);
  check('a two-point run is just its segment',
    RP.geom.polylineLength([[0, 0], [30, 40]]) === 50);

  check('the centroid is area-weighted, not the mean of the clicks',
    Math.abs(RP.geom.polygonCentroid(rect)[0] - 50) < 1e-9 &&
    Math.abs(RP.geom.polygonCentroid(rect)[1] - 25) < 1e-9);

  // --- self-intersection ----------------------------------------------------
  const bowTie = [[0, 0], [100, 0], [0, 50], [100, 50]];
  check('a bow-tie is detected as self-intersecting', RP.geom.selfIntersects(bowTie, true));
  check('a plain rectangle is not', !RP.geom.selfIntersects(rect, true));
  // Every polygon's edges meet at their shared vertices. Counting a shared
  // endpoint as a crossing would report every shape ever drawn as a bow-tie.
  check('edges meeting at a shared vertex are not a crossing',
    !RP.geom.segmentsCross([0, 0], [10, 0], [10, 0], [10, 10]));
  check('nor is a T where an endpoint lands on a segment',
    !RP.geom.segmentsCross([0, 0], [10, 0], [5, 0], [5, 10]));
  check('a genuine X is', RP.geom.segmentsCross([0, 0], [10, 10], [0, 10], [10, 0]));
  check('and so is a collinear overlap of real length',
    RP.geom.segmentsCross([0, 0], [10, 0], [4, 0], [14, 0]));
  // An L is two edges of an open run, not a closed shape: without the `closed`
  // flag the wrap-around edge does not exist and must not be tested.
  check('an open run is not closed behind your back',
    !RP.geom.selfIntersects([[0, 0], [50, 0], [50, 50], [0, 50]], false));

  check('point-in-polygon admits the interior and rejects the outside',
    RP.geom.pointInPolygon(50, 25, rect) && !RP.geom.pointInPolygon(150, 25, rect));

  // --- what the markups report ---------------------------------------------
  const store = RP.createStore();
  const area = { type: 'area', points: rect, width: 2 };
  const run = { type: 'polylength', points: [[0, 0], [100, 0], [100, 50]], width: 2 };

  store.scale = null;
  // 5000pt² over 72² — a hair under one square inch of paper.
  check('an uncalibrated area reads in paper square inches',
    RP.render.readingOf(area, store).startsWith('0.96 in²'),
    RP.render.readingOf(area, store));

  // 72pt = 3m, so 1pt = 1/24 m and the rectangle is 100/24 x 50/24 m.
  store.scale = { pdfLength: 72, realLength: 3, unit: 'm' };
  check('a calibrated area applies the ratio twice and squares the unit',
    store.formatArea(5000) === '8.68 m²', store.formatArea(5000));
  check('and the length ratio only once, unchanged',
    store.formatLength(144) === '6.00 m');
  check('an area markup reports its area and its perimeter',
    RP.render.readingOf(area, store) === '8.68 m² · Perimeter 12.50 m',
    RP.render.readingOf(area, store));
  check('a run reports its total',
    RP.render.readingOf(run, store) === 'Total 6.25 m', RP.render.readingOf(run, store));
  check('a plain polyline reports nothing — it is a drawing tool, not a ruler',
    RP.render.readingOf({ type: 'polyline', points: rect }, store) === '');

  const crossed = { type: 'area', points: bowTie, width: 2 };
  check('a bow-tie refuses to put a number on itself',
    RP.render.polyArea(crossed) === null);
  check('and says so where the reading goes, perimeter still shown',
    /crosses itself/.test(RP.render.readingOf(crossed, store)) &&
    /Perimeter/.test(RP.render.readingOf(crossed, store)),
    RP.render.readingOf(crossed, store));

  // --- labels on the sheet --------------------------------------------------
  const labels = RP.render.measureLabels(run, store);
  check('each segment of a run is labelled, and the total once',
    labels.filter((l) => l.kind === 'segment').length === 2 &&
    labels.filter((l) => l.kind === 'total').length === 1);
  // A threshold in screen pixels would label a run differently at every zoom
  // and differently again on paper, so it is in points and shared.
  const stubby = { type: 'polylength', points: [[0, 0], [10, 0], [200, 0]], width: 2 };
  check('a segment too short for a plate does not get one',
    RP.render.measureLabels(stubby, store).filter((l) => l.kind === 'segment').length === 1);
  check('a single-segment run is not labelled twice over',
    RP.render.measureLabels({ type: 'polylength', points: [[0, 0], [200, 0]] }, store)
      .filter((l) => l.kind === 'total').length === 0);
  check('an area is labelled once, at its centroid',
    RP.render.measureLabels(area, store).length === 1 &&
    RP.render.measureLabels(area, store)[0].at[0] === 50);
  check('the plates and the list quote the same builder',
    RP.render.measureLabels(area, store)[0].lines.join(' · ') === RP.render.readingOf(area, store));

  // --- geometry the select tool depends on ----------------------------------
  check('the bounding box wraps the vertices',
    JSON.stringify(RP.render.bbox(area)) === JSON.stringify({ x: 0, y: 0, w: 100, h: 50 }));
  check('a washed area is grabbable anywhere inside it',
    RP.render.hitTest(area, 50, 25, 4));
  check('an outline-only one is grabbable on its edge, not in the middle',
    RP.render.hitTest({ type: 'area', points: rect, fill: false }, 0, 25, 4) &&
    !RP.render.hitTest({ type: 'area', points: rect, fill: false }, 50, 25, 4));
  // The closing leg is drawn, so it has to be clickable. `distToPolyline`
  // knows nothing about the shape closing, which is what this covers.
  check('including on the closing leg',
    RP.render.hitTest({ type: 'area', points: rect, fill: false }, 50, 50, 4));
  check('a run is grabbable along its segments only',
    RP.render.hitTest(run, 50, 0, 4) && !RP.render.hitTest(run, 50, 25, 4));

  const moved = { type: 'area', points: JSON.parse(JSON.stringify(rect)) };
  RP.render.translate(moved, 10, -5);
  check('translate moves every vertex',
    moved.points[2][0] === 110 && moved.points[2][1] === 45);

  // Handles are the vertices, not a bounding box: "move this one corner of the
  // room" is the edit anybody actually makes to a takeoff, and a box cannot
  // express it.
  const viewport = {
    scale: 1,
    convertToViewportPoint: (x, y) => [x, 100 - y],
    convertToPdfPoint: (x, y) => [x, 100 - y]
  };
  const handles = RP.render.handlesFor(area, viewport);
  check('every vertex gets a handle and nothing else does',
    handles.length === 4 && handles.map((h) => h.id).join(',') === 'v0,v1,v2,v3');

  // --- the in-progress shape ------------------------------------------------
  // The one gesture in this app that survives a pointer-up, so the whole risk
  // is in what clears it.
  const T = RP.tools;
  const wasStore = RP.store;
  const wasViewer = RP.viewer;
  RP.store = RP.createStore();
  RP.store.scale = { pdfLength: 72, realLength: 3, unit: 'm' };  // skips the calibration prompt
  RP.viewer = { redrawPage() {}, pxToPdf: (px) => px };
  const record = { index: 0 };

  T.setTool('area');
  T.beginPending(record, [0, 0]);
  T.addPendingVertex(record, [100, 0]);
  T.addPendingVertex(record, [100, 50]);
  check('a click per vertex builds the shape', T.pending.points.length === 3);

  T.addPendingVertex(record, [100.5, 50]);
  check('a vertex on top of the last one is absorbed, so a double-click ends where it looked like it did',
    T.pending.points.length === 3);

  T.addPendingVertex({ index: 1 }, [10, 10]);
  check('a press on another sheet cannot extend the shape', T.pending.points.length === 3);

  T.dropLastVertex();
  check('Backspace takes a vertex back', T.pending.points.length === 2);
  T.addPendingVertex(record, [0, 50]);

  check('committing adds exactly one markup', T.commitPending() && RP.store.annotations.length === 1);
  check('and one undo step, not one per vertex', RP.store.history.length === 1);
  check('the committed shape keeps its vertices in PDF space',
    RP.store.annotations[0].points.length === 3 &&
    RP.store.annotations[0].type === 'area');
  check('and the tool hands back to Select like every other one-shot', T.tool === 'select');

  T.setTool('area');
  T.beginPending(record, [0, 0]);
  T.addPendingVertex(record, [50, 0]);
  check('a shape with too few corners is refused rather than half-drawn',
    T.commitPending() && RP.store.annotations.length === 1);

  T.setTool('polylength');
  T.beginPending(record, [0, 0]);
  T.setTool('area');
  check('changing tool abandons the shape the old tool was drawing', T.pending === null);

  T.setTool('area');
  T.beginPending(record, [0, 0]);
  check('Escape abandons it and reports that it did', T.cancelPending() === true);
  check('and Escape with nothing pending says so, so it can fall through',
    T.cancelPending() === false);

  T.setTool('select');
  RP.store = wasStore;
  RP.viewer = wasViewer;

  /* The three bus subscriptions are wired in `Tools.init()`, which needs a real
     DOM, so they are checked at the source rather than by emitting. Switching
     tabs is the dangerous one of the three: a shape that survived it would be
     committed onto the drawing you moved *to*, at coordinates measured on the
     one you left, under a page index that means something else there. */
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8');
  for (const event of ['doc:reset', 'tab:changed', 'pages:rebuilt']) {
    check(`${event} abandons a half-drawn shape`,
      new RegExp("RP\\.bus\\.on\\('" + event + "', \\(\\) => this\\.cancelPending\\(\\)\\)").test(tools));
  }
  check('the rubber band goes through the same draw path as the committed shape',
    /drawPreview\(ctx, record\)[\s\S]{0,900}?RP\.render\.drawAnnotation\(ctx, this\.pendingDraft\(true\)/.test(tools));
  // Escape must not also reset the tool: correcting a shape you misjudged
  // would then cost a trip back to the toolbar every time.
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  check('Escape cancels the shape and stops, ahead of clearing the selection',
    /if \(RP\.tools\.cancelPending\(\)\) return;[\s\S]{0,400}?RP\.tools\.setTool\('select'\)/.test(appSrc));
  check('Backspace takes a vertex back before it deletes anything',
    /if \(RP\.tools\.dropLastVertex\(\)\) return;\s*\n\s*this\.deleteSelection\(\)/.test(appSrc));
}

/* ---------------------------------------------------------------------------
   Review status

   The failure this guards is compatibility in both directions. A drawing saved
   before 0.6 has no `status` at all, and it must open with every markup reading
   as outstanding — not as unset, not filtered out of the list where nobody
   would find it again. And a file this build writes has to survive being opened
   by an older one, which knows nothing about the field.

   The other half is the pair that always drifts in this codebase: the canvas
   and the exporter agreeing on what a resolved markup looks like.
   --------------------------------------------------------------------------- */
/**
 * Arranging a selection, and the markup clipboard.
 *
 * The align maths is the part worth pinning down: PDF space has y pointing
 * *up*, so "align top" is a maximum and "align bottom" is a minimum. Getting
 * that backwards swaps the two commands, which reads as a wiring mistake
 * rather than a sign error and is exactly the kind of bug a screenshot does
 * not settle. The rest is the one-undo-step contract that every bulk command
 * in this app has to keep.
 */
function testArrange() {
  console.log('\nArrange and clipboard');

  const boxes = [
    { x: 10, y: 100, w: 40, h: 20 },   // 10..50   100..120
    { x: 30, y: 200, w: 100, h: 60 },  // 30..130  200..260
    { x: 70, y: 300, w: 20, h: 10 }    // 70..90   300..310
  ];
  const dx = (edge) => RP.edit.alignOffsets(boxes, edge).map((o) => o.dx);
  const dy = (edge) => RP.edit.alignOffsets(boxes, edge).map((o) => o.dy);

  check('align left goes to the leftmost edge', dx('left').join(',') === '0,-20,-60', dx('left').join(','));
  check('align right goes to the rightmost edge', dx('right').join(',') === '80,0,40', dx('right').join(','));
  check('align left moves nothing vertically', dy('left').every((v) => v === 0));
  // y is up: the top of the set is the largest y+h, the bottom the smallest y.
  check('align top is a maximum in PDF space', dy('top').join(',') === '190,50,0', dy('top').join(','));
  check('align bottom is a minimum in PDF space', dy('bottom').join(',') === '0,-100,-200', dy('bottom').join(','));
  check('top and bottom are not the same command',
    dy('top').join(',') !== dy('bottom').join(','));
  // Centres: x spans 10..130 -> 70; y spans 100..310 -> 205.
  check('centre horizontally uses the whole extent',
    dx('hcentre').join(',') === '40,-10,-10', dx('hcentre').join(','));
  check('centre vertically uses the whole extent',
    dy('vcentre').join(',') === '95,-25,-100', dy('vcentre').join(','));
  check('aligning one markup is a no-op',
    RP.edit.alignOffsets([boxes[0]], 'left')[0].dx === 0);
  check('an unrecognised edge moves nothing',
    RP.edit.alignOffsets(boxes, 'sideways').every((o) => !o.dx && !o.dy));

  /* Distribute equalises the *gaps*, not the centres — even centres beside a
     box of a different size leaves visibly uneven space. The two outermost
     stay put, or the command would drift the whole group each time. */
  const spread = [
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 20, y: 0, w: 30, h: 10 },
    { x: 100, y: 0, w: 10, h: 10 }
  ];
  const dist = RP.edit.distributeOffsets(spread, 'x');
  check('distribute leaves the outermost two alone',
    dist[0].dx === 0 && dist[2].dx === 0, JSON.stringify(dist.map((o) => o.dx)));
  const placed = spread.map((b, i) => ({ lo: b.x + dist[i].dx, hi: b.x + dist[i].dx + b.w }));
  const gaps = [placed[1].lo - placed[0].hi, placed[2].lo - placed[1].hi];
  check('distribute equalises the gaps', Math.abs(gaps[0] - gaps[1]) < 1e-9,
    gaps.map((g) => g.toFixed(2)).join(' vs '));
  check('distribute needs three markups',
    RP.edit.distributeOffsets(spread.slice(0, 2), 'x').every((o) => !o.dx && !o.dy));
  // Offsets come back in the caller's order, not sorted, so they zip straight
  // onto the selection they were measured from.
  const scrambled = [spread[2], spread[0], spread[1]];
  const scrambledOut = RP.edit.distributeOffsets(scrambled, 'x');
  check('distribute answers in the order it was asked',
    scrambledOut[0].dx === 0 && scrambledOut[1].dx === 0,
    JSON.stringify(scrambledOut.map((o) => o.dx)));

  /* Match size keeps the *screen* top-left — x and y+h — so a column of boxes
     grows down and right from where each already sits rather than jumping. */
  const sized = RP.edit.sizeTargets(boxes);
  check('match size takes the largest of each dimension',
    sized.every((b) => b.w === 100 && b.h === 60), JSON.stringify(sized[0]));
  check('match size keeps the top edge put',
    sized.every((b, i) => Math.abs((b.y + b.h) - (boxes[i].y + boxes[i].h)) < 1e-9),
    sized.map((b) => (b.y + b.h).toFixed(0)).join(','));
  const widthOnly = RP.edit.sizeTargets(boxes, { height: false });
  check('match width alone leaves the heights alone',
    widthOnly.every((b, i) => b.w === 100 && b.h === boxes[i].h));

  // --- the commands, against a real store -----------------------------------
  const store = RP.createStore();
  const saved = RP.store;
  RP.store = store;

  store.load([
    { page: 0, type: 'rect', x: 10, y: 100, w: 40, h: 20, color: '#ff0000', width: 2 },
    { page: 0, type: 'rect', x: 30, y: 200, w: 100, h: 60, color: '#00ff00', width: 5 },
    { page: 1, type: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#0000ff', width: 1 }
  ]);
  const [a, b, other] = store.annotations;

  for (const id of [a.id, b.id]) store.selection.add(id);
  let depth = store.history.length;
  const moved = RP.edit.align('left');
  check('align reports what it moved', moved === 1, moved + ' markup(s)');
  check('align lines the selection up', a.x === 10 && b.x === 10, a.x + ',' + b.x);
  check('aligning a selection is one undo step',
    store.history.length === depth + 1, store.history.length - depth + ' checkpoints');
  store.undo();
  check('undo puts the whole selection back', b.x === 30 || store.annotations[1].x === 30,
    String(store.annotations[1].x));

  /* A run that changes nothing must not leave a dead step in the history —
     Ctrl+Z after aligning an already-aligned selection would otherwise appear
     to do nothing at all. */
  store.selection.clear();
  for (const id of store.annotations.map((x) => x.id).slice(0, 2)) store.selection.add(id);
  RP.edit.align('left');
  depth = store.history.length;
  RP.edit.align('left');
  check('an align that changes nothing leaves no history step',
    store.history.length === depth, store.history.length - depth + ' checkpoints');

  /* Arranging across sheets is refused rather than attempted: the coordinates
     are per page, so it would "work" and silently move a markup on a sheet the
     user cannot see. The markup list can select across pages. */
  store.selection.clear();
  store.selection.add(store.annotations[0].id);
  store.selection.add(store.annotations[2].id);
  const crossPage = store.annotations[2].x;
  check('arranging across sheets is refused',
    RP.edit.align('left') === 0 && store.annotations[2].x === crossPage);
  check('the arrange menu is not offered across sheets',
    RP.edit.menuItems(null).length === 0);

  // Match style pushes appearance, never geometry or text.
  store.selection.clear();
  const src = store.annotations[0];
  const dst = store.annotations[1];
  const dstBefore = { x: dst.x, y: dst.y, w: dst.w, h: dst.h };
  store.selection.add(src.id);
  store.selection.add(dst.id);
  RP.edit.matchStyle(src.id);
  check('match style copies the source appearance',
    dst.color === src.color && dst.width === src.width, dst.color + ' / ' + dst.width);
  check('match style leaves geometry alone',
    dst.x === dstBefore.x && dst.w === dstBefore.w && dst.h === dstBefore.h);
  check('match style copies appearance only, never text or status',
    RP.edit.STYLE_FIELDS.indexOf('color') !== -1 &&
    RP.edit.STYLE_FIELDS.indexOf('text') === -1 &&
    RP.edit.STYLE_FIELDS.indexOf('status') === -1);
  /* Applicability is decided per type, not by asking whether the target already
     carries the key. The shortcut fails in both directions: a `fontSize` handed
     to a pen stroke is a field nothing reads that the exporter then writes into
     the file for ever, and a callout that has never been given an explicit text
     colour has no `textColor` at all — and is exactly the callout being
     restyled. */
  check('a typography field is refused on a type that cannot show it',
    RP.edit.styleApplies('fontSize', 'callout') && !RP.edit.styleApplies('fontSize', 'pen') &&
    RP.edit.styleApplies('textColor', 'callout') && !RP.edit.styleApplies('textColor', 'rect') &&
    RP.edit.styleApplies('fill', 'rect') && !RP.edit.styleApplies('fill', 'line') &&
    RP.edit.styleApplies('color', 'note'));
  {
    const bare = store.add({ page: 0, type: 'callout', x: 0, y: 0, w: 100, h: 40, tipX: 0, tipY: 0, text: 'x' });
    const styled = store.add({
      page: 0, type: 'callout', x: 200, y: 0, w: 100, h: 40, tipX: 200, tipY: 0,
      text: 'y', textColor: '#0044cc', fontSize: 9
    });
    const pen = store.add({ page: 0, type: 'pen', points: [[0, 0], [1, 1]], color: '#000000' });
    store.selection.clear();
    for (const x of [styled, bare, pen]) store.selection.add(x.id);
    RP.edit.matchStyle(styled.id);
    check('match style reaches a field the target did not have',
      bare.textColor === '#0044cc' && bare.fontSize === 9,
      bare.textColor + ' / ' + bare.fontSize);
    check('match style puts no dead field on a type that cannot use it',
      pen.fontSize === undefined && pen.textColor === undefined,
      JSON.stringify({ fontSize: pen.fontSize, textColor: pen.textColor }));
    // A callout's box is sized from its text in its own face, so a new size has
    // to re-fit it or the box stops matching what is drawn in it.
    check('a restyled callout is re-fitted to its new face',
      Math.abs(bare.h - RP.render.fitCallout(bare).h) < 1e-6,
      bare.h + ' vs ' + RP.render.fitCallout(bare).h);
    store.remove([bare.id, styled.id, pen.id]);
  }
  check('match size only offers types with a box the user drew',
    RP.edit.SIZEABLE.indexOf('rect') !== -1 && RP.edit.SIZEABLE.indexOf('line') === -1 &&
    RP.edit.SIZEABLE.indexOf('highlight') === -1);

  // --- clipboard ------------------------------------------------------------
  store.load([
    { page: 0, type: 'text', x: 100, y: 200, text: 'RJ', fontSize: 12, status: 'closed' },
    { page: 0, type: 'rect', x: 100, y: 150, w: 30, h: 10 }
  ]);
  store.selection.clear();
  for (const annot of store.annotations) store.selection.add(annot.id);
  /* Copying markups also writes their readings to the OS clipboard, which goes
     through the preload bridge — stub it, and record what it was handed, so
     both halves of the copy are actually checked rather than one of them
     throwing into a `catch` and being reported as a success. */
  const keptRp = global.window.rp;
  const written = [];
  global.window.rp = { clipboard: { writeText: async (text) => { written.push(text); } } };
  RP.edit.copy();
  global.window.rp = keptRp;
  check('the buffer holds the selection', RP.edit.buffer.annots.length === 2);
  /* Identity is stripped on the way *in*. A buffer holding live ids could be
     pasted back into the drawing it came from and produce two markups claiming
     one id, which the selection set and every `store.get` would disagree about. */
  /* Copying markups fills the markup buffer *and* writes their readings to the
     OS clipboard, because those are two different clipboards serving two
     different pastes — back onto a drawing, and into an email or an RFI. It is
     the reason the markup buffer is internal: share one clipboard and one of
     the two uses has to lose. */
  check('copying markups also writes their readings out as text',
    written.length === 1 && /RJ/.test(written[0]),
    JSON.stringify(written[0] || null));
  check('the buffer carries no identity',
    RP.edit.buffer.annots.every((x) => !x.id && !x.created && !x.modified),
    JSON.stringify(Object.keys(RP.edit.buffer.annots[0])));

  const countBefore = store.annotations.length;
  depth = store.history.length;
  const pasted = RP.edit.paste(1, [400, 500]);
  check('paste lands the whole buffer', pasted === 2 && store.annotations.length === countBefore + 2);
  check('pasting is one undo step',
    store.history.length === depth + 1, store.history.length - depth + ' checkpoints');
  const fresh = store.forPage(1);
  check('paste goes onto the page it was given', fresh.length === 2);
  /* Centred on the point, and the relative layout of the set is preserved —
     that is what makes a copied group of markups a stamp rather than a pile. */
  const union = RP.geom.unionRect(fresh.map((x) => RP.edit.boxOf(x)));
  check('paste centres the group on the point',
    Math.abs((union.x + union.w / 2) - 400) < 1e-6 &&
    Math.abs((union.y + union.h / 2) - 500) < 1e-6,
    (union.x + union.w / 2).toFixed(2) + ',' + (union.y + union.h / 2).toFixed(2));
  const srcUnion = RP.geom.unionRect(store.forPage(0).map((x) => RP.edit.boxOf(x)));
  check('paste keeps the group its original size',
    Math.abs(union.w - srcUnion.w) < 1e-6 && Math.abs(union.h - srcUnion.h) < 1e-6);
  check('a pasted markup is a new item on the punch list',
    fresh.every((x) => x.status === 'open'), fresh.map((x) => x.status).join(','));
  check('the paste becomes the selection',
    store.selection.size === 2 && fresh.every((x) => store.selection.has(x.id)));
  // The same buffer pastes again, which is the whole point of stamping.
  check('the buffer survives a paste', RP.edit.hasBuffer() && RP.edit.paste(1, [50, 60]) === 2);

  /* With nowhere to point at — the pointer off the sheet, or a paste from the
     keyboard with the mouse in the sidebar — the copy is nudged off the
     original rather than landing exactly on top of it, where it would be
     invisible and impossible to pick up. */
  const nudged = RP.edit.pasteOffset([{ x: 10, y: 10, w: 5, h: 5 }], null);
  check('a paste with no target is nudged, not stacked',
    nudged.dx === RP.edit.PASTE_NUDGE && nudged.dy === -RP.edit.PASTE_NUDGE);

  RP.store = saved;
}

/**
 * Grouping.
 *
 * A group is one shared `group` string and nothing else, so almost every
 * behaviour below is a consequence of the selection expanding rather than of a
 * command: move, delete, status, style and copy all read the selection and none
 * of them has heard of groups. What is checked here is therefore the expansion
 * itself, the places that write into `store.selection` without going through it,
 * and the two operations that duplicate markups — paste and duplicate-page —
 * which have to hand the copy a group id of its own.
 */
function testGrouping() {
  console.log('\nGrouping');

  check('a missing group reads as none', RP.groupOf({ type: 'rect' }) === null);
  check('an empty group string is no group', RP.groupOf({ group: '' }) === null);
  check('a non-string group is no group', RP.groupOf({ group: 3 }) === null);

  const store = RP.createStore();
  const saved = RP.store;
  RP.store = store;

  store.load([
    { page: 0, type: 'rect', x: 10, y: 100, w: 40, h: 20, color: '#f00', width: 2 },
    { page: 0, type: 'rect', x: 100, y: 100, w: 40, h: 20, color: '#0f0', width: 2 },
    { page: 0, type: 'rect', x: 200, y: 100, w: 40, h: 20, color: '#00f', width: 2 },
    { page: 1, type: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#fff', width: 1 }
  ]);
  const [a, b, c, other] = store.annotations;

  // --- the command ----------------------------------------------------------
  store.selection.add(a.id);
  check('grouping needs two markups', RP.edit.group() === 0 && !RP.groupOf(a));

  store.selection.add(other.id);
  check('grouping across sheets is refused',
    RP.edit.group() === 0 && !RP.groupOf(a) && !RP.groupOf(other));
  check('the group menu is not offered across sheets',
    RP.edit.groupMenuItems().length === 0);

  store.selection.clear();
  store.selection.add(a.id);
  store.selection.add(b.id);
  let depth = store.history.length;
  check('grouping reports what it grouped', RP.edit.group() === 2);
  check('grouping is one undo step', store.history.length === depth + 1);
  check('a group is one shared id',
    RP.groupOf(a) && RP.groupOf(a) === RP.groupOf(b), String(a.group));
  check('grouping leaves the rest alone', !RP.groupOf(c));

  // Already one whole group: nothing to do, and no dead history step for
  // Ctrl+Z to walk back through.
  depth = store.history.length;
  check('regrouping the same set changes nothing', RP.edit.group() === 0);
  check('a group that changed nothing leaves no history step',
    store.history.length === depth, store.history.length - depth + ' checkpoints');

  // --- selection expansion --------------------------------------------------
  store.select(a.id);
  check('selecting one member selects the group',
    store.selection.size === 2 && store.selection.has(b.id));
  store.select(c.id);
  check('selecting a loose markup selects only it',
    store.selection.size === 1 && store.selection.has(c.id));

  /* Shift-click toggles a group as a unit, and the *clicked* markup decides
     which way — reading each member's own state would let a group that somehow
     disagreed invert into a different half of itself. */
  store.selection.clear();
  store.toggleSelect(a.id);
  check('shift-clicking a member takes the whole group', store.selection.size === 2);
  store.toggleSelect(b.id);
  check('shift-clicking it again drops the whole group', store.selection.size === 0);

  /* The marquee and Ctrl+A write into the selection without going through
     `select`, which is exactly how a group gets half-selected and then dragged
     apart. Both go through `addToSelection`. */
  store.selection.clear();
  store.addToSelection([a.id]);
  check('adding one member adds the group',
    store.selection.size === 2 && store.selection.has(b.id));

  // --- moving and arranging -------------------------------------------------
  store.selection.clear();
  store.select(a.id);
  for (const annot of store.selected()) RP.render.translate(annot, 5, -7);
  check('a group moves as one thing',
    a.x === 15 && b.x === 105 && a.y === 93 && b.y === 93, a.x + ',' + b.x);
  for (const annot of store.selected()) RP.render.translate(annot, -5, 7);

  // --- ungroup --------------------------------------------------------------
  store.selection.clear();
  check('ungrouping nothing is refused', RP.edit.ungroup() === 0);
  store.select(a.id);
  check('ungrouping frees every member', RP.edit.ungroup() === 2);
  check('ungrouped markups carry no group', !RP.groupOf(a) && !RP.groupOf(b));
  check('the group field is deleted, not blanked',
    !('group' in a), JSON.stringify(Object.keys(a)));

  // --- orphans --------------------------------------------------------------
  /* A group of one is not a group: it would draw a frame around a single
     markup, offer Ungroup on something that looks ungrouped, and ride into the
     saved file for ever. Deleting part of a group is how you make one. */
  store.selection.clear();
  store.selection.add(a.id);
  store.selection.add(b.id);
  RP.edit.group();
  store.remove([b.id]);
  check('deleting all but one of a group ungroups the survivor', !RP.groupOf(a));
  check('a group of one is dropped on load',
    (() => {
      const s = RP.createStore();
      s.load([{ page: 0, type: 'rect', x: 0, y: 0, w: 1, h: 1, group: 'g1' }]);
      return !RP.groupOf(s.annotations[0]);
    })());

  // --- the clipboard --------------------------------------------------------
  // `b` was deleted by the orphan check above, so the group here is a + c.
  store.selection.clear();
  store.selection.add(a.id);
  store.selection.add(c.id);
  RP.edit.group();
  const groupId = a.group;
  store.select(a.id);
  const keptRp = global.window.rp;
  global.window.rp = { clipboard: { writeText: async () => {} } };
  RP.edit.copy();
  global.window.rp = keptRp;
  check('the buffer keeps the grouping', RP.edit.buffer.annots.every((x) => x.group === groupId));

  RP.edit.paste(0, [400, 400]);
  const pasted = store.selected();
  check('a paste is still one group',
    pasted.length === 2 && RP.groupOf(pasted[0]) &&
    RP.groupOf(pasted[0]) === RP.groupOf(pasted[1]));
  /* Re-keyed, not carried across. A copy sharing the source's group id would
     join the original's group, so dragging the copy would drag the markups it
     was copied from — possibly on another sheet, or in another drawing. */
  check('a pasted group is its own group', RP.groupOf(pasted[0]) !== groupId,
    RP.groupOf(pasted[0]) + ' vs ' + groupId);
  check('the source group is untouched', RP.groupOf(a) === groupId);

  // One member copied on its own arrives loose — that is how a group of one
  // would otherwise be made, and `store.load` would only have to undo it.
  store.selection.clear();
  store.selection.add(a.id);
  global.window.rp = { clipboard: { writeText: async () => {} } };
  RP.edit.copy();
  global.window.rp = keptRp;
  RP.edit.paste(0, [500, 500]);
  check('half a group pastes as loose markups',
    store.selected().every((x) => !RP.groupOf(x)));

  // --- duplicating a page ---------------------------------------------------
  /* `remapAnnotations` copies markups onto a duplicated sheet. Carrying the
     group id would make one group span two pages, which nothing else in the
     app can produce and a group drag would then act on invisibly. */
  const dupSrc = [
    { id: 'm1', page: 0, type: 'rect', x: 0, y: 0, w: 5, h: 5, group: 'gA' },
    { id: 'm2', page: 0, type: 'rect', x: 9, y: 0, w: 5, h: 5, group: 'gA' }
  ];
  const duped = RP.pages.remapAnnotations(dupSrc, [0, 1], [{ from: 0, to: 1 }]);
  const onOne = duped.filter((x) => x.page === 1);
  check('a duplicated page keeps its markups grouped',
    onOne.length === 2 && RP.groupOf(onOne[0]) === RP.groupOf(onOne[1]));
  check('a duplicated page gets a group of its own',
    RP.groupOf(onOne[0]) !== 'gA', String(onOne[0].group));

  // --- the frame and the group resize --------------------------------------
  /* The frame is built from `selectionRect`, so a callout is framed by its box
     and not by the reach of its leader — six callouts pointing outward would
     otherwise give the group a frame several times what was drawn. */
  const framed = [
    { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    { type: 'callout', x: 40, y: 20, w: 20, h: 10, tipX: -500, tipY: -500, text: 'x' }
  ];
  const box = RP.render.groupBox(framed);
  check('the group box ignores a callout leader',
    box.x === 0 && box.y === 0 && box.w === 60 && box.h === 30, JSON.stringify(box));
  check('a group has eight handles and no vertex or tip handles',
    RP.render.groupHandles(box, stubViewport()).length === 8);

  /* `fitToBox` cannot take the group's boxes directly — for a rect or a
     callout it assigns `next` wholesale, so every boxed member would come out
     filling the whole frame. Each member's own box is mapped through the group
     transform first. */
  const members = [
    { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    { type: 'rect', x: 30, y: 0, w: 10, h: 10 }
  ];
  const origs = members.map((m) => JSON.parse(JSON.stringify(m)));
  const prev = RP.render.groupBox(origs);          // 0,0 40x10
  RP.render.fitGroup(members, origs, prev, { x: 0, y: 0, w: 80, h: 20 });
  check('a group resize scales every member',
    members[0].w === 20 && members[1].w === 20 && members[0].h === 20,
    JSON.stringify(members));
  check('a group resize keeps the members apart',
    members[1].x === 60, String(members[1].x));
  check('no member is stretched to the whole frame',
    members[0].w < 80, String(members[0].w));

  // A note is a fixed-size pin, so a group resize moves it without giving it a
  // width and a height that `bbox` would then contradict.
  const pin = { type: 'note', x: 20, y: 20 };
  const pinOrig = JSON.parse(JSON.stringify(pin));
  RP.render.fitGroup([pin], [pinOrig], { x: 0, y: 0, w: 40, h: 40 }, { x: 0, y: 0, w: 80, h: 80 });
  check('a group resize moves a note without sizing it',
    pin.x === 40 && pin.w === undefined, JSON.stringify(pin));

  // A callout's tip moves with a group resize — unlike a single resize, where
  // it stays pinned to whatever it points at.
  const call = { type: 'callout', x: 0, y: 0, w: 10, h: 10, tipX: 20, tipY: 0, text: '' };
  const callOrig = JSON.parse(JSON.stringify(call));
  RP.render.fitGroup([call], [callOrig], { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 20, h: 10 });
  check('a group resize takes the callout leader with it',
    call.tipX === 40, String(call.tipX));

  // --- persistence ----------------------------------------------------------
  const model = store.serialize();
  check('the embedded model is at version 5', model.version === 5, String(model.version));
  check('the model carries the group field',
    model.annotations.some((x) => RP.groupOf(x)),
    JSON.stringify(model.annotations.map((x) => x.group || null)));
  const reopened = RP.createStore();
  reopened.load(model.annotations);
  const backGroups = new Set(reopened.annotations.map((x) => RP.groupOf(x)).filter(Boolean));
  check('groups survive a round trip through the model', backGroups.size >= 1,
    backGroups.size + ' group(s)');

  RP.store = saved;
}

/** A viewport that does nothing but scale, for the pure geometry checks. */
function stubViewport() {
  return {
    scale: 1,
    width: 612,
    height: 792,
    convertToViewportPoint: (x, y) => [x, 792 - y],
    convertToPdfPoint: (x, y) => [x, 792 - y]
  };
}

function testMarkupStatus() {
  console.log('\nMarkup status');

  check('an absent status reads as open', RP.statusOf({ type: 'rect' }) === 'open');
  check('an empty annotation reads as open', RP.statusOf(null) === 'open');
  // A file from a later version could carry a status this build has no case
  // for. Drawing nothing, or hiding it from the list, would lose the markup.
  check('an unknown status falls back to open',
    RP.statusOf({ status: 'deferred' }) === 'open', 'deferred -> ' + RP.statusOf({ status: 'deferred' }));
  check('a real status is kept', RP.statusOf({ status: 'rejected' }) === 'rejected');

  const store = RP.createStore();
  const saved = RP.store;
  RP.store = store;

  const fresh = store.add({ page: 0, type: 'rect', x: 0, y: 0, w: 10, h: 10 });
  check('a new markup starts open', fresh.status === 'open');

  // The 0.5 case: markups arriving from a file that predates the field.
  store.load([
    { page: 0, type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    { page: 0, type: 'cloud', x: 0, y: 0, w: 10, h: 10, status: 'closed' },
    { page: 0, type: 'note', x: 0, y: 0, status: 'nonsense' }
  ]);
  check('markups saved before 0.6 load as open', RP.statusOf(store.annotations[0]) === 'open');
  check('a saved status survives loading', store.annotations[1].status === 'closed');
  check('a nonsense status is normalised on load', store.annotations[2].status === 'open');

  // One undo step for a whole selection, not one per markup.
  const ids = store.annotations.map((a) => a.id);
  const depth = store.history.length;
  const changed = store.setStatus(ids, 'closed');
  check('setStatus reports how many it moved', changed === 2, changed + ' of 3 (one was already closed)');
  check('closing out a selection is a single undo step',
    store.history.length === depth + 1, store.history.length - depth + ' checkpoints');
  store.undo();
  check('undo restores every status at once',
    store.annotations.map((a) => a.status).join(',') === 'open,closed,open',
    store.annotations.map((a) => a.status).join(','));
  /* Reads coerce an unknown status to 'open' so the markup still draws and
     still lists. Writes must not: coercing here would let a typo reopen a
     closed item, which is the one thing a punch list cannot survive. */
  const before = store.annotations[1].status;
  const depthBefore = store.history.length;
  check('setStatus refuses a status that does not exist',
    store.setStatus(ids, 'banana') === 0 &&
    store.annotations[1].status === before &&
    store.history.length === depthBefore,
    'annotation 2 stayed ' + store.annotations[1].status);

  store.setStatus([ids[0]], 'rejected');
  const counts = store.statusCounts();
  check('status counts tally', counts.open === 1 && counts.closed === 1 && counts.rejected === 1,
    JSON.stringify(counts));

  const payload = store.serialize();
  check('the embedded model declares version 5', payload.version === 5, 'version ' + payload.version);
  check('status is part of the embedded model',
    payload.annotations.every((a) => typeof a.status === 'string'));
  check('the numbering spec is a document-level field, not a per-markup one',
    'numbering' in payload && !payload.annotations.some((a) => 'numbering' in a));

  /* Why an older build does not lose this: `load` and `serialize` both copy
     whole annotation objects, so a field 0.5 has never heard of rides through
     its round trip untouched. Only the version number walks back to 2. The
     BACKLOG entry guessed the field would be dropped; it is not, and the
     changelog says so on the strength of this check. */
  const roundTripped = { id: 'x', page: 0, type: 'rect', status: 'rejected', futureField: 42 };
  store.load([roundTripped]);
  const out = store.serialize().annotations[0];
  check('an unknown field survives a load/serialize round trip',
    out.futureField === 42 && out.status === 'rejected');

  // --- the shared rendering rule -------------------------------------------

  const open = { type: 'rect', x: 100, y: 200, w: 200, h: 80, status: 'open' };
  const closed = Object.assign({}, open, { status: 'closed' });
  const rejected = Object.assign({}, open, { status: 'rejected' });

  check('an open markup is not faded', RP.render.statusAlpha(open) === 1);
  check('a closed markup is faded', RP.render.statusAlpha(closed) === RP.render.STATUS_FADE);
  check('a rejected markup is faded too', RP.render.statusAlpha(rejected) === RP.render.STATUS_FADE);
  check('only a rejected markup is struck',
    !RP.render.statusStruck(open) && !RP.render.statusStruck(closed) && RP.render.statusStruck(rejected));

  // The canvas and the exporter both draw this line; it is defined once, in
  // PDF space, so the two cannot disagree about where it goes.
  const strike = RP.render.statusStrikeLine(rejected);
  check('the rejected rule spans the markup and sits on its middle',
    strike.x1 === 100 && strike.x2 === 300 && strike.y1 === 240 && strike.y2 === 240,
    JSON.stringify(strike));
  check('the rule weight is clamped at both ends',
    RP.render.statusStrikeLine({ type: 'rect', x: 0, y: 0, w: 10, h: 2 }).width === 1.5 &&
    RP.render.statusStrikeLine({ type: 'rect', x: 0, y: 0, w: 10, h: 4000 }).width === 4);
  // A callout is struck through its box, not through the bounding box that
  // also contains the arrow tip — the same rect the selection chrome wraps.
  const callout = { type: 'callout', x: 300, y: 400, w: 100, h: 40, tipX: 50, tipY: 50, status: 'rejected' };
  check('a callout is struck through its box, not its leader',
    RP.render.statusStrikeLine(callout).x1 === 300 &&
    RP.render.statusStrikeLine(callout).x2 === 400);

  // --- the markup list ------------------------------------------------------

  store.load([
    { page: 0, type: 'rect', x: 0, y: 0, w: 10, h: 10, note: 'alpha' },
    { page: 0, type: 'cloud', x: 0, y: 0, w: 10, h: 10, note: 'beta', status: 'closed' },
    { page: 1, type: 'cloud', x: 0, y: 0, w: 10, h: 10, note: 'gamma', status: 'rejected' }
  ]);
  RP.sidebar.status = 'all';
  RP.sidebar.filter = '';
  check('the list shows everything by default', RP.sidebar.visibleAnnotations().length === 3);
  RP.sidebar.status = 'open';
  check('the status filter narrows the list',
    RP.sidebar.visibleAnnotations().length === 1 &&
    RP.sidebar.visibleAnnotations()[0].note === 'alpha');
  RP.sidebar.status = 'all';
  RP.sidebar.filter = 'rejected';
  check('the text filter can match on status',
    RP.sidebar.visibleAnnotations().length === 1 &&
    RP.sidebar.visibleAnnotations()[0].note === 'gamma');
  // ...but the status must not have been folded into the row's own text, or it
  // would be printed twice on screen to be typeable once.
  check('status is not folded into the row description',
    !/rejected/i.test(RP.sidebar.describe(store.annotations[2])),
    RP.sidebar.describe(store.annotations[2]));

  /* The leak the stash pair exists to stop: a filter set on one drawing must
     not narrow another one's list the moment you switch to it. */
  const stashed = RP.sidebar.stash();
  RP.sidebar.unstash(null);
  check('a new tab starts with an unfiltered list',
    RP.sidebar.status === 'all' && RP.sidebar.filter === '' && RP.sidebar.sort === 'page');
  RP.sidebar.unstash(stashed);
  check('switching back restores the list state',
    RP.sidebar.status === 'all' && RP.sidebar.filter === 'rejected');
  RP.sidebar.unstash(null);

  RP.store = saved;
}

/**
 * Arming a tool.
 *
 * A markup tool is a one-shot: it draws one markup and hands back to Select.
 * The behaviour this replaced left the tool armed, so the click meant to
 * select the callout you had just drawn started a second one on top of it.
 *
 * Arming the armed tool toggles a lock, for the runs of clouds and dimensions
 * where the one-shot would be the annoyance instead. Two things have to hold:
 * a *finished* markup is what hands the tool back — a drag too small to become
 * one must leave the tool where it was — and Select itself is never locked.
 */
function testToolArming() {
  console.log('\nTool arming');

  const T = RP.tools;
  const wasStore = RP.store;
  RP.store = RP.createStore();

  T.setTool('select');
  T.setTool('callout');
  check('arming a tool from Select does not lock it', T.tool === 'callout' && !T.sticky);

  T.afterCreate();
  check('one markup hands the tool back to Select', T.tool === 'select');

  T.setTool('callout');
  T.setTool('callout');
  check('arming the armed tool locks it on', T.tool === 'callout' && T.sticky === true);

  T.afterCreate();
  T.afterCreate();
  check('a locked tool stays armed across markups', T.tool === 'callout' && T.sticky === true);

  T.setTool('callout');
  check('arming it once more unlocks it, so it cannot get stuck', !T.sticky);

  T.setTool('callout');
  T.setTool('rect');
  check('picking a different tool drops the lock', T.tool === 'rect' && !T.sticky);

  // Select is where a one-shot lands, so locking it would mean nothing and a
  // second press on it must not quietly turn the lock on for the next tool.
  T.setTool('select');
  T.setTool('select');
  check('Select never locks', T.tool === 'select' && !T.sticky);

  T.afterCreate();
  check('afterCreate stands down under Select', T.tool === 'select' && !T.sticky);

  T.setTool('select');
  RP.store = wasStore;

  // --- wiring ---------------------------------------------------------------
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');

  // A draft that came out under the minimum size returns *before* the markup
  // is added; the hand-back has to sit after that, or a slipped click disarms
  // the tool you were about to use.
  check('a draft too small to become a markup leaves the tool armed',
    /finishDraft\(drag\)[\s\S]*?RP\.store\.add\(draft\)[\s\S]{0,600}?this\.afterCreate\(\);/.test(tools));
  // Text and callout defer to `closeInlineText` instead, because the toolbar's
  // typography group goes away the moment the tool stops being text-ish.
  check('a callout hands back only once its text is committed',
    /if \(made\) this\.afterCreate\(\);/.test(tools)
    && /openInlineText\(drag\.record[^\n]*\);\s*\n\s*return;/.test(tools));
  check('a locked tool looks different from a merely armed one',
    /\.tools \.tbtn\.locked::after/.test(css));

  // The typography controls are part of the edit. Clicking one blurs the
  // editor, and committing on that blur would close the markup before the
  // control's `change` ever fired — the restyle would land on nothing.
  check('the editor survives a click onto the typography controls',
    /closest\('#textOptsGroup'\)\) return;/.test(tools));
  check('the markup being typed into is what the controls restyle',
    /this\.inlineEdit \? this\.inlineEdit\.annot : null/.test(tools));
  // Re-fitting off `annot.text` would size the box to what it held *before*
  // this edit, which on a callout being created is the empty string.
  check('a live callout is re-fitted to the text in the editor',
    /annot === live \? this\.inlineText\.value : annot\.text/.test(tools));
  check('and the editor is re-placed to the box it now has',
    /this\.placeInlineText\(\);\s*\n\s*this\.inlineText\.focus\(\);/.test(tools));
  // Double-clicking a callout to re-word it happens under Select, where the
  // group would otherwise be hidden.
  check('the typography group is up for as long as an editor is',
    /this\.tool === 'callout' \|\| !!this\.inlineEdit/.test(tools));
}

/**
 * A callout's box is sized from its text, so the sizing and the drawing have
 * to wrap identically. They did not: the box was measured in points against a
 * 4pt inset while the canvas wrapped in pixels against a *fixed* 4px one, so
 * at some zooms the drawn text needed a line the box had not been sized for
 * and the overflow landed under the box instead of inside it.
 */
function testCalloutText() {
  console.log('\nCallout text fitting');
  const text = 'Replace this 20A breaker with a 30A per revised load calc and update the panel schedule';

  const escaped = [];
  for (const zoom of [0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3]) {
    // Boxes are drawn at a fixed on-screen size, so their point size is a
    // function of the zoom they were drawn at — which is exactly the axis the
    // old mismatch varied along.
    const annot = {
      type: 'callout', page: 0, text, fontSize: 11, width: 2,
      x: 100, y: 600, w: 200 / zoom, h: 56 / zoom, tipX: 60, tipY: 560
    };
    Object.assign(annot, RP.render.fitCallout(annot));

    const drawn = [];
    const pageHeight = 792;
    const viewport = {
      scale: zoom,
      convertToViewportPoint: (x, y) => [x * zoom, (pageHeight - y) * zoom]
    };
    RP.render.drawAnnotation(measuringContext(drawn), annot, viewport, {});

    const box = drawn.find((d) => d.kind === 'box');
    const lines = drawn.filter((d) => d.kind === 'text');
    const bottom = box.y + box.h;
    const spilled = lines.filter((l) => l.y < box.y - 0.01 || l.y + l.size > bottom + 0.01);
    if (!lines.length || spilled.length) escaped.push(`zoom ${zoom} (${spilled.length}/${lines.length})`);
  }
  check('callout text stays inside its box at every zoom', escaped.length === 0, escaped.join(', '));

  // Hard newlines are part of the text: the box has to allow for them, and
  // they must not be flattened into a single run on the way to the canvas.
  const wrapped = RP.render.wrapLines('Panel LP-1\nSee note 4', 400, (s) => s.length * 5.5);
  check('callout wrapping honours hard newlines', wrapped.length === 2 && wrapped[1] === 'See note 4',
    JSON.stringify(wrapped));

  const oneLine = RP.render.measureCalloutHeight('Panel LP-1', 200, 11);
  const twoLines = RP.render.measureCalloutHeight('Panel LP-1\nSee note 4', 200, 11);
  check('a second paragraph makes the box taller', twoLines > oneLine,
    `${oneLine} -> ${twoLines}`);

  // The inline editor is placed over the box, so it has to be placed from the
  // same rotation-aware rect the box is *drawn* from. Converting the single
  // top-left PDF corner agrees only at /Rotate 0; on a plotted landscape sheet
  // it lands on a different corner and the editor opens away from its box.
  const rotations = [0, 90, 180, 270];
  const sheet = { w: 612, h: 792 };
  const cal = { type: 'callout', x: 100, y: 600, w: 200, h: 56, tipX: 60, tipY: 560, text: 'x', fontSize: 11 };
  const mismatched = [];
  const strayCorner = [];
  for (const rotation of rotations) {
    const s = 1;
    const transforms = {
      0: [s, 0, 0, -s, 0, sheet.h * s],
      90: [0, s, s, 0, 0, 0],
      180: [-s, 0, 0, s, sheet.w * s, 0],
      270: [0, -s, -s, 0, sheet.h * s, sheet.w * s]
    };
    const t = transforms[rotation];
    const viewport = {
      scale: s,
      convertToViewportPoint: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]
    };
    const drawn = [];
    RP.render.drawAnnotation(measuringContext(drawn), cal, viewport, {});
    const painted = drawn.find((d) => d.kind === 'box');
    const rect = RP.render.vpRect(viewport, RP.render.calloutBox(cal));
    if (Math.abs(rect.x - painted.x) > 0.01 || Math.abs(rect.y - painted.y) > 0.01) {
      mismatched.push('rotate ' + rotation);
    }
    // The old single-corner anchor: kept here so the reason the rect is needed
    // stays visible — it must diverge everywhere except /Rotate 0.
    const corner = viewport.convertToViewportPoint(cal.x, cal.y + cal.h);
    const agrees = Math.abs(corner[0] - painted.x) < 0.01 && Math.abs(corner[1] - painted.y) < 0.01;
    if (rotation !== 0 && agrees) strayCorner.push('rotate ' + rotation);
  }
  check('the inline editor rect matches the painted callout box at every rotation',
    mismatched.length === 0, mismatched.join(', '));
  check('a single-corner anchor really does miss on a rotated sheet',
    strayCorner.length === 0, strayCorner.join(', '));

  // Refitting keeps the top edge put, which is what stops a callout walking up
  // the sheet every time its text is edited.
  const box = { type: 'callout', x: 100, y: 600, w: 200, h: 80, text: 'Panel LP-1', fontSize: 11 };
  const fit = RP.render.fitCallout(box);
  check('refitting a callout keeps its top edge', Math.abs((fit.y + fit.h) - (box.y + box.h)) < 1e-6);

  // Typography feeds back into the box: a wider face needs more lines for the
  // same words, and the box has to be measured in the face it is drawn in.
  const phrase = 'Replace this 20A breaker with a 30A per revised load calc';
  // 130pt is a width where the phrase fits in three lines regular and needs a
  // fourth in bold, so this fails outright if the measurement ignores weight.
  const regular = { type: 'callout', x: 0, y: 0, w: 130, h: 40, text: phrase, fontSize: 11 };
  const heavy = Object.assign({}, regular, { bold: true });
  check('a bold callout is measured in bold, not in regular',
    RP.render.fitCallout(heavy).h > RP.render.fitCallout(regular).h,
    `${RP.render.fitCallout(regular).h} -> ${RP.render.fitCallout(heavy).h}`);
  check('the font shorthand carries family and weight',
    /700/.test(RP.render.fontSpec({ bold: true }, 12)) &&
    /Georgia/.test(RP.render.fontSpec({ fontFamily: 'serif' }, 12)) &&
    !/700/.test(RP.render.fontSpec({}, 12)),
    RP.render.fontSpec({ fontFamily: 'serif', bold: true }, 12));
  check('an unknown family falls back rather than rendering nothing',
    RP.render.fontSpec({ fontFamily: 'wingdings' }, 12) === RP.render.fontSpec({}, 12));

  // Callout text colour is its own field: the markup colour is the box and the
  // leader, and tying them together would restyle every callout already drawn.
  const drawn = [];
  const viewport = { scale: 1, convertToViewportPoint: (x, y) => [x, 792 - y] };
  const coloured = Object.assign({}, regular, { x: 100, y: 600, color: '#ff9500', textColor: '#0044cc' });
  Object.assign(coloured, RP.render.fitCallout(coloured));
  const ctx = measuringContext(drawn);
  RP.render.drawAnnotation(ctx, coloured, viewport, {});
  check('callout text takes its own colour, not the box colour',
    drawn.some((d) => d.kind === 'text' && d.fill === '#0044cc'),
    JSON.stringify(drawn.filter((d) => d.kind === 'text').map((d) => d.fill)));

  /* Where the text tool's click point ends up.
     `annot.y` is the *top* of the first line — that is what `drawAnnotation`
     draws down from and what `bbox` measures back up — so using the click point
     as-is hangs the whole run below the pointer. The I-beam is the cursor that
     makes that read as a bug: its hotspot is the middle of the bar, so you aim
     the middle at the line you are annotating and the text lands half a bar
     low. y is up in PDF space, so the correction is *upward* — a sign error
     here doubles the original complaint instead of fixing it. */
  const savedStyle = RP.tools.style.fontSize;
  RP.tools.style.fontSize = 14;
  const anchor = RP.tools.textAnchorFor([120, 600]);
  check('the text anchor is lifted half a line above the click',
    anchor[1] === 607, 'clicked 600 -> anchored ' + anchor[1]);
  check('the text anchor does not move sideways', anchor[0] === 120);
  const centred = { type: 'text', x: anchor[0], y: anchor[1], fontSize: 14, text: 'RJ' };
  const runBox = RP.render.bbox(centred);
  check('the first line straddles the point that was clicked',
    runBox.y < 600 && runBox.y + runBox.h > 600,
    'run spans ' + runBox.y.toFixed(1) + '..' + (runBox.y + runBox.h).toFixed(1) + ' around 600');
  RP.tools.style.fontSize = savedStyle;

  /* The inline editor has to compensate for its own chrome, measured rather
     than hard-coded: the border, the padding and the half-leading that
     `line-height` puts above every line all sit between the editor's border box
     and its first glyph, and none of them exists on the canvas. A copy of those
     numbers in JS would be one more pair to keep in step with app.css by hand. */
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8');
  const place = toolsSrc.slice(toolsSrc.indexOf('placeInlineText()'), toolsSrc.indexOf('closeInlineText(discard)'));
  check('the inline editor measures its own inset instead of assuming one',
    /getComputedStyle\(editor\)/.test(place) && /borderTopWidth/.test(place) &&
    /paddingTop/.test(place) && /lineHeight/.test(place));
  check('the inline editor subtracts the half-leading above the first line',
    /halfLeading/.test(place) && /top\s*=\s*\(box\.top \+ textTop - insetY - halfLeading\)/.test(place));
  // The callout editor must wrap where the canvas wraps, and CALLOUT_PAD scales
  // with the zoom — a fixed inset agrees at 100% and nowhere else.
  check('the callout editor wraps to the scaled pad, not the raw box',
    /RP\.render\.CALLOUT_PAD \* \(record\.viewport\.scale/.test(place) &&
    /rect\.w - pad \* 2/.test(place));
}

/**
 * The app shell is a flex column: every direct child of <body> must either be
 * taken out of flow (absolute/fixed) or declare its own flex sizing, and
 * exactly one of them may grow. This used to be a grid with positional rows,
 * which silently collapsed the viewer the moment a child was hidden.
 */
function testLayoutContract() {
  console.log('\nApp shell layout');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');

  const bodyRule = (css.match(/\nbody\s*\{([^}]*)\}/) || [])[1] || '';
  check('body is a flex column', /display:\s*flex/.test(bodyRule) && /flex-direction:\s*column/.test(bodyRule));
  check('body no longer uses positional grid rows', !/grid-template-rows/.test(bodyRule));

  // Direct element children of <body>, by depth scan.
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'))
    .replace(/<!--[\s\S]*?-->/g, '');
  const topLevel = [];
  let depth = -1;
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const [, closing, tag, attrs] = m;
    const selfClosing = /\/\s*$/.test(attrs) || VOID.has(tag.toLowerCase());
    if (closing) { depth -= 1; continue; }
    if (depth === 0) topLevel.push({ tag: tag.toLowerCase(), attrs });
    if (!selfClosing) depth += 1;
  }

  const outOfFlow = ['sprite', 'note-popup', 'inline-text-editor', 'modal-backdrop',
    'toast-stack', 'drop-veil'];
  const sized = {
    titlebar: '.titlebar',
    'row-actions': '.toolbar.row-actions',
    'row-tools': '.toolbar.row-tools',
    banner: '.banner',
    workspace: '.workspace',
    statusbar: '.statusbar'
  };

  const unaccounted = [];
  let growers = 0;
  for (const node of topLevel) {
    if (node.tag === 'script') continue;
    const classes = ((node.attrs.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    if (classes.some((c) => outOfFlow.includes(c))) continue;

    const key = classes.find((c) => sized[c]);
    if (!key) { unaccounted.push(node.tag + '.' + classes.join('.')); continue; }

    const escaped = sized[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = (css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
    const flex = (rule.match(/flex:\s*([^;]+);/) || [])[1] || '';
    if (/^1\s/.test(flex.trim())) growers += 1;
    else if (!/^0\s+0/.test(flex.trim())) unaccounted.push(key + ' (flex: "' + flex.trim() + '")');
  }

  check('every top-level child is positioned or flex-sized', unaccounted.length === 0,
    unaccounted.length ? unaccounted.join(', ') : topLevel.length + ' children scanned');
  check('exactly one child absorbs the leftover height', growers === 1, growers + ' growing children');

  const workspaceRule = (css.match(/\.workspace\s*\{([^}]*)\}/) || [])[1] || '';
  check('the workspace can shrink so the viewer scrolls', /min-height:\s*0/.test(workspaceRule));

  // Icons: <use> clones into a shadow tree, so stroke styling has to be on the
  // svg element (inherited) and solid shapes need presentation attributes.
  const svgRule = (css.match(/\nsvg\s*\{([^}]*)\}/) || [])[1] || '';
  check('icon stroke style is inheritable (set on svg)',
    /stroke:\s*currentColor/.test(svgRule) && /fill:\s*none/.test(svgRule));
  check('no icon styling relies on unreachable descendant selectors',
    !/svg\s+path\s*,/.test(css) && !/svg\s+\.f\s*\{/.test(css));
  check('solid icon shapes use presentation attributes',
    !/class="f"/.test(html) && /fill="currentColor" stroke="none"/.test(html));
}

/* ---------------------------------------------------------------------------
   Navigation

   Marquee zoom is the one piece of viewer geometry that is not obvious by
   looking at it: the factor is relative to the zoom already in force, because
   `vpRect` reports CSS pixels at the current scale. Getting that backwards
   would land you somewhere else on the sheet at a plausible-looking zoom, which
   is exactly the kind of bug nobody reports precisely.
   --------------------------------------------------------------------------- */
function testMarqueeZoom() {
  console.log('\nMarquee zoom');

  const PAGE_H = 792;
  // A stand-in pdf.js viewport: PDF space is origin bottom-left, viewport space
  // top-left, and both conversions are needed by RP.render.vpRect.
  const viewportAt = (scale) => ({
    scale,
    width: 612 * scale,
    height: PAGE_H * scale,
    convertToViewportPoint: (x, y) => [x * scale, (PAGE_H - y) * scale],
    convertToPdfPoint: (x, y) => [x / scale, PAGE_H - y / scale]
  });

  /** One pane's viewer, with its two DOM-bound methods stubbed out. */
  function harness(zoom) {
    const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
    const scrolled = { top: 0, left: 0 };
    const record = {
      index: 0,
      viewport: viewportAt(zoom),
      container: {
        offsetTop: 0,
        offsetLeft: 0,
        // Page tops are measured from live rects, so the stub has to move with
        // the scroller the way a real element does.
        getBoundingClientRect: () => ({
          top: -viewer.els.viewer.scrollTop,
          left: -viewer.els.viewer.scrollLeft
        })
      }
    };
    viewer.zoom = zoom;
    viewer.rotation = 0;
    viewer.fitMode = 'width';
    viewer.pages = [record];
    viewer.els = {
      viewer: {
        clientWidth: 1000,
        clientHeight: 800,
        scrollLeft: 0,
        scrollTop: 0,
        scrollHeight: 1e6,      // a column taller than anything revealRect aims at
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
        scrollTo: (opts) => { scrolled.top = opts.top; scrolled.left = opts.left; }
      }
    };
    viewer.layout = function () { record.viewport = viewportAt(this.zoom); };
    viewer.highlightThumb = function () {};
    return { viewer, scrolled };
  }

  {
    const { viewer, scrolled } = harness(1);
    viewer.zoomToRect(0, { x: 100, y: 300, w: 100, h: 100 });
    // 1000x800 viewport less 28px of padding, over a 100pt square.
    check('a rect is scaled to fill the tighter viewport axis',
      Math.abs(viewer.zoom - 7.72) < 1e-6, 'zoom ' + viewer.zoom.toFixed(4));
    check('the rect lands centred in the viewport',
      Math.abs(scrolled.left - (150 * viewer.zoom - 500)) < 0.01 &&
      Math.abs(scrolled.top - ((PAGE_H - 350) * viewer.zoom - 400)) < 0.01,
      `scroll ${scrolled.left.toFixed(1)},${scrolled.top.toFixed(1)}`);
    check('zooming to a rect drops fit mode', viewer.fitMode === null, String(viewer.fitMode));
  }

  {
    const { viewer } = harness(1);
    viewer.zoomToRect(0, { x: 6, y: 300, w: 600, h: 20 });
    check('a wide, short rect is limited by the viewport width',
      Math.abs(viewer.zoom - 972 / 600) < 1e-6, 'zoom ' + viewer.zoom.toFixed(4));
  }

  {
    const { viewer } = harness(2.5);
    viewer.zoomToRect(0, { x: 100, y: 300, w: 100, h: 100 });
    check('the factor compounds off the zoom already in force',
      Math.abs(viewer.zoom - 7.72) < 1e-6, 'zoom ' + viewer.zoom.toFixed(4));
  }

  {
    const { viewer } = harness(1);
    viewer.zoomToRect(0, { x: 100, y: 300, w: 1, h: 1 });
    check('a click-sized rect is refused rather than zoomed to the limit',
      viewer.zoom === 1, 'zoom ' + viewer.zoom);
  }

  {
    const { viewer } = harness(4);
    viewer.zoomToRect(0, { x: 10, y: 10, w: 4, h: 4 });
    check('the result still respects MAX_ZOOM', viewer.zoom <= RP.MAX_ZOOM, 'zoom ' + viewer.zoom);
  }

  /* A streaming zoom — a wheel notch or a trackpad pinch — arrives many times
     per frame, and each step is a full pass over the column plus a raster that
     the next step cancels. The steps are held for a frame and the raster until
     the stream stops, so what has to be true is that holding them changes
     nothing about where the zoom lands. */
  {
    const realRaf = global.requestAnimationFrame;
    let frame = null;
    global.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    try {
      const { viewer } = harness(2);
      let laid = null;
      const inner = viewer.layout;
      viewer.layout = function (opts) { laid = opts; inner.call(this, opts); };

      viewer.queueZoom(1.1, { x: 500, y: 400 });
      viewer.queueZoom(1.1, { x: 500, y: 400 });
      viewer.queueZoom(1.1, { x: 500, y: 400 });
      check('a frame of zoom steps is held, not applied one at a time',
        viewer.zoom === 2, 'zoom moved to ' + viewer.zoom + ' before the frame ran');

      frame();
      check('the held steps compound to exactly where they would have landed',
        Math.abs(viewer.zoom - 2 * 1.1 * 1.1 * 1.1) < 1e-9, 'zoom ' + viewer.zoom);
      check('a streaming zoom defers the raster to the end of the gesture',
        laid && laid.defer === true, JSON.stringify(laid));

      // A pinch reports its scale against the start of the gesture, so the
      // newest value replaces the pending one rather than compounding with it.
      viewer.queueZoomTo(3, null);
      viewer.queueZoomTo(3.5, null);
      frame();
      check('an absolute zoom step replaces the pending one',
        Math.abs(viewer.zoom - 3.5) < 1e-9, 'zoom ' + viewer.zoom);
    } finally {
      global.requestAnimationFrame = realRaf;
    }
  }

  // A pane hands its scroll position and zoom to the tab it is leaving and gets
  // them back on the way in; without this a tab switch would silently drop you
  // at the top of the sheet.
  {
    const { viewer } = harness(2.5);
    viewer.els.viewer.scrollTop = 340;
    viewer.els.viewer.scrollLeft = 120;
    viewer.currentPage = 0;
    const state = viewer.viewState();

    const other = harness(1).viewer;
    other.pages = viewer.pages;
    other.applyViewState(state);
    check('a tab switch carries zoom, page and scroll across',
      Math.abs(other.zoom - 2.5) < 1e-9 &&
      other.els.viewer.scrollTop === 340 && other.els.viewer.scrollLeft === 120,
      `zoom ${other.zoom} scroll ${other.els.viewer.scrollLeft},${other.els.viewer.scrollTop}`);
    check('a restored view is not left in fit mode',
      other.fitMode === null || other.fitMode === state.fitMode, String(other.fitMode));
  }

  /* Landing on the page you actually clicked.

     `goToPage` scrolls a column it has to measure. Measuring through
     `offsetTop` ties the answer to whatever the offsetParent happens to be, so
     a positioned ancestor appearing between `.viewer` and `.page` shifts every
     page top at once and a thumbnail starts opening the sheet *before* the one
     clicked. The column here is built with an `offsetTop` that deliberately
     disagrees with its real position, so a return to offsetTop fails loudly. */
  {
    const PAGE_H_PX = 500;
    const GAP = 18;
    const PAD = 22;
    const LEAD = 16;                       // the gutter goToPage leaves showing
    const topFor = (i) => PAD + i * (PAGE_H_PX + GAP);

    const scroller = {
      clientWidth: 1000, clientHeight: 800, scrollTop: 0, scrollLeft: 0,
      scrollHeight: topFor(10) + 60,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      scrollTo: (opts) => {
        if (opts.top !== undefined) scroller.scrollTop = opts.top;
        if (opts.left !== undefined) scroller.scrollLeft = opts.left;
      }
    };
    const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
    viewer.els = { viewer: scroller };
    viewer.highlightThumb = function () {};
    viewer.isActive = function () { return true; };
    viewer.pages = [];
    for (let i = 0; i < 10; i += 1) {
      viewer.pages.push({
        index: i,
        container: {
          offsetTop: topFor(i) - 900,      // an offsetParent that is not the scroller
          offsetLeft: 0,
          getBoundingClientRect: () => ({ top: topFor(i) - scroller.scrollTop, left: 0 })
        }
      });
    }

    viewer.goToPage(4);
    check('a page top is measured against the scroller, not the offsetParent',
      Math.abs(scroller.scrollTop - (topFor(4) - LEAD)) < 0.5, 'scrollTop ' + scroller.scrollTop);
    check('the page the scroll handler reports back is the page that was asked for',
      viewer.pageIndexAt(scroller.scrollTop) === 4,
      'reads page ' + (viewer.pageIndexAt(scroller.scrollTop) + 1));

    viewer.goToPage(9);
    check('the last sheet is not scrolled past what the container allows',
      scroller.scrollTop <= scroller.scrollHeight - scroller.clientHeight,
      'scrollTop ' + scroller.scrollTop);

    /* And when it still lands wrong — a relayout under a smooth scroll, a
       measurement that went stale mid-flight — the landing check pulls it back
       rather than leaving you a sheet away from the one you clicked. Run
       against a captured timer so the check does not have to wait on it. */
    const realTimeout = global.setTimeout;
    let landingCheck = null;
    global.setTimeout = (fn) => { landingCheck = fn; return 1; };
    try {
      viewer.goToPage(4);
      scroller.scrollTop = topFor(3) - LEAD;   // ended up one sheet short
      viewer.pageTops = null;
      landingCheck();
    } finally {
      global.setTimeout = realTimeout;
    }
    check('a navigation that lands on the wrong page is corrected, not left there',
      viewer.pageIndexAt(scroller.scrollTop) === 4 && viewer.currentPage === 4,
      'ended on page ' + (viewer.pageIndexAt(scroller.scrollTop) + 1));

    /* But not when you took the wheel yourself in the meantime. */
    global.setTimeout = (fn) => { landingCheck = fn; return 1; };
    try {
      viewer.goToPage(4);
      viewer.userScrollAt = Date.now() + 5;
      scroller.scrollTop = topFor(7) - LEAD;
      viewer.pageTops = null;
      landingCheck();
    } finally {
      global.setTimeout = realTimeout;
      viewer.userScrollAt = 0;
    }
    check('a scroll of your own outranks the pending landing check',
      viewer.pageIndexAt(scroller.scrollTop) === 7,
      'ended on page ' + (viewer.pageIndexAt(scroller.scrollTop) + 1));
  }
}

/* ---------------------------------------------------------------------------
   View modes

   Three things here are easy to get plausibly wrong and hard to spot:

   - the row a page belongs to. With the cover sheet on its own it is *not*
     `index >> 1`, and two call sites derive it independently — `rowsFor`
     builds the DOM, `rowOfPage` answers questions about it without building
     anything. They disagreeing means clicking a thumbnail opens the spread
     next door.
   - the gap in a facing fit. It is a fixed number of CSS pixels and does not
     scale, so dividing the pane width by the two page widths overshoots by
     exactly the gutter and the right-hand sheet sits a sliver off the edge at
     every zoom.
   - the ink box behind fit-visible. A single speck in the corner of a scan
     would otherwise pull the box out to the whole sheet and turn the mode
     into a worse fit-page.
   --------------------------------------------------------------------------- */
function testViewModes() {
  console.log('\nView modes');
  const V = RP.views;

  check('an unknown mode falls back to continuous rather than throwing',
    V.normalize('spiral') === 'continuous' && V.normalize(undefined) === 'continuous' &&
    V.normalize('facing') === 'facing');
  check('only the two single-row modes are paged',
    V.MODES.filter(V.isPaged).join(',') === 'single,facing',
    V.MODES.filter(V.isPaged).join(','));
  check('only the two facing modes lay out a spread',
    V.MODES.filter((m) => V.spreadOf(m) === 2).join(',') === 'facing,facing-continuous',
    V.MODES.filter((m) => V.spreadOf(m) === 2).join(','));

  check('a single-page mode is one page per row',
    JSON.stringify(V.rowsFor(4, 'single')) === '[[0],[1],[2],[3]]',
    JSON.stringify(V.rowsFor(4, 'single')));
  check('a spread leaves the cover sheet on its own',
    JSON.stringify(V.rowsFor(5, 'facing')) === '[[0],[1,2],[3,4]]',
    JSON.stringify(V.rowsFor(5, 'facing')));
  check('an odd tail sheet is not paired with nothing',
    JSON.stringify(V.rowsFor(4, 'facing')) === '[[0],[1,2],[3]]',
    JSON.stringify(V.rowsFor(4, 'facing')));
  check('an empty document has no rows', V.rowsFor(0, 'facing').length === 0);

  /* The invariant that matters: the arithmetic answer and the built rows are
     the same answer, at every index, in every mode. */
  {
    const wrong = [];
    for (const mode of V.MODES) {
      const rows = V.rowsFor(77, mode);
      for (let i = 0; i < 77; i += 1) {
        const row = V.rowOfPage(i, mode);
        if (!rows[row] || rows[row].indexOf(i) === -1) wrong.push(mode + ' p' + i);
        else if (V.rowStartOf(i, mode) !== rows[row][0]) wrong.push(mode + ' start p' + i);
      }
    }
    check('rowOfPage and rowStartOf agree with the rows that get built',
      wrong.length === 0, wrong.slice(0, 4).join(', '));
  }

  /* Fit maths. The gutter is the whole point of the facing case. */
  {
    const one = V.fitScale([612], [792], { availWidth: 1000, availHeight: 800, gap: V.SPREAD_GAP });
    check('a single page fits the pane width exactly',
      Math.abs(612 * one - 1000) < 1e-9, '612 x ' + one.toFixed(5));

    const two = V.fitScale([612, 612], [792, 792], { availWidth: 1000, availHeight: 800, gap: V.SPREAD_GAP });
    check('a spread fits the pane once the gutter is taken off',
      Math.abs(612 * two * 2 + V.SPREAD_GAP - 1000) < 1e-9,
      'spread ' + (612 * two * 2 + V.SPREAD_GAP).toFixed(3) + 'px into 1000');
    check('the gutter makes the spread fit tighter than half the pane',
      two < 1000 / 2 / 612, 'scale ' + two.toFixed(5));

    // Fit-page takes the taller sheet of the two, not the first one.
    const mixed = V.fitScale([612, 612], [500, 1000], {
      availWidth: 4000, availHeight: 800, gap: V.SPREAD_GAP, mode: 'page'
    });
    check('fit-page on a spread is bounded by the taller sheet',
      Math.abs(1000 * mixed - 800) < 1e-9, '1000 x ' + mixed.toFixed(5));
  }

  /* The ink box. Built by hand so the expected answer is not in doubt. */
  {
    const W = 12;
    const H = 12;
    const raster = (marks) => {
      const data = new Uint8ClampedArray(W * H * 4).fill(255);
      for (const [x, y] of marks) {
        const p = (y * W + x) * 4;
        data[p] = 10; data[p + 1] = 10; data[p + 2] = 10;
      }
      return data;
    };
    const block = [];
    for (let y = 2; y < 6; y += 1) for (let x = 3; x < 7; x += 1) block.push([x, y]);

    const box = V.inkBoxOf(raster(block), W, H);
    check('the ink box is the box the ink is actually in',
      box && box.x === 3 && box.y === 2 && box.w === 4 && box.h === 4, JSON.stringify(box));

    const specked = V.inkBoxOf(raster(block.concat([[0, 0], [11, 11]])), W, H);
    check('a lone speck in the corner of a scan does not become the box',
      specked && specked.x === 3 && specked.y === 2 && specked.w === 4 && specked.h === 4,
      JSON.stringify(specked));

    check('a blank sheet reports no box rather than an empty one',
      V.inkBoxOf(raster([]), W, H) === null);
  }

  /* Paging by row. In a spread the sheet next door is already in front of
     you, so a step that moved by one page index would not move at all. */
  {
    const scroller = {
      clientWidth: 1000, clientHeight: 800, scrollTop: 0, scrollLeft: 0, scrollHeight: 900,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      scrollTo: (opts) => { if (opts.top !== undefined) scroller.scrollTop = opts.top; }
    };
    const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
    viewer.els = { viewer: scroller };
    viewer.highlightThumb = function () {};
    viewer.isActive = function () { return true; };
    viewer.showRow = function () {};          // the DOM half, exercised in the app
    viewer.pages = [];
    for (let i = 0; i < 7; i += 1) viewer.pages.push({ index: i });
    viewer.viewMode = 'facing';
    viewer.currentPage = 0;

    const walk = [];
    for (let i = 0; i < 4; i += 1) { viewer.stepRow(1); walk.push(viewer.currentPage); }
    check('a spread steps by the spread, not by one sheet',
      walk.join(',') === '1,3,5,5', walk.join(','));
    viewer.stepRow(-1);
    check('stepping back lands on the left-hand sheet of the previous spread',
      viewer.currentPage === 3, 'page ' + (viewer.currentPage + 1));
    check('the last spread is the end of the walk',
      viewer.stepRow(1) && viewer.stepRow(1) === false, 'ran past the last row');

    // Going to the right-hand sheet of a spread means going to the spread.
    viewer.goToPage(4);
    check('a jump to the right-hand sheet reports the spread it is in',
      viewer.currentPage === 3, 'page ' + (viewer.currentPage + 1));

    /* The arrow keys read down a sheet and turn over at the edge of the paper.
       `nudgeScroll` returning false is what makes the second half of that work,
       so Down is not a dead key in single-page mode once the scroll runs out.
       The column here is 900 tall in an 800 pane, so there are 100px to give. */
    scroller.scrollLeft = 0;
    scroller.scrollWidth = 1000;   // fits the pane: nothing to scroll sideways
    scroller.scrollTop = 0;
    check('a nudge with room to move reports that it moved',
      viewer.nudgeScroll(0, 80) === true && scroller.scrollTop === 80,
      'scrollTop ' + scroller.scrollTop);
    check('a nudge clamps at the bottom rather than overshooting',
      viewer.nudgeScroll(0, 80) === true && scroller.scrollTop === 100,
      'scrollTop ' + scroller.scrollTop);
    check('a nudge at the bottom reports that it could not move',
      viewer.nudgeScroll(0, 80) === false);
    check('a nudge sideways on a sheet that fits cannot move',
      viewer.nudgeScroll(80, 0) === false);
    /* Sub-pixel movement is not movement: `scrollTop` is fractional at
       fractional zooms, and reading a rounding difference as a move would stop
       the key turning the sheet at the very bottom of the column. */
    scroller.scrollTop = 99.7;
    check('a sub-pixel remainder does not count as movement',
      viewer.nudgeScroll(0, 80) === false, 'scrollTop ' + scroller.scrollTop);
  }

  /* Continuous facing: the pages of a spread share a top, and the scroll
     handler has to name the left-hand one. `pageIndexAt` on its own answers
     with the *last* page at or above the probe, which is the right-hand one. */
  {
    const PAGE_H_PX = 500;
    const GAP = 18;
    const PAD = 22;
    const topFor = (i) => PAD + RP.views.rowOfPage(i, 'facing-continuous') * (PAGE_H_PX + GAP);
    const scroller = {
      clientWidth: 1000, clientHeight: 800, scrollTop: 0, scrollLeft: 0, scrollHeight: 4000,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      scrollTo: (opts) => { if (opts.top !== undefined) scroller.scrollTop = opts.top; }
    };
    const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
    viewer.els = { viewer: scroller };
    viewer.highlightThumb = function () {};
    viewer.isActive = function () { return true; };
    viewer.viewMode = 'facing-continuous';
    viewer.pages = [];
    for (let i = 0; i < 7; i += 1) {
      viewer.pages.push({
        index: i,
        container: { getBoundingClientRect: () => ({ top: topFor(i) - scroller.scrollTop, left: 0 }) }
      });
    }

    scroller.scrollTop = topFor(3);
    viewer.onScroll();
    check('a spread on screen reports itself by its left-hand sheet',
      viewer.currentPage === 3, 'page ' + (viewer.currentPage + 1));
  }

  /* The fit constants and the stylesheet are the same two numbers. Drift here
     is invisible until a fitted spread is a few pixels wide of the pane. */
  {
    const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
    const rowRule = (css.match(/\n\.page-row\s*\{([^}]*)\}/) || [])[1] || '';
    const gap = parseFloat((rowRule.match(/gap:\s*([\d.]+)px/) || [])[1]);
    check('the spread gutter in app.css is the one the fit subtracts',
      gap === RP.views.SPREAD_GAP, 'css ' + gap + ' vs views ' + RP.views.SPREAD_GAP);
    check('a hidden row is actually hidden, despite display:flex',
      /\.page-row\[hidden\]\s*\{[^}]*display:\s*none/.test(css));

    /* A page wider than the pane must be scrollable to *both* of its edges.
       `align-items: center` alone overflows the column on both sides and a
       scroll container only exposes the end one, so the left half of an
       E-size sheet at 400% becomes unreachable — and with it any zoom-to-area
       aimed there. Sizing the column to its widest row is what puts the whole
       sheet inside the scrollable area. */
    const pagesRule = (css.match(/\n\.pages\s*\{([^}]*)\}/) || [])[1] || '';
    check('the page column sizes to its widest row, so a wide sheet scrolls both ways',
      /width:\s*max-content/.test(pagesRule) && /min-width:\s*100%/.test(pagesRule),
      pagesRule.replace(/\s+/g, ' ').trim());
  }
}

/* ---------------------------------------------------------------------------
   Raster cap

   The blank page. Chromium refuses a canvas over ~16384 px on a side or over an
   area it will not commit to, and it refuses *silently*: the allocation fails,
   `page.render()` resolves as normal, and the sheet is white with nothing
   logged. On the drawings this app is for that is not a corner case — an ANSI E
   sheet crosses the side limit at about 335% zoom at dpr 2, and a long plot out
   of a DWF crosses it barely above fit-width.

   `rasterPlan` is the clamp, and it is pure so it can be pinned here. The rule
   it must never break: the canvas gets smaller, the CSS box does not. A soft
   sheet is a sheet; a refused canvas is indistinguishable from an empty
   drawing.
   --------------------------------------------------------------------------- */
function testRasterCap() {
  console.log('\nRaster cap');

  const MAX_SIDE = RP.views.MAX_CANVAS_SIDE;
  const MAX_PX = RP.views.MAX_CANVAS_PIXELS;
  const plan = (w, h, dpr) => RP.views.rasterPlan(w, h, dpr);

  // A letter sheet at 100%: nothing here should touch it.
  const letter = plan(612, 792, 2);
  check('an ordinary sheet rasters at the dpr it asked for',
    !letter.capped && letter.scale === 2 && letter.width === 1224,
    `${letter.width}x${letter.height} @ ${letter.scale}`);

  // An E-size sheet at fit-width on a wide pane — the 13 MP case the retention
  // budget was written around. Still under both limits, still untouched.
  const eFit = plan(1600, 2070, 2);
  check('an E-size sheet at fit-width is not capped',
    !eFit.capped, `${eFit.width}x${eFit.height} = ${(eFit.width * eFit.height / 1e6).toFixed(1)} MP`);

  /* The side limit. ANSI E is 2448 x 3168 pt, so 400% zoom is 9792 x 12672 CSS
     px and dpr 2 asks for 19584 x 25344 — refused, silently, which is the bug
     this whole section exists for. */
  const e400 = plan(9792, 12672, 2);
  check('an E-size sheet at 400% is capped rather than refused',
    e400.capped && e400.width <= MAX_SIDE && e400.height <= MAX_SIDE,
    `${e400.width}x${e400.height} @ ${e400.scale.toFixed(3)}`);

  /* A long plot: a riser diagram or site plan run out on one continuous sheet
     from a DWF. 7200 pt across is 100 inches, which is ordinary for one of
     these, and at dpr 2 it crosses the side limit at 1.14x zoom. */
  const longPlot = plan(7200, 1224, 2);
  check('a long DWF plot is capped just above fit-width',
    longPlot.capped && longPlot.width <= MAX_SIDE,
    `${longPlot.width}x${longPlot.height} @ ${longPlot.scale.toFixed(3)}`);

  // Every plan, whatever it was asked for, has to be something the browser will
  // actually hand over. This is the invariant the whole fix rests on.
  let worstSide = 0;
  let worstPixels = 0;
  let squashed = null;
  for (const w of [612, 1224, 2448, 5000, 9792, 20000, 40000]) {
    for (const h of [792, 1584, 3168, 1224, 12672, 30000]) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const p = plan(w, h, dpr);
        worstSide = Math.max(worstSide, p.width, p.height);
        worstPixels = Math.max(worstPixels, p.width * p.height);
        // Proportion is not optional: the CSS box does not change, so a raster
        // clamped on one axis alone is stretched over it and every markup
        // painted through `rasterScale` lands in the wrong place.
        const wantAspect = w / h;
        const gotAspect = p.width / p.height;
        if (Math.abs(wantAspect - gotAspect) / wantAspect > 0.02) {
          squashed = `${w}x${h} @${dpr} -> ${p.width}x${p.height}`;
        }
      }
    }
  }
  check('no plan exceeds the per-side limit', worstSide <= MAX_SIDE, worstSide + ' px');
  check('no plan exceeds the pixel budget', worstPixels <= MAX_PX,
    (worstPixels / 1e6).toFixed(1) + ' MP vs ' + (MAX_PX / 1e6) + ' MP');
  check('a capped raster keeps the page proportions', !squashed, squashed || 'aspect held');

  // Never zero: a canvas with no dimension has no context to draw through, and
  // the failure looks exactly like the one being fixed.
  const degenerate = plan(0, 0, 2);
  check('a degenerate page still gets a usable canvas',
    degenerate.width >= 1 && degenerate.height >= 1,
    `${degenerate.width}x${degenerate.height}`);

  /* The cap is a *scale*, and `rasterScale` is what the markup canvas paints
     through. A page capped to half the requested dpr must report exactly that,
     or markups drift by the ratio on precisely the large sheets being fixed. */
  const capped = plan(MAX_SIDE, 1000, 2);
  check('the plan reports the scale the markup layer has to paint at',
    Math.abs(capped.width - MAX_SIDE * capped.scale) < 1.5,
    `${capped.width} px at scale ${capped.scale.toFixed(3)}`);

  /* A page whose *layout* already exceeds the limit gets a scale below 1 — the
     bitmap is smaller than the CSS box and is stretched over it. That is the
     trade, and it is the same one `setZoom({defer:true})` already makes. */
  const beyond = plan(MAX_SIDE * 2, 1000, 1);
  check('a page laid out past the limit rasters below 1:1 rather than failing',
    beyond.scale < 1 && beyond.width <= MAX_SIDE, `scale ${beyond.scale.toFixed(3)}`);

  /* The blank-canvas probe. `renderPage` fills white and reads one pixel back,
     because a refused surface reads as transparent black while `canvas.width`
     still reports whatever was assigned to it. */
  const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
  const pixelCtx = (rgba) => ({ getImageData: () => ({ data: rgba }) });
  check('a canvas that took the white fill is accepted',
    viewer.canvasTookTheFill(pixelCtx([255, 255, 255, 255]), { width: 100, height: 100 }));
  check('a refused surface reads back transparent and is caught',
    !viewer.canvasTookTheFill(pixelCtx([0, 0, 0, 0]), { width: 100, height: 100 }));
  check('a zero-sized canvas is caught',
    !viewer.canvasTookTheFill(pixelCtx([255, 255, 255, 255]), { width: 0, height: 100 }));
  check('a context that throws on read is caught, not propagated',
    !viewer.canvasTookTheFill(
      { getImageData() { throw new Error('out of memory'); } }, { width: 100, height: 100 }));

  /* A page that could not be rastered has to say so. The failed state is a
     class on the container and a rule in app.css; a white rectangle on its own
     reads as a drawing with nothing on it, which is the wrong thing to tell
     someone about a sheet that did not render. */
  const cssPath = path.join(ROOT, 'src', 'css', 'app.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  check('a failed raster has something on screen saying so',
    /\.page\.render-failed::after\s*\{[^}]*content:\s*"[^"]+"/.test(css));
  check('the failure notice is positioned, not left in flow below the canvas',
    /\.page\.render-failed::after\s*\{[^}]*position:\s*absolute/.test(css),
    'in flow it lands outside the page box and is never seen');
}

/* ---------------------------------------------------------------------------
   The detail overlay

   What the cap above costs. An ANSI E sheet at 400% rasters at about 0.44
   device pixels per CSS pixel, because the whole page is one canvas and the
   whole page will not fit in one — a sheet you can see the shape of and not
   read. The viewport always fits, though, so a capped sheet gets a second pair
   of canvases over the first covering only the visible crop, at the full dpr.

   Three things are pinned here, and each of them is a way this goes wrong
   quietly rather than loudly:

   - the crop is in *page-local* coordinates, so a sheet that does not start at
     the origin of the scroll column — the right-hand page of a spread, any
     page below the first — gets a tile offset by exactly the wrong amount if
     the subtraction is missed, and a piece of the drawing lands over a
     different piece of the drawing;
   - the tile is only taken when there is something to gain, or an ordinary
     sheet pays for a second full-resolution canvas it cannot tell apart from
     the first;
   - the margin is slack against scrolling, not a trigger. Re-cropping every
     time the view leaves the margin means the sheet being read queues behind a
     crop of itself on the one pdf.js worker.
   --------------------------------------------------------------------------- */
async function testDetailTiles() {
  console.log('\nDetail overlay');

  const MARGIN = RP.views.TILE_MARGIN;

  /* The case the whole feature is for. ANSI E is 2448 x 3168 pt, so 400% is
     9792 x 12672 CSS px, and at dpr 2 that asks for a canvas four times over
     every limit Chromium has. */
  const sheet = { x: 0, y: 0, w: 9792, h: 12672 };
  const base = RP.views.rasterPlan(sheet.w, sheet.h, 2);
  check('the whole-page raster of an E sheet at 400% is well below 1:1',
    base.capped && base.scale < 0.5, `scale ${base.scale.toFixed(3)}`);

  const pane = { x: 0, y: 5000, w: 1600, h: 1000 };
  const tile = RP.views.detailTile(sheet, pane);
  check('a sheet larger than the pane gets a crop of it',
    !!tile, tile ? `${tile.w}x${tile.h} at ${tile.x},${tile.y}` : 'none');
  check('the crop is the view plus a margin, clamped to the paper',
    tile.x === 0 && tile.y === pane.y - MARGIN
      && tile.w <= pane.w + MARGIN * 2 + 2 && tile.h <= pane.h + MARGIN * 2 + 2,
    `${tile.x},${tile.y} ${tile.w}x${tile.h}`);

  const detail = RP.views.rasterPlan(tile.w, tile.h, 2, { maxPixels: RP.views.MAX_TILE_PIXELS });
  check('and it rasters at the full device pixel ratio',
    !detail.capped && detail.scale === 2, `scale ${detail.scale}`);
  check('which is the point: several times the resolution of the base',
    detail.scale / base.scale > 4,
    `${base.scale.toFixed(3)} -> ${detail.scale} (${(detail.scale / base.scale).toFixed(1)}x)`);

  /* Page-local, not column-local. Everything in the scroll column past the
     first page has a non-zero origin, and the right-hand sheet of a spread has
     a non-zero origin across as well — `viewer.leftOf` exists for that. A tile
     that forgot to subtract it renders one part of the drawing over another,
     which reads as a corrupt page rather than as a coordinate bug. */
  const second = { x: 1614, y: 3000, w: 3000, h: 2000 };
  const offsetTile = RP.views.detailTile(second, { x: 2000, y: 3400, w: 1000, h: 800 });
  check('a crop is measured from the page, not from the scroll column',
    offsetTile.x === 2000 - MARGIN - second.x && offsetTile.y === 3400 - MARGIN - second.y,
    `${offsetTile.x},${offsetTile.y}`);
  check('and never runs past the edge of the paper',
    offsetTile.x >= 0 && offsetTile.y >= 0
      && offsetTile.x + offsetTile.w <= second.w && offsetTile.y + offsetTile.h <= second.h,
    `${offsetTile.x},${offsetTile.y} ${offsetTile.w}x${offsetTile.h}`);

  /* Null is the ordinary answer, and it means "the base canvas already is the
     tile". A letter sheet at 100%, or any sheet zoomed out to fit, takes this
     path and comes out with nothing over it. */
  check('a page that fits in the pane gets no crop at all',
    RP.views.detailTile({ x: 0, y: 0, w: 612, h: 792 }, { x: 0, y: 0, w: 1600, h: 1000 }) === null);
  check('a page scrolled off screen gets no crop either',
    RP.views.detailTile(sheet, { x: 0, y: 40000, w: 1600, h: 1000 }) === null);

  /* The margin is slack. It buys a scroll of about its own size before the
     crop has to be taken again; spending it on the *test* instead — treating
     the margin as the boundary — would re-crop continuously. */
  check('the crop it just took covers the view it was taken for',
    RP.views.tileCovers(tile, sheet, pane));
  check('and still covers it after a scroll shorter than the margin',
    RP.views.tileCovers(tile, sheet, { x: 0, y: pane.y + MARGIN - 20, w: 1600, h: 1000 }),
    `scrolled ${MARGIN - 20}px into a ${MARGIN}px margin`);
  check('but not after one longer than it',
    !RP.views.tileCovers(tile, sheet, { x: 0, y: pane.y + MARGIN * 2, w: 1600, h: 1000 }));
  check('a page with nothing on screen needs no cover',
    RP.views.tileCovers(tile, sheet, { x: 0, y: 40000, w: 1600, h: 1000 }));

  // -- the viewer's half ---------------------------------------------------

  const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
  viewer.dpr = 2;
  const canvas = () => ({ width: 0, height: 0, hidden: true, style: {} });
  const makeRecord = (index, rasterScale, visible) => ({
    index,
    visible: visible !== false,
    rendered: true,
    renderTask: null,
    rasterScale,
    pdfCanvas: { width: 1600, height: 2070, style: {} },
    annotCanvas: { width: 1600, height: 2070, style: {} },
    detailCanvas: canvas(),
    detailAnnot: canvas(),
    tile: null,
    detailTask: null,
    textLayer: { innerHTML: '' },
    nativeLayer: { innerHTML: '', hidden: false },
    textDivs: []
  });

  /* The gate. A sheet already at the device pixel ratio has nothing to gain
     from a second canvas of the same pixels, and would pay for it in the same
     memory budget — so on every ordinary document none of this runs. */
  check('an uncapped sheet is not offered a crop',
    !viewer.wantsDetail(makeRecord(0, 2)));
  check('a capped one is', viewer.wantsDetail(makeRecord(0, 0.44)));
  check('but not while it is off screen',
    !viewer.wantsDetail(makeRecord(0, 0.44, false)));
  check('and not once it has stood itself down',
    !viewer.wantsDetail(Object.assign(makeRecord(0, 0.44), { detailOff: true })));

  /* Releasing has to hand the backing store back, not just drop the flag —
     the same thing `releasePage` gets wrong if `clearRect` is used instead.
     This pair is the largest single allocation the app makes. */
  const held = makeRecord(0, 0.44);
  held.tile = { x: 0, y: 0, w: 1840, h: 1240 };
  held.detailCanvas.width = 3680;
  held.detailCanvas.height = 2480;
  held.detailAnnot.width = 3680;
  held.detailAnnot.height = 2480;
  const withDetail = viewer.pixelsOf(held);
  viewer.releaseDetail(held);
  check('releasing a crop zeroes both canvases, not just the tile',
    held.detailCanvas.width === 0 && held.detailAnnot.width === 0 && held.tile === null);
  check('a crop is hidden as well as emptied, so the base shows through',
    held.detailCanvas.hidden === true && held.detailAnnot.hidden === true);
  check('the crop counts against the same memory budget as the sheet',
    withDetail > viewer.pixelsOf(held),
    `${(withDetail / 1e6).toFixed(1)} MP -> ${(viewer.pixelsOf(held) / 1e6).toFixed(1)} MP`);

  /* A crop belongs to a viewport, so a page that has left the viewport has no
     use for one whatever the eviction ordering says. Without this the pages
     inside MIN_RETAINED_PAGES — which are never released — would each carry a
     viewport-sized pair for the rest of the session. */
  const sweep = RP.createViewer({ querySelector: () => null }, RP.store);
  sweep.dpr = 2;
  sweep.pages = [];
  for (let i = 0; i < 5; i += 1) {
    const record = makeRecord(i, 0.44, i === 2);
    record.tile = { x: 0, y: 0, w: 1840, h: 1240 };
    record.detailCanvas.width = 3680;
    record.detailCanvas.height = 2480;
    record.detailAnnot.width = 3680;
    record.detailAnnot.height = 2480;
    sweep.pages.push(record);
  }
  sweep.currentPage = 2;
  sweep.retainCanvases();
  check('the sweep drops every crop that is no longer on screen',
    sweep.pages.filter((r) => r.tile).length === 1 && !!sweep.pages[2].tile,
    sweep.pages.map((r) => (r.tile ? r.index + 1 : null)).filter(Boolean).join(',') || 'none');
  check('and keeps the one under the viewport',
    sweep.pages[2].detailCanvas.width > 0);
  check('a crop on a neighbouring sheet is released even though the sheet is not',
    sweep.pages[1].detailCanvas.width === 0 && sweep.pages[1].pdfCanvas.width > 0,
    'the page floor holds the sheet, not its crop');

  /* Which sheet the next crop goes to, and when.

     Everything above is arithmetic; this is the part that decides whether the
     arithmetic is ever reached. Two failures live here and neither shows up as
     an exception: a scroll that releases the crop instead of marking it (a
     soft flash on every scroll of a large sheet), and a page with nothing to
     crop stopping the scan (the other sheet of a spread never gets one). */
  const picker = RP.createViewer({ querySelector: () => null }, RP.store);
  picker.dpr = 2;
  const scroller = { scrollTop: 5000, scrollLeft: 0, clientWidth: 1600, clientHeight: 1000 };
  picker.els = { viewer: scroller };
  picker.pages = [
    // A sheet that fits the pane whole — capped, but with nothing to gain.
    Object.assign(makeRecord(0, 0.44), { viewport: { width: 900, height: 700 } }),
    // And an E-size sheet at 400% behind it.
    Object.assign(makeRecord(1, 0.44), { viewport: { width: sheet.w, height: sheet.h } })
  ];
  picker.pageTops = [0, 0];
  picker.pageLefts = [0, 0];

  let asked = null;
  picker.renderDetail = (record, wanted) => {
    asked = { index: record.index, tile: wanted };
    record.tile = wanted;
    return Promise.resolve();
  };
  picker.pumpDetail();
  check('a sheet with nothing to crop does not stop the scan',
    asked && asked.index === 1, asked ? 'page ' + (asked.index + 1) : 'nothing picked');
  /* And it is skipped without being stood down. "The whole sheet is on screen"
     is a fact about the scroll position, which changes freely; `detailOff` is
     a fact about the zoom and is only cleared by `layout()`. Setting it here
     would mean a sheet that fits at the top of the column never gets a crop
     once you scroll it half out of the pane. */
  check('a sheet that fits is skipped, not stood down',
    !picker.pages[0].detailOff && !picker.pages[0].tile);

  /* Scrolling marks, it does not release. The crop is positioned inside the
     page and scrolls with it, so what is left of it on screen is still right;
     dropping it here would trade a sharp region for a soft one at the exact
     moment the user stopped scrolling to look at something. */
  scroller.scrollTop = 5000 + MARGIN * 3;
  picker.refreshDetail();
  check('a scroll off the crop marks it rather than dropping it',
    picker.pages[1].tileStale === true && !!picker.pages[1].tile);
  check('and a scroll still inside it changes nothing',
    (scroller.scrollTop = 5000 + 20, picker.pages[1].tileStale = false,
      picker.refreshDetail(), picker.pages[1].tileStale === false));

  /* The markup pass is shared by the two canvases on purpose. A crop that drew
     its markups through a different path could disagree with the sheet under
     it about what is selected, which is invisible until it happens and then
     looks like the drawing having two states at once. Same reasoning as
     render.js being shared with the exporter. */
  check('one markup pass serves both the sheet and the crop',
    typeof viewer.paintMarkups === 'function' && typeof viewer.redrawDetail === 'function');

  /* The crop covers part of the page, so the `inset: 0` every other canvas in
     the app relies on has to be given back — left in, a viewport-sized crop is
     stretched across the whole sheet. */
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const detailRule = (css.match(/\.page canvas\.detail\s*\{[^}]*\}/) || [''])[0];
  check('the crop is positioned rather than inset over the whole page',
    /position:\s*absolute/.test(detailRule) && /inset:\s*auto/.test(detailRule),
    detailRule.replace(/\s+/g, ' ') || 'no .page canvas.detail rule');
  check('it comes after the rule it has to override',
    css.indexOf('.page canvas.detail') > css.indexOf('.page canvas.pdf-canvas { position: relative; }'),
    'equal specificity — source order is what decides');
  check('and can actually be hidden while the next one renders',
    /\.page canvas\.detail\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
    'author display:block beats the UA [hidden] rule');

  /* Whether the crop is ever asked for at all.
     ---------------------------------------------------------------------------
     Everything above tests a crop that gets taken. This is the half that
     decides whether it does, and it is where the overlay went silently dead:
     on an ANSI E sheet at 800% the drawing stayed soft for the whole session,
     with `capped 1` and `active 1` in the diagnostics and nothing else to go
     on. Two faults compounded, and neither raises anything.

     `pumpDetail` returned outright while a raster was pending instead of
     asking again, so the request was simply dropped — and the only thing that
     ever re-asked was a *later* capped render succeeding, which on a document
     showing one large sheet never comes. And the thing it asked was
     `activeRenders`, a counter `pumpRenders` only decremented on the success
     arm of its `.then`. One rejection — `getContext` returns null rather than
     throwing when the browser will not back a surface, so the throw lands on
     the next line, outside every `try` in `renderPage` — pinned the count
     above zero permanently.

     So: the slot comes back from both arms, and the gate reads the pages
     rather than the counter. Both are needed. Either alone leaves a sheet
     that is soft at every zoom with nothing on screen to explain it. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const gate = RP.createViewer({ querySelector: () => null }, RP.store);
  gate.dpr = 2;
  gate.els = { viewer: { scrollTop: 5000, scrollLeft: 0, clientWidth: 1600, clientHeight: 1000 } };
  gate.pages = [Object.assign(makeRecord(0, 0.44),
    { viewport: { width: sheet.w, height: sheet.h } })];
  gate.pageTops = [0];
  gate.pageLefts = [0];
  let rearmed = 0;
  gate.scheduleDetail = () => { rearmed += 1; };
  let picked = 0;
  gate.renderDetail = (record, wanted) => {
    picked += 1;
    record.tile = wanted;
    return Promise.resolve();
  };

  gate.pages[0].renderTask = {};
  gate.pumpDetail();
  check('a crop waits for the sheet under it, and asks again rather than giving up',
    picked === 0 && rearmed === 1, `taken ${picked}, re-armed ${rearmed}`);

  gate.pages[0].renderTask = null;
  // The leak this replaced. The sheet is drawn and settled; only the counter
  // disagrees, and it must not be the thing holding the answer. Counted from
  // zero rather than from whatever the check above left behind, or a gate that
  // fires too eagerly passes this one on the previous scenario's crop.
  picked = 0;
  gate.activeRenders = 2;
  gate.pumpDetail();
  check('but a leaked render slot cannot switch the overlay off for the session',
    picked === 1, `taken ${picked}`);

  /* The slot itself. Note that the old code does not merely fail this check —
     an unhandled rejection takes the whole suite down with a non-zero exit,
     which is the correct amount of noise for a counter that silently disables
     a feature in the shipped app. */
  const slots = RP.createViewer({ querySelector: () => null }, RP.store);
  slots.pages = [Object.assign(makeRecord(0, 0.44),
    { rendered: false, viewport: { width: sheet.w, height: sheet.h } })];
  slots.currentPage = 0;
  let slotAsked = 0;
  slots.scheduleDetail = () => { slotAsked += 1; };
  slots.pumpLayers = () => {};
  slots.pumpThumbs = () => {};
  slots.renderPage = () => Promise.reject(new Error('no 2d context'));
  const realError = console.error;
  console.error = () => {};
  slots.requestPage(0);
  await flush();
  console.error = realError;
  check('a render that rejects still counts its slot back',
    slots.activeRenders === 0, slots.activeRenders + ' left in flight');
  check('and the crop is asked for as the slot clears, not only on a capped success',
    slotAsked === 1, slotAsked + ' requests');
}

/* ---------------------------------------------------------------------------
   The thumbnail navigator

   Past about 300% on a large-format sheet the pane holds a few percent of the
   drawing, and the scrollbars are the only thing saying which few. The
   thumbnail is already a picture of the whole sheet, so the box on it is the
   answer — and once it is there, dragging it is how you ask for somewhere
   else.

   Everything here is in *fractions of the page box* rather than pixels of
   either surface, because that is the one quantity that means the same thing
   on the thumbnail and on the page. It is also what makes the whole thing
   rotation-safe for nothing: the thumbnail is rendered through the same
   `rotationOf` the page viewport is, so the two are in the same displayed
   orientation by construction and no angle ever enters the arithmetic.
   --------------------------------------------------------------------------- */
function testNavigator() {
  console.log('\nThumbnail navigator');

  const sheet = { x: 0, y: 0, w: 1000, h: 2000 };

  const mid = RP.views.visibleBox(sheet, { x: 250, y: 500, w: 500, h: 400 });
  check('the box is the visible part of the sheet, as fractions of it',
    mid.x === 0.25 && mid.y === 0.25 && mid.w === 0.5 && mid.h === 0.2,
    `${mid.x}, ${mid.y}, ${mid.w}×${mid.h}`);

  /* Clipped to the sheet, not to the pane. Scrolled to the bottom of a
     document the pane holds the last of the drawing *and* the gap under it,
     and a box drawn from the raw pane height hangs off the end of the
     thumbnail claiming there is sheet down there that is not. */
  const foot = RP.views.visibleBox(sheet, { x: 0, y: 1800, w: 1000, h: 600 });
  check('and clipped to the sheet where the pane runs past it',
    foot.y === 0.9 && Math.abs(foot.y + foot.h - 1) < 1e-9,
    `y ${foot.y} + h ${foot.h}`);

  /* A page is not at the origin of the scroller: the column is padded, and the
     second sheet of a facing spread starts most of a page across. Both boxes
     are in the scroller's coordinates and the subtraction is what puts the
     answer back in the page's own space — dropping it reads the column
     position as a scroll offset and slides the box off the sheet. */
  const second = { x: 1040, y: 3120, w: 1000, h: 2000 };
  const onSecond = RP.views.visibleBox(second, { x: 1290, y: 3620, w: 500, h: 400 });
  check('a sheet away from the origin is measured in its own space',
    onSecond.x === 0.25 && onSecond.y === 0.25,
    `${onSecond.x}, ${onSecond.y}`);

  check('a sheet with none of it on screen has no box at all',
    RP.views.visibleBox(sheet, { x: 0, y: 9000, w: 500, h: 400 }) === null);
  const whole = RP.views.visibleBox(sheet, { x: -50, y: -50, w: 1200, h: 2200 });
  check('a sheet entirely on screen reports itself whole, not null',
    whole.w === 1 && whole.h === 1, 'the caller decides whether to draw it');

  /* Centred, and deliberately unclamped: the scroll limits live on the live
     container and the caller owns them. A clamp here would have to be given
     `maxScrollTop`, which is a DOM measurement, and this file could not test
     any of it. */
  const to = RP.views.scrollToFraction(sheet, { x: 0, y: 0, w: 500, h: 400 }, 0.5, 0.5);
  check('clicking the middle of a thumbnail centres the middle of the sheet',
    to.top === 800 && to.left === 250, `top ${to.top}, left ${to.left}`);
  const corner = RP.views.scrollToFraction(sheet, { x: 0, y: 0, w: 500, h: 400 }, 0, 0);
  check('and a corner asks for a negative offset rather than pretending',
    corner.top < 0 && corner.left < 0, `top ${corner.top}, left ${corner.left}`);

  // -- the viewer's half ---------------------------------------------------

  const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
  const scrolled = [];
  const scroller = {
    scrollTop: 500, scrollLeft: 250, clientWidth: 500, clientHeight: 400,
    scrollHeight: 2400, scrollWidth: 1000,
    scrollTo: (opts) => scrolled.push(opts)
  };
  const box = {
    style: {}, hidden: true, isConnected: true, parentNode: null,
    classList: { add() {}, remove() {} },
    addEventListener() {}, setPointerCapture() {}, removeEventListener() {}
  };
  const shot = {
    appendChild: (el) => { el.parentNode = shot; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 240 })
  };
  viewer.els = { viewer: scroller, thumbs: {} };
  viewer.navBox = box;
  viewer.pages = [{
    index: 0,
    viewport: { width: sheet.w, height: sheet.h },
    thumbShot: shot,
    thumbButton: null
  }];
  viewer.pageTops = [0];
  viewer.pageLefts = [0];
  viewer.currentPage = 0;
  viewer.highlightThumb = () => {};
  const wasViewer = RP.viewer;
  RP.viewer = viewer;   // isActive()

  viewer.updateNavBox();
  check('the box lands over the part of the sheet on screen',
    !box.hidden && box.style.left === '25.000%' && box.style.top === '25.000%',
    `${box.style.left} / ${box.style.top}, ${box.style.width}×${box.style.height}`);
  check('and adopts the current sheet\'s thumbnail', box.parentNode === shot);

  /* At fit-width the whole sheet is on screen and a box around all of it is a
     border that means nothing. The feature has to appear when the sheet stops
     fitting and not before, or it is decoration on every ordinary document. */
  scroller.clientWidth = 1200;
  scroller.clientHeight = 2400;
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  viewer.updateNavBox();
  check('and is not drawn at all when the whole sheet is on screen', box.hidden === true);

  // Back to a zoomed-in view for the click.
  scroller.clientWidth = 500;
  scroller.clientHeight = 400;
  viewer.revealFraction(0, 0.5, 0.5, { instant: true });
  const landed = scrolled[scrolled.length - 1];
  check('clicking a thumbnail scrolls to that spot at the zoom in force',
    landed.top === 800 && landed.left === 250, `top ${landed.top}, left ${landed.left}`);
  check('and lands instantly rather than animating', landed.behavior === 'auto');

  /* The clamp the pure half leaves to the caller. A click at the very top of a
     thumbnail asks for a negative scroll; handing that to `scrollTo` unclamped
     is a no-op on one browser and a jump to zero on another. */
  scrolled.length = 0;
  viewer.revealFraction(0, 0, 0, { instant: true });
  const clamped = scrolled[scrolled.length - 1];
  check('a click at the edge is clamped to the scroll range, not passed through',
    clamped.top === 0 && clamped.left === 0, `top ${clamped.top}, left ${clamped.left}`);

  /* The press has to be swallowed. `RP.pages` starts a page-reorder drag from
     a pointerdown on any `.thumb`, delegated on the list, so a drag of the box
     that lets the event through moves the sheet to a different place in the
     document — a page order change from a gesture that meant "pan". */
  let stopped = false;
  let defaulted = false;
  viewer.revealFraction = () => {};
  viewer.startNavDrag({
    button: 0, pointerId: 1, clientX: 0, clientY: 0,
    stopPropagation: () => { stopped = true; },
    preventDefault: () => { defaulted = true; }
  });
  check('dragging the box does not also start a page reorder',
    stopped && defaulted, `stopPropagation ${stopped}, preventDefault ${defaulted}`);
  check('and the drag pins the box to the sheet it grabbed',
    viewer.navDrag === 0, 'a drag to the edge must not re-parent it mid-gesture');

  RP.viewer = wasViewer;

  // -- the stylesheet's half -----------------------------------------------

  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const shotRule = (css.match(/\.thumb-shot\s*\{[^}]*\}/) || [''])[0];
  check('the canvas wrapper is positioned, so the box can be a percentage of it',
    /position:\s*relative/.test(shotRule) && /display:\s*block/.test(shotRule),
    shotRule.replace(/\s+/g, ' ') || 'no .thumb-shot rule');
  check('and adds no spacing of its own, or the box is offset from the sheet',
    !/padding|margin/.test(shotRule), shotRule.replace(/\s+/g, ' '));

  const viewRule = (css.match(/\.thumb-view\s*\{[^}]*\}/) || [''])[0];
  check('the box is absolute over the canvas', /position:\s*absolute/.test(viewRule));
  check('and has a floor on its size, or it is ungrabbable at high zoom',
    /min-width/.test(viewRule) && /min-height/.test(viewRule),
    'a few percent of a thumbnail is a fraction of a pixel');
  check('and can actually be hidden',
    /\.thumb-view\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
    'author display:block beats the UA [hidden] rule — same trap as the crop');
}

/* ---------------------------------------------------------------------------
   Text layer scheduling

   The slow load. `renderPage` used to await the text layer and the native
   annotation layer inside its render slot, so `activeRenders` stayed occupied
   for the whole chain — and on a drawing plotted out of CAD that chain is the
   expensive half, not the raster: the text arrives as thousands of short runs,
   so `getTextContent` is a long trip through the one pdf.js worker and
   `TextLayer.render` is a few thousand absolutely positioned divs behind it.
   With two slots, two of those blocked the sheet actually being waited for.

   The layers are now their own queue, behind every pending raster, one at a
   time, for pages on screen only. What is pinned here is the ordering and the
   two ways a build can be wasted — a page that scrolled away, and a zoom that
   landed mid-build.
   --------------------------------------------------------------------------- */
async function testLayerQueue() {
  console.log('\nText layer scheduling');

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const makeRecord = (index, visible) => ({
    index,
    visible: !!visible,
    rendered: true,
    renderTask: null,
    layersBuilt: false,
    layerTask: false,
    annotDirty: false,
    viewport: { scale: 1, width: 800, height: 1000 },
    pdfCanvas: { width: 800, height: 1000, style: {} },
    annotCanvas: { width: 800, height: 1000, style: {} },
    textLayer: { innerHTML: 'runs' },
    nativeLayer: { innerHTML: 'annots', hidden: false },
    nativeLayerObj: null,
    textDivs: [1, 2, 3],
    annotCanvasMap: null,
    container: {
      classList: { add() {}, remove() {} },
      style: { setProperty() {} },
      dataset: {}
    }
  });

  const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
  const built = [];
  // The scheduling is what is under test, not what a layer build does.
  viewer.buildLayers = async (index) => {
    built.push(index);
    const record = viewer.pages[index];
    if (record) record.layersBuilt = true;
  };

  viewer.pages = [0, 1, 2, 3, 4].map((i) => makeRecord(i, i >= 1 && i <= 3));
  viewer.currentPage = 2;

  /* A raster outranks a layer, always. A page with no bitmap is a blank sheet;
     a page with no text layer is a sheet you cannot select on *yet*. */
  viewer.activeRenders = 1;
  viewer.requestLayers(2);
  await flush();
  check('a layer build waits behind a raster in flight', built.length === 0,
    built.length + ' built');

  viewer.activeRenders = 0;
  viewer.renderQueue = [7];
  viewer.pumpLayers();
  await flush();
  check('and behind one still queued', built.length === 0, built.length + ' built');

  viewer.renderQueue = [];
  viewer.pumpLayers();
  await flush();
  check('and runs once the render queue is clear', built.join(',') === '2', built.join(',') || 'none');

  /* Off-screen pages are skipped outright. The page observer prefetches 600px
     past the viewport in both directions and a split has two panes doing it —
     building text layers for all of that is most of what made a large set feel
     like it was loading in slow motion. */
  built.length = 0;
  for (const i of [0, 4]) viewer.requestLayers(i);
  await flush();
  check('a page off screen does not get a text layer built for it',
    built.length === 0, built.join(',') || 'none');

  // But it must be caught when it comes back, or it is a page that silently
  // never becomes selectable. That is the observer's job; the flag it reads is
  // what is checked here.
  check('an off-screen page is left marked as needing one',
    viewer.pages[0].layersBuilt === false && viewer.pages[4].layersBuilt === false);

  built.length = 0;
  viewer.pages[0].visible = true;
  viewer.requestLayers(0);
  await flush();
  check('and gets one as soon as it is on screen again', built.join(',') === '0',
    built.join(',') || 'none');

  /* Nearest the viewport first, the same ordering the render queue uses. The
     queue is seeded directly rather than through `requestLayers`, because a
     request made while nothing is in flight is served immediately — the
     ordering only decides anything for the ones that pile up behind a build,
     which with one slot is all of them on a real document. */
  built.length = 0;
  for (const record of viewer.pages) { record.visible = true; record.layersBuilt = false; }
  viewer.layerQueue = [4, 0, 3, 1];
  viewer.pumpLayers();
  for (let i = 0; i < 6; i += 1) await flush();
  check('layers are built nearest the viewport first', built[0] === 1 || built[0] === 3,
    built.join(','));
  check('and every queued page is eventually built',
    built.length === 4, built.join(','));

  // Asking twice must not build twice: `requestLayers` fires from the render
  // completion *and* from the observer on every intersection change.
  built.length = 0;
  viewer.pages[2].layersBuilt = true;
  viewer.requestLayers(2);
  await flush();
  check('a page that already has its layers is not rebuilt', built.length === 0,
    built.join(',') || 'none');

  /* One slot means one throw is enough to stop everything. A build that
     rejects and is not counted back leaves `activeLayers` stuck and every
     later page silently never becomes selectable — which would read as the
     deferral being broken rather than as one page failing. */
  const stalled = RP.createViewer({ querySelector: () => null }, RP.store);
  const after = [];
  stalled.pages = [0, 1].map((i) => makeRecord(i, true));
  stalled.buildLayers = async (index) => {
    if (index === 0) throw new Error('text layer blew up');
    after.push(index);
    stalled.pages[index].layersBuilt = true;
  };
  stalled.layerQueue = [0, 1];
  stalled.pumpLayers();
  for (let i = 0; i < 4; i += 1) await flush();
  check('a layer build that throws does not stall the queue behind it',
    after.join(',') === '1', after.join(',') || 'nothing built after the throw');
  check('and the slot is handed back', stalled.activeLayers === 0,
    stalled.activeLayers + ' still active');

  /* Thumbnails queue behind layers as well as behind rasters. They share the
     one worker, and a thumbnail is the least urgent thing on screen. */
  const thumbViewer = RP.createViewer({ querySelector: () => null }, RP.store);
  let thumbsPumped = 0;
  thumbViewer.pages = [makeRecord(0, true)];
  thumbViewer.renderThumb = async () => { thumbsPumped += 1; };
  thumbViewer.pages[0].thumbCanvas = { width: 10, height: 10 };
  thumbViewer.pages[0].thumbRendered = false;
  thumbViewer.layerQueue = [0];
  thumbViewer.thumbQueue = [0];
  thumbViewer.pumpThumbs();
  await flush();
  check('a thumbnail waits behind a pending text layer', thumbsPumped === 0,
    thumbsPumped + ' pumped');

  /* A zoom mid-build. Both layers are positioned against `record.viewport`,
     and `layout()` replaces that object — so identity is the test, and a build
     that comes back to a different one has to drop what it did rather than
     leave runs positioned against geometry that has gone. */
  const guarded = RP.createViewer({ querySelector: () => null }, RP.store);
  guarded.pages = [makeRecord(0, true)];
  const record = guarded.pages[0];
  const annots = RP.annots.build;
  let annotsBuilt = 0;
  guarded.buildTextLayer = async () => {
    // The zoom lands while the text content is being fetched.
    record.viewport = { scale: 2, width: 1600, height: 2000 };
  };
  RP.annots.build = async () => { annotsBuilt += 1; };
  try {
    await guarded.buildLayers(0);
  } finally {
    RP.annots.build = annots;
  }
  check('a zoom mid-build stops the annotation layer being built at the old scale',
    annotsBuilt === 0, annotsBuilt + ' built');
  check('and the page is left needing its layers rather than marked done',
    record.layersBuilt === false);

  /* A re-layout drops the whole queue: every entry in it is for a viewport
     that no longer exists, and the pages will re-request as they re-raster. */
  const relaid = RP.createViewer({ querySelector: () => null }, RP.store);
  relaid.pages = [makeRecord(0, true), makeRecord(1, true)];
  relaid.pages[0].layersBuilt = true;
  relaid.layerQueue = [1];
  relaid.els = { viewer: null, pages: null };
  relaid.pages.forEach((r) => {
    r.pageProxy = { rotate: 0, getViewport: () => ({ width: 800, height: 1000 }) };
  });
  relaid.emit = () => {};
  relaid.rasterNow = () => {};
  relaid.layout();
  check('a re-layout empties the layer queue', relaid.layerQueue.length === 0,
    relaid.layerQueue.length + ' queued');
  check('and marks a built page as needing its layers again',
    relaid.pages[0].layersBuilt === false);

  /* A released page loses its layers with its bitmap, so it has to be able to
     ask for them again — `releasePage` clears the DOM, and the flag has to go
     with it or the page comes back rastered and permanently unselectable. */
  const released = RP.createViewer({ querySelector: () => null }, RP.store);
  released.pages = [makeRecord(0, false)];
  released.pages[0].layersBuilt = true;
  released.releasePage(released.pages[0]);
  check('a released page is marked as needing its layers rebuilt',
    released.pages[0].layersBuilt === false);
  check('and its text layer is actually emptied',
    released.pages[0].textLayer.innerHTML === '');

  /* The "this page is a scan" warning reads counts that are both zero until
     the layer exists. Deferred, that fires on a sheet full of schedules. */
  RP.tools.warnedNoText = false;
  let warned = false;
  const toast = RP.toast;
  RP.toast = () => { warned = true; };
  try {
    RP.tools.checkPageHasText({ layersBuilt: false, textLayer: { childElementCount: 0 }, textContent: null });
    check('no "this is a scan" warning before the text layer is built', !warned);
    RP.tools.checkPageHasText({ layersBuilt: true, textLayer: { childElementCount: 0 }, textContent: { items: [] } });
    check('but a genuine scan still warns once the layer is built', warned);
  } finally {
    RP.toast = toast;
    RP.tools.warnedNoText = false;
  }
}

/* ---------------------------------------------------------------------------
   Canvas retention

   Nothing frees a page canvas on its own. A 77-sheet set at fit-width holds
   over a gigabyte of backing store if every page keeps its bitmap, and the
   symptom is not a crash — it is pages taking longer and longer to appear the
   further into the document you have scrolled, which is easy to blame on the
   file or the machine. So the two halves are pinned here: eviction actually
   hands memory back, and the page you are looking at is never the one evicted.
   --------------------------------------------------------------------------- */
function testCanvasRetention() {
  console.log('\nCanvas retention');

  /** A page record with canvases big enough that a few blow any sane budget. */
  const makeRecord = (index, visible) => {
    const canvas = () => ({ width: 3200, height: 4140, style: {} });
    return {
      index,
      visible: !!visible,
      rendered: true,
      renderTask: null,
      pdfCanvas: canvas(),
      annotCanvas: canvas(),
      textLayer: { innerHTML: 'text' },
      nativeLayer: { innerHTML: 'annots', hidden: false },
      nativeLayerObj: null,
      textDivs: [1, 2, 3],
      annotCanvasMap: new Map()
    };
  };

  const viewer = RP.createViewer({ querySelector: () => null }, RP.store);
  viewer.pages = [];
  for (let i = 0; i < 40; i += 1) viewer.pages.push(makeRecord(i, i >= 19 && i <= 21));
  viewer.currentPage = 20;

  const before = viewer.rasterStats();
  viewer.retainCanvases();
  const after = viewer.rasterStats();

  check('40 rastered sheets is over the retention budget',
    before.approxMB > before.budgetMB, `${before.approxMB} MB vs ${before.budgetMB} MB budget`);
  check('eviction sheds the bulk of it',
    after.approxMB < before.approxMB / 10,
    `${before.approxMB} MB -> ${after.approxMB} MB (budget ${after.budgetMB} MB)`);
  /* Not "under budget": the budget is a target, not a ceiling. Pages on screen
     and the MIN_RETAINED_PAGES floor are exempt, and three E-size sheets at
     fit-width exceed it between them. Evicting those would mean re-rendering
     the sheet being drawn on every scroll frame, which is worse than the
     memory. So what is checked is that nothing *else* survived. */
  check('everything still held is on screen or inside the floor',
    viewer.pages.filter((r) => r.pdfCanvas.width > 0)
      .every((r) => r.visible || Math.abs(r.index - viewer.currentPage) <= 2),
    viewer.pages.filter((r) => r.pdfCanvas.width > 0).map((r) => r.index + 1).join(','));
  check('eviction actually zeroes the backing store, not just a flag',
    viewer.pages[0].pdfCanvas.width === 0 && viewer.pages[0].annotCanvas.width === 0,
    `page 1 canvas ${viewer.pages[0].pdfCanvas.width}x${viewer.pages[0].pdfCanvas.height}`);

  // The page under the viewport is exempt whatever the budget says, or scrolling
  // would evict the sheet being drawn and re-render it on the spot, forever.
  check('the page you are looking at is never evicted',
    viewer.pages[20].rendered && viewer.pages[20].pdfCanvas.width > 0,
    'page 21 rendered=' + viewer.pages[20].rendered);
  check('the pages either side of it survive too',
    viewer.pages[19].pdfCanvas.width > 0 && viewer.pages[21].pdfCanvas.width > 0);
  check('an evicted page is marked for repaint, not left silently blank',
    viewer.pages[0].annotDirty === true && viewer.pages[0].rendered === false);
  check('an evicted page drops its text and annotation layers',
    viewer.pages[0].textLayer.innerHTML === '' && viewer.pages[0].nativeLayer.innerHTML === '');

  // A released page must still occupy its slot in the scroll column, or the
  // document would concertina as you scrolled and every offset would move.
  check('eviction leaves the CSS box alone so the scroll column holds',
    viewer.pages[0].pdfCanvas.style.width === undefined ||
    viewer.pages[0].pdfCanvas.style.width !== '0px');

  // Re-running must be idempotent: retainCanvases is called from the observer,
  // so it fires several times per scroll.
  const stable = viewer.rasterStats();
  viewer.retainCanvases();
  check('a second sweep evicts nothing further',
    viewer.rasterStats().rastered === stable.rastered, `${stable.rastered} pages held`);

  /* A single sheet can be larger than the whole budget — an E-size drawing at
     400% is tens of megapixels on its own. Something must survive, or the
     viewer evicts everything and renders nothing.

     What survives is where this changed. The page floor used to be
     unconditional, so three sheets of this size were held whatever the budget
     said — several hundred megabytes that nothing could evict, on exactly the
     documents the budget was written for. The floor now gives way past
     FLOOR_CEILING_PX and only the sheet under the viewport stays exempt. */
  const huge = RP.createViewer({ querySelector: () => null }, RP.store);
  huge.pages = [];
  for (let i = 0; i < 6; i += 1) {
    const record = makeRecord(i, false);
    record.pdfCanvas.width = 12000;
    record.pdfCanvas.height = 12000;
    record.annotCanvas.width = 12000;
    record.annotCanvas.height = 12000;
    huge.pages.push(record);
  }
  huge.currentPage = 3;
  huge.retainCanvases();
  check('a sheet larger than the whole budget is still retained',
    huge.rasterStats().rastered >= 1, huge.rasterStats().rastered + ' pages held');
  check('the retained one is the page under the viewport',
    huge.pages[3].pdfCanvas.width > 0, 'current page held');
  check('the page floor does not hold sheets this size against the budget',
    huge.rasterStats().approxMB < 6 * 12000 * 12000 * 2 * 4 / 1e6 / 3,
    huge.rasterStats().approxMB + ' MB held');

  /* The floor still does its job at ordinary sheet sizes: three 13 MP pages
     are what it was written for, and evicting the neighbours of the page you
     are on means re-rendering them the moment you scroll a line. */
  const normal = RP.createViewer({ querySelector: () => null }, RP.store);
  normal.pages = [];
  for (let i = 0; i < 12; i += 1) normal.pages.push(makeRecord(i, false));
  normal.currentPage = 6;
  normal.retainCanvases();
  check('the floor still holds three ordinary sheets',
    normal.rasterStats().rastered >= 3, normal.rasterStats().rastered + ' pages held');
}

/* ---------------------------------------------------------------------------
   Scroll position

   `onScroll` runs on every frame of a scroll. It used to ask all 77 containers
   for a bounding rect, forcing a layout per page per frame; it now binary
   searches cached offsets, so the answer has to keep matching the old one at
   the boundaries — inside a page, in the gutter between two, and at both ends.
   --------------------------------------------------------------------------- */
function testScrollPage() {
  console.log('\nCurrent page tracking');

  const PAGE_H = 800;
  const GAP = 16;
  const viewer = RP.createViewer({ querySelector: () => null }, RP.store);

  // The probe sits min(140, 30% of height) below the top of the pane.
  const scroller = {
    scrollTop: 0, scrollLeft: 0, clientHeight: 900,
    scrollHeight: 77 * (PAGE_H + GAP) + 900,
    getBoundingClientRect: () => ({ top: 0, left: 0 })
  };
  viewer.els = { viewer: scroller };

  viewer.pages = [];
  for (let i = 0; i < 77; i += 1) {
    const layoutTop = i * (PAGE_H + GAP);
    viewer.pages.push({
      index: i,
      container: {
        offsetTop: layoutTop,
        offsetHeight: PAGE_H,
        getBoundingClientRect: () => ({ top: layoutTop - scroller.scrollTop, left: 0 })
      }
    });
  }
  viewer.highlightThumb = function () {};
  viewer.emit = function () {};
  const at = (top) => {
    scroller.scrollTop = top;
    viewer.onScroll();
    return viewer.currentPage;
  };

  check('the top of the document is page 1', at(0) === 0, 'page ' + (at(0) + 1));
  check('scrolling within a sheet keeps that sheet current',
    at(300) === 0, 'page ' + (at(300) + 1));
  // The probe is 140px below the top of the pane, so sheet 2 (top 816) takes
  // over the moment scrollTop reaches 676 — not when it reaches the top edge.
  check('the next sheet takes over once it passes the probe line',
    at(600) === 0 && at(700) === 1, `${at(600) + 1} then ${at(700) + 1}`);
  check('the gutter between sheets belongs to the one above it',
    at(PAGE_H - 140 + 8) === 0, 'page ' + (at(PAGE_H - 140 + 8) + 1));
  check('a jump deep into the set lands on the right sheet',
    at(50 * (PAGE_H + GAP)) === 50, 'page ' + (at(50 * (PAGE_H + GAP)) + 1));
  check('the last sheet is reachable and does not overrun',
    at(76 * (PAGE_H + GAP) + 400) === 76, 'page ' + (at(76 * (PAGE_H + GAP) + 400) + 1));

  // layout() invalidates the cache; a stale one would report the old geometry.
  viewer.pageTops = null;
  check('a cleared offset cache is rebuilt rather than crashing',
    at(20 * (PAGE_H + GAP)) === 20, 'page ' + (at(20 * (PAGE_H + GAP)) + 1));
}

/* ---------------------------------------------------------------------------
   Tabs

   Each open drawing gets its own store, and the one the UI is pointed at is
   `RP.store`. Two things must hold or markups leak between drawings: the stores
   have to be genuinely separate, and a background store must not be able to
   drive the UI off the bus.
   --------------------------------------------------------------------------- */

function testSessions() {
  console.log('\nPer-document sessions');

  const a = RP.createStore();
  const b = RP.createStore();
  check('every document gets its own store', a !== b && a.id !== b.id, a.id + ' / ' + b.id);

  const saved = RP.store;
  RP.store = a;
  a.setDocument({ doc: null, path: 'C:\\drawings\\E-101.pdf', name: 'E-101.pdf', bytes: null });
  b.setDocument({ doc: null, path: 'C:\\drawings\\E-102.pdf', name: 'E-102.pdf', bytes: null });
  a.add({ page: 0, type: 'rect', x: 0, y: 0, w: 10, h: 10 });
  a.select(a.annotations[0].id);

  check('markups do not leak between documents',
    a.annotations.length === 1 && b.annotations.length === 0);
  check('selection does not leak between documents',
    a.selection.size === 1 && b.selection.size === 0);
  check('undo history is per document',
    a.canUndo() === true && b.canUndo() === false);

  // The bus gate: only the focused store may repaint the shared chrome.
  let heard = 0;
  const off = RP.bus.on('annots:changed', () => { heard += 1; });
  b.add({ page: 0, type: 'rect', x: 0, y: 0, w: 5, h: 5 });
  check('a background document cannot repaint the UI', heard === 0, heard + ' events heard');
  a.add({ page: 0, type: 'rect', x: 0, y: 0, w: 5, h: 5 });
  check('the focused document still drives the UI', heard === 1, heard + ' events heard');
  if (typeof off === 'function') off();

  // ...except the dirty flag, which the tab strip and the close guard need for
  // documents nobody is looking at.
  b.markDirty(false);
  b.markDirty(true);
  check('an unsaved background document still knows it is dirty', b.dirty === true);

  RP.store = saved;
}

/* ---------------------------------------------------------------------------
   Printing

   The print path is where "it looked right on screen" is least useful, so the
   things that can silently ruin a plot are checked here: the range parser, the
   page subset, and — the one that matters most for drawings — that actual-size
   printing leaves page geometry byte-for-byte alone.
   --------------------------------------------------------------------------- */
async function testPrinting() {
  console.log('\nPrinting');
  const Print = RP.print;

  // --- range parsing --------------------------------------------------------
  const parse = (text, count) => Print.parseCustom(text, count === undefined ? 10 : count);
  check('a single page parses to one zero-based index', String(parse('3')) === '2');
  check('a span is inclusive at both ends', String(parse('2-4')) === '1,2,3');
  check('a comma list keeps document order and de-duplicates',
    String(parse('5, 1-2, 5')) === '4,0,1');
  check('an open-ended span runs to the last page', String(parse('8-', 10)) === '7,8,9');
  check('a backwards span is read as the span the user meant', String(parse('4-2')) === '1,2,3');
  check('pages past the end are dropped, not clamped', String(parse('9-14', 10)) === '8,9');
  check('nonsense is rejected rather than guessed at', parse('abc') === null && parse('') === null);
  check('a range entirely outside the document is rejected', parse('40-50', 10) === null);

  // --- page subsetting ------------------------------------------------------
  const store = RP.store;
  const source = await makeThreePagePdf();
  store.docName = 'panel-schedule.pdf';
  store.numPages = 3;

  const subset = await Print.layout(source, [2, 0], null);
  const subsetDoc = await PDFLib.PDFDocument.load(subset);
  check('the print copy holds exactly the pages asked for', subsetDoc.getPageCount() === 2,
    subsetDoc.getPageCount() + ' pages');
  check('pages come out in the order the range gave them',
    await pageLabel(subset, 0) === 'SHEET-3' && await pageLabel(subset, 1) === 'SHEET-1');

  // --- actual size must not touch geometry ---------------------------------
  const srcDoc = await PDFLib.PDFDocument.load(source);
  const srcBox = srcDoc.getPages()[1].getMediaBox();
  const actual = await Print.layout(source, [1], null);
  const actualBox = (await PDFLib.PDFDocument.load(actual)).getPages()[0].getMediaBox();
  check('actual size leaves the sheet exactly as it was',
    actualBox.width === srcBox.width && actualBox.height === srcBox.height,
    `${actualBox.width}×${actualBox.height} vs ${srcBox.width}×${srcBox.height}`);

  // --- fit to paper ---------------------------------------------------------
  const fitted = await Print.layout(source, [0], Print.PAPER.letter);
  const fittedBox = (await PDFLib.PDFDocument.load(fitted)).getPages()[0].getMediaBox();
  check('fitting lands the sheet on the chosen paper',
    Math.abs(fittedBox.width - 612) < 0.5 && Math.abs(fittedBox.height - 792) < 0.5,
    `${fittedBox.width.toFixed(1)}×${fittedBox.height.toFixed(1)}`);

  // A landscape sheet should get landscape paper, not a portrait letterbox.
  const wide = await PDFLib.PDFDocument.create();
  wide.addPage([1224, 792]);
  const wideFitted = await Print.layout(await wide.save(), [0], Print.PAPER.letter);
  const wideBox = (await PDFLib.PDFDocument.load(wideFitted)).getPages()[0].getMediaBox();
  check('a landscape sheet is fitted onto landscape paper',
    wideBox.width > wideBox.height,
    `${wideBox.width.toFixed(1)}×${wideBox.height.toFixed(1)}`);

  // Sizing the sheet right is only half of it — the content has to actually
  // land on it. A 1224×1584 sheet is exactly 2× Letter, so every mark should
  // come back at half its coordinates and half its size.
  const halved = await Print.layout(await markedSheet(1224, 1584, 100, 200), [0], Print.PAPER.letter);
  const halvedMark = await firstTextPos(halved);
  check('fitted content is scaled and placed, not just re-boxed',
    !halvedMark || (near(halvedMark.x, 50) && near(halvedMark.y, 100) && near(halvedMark.size, 20)),
    halvedMark ? `x=${halvedMark.x} y=${halvedMark.y} size=${halvedMark.size} (want 50/100/20)` : 'pdf.js unavailable');

  // A 2:1 sheet on landscape Letter leaves slack top and bottom; it should be
  // shared, not dumped at one edge.
  const ratio = 792 / 1224;
  const centred = await Print.layout(await markedSheet(1224, 792, 0, 0), [0], Print.PAPER.letter);
  const centredMark = await firstTextPos(centred);
  const wantY = (612 - 792 * ratio) / 2;
  check('a sheet that does not match the paper aspect is centred',
    !centredMark || (near(centredMark.x, 0) && near(centredMark.y, wantY)),
    centredMark ? `y=${centredMark.y} (want ${wantY.toFixed(2)})` : 'pdf.js unavailable');

  // A MediaBox with a non-zero origin would otherwise scale its own offset and
  // walk the drawing off the sheet.
  const offset = await Print.layout(await markedSheet(1224, 1584, 150, 100, [100, 50]), [0], Print.PAPER.letter);
  const offsetMark = await firstTextPos(offset);
  check('an offset MediaBox does not drag the content off the paper',
    !offsetMark || (near(offsetMark.x, 25) && near(offsetMark.y, 25)),
    offsetMark ? `x=${offsetMark.x} y=${offsetMark.y} (want 25/25)` : 'pdf.js unavailable');

  // /Rotate is applied after the content stream, so a rotated sheet has to be
  // fitted in unrotated space or it prints off the edge of the paper.
  const turned = await PDFLib.PDFDocument.create();
  const turnedPage = turned.addPage([792, 1224]);
  turnedPage.setRotation(PDFLib.degrees(90));
  const turnedFitted = await Print.layout(await turned.save(), [0], Print.PAPER.letter);
  const turnedOut = (await PDFLib.PDFDocument.load(turnedFitted)).getPages()[0];
  const turnedBox = turnedOut.getMediaBox();
  check('a /Rotate 90 sheet keeps its rotation through the fit',
    turnedOut.getRotation().angle === 90, String(turnedOut.getRotation().angle));
  // Stored 792×1224 with /Rotate 90 displays as 1224×792 — landscape — so it
  // wants landscape Letter (792×612 on paper), which is a 612×792 MediaBox
  // *before* the rotation is applied. Getting this backwards is exactly how a
  // rotated sheet ends up printing off the edge of the paper.
  check('a /Rotate 90 sheet is fitted by how it displays, not how it is stored',
    Math.abs(turnedBox.width - 612) < 0.5 && Math.abs(turnedBox.height - 792) < 0.5,
    `MediaBox ${turnedBox.width.toFixed(1)}×${turnedBox.height.toFixed(1)}` +
    ` → prints ${turnedBox.height.toFixed(1)}×${turnedBox.width.toFixed(1)}`);

  // --- the print copy is a dead end, not a save ----------------------------
  store.reset();
  store.docBytes = await makeSourcePdf();
  store.docName = 'sheet.pdf';
  store.numPages = 2;
  store.annotations = sampleAnnotations();
  const printable = await RP.exporter.buildPdf({ embed: false });
  const savedCopy = await RP.exporter.buildPdf({});
  const printableDoc = await PDFLib.PDFDocument.load(printable);
  const catalogKeys = printableDoc.catalog.keys().map(String);
  check('a print copy carries no re-editable markup model',
    !catalogKeys.includes('/RedlineMarkup') &&
    (await RP.exporter.readEmbeddedMarkup(printable)) === null,
    catalogKeys.join(' '));

  // …but dropping the model must not drop the ink. The print copy should be
  // stamped exactly as heavily as a real save.
  const streams = async (bytes) => {
    const doc = await PDFLib.PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
      const contents = page.node.get(PDFLib.PDFName.of('Contents'));
      return contents && contents.asArray ? contents.asArray().length : 1;
    });
  };
  const printStreams = await streams(printable);
  const saveStreams = await streams(savedCopy);
  check('a print copy is stamped as heavily as a save',
    JSON.stringify(printStreams) === JSON.stringify(saveStreams),
    JSON.stringify(printStreams) + ' vs ' + JSON.stringify(saveStreams));

  // Markups off has to rebuild from stripped bytes; a page carrying a previous
  // save's stamps in its content stream would print ink the user turned off.
  const stampedTwice = await RP.exporter.buildPdf({});
  const stripped = await RP.exporter.stripToBaseBytes(stampedTwice);
  const strippedDoc = await PDFLib.PDFDocument.load(stripped);
  check('markups-off starts from bytes with no stamps left in them',
    (await RP.exporter.readEmbeddedMarkup(stripped)) === null &&
    strippedDoc.getPageCount() === 2);

  /* The preview window is the other half of printing, and the half that cannot
     be tested by reading bytes. Chromium does not make a PDF the top-level
     document even when the URL is one — it loads its viewer and puts the PDF in
     a child frame — so a print issued before that frame lands prints the viewer
     instead: a blank sheet if nothing has painted, a shrunken picture of the
     window if it has. `ready-to-show` is the viewer, not the drawing, so the
     automatic dialog must wait on the frame rather than on a timer. */
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('the automatic print dialog is not fired off a bare timer',
    !/setTimeout\(\s*\(\)\s*=>\s*printPreviewWindow/.test(mainSrc));
  check('printing waits for the preview to be showing the PDF',
    /await previewReady\(win\)/.test(mainSrc) &&
    /framesInSubtree/.test(mainSrc));
  check('the automatic dialog stands down rather than printing early',
    /printPreviewWindow\(target,\s*\{\s*requireReady:\s*true\s*\}\)/.test(mainSrc) &&
    /opts\.requireReady/.test(mainSrc));
  check('a print that went out wrong leaves something in the log',
    /logMain\('info',\s*'print dialog: '/.test(mainSrc));
  /* Bounded, or a viewer that never exposes a child frame would be a preview
     that never prints — worse than one that prints a little early. */
  check('the wait for the PDF frame is bounded',
    /PREVIEW_PLUGIN_MS/.test(mainSrc) && /PREVIEW_LOAD_MS/.test(mainSrc));
}

/* ---------------------------------------------------------------------------
   Native annotations

   Two things are worth pinning down without a browser: the destination maths
   (which decides where a link actually lands), and the contract that a URL out
   of an untrusted PDF cannot reach the OS without passing the main-process
   confirm dialog.
   --------------------------------------------------------------------------- */
function testNativeAnnotations() {
  console.log('\nNative annotations');
  const Annots = RP.annots;
  check('the module loads without touching the DOM', !!Annots && typeof Annots.build === 'function');

  // --- destination maths ----------------------------------------------------
  // Letter, MediaBox at the origin, and the same sheet plotted with a MediaBox
  // that starts somewhere else — which is common in issued drawing sets.
  const sheet = { view: [0, 0, 612, 792] };
  const offset = { view: [20, 30, 632, 822] };
  const dest = (...args) => Annots.destRect(args, sheet);

  const xyz = dest(null, { name: 'XYZ' }, 100, 700, null);
  check('an XYZ destination becomes a point at the given spot',
    xyz.x === 100 && xyz.y === 700 && xyz.w === 0 && xyz.h === 0, JSON.stringify(xyz));

  const noLeft = Annots.destRect([null, { name: 'XYZ' }, null, 700, 0], offset);
  check('a null XYZ coordinate falls back to the MediaBox, not to zero',
    noLeft.x === 20 && noLeft.y === 700, JSON.stringify(noLeft));

  check('XYZ with nothing but a zoom is not worth revealing',
    dest(null, { name: 'XYZ' }, null, null, 2) === null);

  const fitH = dest(null, { name: 'FitH' }, 500);
  check('FitH lands on the given row at the left edge', fitH.x === 0 && fitH.y === 500);
  check('FitBV lands on the given column at the top',
    Annots.destRect([null, { name: 'FitBV' }, 300], sheet).y === 792);

  const fitR = dest(null, { name: 'FitR' }, 400, 600, 100, 200);
  check('FitR normalises a backwards rect instead of producing a negative size',
    fitR.x === 100 && fitR.y === 200 && fitR.w === 300 && fitR.h === 400, JSON.stringify(fitR));

  check('Fit and unknown destination types just go to the page',
    dest(null, { name: 'Fit' }) === null &&
    dest(null, { name: 'FitB' }) === null &&
    dest(null, { name: 'Nonsense' }, 1, 2) === null);
  check('a malformed FitR is refused rather than half-applied',
    dest(null, { name: 'FitR' }, 10, 20, null, 40) === null);

  // --- link plumbing --------------------------------------------------------
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const annots = fs.readFileSync(path.join(ROOT, 'src', 'js', 'annots.js'), 'utf8');

  check('the external-link IPC exists on all three required sides',
    /ipcMain\.handle\(\s*'shell:open-external'/.test(main) &&
    /call\(\s*'shell:open-external'/.test(preload) &&
    /window\.rp\.links\.openExternal/.test(annots));
  check('the main process confirms before it opens anything',
    /showMessageBox[\s\S]{0,600}shell\.openExternal/.test(main));
  check('only http, https and mailto are ever handed to the OS',
    /EXTERNAL_SCHEMES[\s\S]{0,120}'https:'/.test(main) &&
    /EXTERNAL_SCHEMES\.has\(url\.protocol/.test(main));
  check('the renderer never opens a URL itself',
    !/window\.open\(/.test(annots) && !/link\.href\s*=\s*url/.test(annots));

  // A PDF-supplied href must never end up in the anchor: the confirm dialog is
  // the only place a real URL is allowed to be shown, and it shows the resolved
  // one, not the link text.
  const link = { dataset: {}, style: {} };
  Annots.linkService.addLinkAttributes(link, 'https://example.invalid/spec.pdf');
  check('a link anchor stays inert and carries the URL out of band',
    link.href === '#' && link.dataset.externalUrl === 'https://example.invalid/spec.pdf' &&
    typeof link.onclick === 'function' && link.rel === 'noopener noreferrer');
  check('destination anchors are inert too',
    Annots.linkService.getDestinationHash([]) === '#' &&
    Annots.linkService.getAnchorUrl('') === '#');
  for (const method of ['goToDestination', 'executeNamedAction', 'executeSetOCGState',
    'getAttachmentContent', 'addLinkAttributes', 'getDestinationHash', 'getAnchorUrl']) {
    check('the link service implements ' + method, typeof Annots.linkService[method] === 'function');
  }

  // --- wiring ---------------------------------------------------------------
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const viewer = fs.readFileSync(path.join(ROOT, 'src', 'js', 'viewer.js'), 'utf8');

  check('annots.js is loaded, after the viewer it draws into',
    html.indexOf('js/annots.js') > html.indexOf('js/viewer.js'));
  check('the layer sits between the text layer and the markup canvas',
    /container\.append\(pdfCanvas,\s*textLayer,\s*nativeLayer,\s*annotCanvas/.test(viewer));
  check('the viewer actually reads the file\'s annotations',
    /getAnnotations\(/.test(annots) && /RP\.annots\.build\(record\)/.test(viewer));
  check('own-canvas annotations are collected from the page render',
    /annotationCanvasMap:\s*record\.annotCanvasMap/.test(viewer));
  check('the viewport is unflipped for pdf.js, and page rotation is honoured',
    /dontFlip:\s*true/.test(annots) && /rotationOf\(/.test(viewer));

  // The ink layer is a later sibling, so without a z-index it would eat every
  // click before a link annotation could see it.
  const layerRule = (css.match(/\.page\s+\.native-annots\s*\{([^}]*)\}/) || [])[1] || '';
  const zIndex = Number((layerRule.match(/z-index:\s*(\d+)/) || [])[1]);
  check('the native layer outranks the ink layer for pointer input', zIndex > 0, 'z-index ' + zIndex);
  check('the layer itself is transparent to the pointer', /pointer-events:\s*none/.test(layerRule));
  check('a drawing tool takes the layer back out of the pointer path',
    /body:not\(\[data-tool="select"\]\)\s+\.page\s+\.native-annots\s+section/.test(css));
  check('the select tool yields to annotation elements',
    /closest\('\.'\s*\+\s*RP\.annots\.LAYER_CLASS\)/
      .test(fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8')));

  // Annotation icons are <img> loads over app://; missing from the installer
  // means every sticky note in a reviewed drawing renders as a broken image.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('annotation icons are shipped in the installer',
    pkg.build.files.some((glob) => /pdfjs-dist\/web\/images/.test(glob)));
  check('the tight CSP is untouched',
    /default-src 'self'/.test(html) && !/https?:\/\//.test((html.match(/Content-Security-Policy[\s\S]*?\/>/) || [''])[0]));
}

/**
 * Appearance — theme, accent, density and paper mode.
 *
 * Four independent axes, and the ways they break are all "one of the four
 * pieces was not updated with the other three": a catalog entry with no CSS
 * rule behind it, a literal accent colour that stops tracking the picker, a
 * density that leaves one piece of chrome at its old fixed size, a settings
 * value nothing normalises. None of that shows up as an exception — it shows
 * up as a control that appears to work and does not, which is why it is
 * checked statically here rather than trusted to be noticed.
 */
function testAppearance() {
  console.log('\nAppearance');

  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const A = RP.appearance;

  // --- themes ---------------------------------------------------------------
  // `dark` is the :root block and deliberately has no class of its own.
  const themeless = A.THEMES.map((t) => t.id)
    .filter((id) => id !== 'dark' && !new RegExp('body\\.theme-' + id + '\\s*\\{').test(css));
  check('every theme in the catalog has a block', themeless.length === 0, themeless.join(', '));

  /* A theme that leaves one of the greys unset inherits it from :root, which
     is the dark set — so a light theme with a forgotten --bg-3 gets a near
     black hover state on white chrome. Each theme has to restate all of
     them. */
  const CORE = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--canvas-bg',
    '--line', '--line-soft', '--txt-0', '--txt-1', '--txt-2'];
  for (const theme of A.THEMES) {
    if (theme.id === 'dark') continue;
    const block = (css.match(new RegExp('body\\.theme-' + theme.id + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
    const gaps = CORE.filter((name) => !new RegExp(name + '\\s*:').test(block));
    check('theme "' + theme.id + '" sets every core colour', gaps.length === 0, gaps.join(', '));
  }

  // --- accent ---------------------------------------------------------------
  /* The accent is one channel triple and every tint derives from it. A literal
     `rgba(255, 91, 74, …)` left anywhere in the sheet is a spot re-pinned to
     the default red, which reads as a picker that half works. Comments are
     stripped first — the note explaining this rule quotes the literal. */
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pinned = (rules.match(/rgba?\(\s*255,\s*91,\s*74|#ff5b4a|#ff8375|#ff8f80|#ff8a5b/gi) || []);
  check('no literal accent colour is left in the stylesheet',
    pinned.length === 0, pinned.join(', '));
  check('the accent is declared once, as a channel triple',
    (rules.match(/--accent-rgb:\s*255,\s*91,\s*74/g) || []).length === 1);
  check('the accent picker sets one property, not many',
    /setProperty\('--accent-rgb'/.test(fs.readFileSync(path.join(ROOT, 'src', 'js', 'appearance.js'), 'utf8')));
  check('every accent in the catalog is a channel triple',
    A.ACCENTS.every((a) => /^\d{1,3}, \d{1,3}, \d{1,3}$/.test(a.rgb)));

  // --- density --------------------------------------------------------------
  /* The metrics are a *set*: a density block that overrides five of the six
     leaves the sixth at the normal size, so the toolbar grows and the status
     bar does not. */
  const METRICS = ['--ui-font', '--tb-h', '--row1-h', '--row2-h', '--status-h',
    '--side-w', '--tbtn-h', '--tool-w', '--tool-h', '--tool-icon'];
  for (const density of A.DENSITIES) {
    if (density.id === 'normal') continue;
    const block = (css.match(new RegExp('body\\[data-density="' + density.id + '"\\]\\s*\\{([^}]*)\\}')) || [])[1] || '';
    const gaps = METRICS.filter((name) => !new RegExp(name + '\\s*:').test(block));
    check('density "' + density.id + '" sets every metric', gaps.length === 0, gaps.join(', '));
  }
  /* Nothing outside those blocks may restate a metric as a literal — that
     piece of chrome then stops scaling with the rest, and it is always the
     one nobody looks at in the density they do not use. */
  const bodyFont = (rules.match(/html,\s*body\s*\{([^}]*)\}/) || [])[1] || '';
  check('the base font size comes from the density', /font-size:\s*var\(--ui-font\)/.test(bodyFont));

  // --- normalisers ----------------------------------------------------------
  /* Settings can be hand-edited, or written by a later build, or left over
     from one where the option did not exist. None of that may leave the app
     with chrome it has no rule for. */
  check('an unknown theme falls back to the default',
    A.themeOf('chartreuse') === 'dark' && A.themeOf(undefined) === 'dark' &&
    A.themeOf('blueprint') === 'blueprint');
  check('an unknown accent falls back to the default',
    A.accentOf('puce') === 'redline' && A.accentRgb('puce') === '255, 91, 74');
  check('an unknown density falls back to the default',
    A.densityOf('enormous') === 'normal' && A.densityOf('compact') === 'compact');

  // --- wiring ---------------------------------------------------------------
  check('appearance.js is loaded before app.js',
    html.indexOf('js/appearance.js') > 0 &&
    html.indexOf('js/appearance.js') < html.indexOf('js/app.js'));
  /* The 0.12 bug: assigning body.className wholesale took `presenting` (and
     data-tool) off with it, so changing theme from inside a presentation
     dropped every toolbar back over the drawing. */
  check('nothing assigns body.className wholesale',
    !/body\.className\s*=/.test(app) &&
    !/body\.className\s*=/.test(fs.readFileSync(path.join(ROOT, 'src', 'js', 'appearance.js'), 'utf8')));
  check('the theme swap toggles only the theme classes',
    /classList\.toggle\('theme-' \+ item\.id/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'js', 'appearance.js'), 'utf8')));

  // --- reduced motion -------------------------------------------------------
  /* Every transition in the sheet is decoration on a state that has already
     changed, so all of them can go — but only if the query is actually
     there. */
  check('transitions are dropped under prefers-reduced-motion',
    /@media \(prefers-reduced-motion: reduce\)/.test(css) &&
    /transition-duration:[^;]*!important/.test(css));
}

/**
 * The chrome added for view/copy/navigation: paper display modes, the
 * clipboard path,
 * the recents surface, the context menu and the status bar. All of it is
 * wiring rather than maths, so these are static checks — they catch the ways
 * this breaks in practice, which are a missing <script> tag, a filter that
 * creeps onto the wrong canvas, and an IPC channel wired on only two of its
 * three sides.
 */
function testChrome() {
  console.log('\nViewer chrome');

  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(ROOT, 'src', 'js', 'viewer.js'), 'utf8');

  // --- every module the page asks for is actually there ---------------------
  const scripts = Array.from(html.matchAll(/<script src="(js\/[^"]+)"/g)).map((m) => m[1]);
  const missing = scripts.filter((rel) => !fs.existsSync(path.join(ROOT, 'src', rel)));
  check('every script tag points at a file that exists', missing.length === 0,
    missing.length ? missing.join(', ') : scripts.length + ' modules');
  for (const [module, before] of [['js/clip.js', 'js/tools.js'], ['js/menu.js', 'js/pages.js'],
    ['js/props.js', 'js/tools.js'], ['js/keys.js', 'js/app.js'],
    ['js/render.js', 'js/edit.js'], ['js/edit.js', 'js/app.js']]) {
    check(module + ' is loaded before ' + before,
      html.indexOf(module) > 0 && html.indexOf(module) < html.indexOf(before));
  }

  // --- paper display modes --------------------------------------------------
  // The whole point is that the *drawing* is filtered and the markups are not.
  // A filter that reaches .annot-canvas turns every redline cyan, and the user
  // is then choosing colours that are not the colours that will print.
  const paperRules = (css.match(/body\[data-paper[^{]*\{[^}]*\}/g) || []).join('\n');
  check('every paper mode filters the PDF canvas', /\.pdf-canvas/.test(paperRules) &&
    /invert\(1\)/.test(paperRules) && /grayscale\(/.test(paperRules) &&
    /sepia\(/.test(paperRules) && /contrast\(/.test(paperRules));
  check('no paper mode touches the markup canvas', !/annot-canvas/.test(paperRules));
  // Thumbnails follow the page, or the panel and the viewer disagree about
  // what the drawing looks like and the thumbnails read as the "real" one.
  const thumbFiltered = (css.match(/body\[data-paper="([a-z]+)"\] \.thumb canvas/g) || []).length;
  check('thumbnails follow the page in every filtered mode', thumbFiltered === 4,
    thumbFiltered + ' of 4');
  // Every mode the catalog can produce needs a rule, or picking it from the
  // menu is a no-op that still lights the toolbar button.
  const RPa = RP.appearance;
  const unruled = RPa.PAPER_MODES.map((m) => m.id).filter((id) =>
    id !== 'normal' && !new RegExp('body\\[data-paper="' + id + '"\\]').test(css));
  check('every paper mode in the catalog has a rule', unruled.length === 0, unruled.join(', '));
  check('the paper mode is persisted, not just applied',
    /paperMode/.test(main) && /paperMode: id/.test(app));
  check('appearance is applied at boot',
    /this\.applyAppearance\(this\.settings\)/.test(app));
  // A settings file from 0.12 has `nightMode` and no `paperMode`; dropping it
  // turns night mode off for everyone who had it on, which gets reported as
  // the app forgetting rather than as a missed migration.
  check('the pre-0.13 nightMode flag still migrates',
    /stored\.paperMode === undefined && stored\.nightMode/.test(main));
  check('paperModeOf folds the legacy flag in',
    RPa.paperModeOf({ nightMode: true }) === 'invert' &&
    RPa.paperModeOf({ nightMode: true, paperMode: 'grey' }) === 'grey' &&
    RPa.paperModeOf({ paperMode: 'normal', nightMode: true }) === 'normal' &&
    RPa.paperModeOf({}) === 'normal');

  // --- clipboard ------------------------------------------------------------
  const clip = fs.readFileSync(path.join(ROOT, 'src', 'js', 'clip.js'), 'utf8');
  check('the clipboard IPC exists on all three required sides',
    /ipcMain\.handle\(\s*'clipboard:write-text'/.test(main) &&
    /call\(\s*'clipboard:write-text'/.test(preload) &&
    /window\.rp\.clipboard\.writeText/.test(clip));
  // Ctrl+C serves two clipboards. Markups have to be tried first: a marquee
  // drag under the select tool can leave a stray text selection behind it, and
  // copying that instead of the markups the user is holding is the wrong guess.
  check('Ctrl+C is bound', /key === 'c'[\s\S]{0,320}RP\.clip\.copySelection\(\)/.test(app));
  check('Ctrl+C prefers markups over text',
    /key === 'c'[\s\S]{0,200}RP\.edit\.copy\(\)/.test(app) &&
    app.indexOf('RP.edit.copy()') < app.indexOf('RP.clip.copySelection()'));
  check('Ctrl+X and Ctrl+V are bound',
    /key === 'x'[\s\S]{0,160}RP\.edit\.cut\(\)/.test(app) &&
    /key === 'v'[\s\S]{0,600}RP\.edit\.paste\(/.test(app));
  // A paste aims at the pointer, which is the whole reason the case exists —
  // stamping the same markup in several places without a drag after each one.
  check('Ctrl+V pastes at the pointer', /RP\.tools\.pasteTarget\(\)/.test(app));

  // --- arrow keys -----------------------------------------------------------
  // Left and Right turn the sheet; Up and Down read down it and turn over only
  // at the edge of the paper, or a Down on an E-size sheet would skip most of
  // what is on it.
  check('the arrow keys are bound',
    /'ArrowRight'[\s\S]{0,120}stepRow\(1/.test(app) &&
    /'ArrowLeft'[\s\S]{0,120}stepRow\(-1/.test(app) &&
    /'ArrowDown'[\s\S]{0,400}nudgeScroll/.test(app));
  check('Up and Down turn the sheet only when the scroll runs out',
    /if \(!RP\.viewer\.nudgeScroll\(0, dir \* ARROW_SCROLL_PX\)\) RP\.viewer\.stepRow\(dir/.test(app));
  /* Navigation is refused while anything is over the drawing. A dialog is modal
     to the user whether or not it is modal to the document, and paging the
     sheet set behind an open panel is movement they cannot see. Queried by
     class rather than by module so a new dialog is covered automatically. */
  check('navigation keys are blocked behind a dialog',
    /navigationBlocked\(\)/.test(app) &&
    /modal-backdrop:not\(\[hidden\]\)/.test(app) &&
    /RP\.menu\.isOpen\(\)/.test(app));
  check('the navigation guard wraps the page keys too',
    app.indexOf('if (!this.navigationBlocked())') < app.indexOf("event.key === 'PageDown'"));
  check('the text layer is reachable under the select tool',
    /body\[data-tool="select"\]\s+\.page\s+\.ink-layer\s*\{[^}]*pointer-events:\s*none/.test(css));
  // Without this the browser paints a text selection behind every marquee.
  check('the browser selection is refused on presses that are not on glyphs',
    /mousedown[\s\S]{0,400}RP\.clip\.isGlyph\(event\.target\)[\s\S]{0,80}preventDefault/.test(tools));
  check('a glyph press yields to the browser instead of marqueeing',
    /RP\.clip\.isGlyph\(event\.target\)\)\s*\{[\s\S]{0,120}return;/.test(tools));

  // --- layer rotation -------------------------------------------------------
  // pdf.js sizes the text and annotation layers from `viewport.rawDims` — the
  // unrotated viewBox — positions every child as a percentage of that box, and
  // hands the rotation to CSS through `data-main-rotation`. Its own
  // pdf_viewer.css carries the three transforms at the top level; this app
  // mirrors those rules by hand instead of importing the sheet, so dropping
  // them is a one-line regression with no visible error. What it produces is an
  // upright text layer over a landscape sheet: the I-beam appears over blank
  // paper, `overflow: clip` swallows the overhang, and a drag selects spans
  // that are nowhere near the glyphs — which reads as a broken drawing.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rotates = (selector, angle) =>
    Array.from(rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)).some(([, sel, body]) =>
      sel.split(',').some((part) =>
        part.trim() === '.page .' + selector + '[data-main-rotation="' + angle + '"]') &&
      new RegExp('transform:\\s*rotate\\(' + angle + 'deg\\)').test(body));
  for (const layer of ['text-layer', 'native-annots']) {
    for (const angle of [90, 180, 270]) {
      check('.' + layer + ' turns with the page at ' + angle + '°', rotates(layer, angle));
    }
    const rule = (rules.match(new RegExp('\\.page\\s+\\.' + layer + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
    // rotate() about the centre would swing the layer off the sheet entirely;
    // the translate() in each transform assumes a top-left origin.
    check('.' + layer + ' rotates about its top-left corner',
      /transform-origin:\s*0\s+0/.test(rule));
  }

  // --- recents --------------------------------------------------------------
  check('the recents pin/remove IPC exists on both sides',
    /ipcMain\.handle\(\s*'recents:pin'/.test(main) &&
    /ipcMain\.handle\(\s*'recents:remove'/.test(main) &&
    /call\(\s*'recents:pin'/.test(preload) && /call\(\s*'recents:remove'/.test(preload));
  check('pinned entries are exempt from the ageing cap',
    /function trimRecents[\s\S]{0,300}entry\.pinned/.test(main));
  check('the tray offers recents', /Open Recent[\s\S]{0,80}trayRecentsSubmenu/.test(main));
  check('the tray menu is rebuilt when recents change',
    (main.match(/refreshTrayMenu\(\)/g) || []).length >= 4);

  // --- navigation and status ------------------------------------------------
  check('the go-to-page box exists and is wired',
    /id="pageInput"/.test(html) && /pageInput[\s\S]{0,600}goToPage/.test(app));
  check('Ctrl+G focuses it', /key === 'g'[\s\S]{0,80}focusPageInput/.test(app));
  check('Home and End reach the first and last page',
    /event\.key === 'Home'[\s\S]{0,80}goToPage\(0\)/.test(app) &&
    /event\.key === 'End'/.test(app));
  check('the page box is not rewritten while it is being typed into',
    /document\.activeElement !== pageInput/.test(app));
  check('the status bar reports the selection and the sheet size',
    /id="stSel"/.test(html) && /id="stDims"/.test(html) &&
    /updateSelectionStatus/.test(app) && /updateDims/.test(app));
  check('Ctrl+Shift+T reopens a closed tab',
    /key === 't' && event\.shiftKey[\s\S]{0,60}reopenClosed/
      .test(fs.readFileSync(path.join(ROOT, 'src', 'js', 'tabs.js'), 'utf8')));

  // --- zoom -----------------------------------------------------------------
  check('the zoom preset menu exists', /id="zoomPresets"/.test(html) && /openZoomMenu/.test(app));
  // setZoom bails out early when the value already matches, which would leave
  // fitMode set and let the next resize snap the drawing back to fit-width.
  check('a preset clears the fit mode explicitly',
    /openZoomMenu[\s\S]{0,1600}viewer\.fitMode = null;\s*viewer\.setZoom/.test(app));
  check('a trackpad pinch is scaled by its delta, not by a fixed step',
    /deltaMode/.test(viewer) && /Math\.exp\(/.test(viewer));

  // --- one menu, not several ------------------------------------------------
  const pages = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pages.js'), 'utf8');
  check('the page manager uses the shared menu', /RP\.menu\.open\(/.test(pages) &&
    !/document\.body\.appendChild\(menu\)/.test(pages));
  check('the viewer has a context menu', /contextmenu[\s\S]{0,80}onContextMenu/.test(tools));
  check('it leaves the file\'s own annotations alone',
    /onContextMenu\(event\)\s*\{\s*if \(event\.target\.closest && event\.target\.closest\('\.' \+ RP\.annots\.LAYER_CLASS\)\) return;/
      .test(tools));
}

/* The packaging contract for the updater.

   `build.files` is an allowlist, so a dependency that is not named there is
   simply absent from the installer and `require('electron-updater')` fails at
   runtime — inside a try/catch, on an installed build, where nobody would see
   it. Walking the real dependency closure here turns that into a failing check
   the moment a version bump adds a package. */
function testPackaging() {
  console.log('\nPackaging');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];

  check('updater.js is packaged', files.includes('updater.js'));
  check('electron-updater is a runtime dependency, not a dev one',
    !!(pkg.dependencies && pkg.dependencies['electron-updater']));
  check('a publish target is configured',
    Array.isArray(pkg.build.publish) && pkg.build.publish.some((p) => p.provider === 'github'));

  const modules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(path.join(modules, 'electron-updater'))) {
    check('electron-updater dependency closure is packaged', true, 'skipped — not installed');
    return;
  }

  const seen = new Set();
  const missing = [];
  (function walk(name) {
    if (seen.has(name)) return;
    seen.add(name);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8'));
    } catch (err) {
      return; // hoisted elsewhere or bundled; the require would still resolve
    }
    if (!files.includes('node_modules/' + name + '/**/*')) missing.push(name);
    for (const dep of Object.keys(meta.dependencies || {})) walk(dep);
  })('electron-updater');

  check('electron-updater dependency closure is packaged', missing.length === 0,
    missing.length ? 'not in build.files: ' + missing.join(', ') : seen.size + ' packages');
}

async function makeThreePagePdf() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText('SHEET-' + (i + 1), { x: 60, y: 700, size: 18, font });
  }
  return doc.save();
}

const near = (value, want, slack) => Math.abs(value - want) <= (slack === undefined ? 0.5 : slack);

/** A sheet with a single glyph at a known spot, for checking fit geometry. */
async function markedSheet(width, height, x, y, mediaOrigin) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const page = doc.addPage([width, height]);
  if (mediaOrigin) page.setMediaBox(mediaOrigin[0], mediaOrigin[1], width, height);
  page.drawText('X', { x, y, size: 40, font });
  return doc.save();
}

/** Where the first glyph sits, in points from the sheet's bottom-left. */
async function firstTextPos(bytes) {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const items = (await (await doc.getPage(1)).getTextContent()).items;
  if (!items.length) return null;
  const t = items[0].transform;
  return { x: +t[4].toFixed(2), y: +t[5].toFixed(2), size: +Math.hypot(t[0], t[1]).toFixed(2) };
}

/**
 * Highlight geometry.
 *
 * Everything here is in page-local CSS pixels with y running down, and the
 * fixtures are modelled on a plotted description block: an 8pt stick font on
 * 13pt line spacing, one span per word, with a second column of unrelated text
 * far to the right at the same heights. That second column is the whole point —
 * pdf.js hands the browser's selection over in content-stream order, so those
 * runs arrive mixed in with the ones actually swept, and before `sweep` existed
 * they were highlighted too.
 */
function testHighlightGeometry() {
  console.log('\nHighlight geometry');
  const HL = RP.tools.hl;

  // A word box: 8pt caps in a 13pt line box, ~5.5pt per character.
  const word = (text, left, line) => ({
    left, right: left + text.length * 5.5, top: line * 13, bottom: line * 13 + 11
  });

  // --- rows -----------------------------------------------------------------
  // Same row, different heights: a taller glyph shifts `top` without starting a
  // new line, which is exactly what sorting on `top` used to get wrong.
  const ragged = [
    word('LIGHT', 40, 0),
    Object.assign(word('STACK', 0, 0), { top: -1, bottom: 11 }),
    word('RED', 0, 1)
  ];
  const rows = HL.rows(ragged);
  check('words on one row stay on one row when their tops disagree',
    rows.length === 2 && rows[0].words.length === 2, rows.length + ' rows');
  check('rows come back top of the page first', rows[0].top < rows[1].top);
  check('words within a row come back left to right',
    rows[0].words[0].left === 0 && rows[0].words[1].left === 40);

  // --- bars: bridging -------------------------------------------------------
  const phrase = [word('STACK', 0, 0), word('LIGHT', 33, 0)];   // 5.5pt gap
  const bars = HL.bars(phrase);
  check('a word gap on one row is painted through', bars.length === 1,
    bars.length + ' bars');
  check('the bridged bar spans the whole phrase',
    bars[0].left === 0 && Math.abs(bars[0].right - 60.5) < 0.01,
    JSON.stringify(bars[0]));

  // A schedule row: two columns, blank paper between them.
  const columns = HL.bars([word('SPARE', 0, 0), word('RELAY', 200, 0)]);
  check('a column gap is left alone', columns.length === 2, columns.length + ' bars');

  // Measured on a real sheet, the two gap populations are cleanly separated:
  // letter gaps at ~0.3 of the row height, word gaps at ~0.93, column gaps
  // several times that. The threshold has to sit in the space between.
  const rowHeight = 11;
  const gapOf = (ratio) => HL.bars([
    word('A', 0, 0),
    { left: 5.5 + rowHeight * ratio, right: 5.5 + rowHeight * ratio + 20, top: 0, bottom: 11 }
  ]).length;
  check('a letter gap bridges', gapOf(0.3) === 1);
  check('the widest real word gap bridges', gapOf(0.93) === 1);
  check('a column gap does not', gapOf(2) === 2);

  // --- bars: the union ------------------------------------------------------
  // Carrying `max(height)` against `min(top)` produced a bar shorter than the
  // words under it. The union has to be taken on the edges.
  const uneven = HL.bars([
    { left: 0, right: 20, top: 2, bottom: 12 },
    { left: 22, right: 40, top: 0, bottom: 10 }
  ]);
  check('a bar covers every word it merged, top and bottom',
    uneven.length === 1 && uneven[0].top === 0 && uneven[0].bottom === 12,
    JSON.stringify(uneven[0]));

  // --- sweep ----------------------------------------------------------------
  // Three lines of a description block, plus a column of unrelated runs at
  // x=400 that the content stream happens to interleave.
  const block = [
    word('STACK', 0, 0), word('LIGHT', 33, 0),
    word('RED', 0, 1), word('LIGHT', 22, 1),
    word('FAULTED', 0, 2),
    word('ELSEWHERE', 400, 0), word('ALSO', 400, 1), word('AGAIN', 400, 2)
  ];
  const blockRows = HL.rows(block);
  const swept = HL.sweep(blockRows, { row: 0, x: 1 }, { row: 2, x: 60 });
  const sweptWords = swept.flat();
  check('the sweep keeps every row it crossed', swept.length === 3, swept.length + ' rows');
  check('runs from elsewhere in the content stream are dropped',
    sweptWords.every((w) => w.left < 200), JSON.stringify(sweptWords.map((w) => w.left)));
  check('the swept rows still contain the words that were under the pointer',
    sweptWords.length === 5, sweptWords.length + ' words');

  // A drag that stops part way along the last row must not take the rest of it.
  const partial = HL.sweep(blockRows, { row: 0, x: 1 }, { row: 1, x: 10 });
  check('the last row stops where the pointer was released',
    partial.length === 2 && partial[1].length === 1 && partial[1][0].left === 0,
    JSON.stringify(partial[1] && partial[1].map((w) => w.left)));

  // Dragging up the page is the same selection as dragging down it.
  const upwards = HL.sweep(blockRows, { row: 2, x: 60 }, { row: 0, x: 1 });
  check('a drag up the page sweeps the same words as a drag down it',
    JSON.stringify(upwards) === JSON.stringify(swept));

  // A double-click lands both ends on one word; the row must not run away.
  const oneWord = HL.sweep(blockRows, { row: 1, x: 30 }, { row: 1, x: 30 });
  check('a double-click takes the word under it and nothing else',
    oneWord.length === 1 && oneWord[0].length === 1 && oneWord[0][0].left === 22,
    JSON.stringify(oneWord[0] && oneWord[0].map((w) => w.left)));

  // No drag recorded — a keyboard selection — must not be filtered away.
  check('a selection with no drag behind it is taken as it stands',
    HL.sweep(blockRows, null, null).flat().length === block.length);

  // --- wiring ---------------------------------------------------------------
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8');
  check('the press point is recorded before the text layer takes the drag',
    /hlPress = \{ page: record\.index/.test(tools));
  check('the capture works off pdf.js\'s own span list, not the range rects',
    /record\.textDivs/.test(tools) && /containsNode\(div, true\)/.test(tools));
  check('a partial word is rounded out to whitespace at both ends',
    /while \(from > 0 && !\/\\s\/\.test\(text\[from - 1\]\)\)/.test(tools) &&
    /while \(to < text\.length && !\/\\s\/\.test\(text\[to\]\)\)/.test(tools));
}

/**
 * Selecting text, and what can be done with it once selected.
 *
 * Three separate things are covered here and they fail in different ways.
 *
 * The *band* rule decides which words an area drag picks up, and it is the one
 * piece of that feature with no visible symptom until a sheet is in front of
 * someone: too greedy and a box drawn short of a schedule's second column
 * takes the column anyway, too strict and a word with a descender falls out of
 * its own row.
 *
 * *Reading order* is why the text is rebuilt from the swept rows rather than
 * taken from `selection.toString()`. The browser concatenates in DOM order and
 * pdf.js emits spans in content-stream order — plotter order — so the naive
 * version pastes a description block with its lines shuffled. The rows are
 * already bucketed and sorted by `HL`, so this checks that `textOf` actually
 * walks them rather than trusting whatever order it was handed.
 *
 * And the *payload* is the contract between the two gestures and the action
 * menu. It is snapshotted at release because opening a menu collapses the
 * browser's selection before a single handler in it runs; anything here that
 * reached back for the live selection would work in testing and fail on the
 * first real click.
 */
function testTextSelection() {
  console.log('\nText selection');
  const band = RP.tools.band;
  const HL = RP.tools.hl;

  // --- the band -------------------------------------------------------------
  const dragged = band.normBand({ x: 220, y: 180 }, { x: 40, y: 60 });
  check('a band is normalised whichever way it was dragged',
    dragged.left === 40 && dragged.top === 60 && dragged.right === 220 && dragged.bottom === 180);

  const inside = { left: 60, top: 80, right: 100, bottom: 92 };
  const outside = { left: 300, top: 80, right: 340, bottom: 92 };
  // Clipped at the left edge: most of the word is outside, so its centre is
  // too, and it stays out. Overlap would have taken it.
  const clipped = { left: 20, top: 80, right: 52, bottom: 92 };
  // A descender pokes out of the bottom edge. Containment would have dropped
  // it; the centre is still in, so it stays.
  const descender = { left: 120, top: 165, right: 160, bottom: 190 };
  check('a word inside the band is taken', band.centreInBand(inside, dragged));
  check('a word outside the band is not', !band.centreInBand(outside, dragged));
  check('a word the band merely clips is not taken', !band.centreInBand(clipped, dragged));
  check('a word that pokes out of the edge is still taken', band.centreInBand(descender, dragged));

  // --- reading order --------------------------------------------------------
  // Fed in plotter order — the second line before the first, and the right-hand
  // column before the left — which is exactly the shape pdf.js hands over.
  const scrambled = [
    { left: 200, top: 40, right: 260, bottom: 52, text: 'AMPS' },
    { left: 40, top: 60, right: 90, bottom: 72, text: 'FEEDER' },
    { left: 40, top: 40, right: 96, bottom: 52, text: 'PANEL' },
    { left: 98, top: 40, right: 150, bottom: 52, text: 'L1' },
    { left: 92, top: 60, right: 140, bottom: 72, text: 'B' }
  ];
  const rows = HL.rows(scrambled);
  const text = HL.textOf(new Map([[0, rows.map((row) => row.words)]]));
  check('rows come back top to bottom and words left to right',
    text === 'PANEL L1  AMPS\nFEEDER B', JSON.stringify(text));
  // The gap between L1 and AMPS is several row-heights wide, which is a column
  // boundary rather than a word space — running them together would read as one
  // phrase on a schedule.
  check('a column gap does not become a word space', /L1 {2}AMPS/.test(text));
  check('pages are kept apart and in order',
    HL.textOf(new Map([
      [2, [[{ left: 0, top: 0, right: 10, bottom: 8, text: 'later' }]]],
      [1, [[{ left: 0, top: 0, right: 10, bottom: 8, text: 'earlier' }]]]
    ])) === 'earlier\n\nlater');
  check('a rect carrying no text is skipped rather than pasted as a gap',
    HL.textOf(new Map([[0, [[
      { left: 0, top: 0, right: 10, bottom: 8, text: 'wrapped' },
      { left: 0, top: 10, right: 10, bottom: 18, text: '' }
    ]]]])) === 'wrapped');

  // --- payloads and the actions built on them -------------------------------
  const payload = {
    pages: new Map([
      [0, [{ x: 60, y: 690, w: 200, h: 12 }, { x: 60, y: 674, w: 120, h: 12 }]],
      [1, [{ x: 80, y: 400, w: 90, h: 12 }]]
    ]),
    text: 'PANEL L1\nFEEDER B'
  };
  check('an empty payload is recognised as empty',
    RP.textsel.isEmpty(null) && RP.textsel.isEmpty({ pages: new Map() }) &&
    RP.textsel.isEmpty({ pages: new Map([[0, []]]) }));
  check('a real payload is not', !RP.textsel.isEmpty(payload));
  check('the first page is the lowest, not the first inserted',
    RP.textsel.firstPage({ pages: new Map([[3, [{ x: 0, y: 0, w: 1, h: 1 }]], [1, [{ x: 0, y: 0, w: 1, h: 1 }]]]) }) === 1);
  check('word count comes off the text', RP.textsel.wordCount(payload) === 4);

  // The box a cloud, a box or a cover is drawn at: the union of that page's
  // rects with a little air. Anchored on the page asked for, not on the first.
  const box = RP.textsel.boxOn(payload, 0);
  check('the shape box unions one page\'s rects and pads them',
    box.x < 60 && box.y < 674 && box.x + box.w > 260 && box.y + box.h > 702,
    JSON.stringify(box));
  check('a page the selection does not touch has no box',
    RP.textsel.boxOn(payload, 5) === null);

  // Each page gets one markup, not one per run — three bars over two pages is
  // two things the user did, and splitting them would need six deletes to undo.
  const store = RP.store;
  const before = store.annotations.length;
  const made = RP.textsel.markup(payload, 'strikeout');
  check('one markup per page, not one per run', made === 2,
    made + ' from ' + payload.pages.size + ' pages');
  const added = store.annotations.slice(before);
  check('the markup carries the rects it was made from',
    added[0].rects.length === 2 && added[1].rects.length === 1);
  check('the rects are copies, so editing the markup cannot corrupt the payload',
    added[0].rects[0] !== payload.pages.get(0)[0]);
  check('the words are carried along for the markup list and the CSV',
    added[0].text === payload.text);
  store.annotations.length = before;

  const covers = RP.textsel.shape(payload, 'cover');
  check('a shape is drawn per page too', covers === 2);
  const cover = store.annotations[store.annotations.length - 1];
  check('a cover is opaque — that is the whole difference from a filled box',
    cover.opacity === 1 && cover.fill === undefined);
  store.annotations.length = before;

  check('a page reference is prefixed per page, in page order',
    RP.textsel.referenced(payload).split('\n')[0].startsWith('p1  '));

  // --- geometry of the new markups -----------------------------------------
  // The rule scales with the run it crosses. A fixed weight either obliterates
  // 3pt schedule text or reads as a hairline under a 24pt sheet title.
  const small = RP.render.ruleWeight({ h: 4 });
  const large = RP.render.ruleWeight({ h: 24 });
  check('the rule weight follows the text size', large > small * 3, small + ' vs ' + large);
  check('the rule never vanishes on very small text', RP.render.ruleWeight({ h: 0.1 }) >= 0.5);
  for (const type of ['strikeout', 'underline']) {
    const annot = { type, rects: [{ x: 10, y: 20, w: 100, h: 10 }] };
    const bounds = RP.render.bbox(annot);
    check('a ' + type + ' knows its own bounds',
      bounds.x === 10 && bounds.y === 20 && bounds.w === 100 && bounds.h === 10);
    check('a ' + type + ' hit-tests against its rects',
      RP.render.hitTest(annot, 50, 25, 2) && !RP.render.hitTest(annot, 300, 25, 2));
    RP.render.translate(annot, 5, -5);
    check('a ' + type + ' moves with its rects',
      annot.rects[0].x === 15 && annot.rects[0].y === 15);
  }
  check('every new type has a label rather than falling back to its id',
    ['strikeout', 'underline', 'cover']
      .every((type) => RP.store.typeLabel(type) !== type));

  // --- wiring ---------------------------------------------------------------
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tools.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(ROOT, 'src', 'js', 'viewer.js'), 'utf8');
  const clip = fs.readFileSync(path.join(ROOT, 'src', 'js', 'clip.js'), 'utf8');
  const tabs = fs.readFileSync(path.join(ROOT, 'src', 'js', 'tabs.js'), 'utf8');

  check('the tool is on the toolbar and bound to a key',
    /data-tool="textselect"/.test(html) && /x: 'textselect'/.test(app));
  // The whole reason this is a separate tool: the ink layer keeps the press,
  // so the browser's own selection is never started behind the marquee.
  check('the text-select tool keeps the pointer on the ink layer',
    /body\[data-tool="textselect"\]\s+\.page\s+\.ink-layer\s*\{[^}]*pointer-events:\s*auto/.test(css));
  check('and takes the text layer out of the pointer path',
    /body\[data-tool="textselect"\]\s+\.page\s+\.text-layer\s*\{[^}]*pointer-events:\s*none/.test(css));
  // The payload is snapshotted at release; a handler that reached back for the
  // live selection would find it collapsed by the menu that is asking.
  check('the selection is turned into a payload before any menu opens',
    /selectionPayload\(event\)[\s\S]{0,900}RP\.textsel\.open\(/.test(tools));
  check('the standing selection is painted by the viewer',
    /RP\.textsel && RP\.textsel\.draw/.test(viewer));
  check('it is painted only for the focused document',
    /isActive\(\)\)\s*\{[\s\S]{0,500}RP\.textsel\.draw/.test(viewer));
  check('Ctrl+C sees a standing selection', /RP\.textsel\.has\(\)/.test(clip));
  // Per-document state has to ride the tab switch or it leaks between drawings.
  check('the selection is stashed and unstashed with its tab',
    /RP\.textsel\.stash\(\)/.test(tabs) && /RP\.textsel\.unstash\(/.test(tabs));
  check('Escape drops the selection without also resetting the tool',
    /if \(RP\.textsel\.clear\(\)\) return;/.test(app));
  check('a rebuilt page order clears it, since the rects no longer mean anything',
    /pages:rebuilt'[\s\S]{0,60}RP\.textsel\.clear\(\)/.test(tools));
}

/**
 * Where a save goes. The bug this covers: copy mode wrote `<drawing>-markup.pdf`
 * next to the original on the very first Ctrl+S without ever asking, so the app
 * chose a filename and a folder for the user and only mentioned them afterwards
 * in the toast. The fix has two halves and both matter — the *first* save must
 * ask, and every save after it must not.
 */
async function testSaveTargets() {
  console.log('\nSave targets');

  check('the suggested copy sits beside the original',
    RP.copyPath('C:\\drawings\\E-101.pdf') === 'C:\\drawings\\E-101-markup.pdf',
    RP.copyPath('C:\\drawings\\E-101.pdf'));
  check('-markup is appended once, not once per generation',
    RP.copyPath('C:\\drawings\\E-101-markup.pdf') === 'C:\\drawings\\E-101-markup.pdf');
  check('a drawing that was never on disk has no suggestion',
    RP.copyPath(null) === null);

  const App = RP.app;
  const keptStore = RP.store;
  const keptSettings = App.settings;
  const keptRp = global.window.rp;
  const keptTabs = RP.tabs;

  let prompts = 0;
  let suggested = null;
  let picks = 'C:\\approved\\E-101-markup.pdf';
  global.window.rp = {
    files: {
      saveAsDialog: async (opts) => { prompts += 1; suggested = opts.defaultPath; return picks; }
    },
    dialog: { message: async () => ({ response: 0 }) }
  };

  const store = RP.createStore();
  RP.store = store;
  store.setDocument({ doc: null, path: 'C:\\drawings\\E-101.pdf', name: 'E-101.pdf', bytes: null });
  App.settings = { saveMode: 'copy', backupOnOverwrite: true };

  try {
    let target = await App.resolveTarget(store);
    check('the first copy-mode save asks instead of inventing a filename', prompts === 1,
      prompts + ' dialog(s)');
    check('the dialog opens on the -markup name', suggested === 'C:\\drawings\\E-101-markup.pdf',
      String(suggested));
    check('the confirmed path is what gets written', !!target && target.path === picks);
    check('a copy is never taken as an overwrite',
      !!target && target.backup === false && !target.overwrote);

    // What writeTo does on success, and the only thing it changes about the doc.
    store.savedTo = target.path;

    target = await App.resolveTarget(store);
    check('a repeat save does not ask again', prompts === 1, prompts + ' dialog(s)');
    check('a repeat save goes over the same copy rather than stacking files',
      target.path === 'C:\\approved\\E-101-markup.pdf');
    check('saving to a copy leaves the tab pointing at the original',
      store.docPath === 'C:\\drawings\\E-101.pdf');

    // Cancelling is "did not save", not "saved somewhere" — App.save() turns a
    // null target into false and the close guards stop on it.
    const fresh = RP.createStore();
    fresh.setDocument({ doc: null, path: 'C:\\drawings\\E-102.pdf', name: 'E-102.pdf', bytes: null });
    picks = null;
    target = await App.resolveTarget(fresh);
    check('cancelling the first save resolves no target at all', target === null);
    check('cancelling writes nothing and leaves the document unsaved', !fresh.savedTo);

    // Overwrite mode is unchanged: no dialog, and the one-time .bak.
    App.settings = { saveMode: 'overwrite', backupOnOverwrite: true };
    const before = prompts;
    target = await App.resolveTarget(store);
    check('overwrite mode writes over the original without a dialog',
      prompts === before && target.path === 'C:\\drawings\\E-101.pdf' && target.overwrote === true);
    check('the overwrite asks for its backup', target.backup === true);

    /* An overwrite must not leave `savedTo` behind it. `savedTo` means "the
       copy this document has been writing", and copy mode reuses it without
       asking — so an overwrite recording it there would make the next save in
       copy mode write silently over the original drawing, which is the one
       thing copy mode exists to prevent. */
    const overwritten = RP.createStore();
    overwritten.setDocument({ doc: null, path: 'C:\\drawings\\E-104.pdf', name: 'E-104.pdf', bytes: null });
    const owTarget = await App.resolveTarget(overwritten);
    if (!owTarget.overwrote) overwritten.savedTo = owTarget.path; // writeTo's rule
    check('an overwrite claims no copy to reuse', !overwritten.savedTo, String(overwritten.savedTo));

    App.settings = { saveMode: 'copy', backupOnOverwrite: true };
    picks = 'C:\\approved\\E-104-markup.pdf';
    const askedBefore = prompts;
    const copyTarget = await App.resolveTarget(overwritten);
    check('switching to copy mode after an overwrite asks where the copy goes',
      prompts === askedBefore + 1 && copyTarget.path === 'C:\\approved\\E-104-markup.pdf',
      copyTarget.path);

    // The rule above is only true if writeTo actually applies it.
    check('writeTo records savedTo for copies only',
      /if \(!overwrote\)\s*store\.savedTo = path;/
        .test(fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8')));

    App.settings = { saveMode: 'overwrite', backupOnOverwrite: true };

    // "Ask each time" is answered per document and remembered on the store.
    App.settings = { saveMode: 'ask', backupOnOverwrite: true };
    picks = 'C:\\approved\\E-102-markup.pdf';
    const asked = RP.createStore();
    asked.setDocument({ doc: null, path: 'C:\\drawings\\E-103.pdf', name: 'E-103.pdf', bytes: null });
    await App.resolveTarget(asked);
    check('answering "new copy" is remembered for that document',
      asked.saveModeDecided === 'copy', String(asked.saveModeDecided));

    /* Changing the mode has to reach documents nobody is looking at, or a
       background drawing goes on honouring an answer the user has replaced. */
    RP.tabs = { all: () => [{ store: asked }, { store }] };
    store.saveModeDecided = 'overwrite';
    App.clearSaveModeDecisions();
    check('changing the save mode clears the answer on every open document',
      asked.saveModeDecided === null && store.saveModeDecided === null);
  } finally {
    RP.tabs = keptTabs;
    RP.store = keptStore;
    App.settings = keptSettings;
    global.window.rp = keptRp;
  }

  // The chip is the only thing in the window that says how Ctrl+S behaves, so
  // it has to read as a control rather than a caption.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  check('the save-mode chip carries a dropdown affordance',
    /\.st-toggle::after\s*\{[^}]*content:/.test(css));
  check('the save-mode chip says what clicking it does',
    /id="stSaveMode"[\s\S]{0,200}title="[^"]*click/i.test(html));
}

/* ---------------------------------------------------------------------------
   Copying an area as a picture

   The whole value of this feature is that the copy is legible, and legibility
   is entirely a question of the density it renders at. Compositing the
   on-screen canvases — the obvious implementation — ties that density to
   whatever zoom the user happens to be at, so a detail copied at fit-width is
   unreadable and nobody can say why. `plan` is where the density is decided,
   it is pure, and these are the three rules it has to hold to at once: never
   coarser than the target, never coarser than the screen, never bigger than
   Chromium will allocate.
   --------------------------------------------------------------------------- */
function testSnapshotGeometry() {
  console.log('\nCopy area as image');

  const PAGE_H = 792;
  // A scale-1 pdf.js viewport. PDF space is origin bottom-left and viewport
  // space top-left, which is the flip `plan` has to go through `vpRect` for.
  const upright = {
    scale: 1,
    width: 612,
    height: PAGE_H,
    viewBox: [0, 0, 612, PAGE_H],
    convertToViewportPoint: (x, y) => [x, PAGE_H - y],
    convertToPdfPoint: (x, y) => [x, PAGE_H - y]
  };

  {
    const plan = RP.snapshot.plan(upright, { x: 100, y: 300, w: 200, h: 100 });
    check('a crop is placed in viewport pixels, not PDF points',
      plan.x === 100 && plan.y === PAGE_H - 400, `${plan.x},${plan.y}`);
    check('a crop is sized from the rect it was given',
      plan.w === 200 && plan.h === 100, `${plan.w}x${plan.h}`);
    check('a crop renders at the 2x target rather than at screen scale',
      plan.scale === 2 && plan.pixelW === 400 && plan.pixelH === 200,
      `scale ${plan.scale}, ${plan.pixelW}x${plan.pixelH}`);
  }

  {
    // Somebody at 400% has already said what density they want the detail at.
    const plan = RP.snapshot.plan(upright, { x: 100, y: 300, w: 200, h: 100 }, { floor: 4 });
    check('a crop is never coarser than what is already on screen',
      plan.scale === 4 && plan.pixelW === 800, `scale ${plan.scale}`);
  }

  {
    // Zoomed out, the floor must not *lower* the target — that would put the
    // rule the wrong way round and make fit-width crops the blurry ones again.
    const plan = RP.snapshot.plan(upright, { x: 100, y: 300, w: 200, h: 100 }, { floor: 0.25 });
    check('being zoomed out does not drag the crop below the target',
      plan.scale === 2, `scale ${plan.scale}`);
  }

  {
    /* A whole E-size sheet. At the 2x target this is 31 megapixels, and a
       canvas Chromium refuses to allocate comes back *blank* rather than as an
       error — so the cap is the difference between a big crop and a white
       rectangle with no explanation. */
    const eSize = {
      scale: 1, width: 2448, height: 3168, viewBox: [0, 0, 2448, 3168],
      convertToViewportPoint: (x, y) => [x, 3168 - y],
      convertToPdfPoint: (x, y) => [x, 3168 - y]
    };
    const plan = RP.snapshot.plan(eSize, { x: 0, y: 0, w: 2448, h: 3168 });
    check('a whole-sheet crop is capped rather than allocated at 31 megapixels',
      plan.pixelW * plan.pixelH <= 24e6 + 1, (plan.pixelW * plan.pixelH / 1e6).toFixed(1) + ' MP');
    check('the cap lowers the density instead of cropping the region',
      plan.scale < 2 && plan.w === 2448 && plan.h === 3168, `scale ${plan.scale.toFixed(3)}`);
    // Even capped, the sheet must not come back below 1:1 by accident.
    check('a capped crop is still at least readable', plan.scale > 1, `scale ${plan.scale.toFixed(3)}`);
  }

  {
    /* A landscape sheet stored portrait with /Rotate 90 — which is most plotted
       drawings. The crop has to come out the way the sheet *looks*, so it goes
       through the display viewport and its width and height swap. Get this
       wrong and every crop off a plotted sheet is rotated. */
    const turned = {
      scale: 1, width: PAGE_H, height: 612, viewBox: [0, 0, 612, PAGE_H],
      // 90° clockwise about the page: PDF (x,y) -> viewport (y, x).
      convertToViewportPoint: (x, y) => [y, x],
      convertToPdfPoint: (x, y) => [y, x]
    };
    const plan = RP.snapshot.plan(turned, { x: 100, y: 300, w: 200, h: 100 });
    check('a crop off a rotated sheet is taken in display orientation',
      plan.w === 100 && plan.h === 200, `${plan.w}x${plan.h}`);
    check('a rotated crop is placed by its displayed corner',
      plan.x === 300 && plan.y === 100, `${plan.x},${plan.y}`);
  }

  check('a degenerate rect plans no crop at all',
    RP.snapshot.plan(upright, { x: 100, y: 300, w: 0, h: 100 }) === null);
  check('a slipped click is not a region',
    !RP.snapshot.isRegion({ x: 0, y: 0, w: 3, h: 40 }) &&
    !RP.snapshot.isRegion({ x: 0, y: 0, w: 40, h: 2 }) &&
    RP.snapshot.isRegion({ x: 0, y: 0, w: 40, h: 40 }));

  // --- the wiring the crop needs to exist at all ----------------------------
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const snapshot = fs.readFileSync(path.join(ROOT, 'src', 'js', 'snapshot.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

  check('the image clipboard IPC exists on all three required sides',
    /ipcMain\.handle\(\s*'clipboard:write-image'/.test(main) &&
    /call\(\s*'clipboard:write-image'/.test(preload) &&
    /window\.rp\.clipboard\.writeImage/.test(snapshot));
  check('the image goes onto the clipboard as a bitmap, not as text',
    /nativeImage\.createFromBuffer/.test(main) && /clipboard\.writeImage/.test(main));
  check('snapshot.js is loaded, and after the modules it draws through',
    html.indexOf('js/snapshot.js') > html.indexOf('js/render.js') &&
    html.indexOf('js/snapshot.js') > html.indexOf('js/viewer.js') &&
    html.indexOf('js/snapshot.js') < html.indexOf('js/tools.js'));

  /* Re-rendering rather than compositing is the entire point, and it is the
     thing a later "simplification" would undo — the composite version is
     shorter and looks equivalent until you paste one. */
  check('a crop is re-rendered from the page proxy, not scraped off the screen',
    /pageProxy\.render\(/.test(snapshot) &&
    !/pdfCanvas/.test(snapshot) && !/annotCanvas/.test(snapshot));
  /* No annotationCanvasMap: with one, pdf.js diverts stamps and some free text
     into canvases meant for a live annotation layer, and a crop has none — so
     a stamped sheet would copy without its stamp. */
  check('a crop lets the file\'s own stamps render into the page canvas',
    !/annotationCanvasMap/.test(snapshot.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('night mode is not baked into a copied crop',
    !/invert|hue-rotate|night/i.test(snapshot.replace(/\/\*[\s\S]*?\*\//g, '')));
}

/* ---------------------------------------------------------------------------
   Password-protected drawings

   Two halves, and the second one is the one that matters. Prompting is a state
   machine with three exits — got it, gave up, ran out — and each has to be
   told apart from the others or a user who cancels is shown a "corrupt file"
   message. Refusing the save is the half that protects work: pdf-lib cannot
   rewrite an encrypted PDF and does not fail loudly about it, so without the
   guard the app writes a damaged file and reports success.
   --------------------------------------------------------------------------- */
async function testProtectedDrawings() {
  console.log('\nPassword-protected drawings');

  const NEED = 1;
  const INCORRECT = 2;

  /** Drive `onPassword` the way pdf.js does and report how it came out. */
  function run(answers, opts) {
    const asked = [];
    // A stand-in loading task. The handler hangs off *this*, not off the
    // getDocument parameters — see the fixture tests below, which are what
    // caught that being the other way round.
    const params = RP.pdfjs.attachPassword({}, (state) => {
      asked.push(state);
      const answer = answers[asked.length - 1];
      return Promise.resolve(answer);
    }, opts);
    const settled = { value: undefined, error: null };
    const updatePassword = (value) => {
      if (value instanceof Error) settled.error = value;
      else settled.value = value;
    };
    return { params, asked, settled, updatePassword };
  }

  /** Let the ask() promise chain settle. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  {
    const r = run(['letmein']);
    check('the handler is attached to the loading task, not to the parameters',
      typeof r.params.onPassword === 'function');
    r.params.onPassword(r.updatePassword, NEED);
    await tick();
    check('a first prompt is described as a first attempt',
      r.asked[0].reason === 'need' && r.asked[0].attempt === 1, JSON.stringify(r.asked[0]));
    check('the password reaches pdf.js unchanged', r.settled.value === 'letmein');
  }

  {
    const r = run(['wrong', 'letmein']);
    r.params.onPassword(r.updatePassword, NEED);
    await tick();
    r.params.onPassword(r.updatePassword, INCORRECT);
    await tick();
    check('a retry is described as a wrong password, not as a fresh one',
      r.asked[1].reason === 'incorrect' && r.asked[1].attempt === 2, JSON.stringify(r.asked[1]));
    check('the second answer is the one used', r.settled.value === 'letmein');
  }

  {
    // Backing out is a decision, not a failure, and the two get different
    // messages — so they must be distinguishable at the catch.
    const r = run([null]);
    r.params.onPassword(r.updatePassword, NEED);
    await tick();
    check('cancelling rejects the load rather than leaving it hanging',
      r.settled.error instanceof Error, String(r.settled.error));
    /* The outcome is recorded on the task, not on the error. pdf.js does not
       reject with the Error it is handed — it rejects its own capability,
       that crosses the worker boundary, and what reaches the caller is a
       fresh PasswordException with nothing of ours on it. The fixture tests
       below are what established that; a stub happily carried the tag. */
    check('a cancel is recorded on the task', r.params.rpPassword === 'cancelled',
      String(r.params.rpPassword));
  }

  {
    /* An empty box is a cancel, not a password. An empty string is a *valid*
       password as far as pdf.js is concerned, so passing it through would burn
       an attempt on nothing and report the wrong reason next time round. */
    const r = run(['']);
    r.params.onPassword(r.updatePassword, NEED);
    await tick();
    check('an empty box is treated as backing out',
      !!r.settled.error && r.params.rpPassword === 'cancelled');
  }

  {
    /* The cap has to live here rather than in the prompt: a file whose
       encryption dictionary is broken answers "incorrect" to the *right*
       password, and without a cap that is an infinite prompt loop. */
    const r = run(['a', 'b', 'c', 'd'], { attempts: 3 });
    for (let i = 0; i < 4; i += 1) {
      r.params.onPassword(r.updatePassword, i === 0 ? NEED : INCORRECT);
      await tick();
    }
    check('attempts are capped', r.asked.length === 3, r.asked.length + ' prompt(s)');
    check('running out of attempts is recorded apart from a cancel',
      !!r.settled.error && r.params.rpPassword === 'exhausted', String(r.params.rpPassword));
  }

  check('a pdf.js password rejection is recognised',
    RP.pdfjs.isPasswordError({ name: 'PasswordException' }) &&
    !RP.pdfjs.isPasswordError({ name: 'InvalidPDFException' }));
  check('the password reason codes have working defaults',
    RP.pdfjs.passwordReasons().need === 1 && RP.pdfjs.passwordReasons().incorrect === 2);

  // --- the save guard -------------------------------------------------------
  const App = RP.app;
  const keptStore = RP.store;
  const keptRp = global.window.rp;
  let dialogs = 0;
  let saveDialogs = 0;

  global.window.rp = {
    files: { saveAsDialog: async () => { saveDialogs += 1; return 'C:\\x.pdf'; } },
    dialog: { message: async () => { dialogs += 1; return { response: 2 }; } }
  };

  try {
    const plain = RP.createStore();
    plain.setDocument({ doc: null, path: 'C:\\d\\E-101.pdf', name: 'E-101.pdf', bytes: null });
    check('an ordinary drawing is not marked encrypted', plain.encrypted === false);
    check('an ordinary drawing is writable', (await App.confirmWritable(plain)) === true);
    check('a writable drawing puts no dialog up', dialogs === 0);

    const locked = RP.createStore();
    locked.setDocument({
      doc: null, path: 'C:\\d\\E-102.pdf', name: 'E-102.pdf', bytes: null, encrypted: true
    });
    check('a protected drawing is marked encrypted', locked.encrypted === true);

    RP.store = locked;
    const allowed = await App.confirmWritable(locked);
    check('a protected drawing is refused rather than saved', allowed === false);
    check('the refusal explains itself', dialogs === 1, dialogs + ' dialog(s)');
    check('the refusal never reaches the save-location dialog', saveDialogs === 0);

    /* The flag is a fact about the bytes, so it must survive being asked twice
       — a second Ctrl+S has to be refused as firmly as the first. There is no
       "accepted" escape hatch here on purpose: unlike the save-mode question,
       this one has no answer that makes the write work. */
    await App.confirmWritable(locked);
    check('a protected drawing stays refused on the second attempt',
      locked.encrypted === true && dialogs === 2, dialogs + ' dialog(s)');
  } finally {
    RP.store = keptStore;
    global.window.rp = keptRp;
  }

  // --- everything else that writes a PDF from the drawing's bytes -----------
  const app = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const print = fs.readFileSync(path.join(ROOT, 'src', 'js', 'print.js'), 'utf8');
  const pages = fs.readFileSync(path.join(ROOT, 'src', 'js', 'pages.js'), 'utf8');
  const store = fs.readFileSync(path.join(ROOT, 'src', 'js', 'store.js'), 'utf8');

  check('the guard runs before the save resolves a target',
    /confirmWritable\(store\)[\s\S]{0,200}resolveTarget\(store\)/.test(app));
  check('Save As is guarded too', (app.match(/confirmWritable\(store\)/g) || []).length >= 2);
  /* Print builds its bytes through pdf-lib exactly as a save does, so it is
     broken on a protected drawing in the same way — and a damaged preview on
     the way to a plotter is worse than being told no. */
  check('printing a protected drawing is blocked', /RP\.store\.encrypted/.test(print));
  /* So does every page operation: they rebuild the whole file. */
  check('page edits on a protected drawing are blocked',
    /store\.encrypted/.test(pages) && /ensureBase\(\)/.test(pages));
  check('the encrypted flag is set from the document, not guessed later',
    /setDocument\(\{[^}]*encrypted[^}]*\}\)/.test(store) && /this\.encrypted = !!encrypted/.test(store));

  /* Detection has to be `getPermissions`, not "did we prompt". An owner
     password gates editing rather than opening, so those files never prompt —
     and they are exactly the ones that were being corrupted silently. */
  check('encryption is detected even when nothing prompted for it',
    /getPermissions\(\)/.test(app));

  // The password must not reach anything that outlives the session. diag.js
  // streams what it captures to a log file on disk.
  check('the password field is masked', /type: 'password'/.test(app));
  check('nothing logs the password',
    !/console\.(log|warn|error)\([^)]*password/i.test(app));

  await testProtectedFixtures();
}

/* ---------------------------------------------------------------------------
   The same thing against real encrypted files

   Everything above drives `onPassword` the way pdf.js is understood to drive
   it. This drives it the way pdf.js actually does, because the whole feature
   rests on a contract that is only documented by the source: pdf.js does not
   reject an encrypted file, it *calls back and waits*, and hands an Error to
   `updatePassword` to give up. A stub can agree with a misreading of that all
   day.

   The two fixtures were made with qpdf from a one-page pdf-lib document:

     qpdf --allow-weak-crypto --object-streams=disable \
          --encrypt redline ownerpw 128 -- in.pdf encrypted-user-password.pdf
     qpdf --allow-weak-crypto --object-streams=disable \
          --encrypt "" ownerpw 128 --print=none --modify=none -- \
          in.pdf encrypted-owner-password.pdf

   The second is the important one. It has no *user* password, so it opens with
   no prompt and looks like any other drawing — and it is the case that was
   being saved to a damaged file without anybody being told.
   --------------------------------------------------------------------------- */
async function testProtectedFixtures() {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) { check('pdf.js available for the encryption fixtures', false); return; }

  const dir = path.join(ROOT, 'test', 'fixtures');
  const read = (name) => new Uint8Array(fs.readFileSync(path.join(dir, name)));
  if (!fs.existsSync(path.join(dir, 'encrypted-user-password.pdf'))) {
    check('the encryption fixtures are present', false, 'test/fixtures is missing');
    return;
  }

  /** Open exactly the way `App.loadDocument` does. */
  async function open(name, answers) {
    const asked = [];
    const task = RP.pdfjs.attachPassword(
      pdfjs.getDocument({ data: read(name) }),
      (state) => { asked.push(state.reason); return answers[asked.length - 1]; }
    );
    try {
      return { doc: await task.promise, asked, error: null, outcome: task.rpPassword };
    } catch (err) {
      return { doc: null, asked, error: err, outcome: task.rpPassword };
    }
  }

  {
    const r = await open('encrypted-user-password.pdf', ['redline']);
    check('a user-password drawing prompts once and opens',
      !!r.doc && r.asked.length === 1 && r.asked[0] === 'need',
      r.error ? String(r.error) : r.asked.join(','));
    if (r.doc) {
      check('an opened protected drawing is readable',
        r.doc.numPages === 1, String(r.doc && r.doc.numPages));
      check('a decrypted drawing still reports as encrypted',
        (await r.doc.getPermissions()) !== null);
    }
  }

  {
    const r = await open('encrypted-user-password.pdf', ['nope', 'redline']);
    check('a wrong password is re-asked as a wrong password, not as a new file',
      !!r.doc && r.asked.length === 2 && r.asked[1] === 'incorrect', r.asked.join(','));
  }

  {
    const r = await open('encrypted-user-password.pdf', [null]);
    check('backing out of a real password prompt rejects the load',
      !r.doc && !!r.error, r.doc ? 'opened anyway' : 'rejected');
    /* And it is still tellable from a corrupt file afterwards. This is the
       check that would have caught the tag being put on the error: pdf.js
       replaces that error entirely, so `err.rpPassword` is undefined here
       however carefully it was set. */
    check('a real cancel is distinguishable from an unreadable file',
      r.outcome === 'cancelled' && r.error.name === 'PasswordException',
      r.outcome + ' / ' + (r.error && r.error.name));
  }

  {
    const r = await open('encrypted-user-password.pdf', ['a', 'b', 'c', 'd']);
    check('a run of wrong passwords stops rather than looping forever',
      !r.doc && r.asked.length === 3 && r.outcome === 'exhausted',
      r.asked.length + ' prompt(s), ' + r.outcome);
  }

  {
    /* The regression that motivated all of this. This file opens with no
       prompt at all, so "did we ask for a password" is not a usable test for
       whether it can be written — `getPermissions` is. */
    const r = await open('encrypted-owner-password.pdf', []);
    check('an owner-password drawing opens without ever prompting',
      !!r.doc && r.asked.length === 0, r.asked.join(','));
    if (r.doc) {
      const perms = await r.doc.getPermissions();
      check('an owner-password drawing is still detected as encrypted',
        perms !== null, perms === null ? 'getPermissions() was null' : 'permission flags present');
    }
  }

  {
    /* And the reason it must be detected: pdf-lib cannot rewrite these bytes.
       It does not throw — it assembles a document around content streams it
       never decrypted and carries the original /Encrypt dictionary out with
       it, so what lands on disk still demands a password *and* no longer
       matches the one it names. If this check ever starts failing because the
       output opens cleanly, pdf-lib has learned to decrypt and the guard in
       `App.confirmWritable` can be revisited. */
    let output = null;
    try {
      const doc = await PDFLib.PDFDocument.load(read('encrypted-owner-password.pdf'),
        { ignoreEncryption: true, updateMetadata: false });
      output = await doc.save();
    } catch (err) {
      output = null;   // some encrypted files do not even parse
    }
    let readable = false;
    if (output) {
      try {
        await pdfjs.getDocument({ data: new Uint8Array(output) }).promise;
        readable = true;
      } catch (err) { readable = false; }
    }
    check('pdf-lib still cannot write a usable file from an encrypted one',
      !readable, readable ? 'it round-tripped — the save guard may be revisitable' : 'confirmed');
  }
}

/* ---------------------------------------------------------------------------
   Reopening a drawing this app saved

   A save writes the markups twice over — stamped into the page content for
   other viewers, and as the editable model in the catalog for this one. Open
   such a file and rasterise it as it stands and every markup is on the sheet
   twice: once live, once baked in where nothing can select, move or delete it.
   `splitSaved` is what stops that, and it has to hand back both halves.
   --------------------------------------------------------------------------- */
async function testReopen() {
  console.log('\nReopening a saved drawing');

  const source = await makeSourcePdf();
  RP.store.docBytes = source;
  RP.store.docName = 'sheet.pdf';
  RP.store.scale = null;
  RP.store.annotations = sampleAnnotations();

  const streamsPerPage = async (bytes) => {
    const doc = await PDFLib.PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
      const contents = page.node.get(PDFLib.PDFName.of('Contents'));
      return contents && contents.asArray ? contents.asArray().length : 1;
    });
  };

  const saved = await RP.exporter.buildPdf({});
  const plain = await streamsPerPage(source);
  const stamped = await streamsPerPage(saved);
  check('a save really does stamp the pages it is being split back apart from',
    JSON.stringify(stamped) !== JSON.stringify(plain),
    JSON.stringify(plain) + ' -> ' + JSON.stringify(stamped));

  const split = await RP.exporter.splitSaved(saved);
  check('the editable model comes back off a saved file',
    !!split.model && split.model.annotations.length === RP.store.annotations.length,
    split.model ? split.model.annotations.length + ' markups' : 'nothing recovered');
  check('the drawing handed to pdf.js has the stamp taken back out of it',
    JSON.stringify(await streamsPerPage(split.bytes)) === JSON.stringify(plain),
    JSON.stringify(await streamsPerPage(split.bytes)) + ' vs ' + JSON.stringify(plain));
  check('and carries no markup model of its own',
    (await RP.exporter.readEmbeddedMarkup(split.bytes)) === null);

  // Those bytes are what the next save builds from, so they must stamp exactly
  // once — the same as a save straight off the untouched drawing.
  RP.store.docBytes = split.bytes;
  RP.store.annotations = split.model.annotations;
  check('saving what was reopened stamps each page once, not twice',
    JSON.stringify(await streamsPerPage(await RP.exporter.buildPdf({}))) === JSON.stringify(stamped),
    JSON.stringify(await streamsPerPage(await RP.exporter.buildPdf({}))) + ' vs ' + JSON.stringify(stamped));

  // A drawing nobody has marked up yet is the common case and must cost
  // nothing: the same buffer comes straight back.
  const untouched = await RP.exporter.splitSaved(source);
  check('a file this app never saved is handed back untouched',
    untouched.model === null && untouched.bytes === source);
}

/* ---------------------------------------------------------------------------
   Stamping onto a rotated sheet

   `/Rotate` is applied after the content stream, so a shape drawn in user
   space turns with the page and stays where it was put. Text does not: a run
   laid along +x reads left-to-right only on an unturned sheet, and comes out
   on its side on the landscape sheets drawings are plotted as. What the reader
   then sees is the markup twice — the live one upright and the stamped one
   lying on its side beside it.
   --------------------------------------------------------------------------- */
async function testRotatedStamp() {
  console.log('\nStamping onto a rotated sheet');
  const pdfjs = await loadPdfjs();
  if (!pdfjs) { console.log('  (pdfjs-dist not installed — skipped)'); return; }

  const SIZE = 14;
  const ORIGIN = { x: 120, y: 600 };
  const upright = [];
  const placed = [];
  const turnedInUserSpace = [];
  // A measured area rides along: its plate is placed through the same page
  // frame as the text above, and a plate stamped without `rotate` reads
  // sideways on exactly the landscape sheets drawings are plotted as.
  const AREA_PTS = [[200, 200], [400, 200], [400, 320], [200, 320]];
  const AREA_CENTRE = RP.geom.polygonCentroid(AREA_PTS);
  const plateUpright = [];
  const plateCentred = [];

  for (const angle of [0, 90, 180, 270]) {
    const doc = await PDFLib.PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.setRotation(PDFLib.degrees(angle));

    RP.store.docBytes = await doc.save();
    RP.store.docName = 'rotated.pdf';
    RP.store.scale = null;
    RP.store.annotations = [{
      id: 'rot', created: Date.now(), modified: Date.now(), author: 'Tester', note: '', status: 'open',
      page: 0, type: 'text', color: '#ff2f2f', fontSize: SIZE, opacity: 1,
      x: ORIGIN.x, y: ORIGIN.y, text: 'SIDEWAYS'
    }, {
      id: 'rotarea', created: Date.now(), modified: Date.now(), author: 'Tester', note: '', status: 'open',
      page: 0, type: 'area', color: '#2f8fff', width: 1.5, opacity: 1, points: AREA_PTS
    }];

    const saved = await RP.exporter.buildPdf({});
    const parsed = await pdfjs.getDocument({
      data: new Uint8Array(saved), useWorkerFetch: false, isEvalSupported: false
    }).promise;
    const pageProxy = await parsed.getPage(1);
    const viewport = pageProxy.getViewport({ scale: 1, rotation: pageProxy.rotate });
    const content = await pageProxy.getTextContent();
    const item = content.items.find((it) => (it.str || '').includes('SIDEWAYS'));
    if (!item) { check('the stamped text is in the page at ' + angle + '°', false); continue; }

    // Where the run ends up on screen, and which way it runs.
    const device = pdfjs.Util.transform(viewport.transform, item.transform);
    if (Math.abs(device[1]) < 0.01 && device[0] > 0) upright.push(angle);

    /* The canvas hangs the first line from `annot.x, annot.y` with
       `textBaseline: 'top'`, so the baseline sits 0.85 of the size below it —
       down the *screen*, whichever way the sheet is turned. */
    const top = viewport.convertToViewportPoint(ORIGIN.x, ORIGIN.y);
    if (Math.abs(device[4] - top[0]) < 0.5 && Math.abs(device[5] - (top[1] + SIZE * 0.85)) < 0.5) {
      placed.push(angle);
    }

    // The negative control: on a turned sheet the run must genuinely be laid
    // at an angle in user space. Drawn upright there — which is what pdf-lib
    // does if nobody passes `rotate` — it would read sideways on screen.
    if (Math.abs(item.transform[0]) < 0.01) turnedInUserSpace.push(angle);

    // The area's plate. `in²` only appears in the uncalibrated reading, which
    // is what this store is set to, so it identifies the line unambiguously.
    const plate = content.items.find((it) => (it.str || '').includes('in²'));
    if (plate) {
      const plateDevice = pdfjs.Util.transform(viewport.transform, plate.transform);
      if (Math.abs(plateDevice[1]) < 0.01 && plateDevice[0] > 0) plateUpright.push(angle);
      const centre = viewport.convertToViewportPoint(AREA_CENTRE[0], AREA_CENTRE[1]);
      // The reading is centred on the centroid: the glyph run starts half its
      // own width to the left of it, and its baseline sits just above.
      if (Math.abs(plateDevice[4] + plate.width / 2 - centre[0]) < 1.5) plateCentred.push(angle);
    }
  }

  check('stamped text reads horizontally at every /Rotate',
    upright.join(',') === '0,90,180,270', 'upright at ' + upright.join(', ') + '°');
  check('and lands where the canvas draws it',
    placed.join(',') === '0,90,180,270', 'placed at ' + placed.join(', ') + '°');
  check('a quarter-turned sheet really is stamped turned, not upright',
    turnedInUserSpace.join(',') === '90,270', 'turned at ' + turnedInUserSpace.join(', ') + '°');
  check('a measurement plate reads horizontally at every /Rotate',
    plateUpright.join(',') === '0,90,180,270', 'upright at ' + plateUpright.join(', ') + '°');
  check('and stays centred on what it is measuring',
    plateCentred.join(',') === '0,90,180,270', 'centred at ' + plateCentred.join(', ') + '°');
}

/* ---------------------------------------------------------------------------
   Assembling and taking apart a document

   Merge, split, extract and page numbering all sit on the same two pieces —
   the pure order maths in `RP.pages.ops` and the rebuild in `buildBytes` — so
   the interesting failures are in the grouping arithmetic and in what the
   pieces carry with them, not in the pdf-lib calls.
   --------------------------------------------------------------------------- */
async function testPageAssembly() {
  console.log('\nMerging, splitting and numbering');
  const { ops, buildBytes, parseGroups, chunkGroups, breakGroups,
    rebaseNumbering, recoverableOrder } = RP.pages;

  // --- grouping -------------------------------------------------------------
  check('fixed-size chunks cover every page and leave a short last part',
    JSON.stringify(chunkGroups(7, 3)) === '[[0,1,2],[3,4,5],[6]]',
    JSON.stringify(chunkGroups(7, 3)));
  check('a chunk size of one is a file per page',
    chunkGroups(4, 1).length === 4 && chunkGroups(4, 1).every((g) => g.length === 1));
  check('a nonsense chunk size still produces something usable',
    JSON.stringify(chunkGroups(3, 0)) === '[[0],[1],[2]]', JSON.stringify(chunkGroups(3, 0)));

  /* The pages before the first chosen break belong to a file too. Without the
     implicit break at 0 they would belong to none, and a split would quietly
     drop the front of the set — which is the failure nobody notices until the
     cover sheet is missing from the issue. */
  check('a break part-way through still keeps the pages before it',
    JSON.stringify(breakGroups(6, [3])) === '[[0,1,2],[3,4,5]]',
    JSON.stringify(breakGroups(6, [3])));
  check('a break selected on page one is not counted twice',
    JSON.stringify(breakGroups(4, [0, 2])) === '[[0,1],[2,3]]',
    JSON.stringify(breakGroups(4, [0, 2])));

  /* A split's ranges are groups, not one flattened list — that is exactly how
     it differs from the print range it shares a grammar with. Getting this
     wrong produces one file where the user asked for three, and it looks like
     the split silently ignored the box. */
  check('split ranges stay separate rather than flattening like a print range',
    JSON.stringify(parseGroups('1-2, 3-4', 6)) === '[[0,1],[2,3]]',
    JSON.stringify(parseGroups('1-2, 3-4', 6)));
  check('and the print range with the same text is one list',
    JSON.stringify(RP.print.parseCustom('1-2, 3-4', 6)) === '[0,1,2,3]');
  check('an open-ended last group runs to the end of the document',
    JSON.stringify(parseGroups('1-2, 3-', 5)) === '[[0,1],[2,3,4]]',
    JSON.stringify(parseGroups('1-2, 3-', 5)));
  check('a group that names nothing is refused rather than dropped',
    parseGroups('1-2, wat', 5) === null);

  // --- the numbering label --------------------------------------------------
  const spec = { prefix: 'ABC-', start: 5, digits: 4, suffix: '', from: 1, to: 3 };
  check('a page before the numbered window carries no number',
    RP.render.pageNumberText(spec, 0) === null);
  check('the counter starts at `start` on the first numbered page',
    RP.render.pageNumberText(spec, 1) === 'ABC-0005', RP.render.pageNumberText(spec, 1));
  check('and runs on from there', RP.render.pageNumberText(spec, 3) === 'ABC-0007');
  check('a page past the window is unnumbered too',
    RP.render.pageNumberText(spec, 4) === null);
  check('zero digits means no padding',
    RP.render.pageNumberText({ start: 7, digits: 0, from: 0 }, 0) === '7');
  check('no spec at all is no number', RP.render.pageNumberText(null, 0) === null);

  /* One undo step for the whole numbering, and none at all for a dialog that
     was opened and OK'd unaltered — same contract as `setStatus` and the
     commands in `edit.js`. A dead history entry makes the next Ctrl+Z look
     like it did nothing. */
  const numStore = RP.createStore();
  numStore.numbering = null;
  check('setting numbering is one undo step',
    numStore.setNumbering({ start: 1, from: 0 }) === true && numStore.history.length === 1);
  check('re-setting the same numbering leaves no history behind',
    numStore.setNumbering({ start: 1, from: 0 }) === false && numStore.history.length === 1);
  numStore.undo();
  check('and undo takes the whole numbering back at once', numStore.numbering === null);
  check('clearing numbering is one step too',
    numStore.setNumbering({ start: 1, from: 0 }) && numStore.setNumbering(null) === true &&
    numStore.numbering === null);

  /* PDF space has y up, but these offsets are down the *screen* — the canvas
     and the exporter both work from the displayed top-left corner. A top-row
     number sits a cap height below the margin so its ascenders stay on the
     sheet; a bottom-row one sits `margin` up from the bottom edge. */
  const size = { w: 600, h: 800 };
  const bottomRight = RP.render.numberOffsets(size, 'bottom-right', 24, 40, 10);
  check('bottom right measures in from both far edges',
    bottomRight.right === 536 && bottomRight.down === 776, JSON.stringify(bottomRight));
  const topLeft = RP.render.numberOffsets(size, 'top-left', 24, 40, 10);
  check('top left drops the baseline by a cap height so ascenders stay on the sheet',
    topLeft.right === 24 && Math.abs(topLeft.down - 32.5) < 0.001, JSON.stringify(topLeft));
  const centred = RP.render.numberOffsets(size, 'bottom-centre', 24, 40, 10);
  check('a centred number is centred on the sheet, not on the margin box',
    centred.right === 280, JSON.stringify(centred));
  check('an unknown position falls back rather than placing at NaN',
    JSON.stringify(RP.render.numberOffsets(size, 'nowhere', 24, 40, 10)) ===
    JSON.stringify(bottomRight));

  // --- rebasing a subset's numbering ---------------------------------------
  const rebased = rebaseNumbering(spec, [2, 3]);
  check('an extracted run keeps the numbers its pages already had',
    RP.render.pageNumberText(rebased, 0) === 'ABC-0006' &&
    RP.render.pageNumberText(rebased, 1) === 'ABC-0007',
    JSON.stringify(rebased));
  check('a subset with no numbered pages in it carries no numbering',
    rebaseNumbering(spec, [0]) === null);

  // --- what may go in a crash snapshot -------------------------------------
  check('an untouched document has no order worth persisting',
    recoverableOrder({ pageOrder: null }) === null);
  check('an order built from the file alone is persisted',
    recoverableOrder({ pageOrder: ops.fromDocument(3) }) !== null);
  /* Half an order is worse than none: it would rebuild the document with the
     merged-in pages silently missing, and call that a recovery. */
  check('an order reaching into another PDF is refused whole',
    recoverableOrder({ pageOrder: ops.fromDocument(2).concat([ops.descriptor('src-1', 0, 0)]) }) === null);
  check('a blank page does not make an order unrecoverable',
    recoverableOrder({ pageOrder: ops.fromDocument(1).concat([ops.blank(612, 792)]) }) !== null);

  // --- merging pages in from a second PDF ----------------------------------
  const makeSet = async (label, count) => {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    for (let i = 0; i < count; i += 1) {
      doc.addPage([600, 800]).drawText(label + '-' + (i + 1), { x: 60, y: 700, size: 24, font });
    }
    return doc.save();
  };
  const host = await makeSet('HOST', 2);
  const guest = await makeSet('GUEST', 3);

  const merged = ops.insert(ops.fromDocument(2), 1, [
    ops.descriptor('guest', 1, 0), ops.descriptor('guest', 2, 0)
  ]);
  const mergedBytes = await buildBytes(host, merged.order, { guest });
  const mergedDoc = await PDFLib.PDFDocument.load(mergedBytes);
  check('merged pages land where they were asked for', mergedDoc.getPageCount() === 4);
  check('the host document\'s own pages shift along for them',
    JSON.stringify(merged.map) === '[0,3]', JSON.stringify(merged.map));

  const pdfjs = await loadPdfjs();
  if (pdfjs) {
    const parsed = await pdfjs.getDocument({
      data: new Uint8Array(mergedBytes), useWorkerFetch: false, isEvalSupported: false
    }).promise;
    const labels = [];
    for (let i = 1; i <= parsed.numPages; i += 1) {
      const content = await (await parsed.getPage(i)).getTextContent();
      labels.push(content.items.map((item) => item.str).join('').trim());
    }
    check('the merged pages carry the other document\'s content, not a placeholder',
      labels.join(',') === 'HOST-1,GUEST-2,GUEST-3,HOST-2', labels.join(', '));
  }
  check('a descriptor naming a source that was never registered is refused',
    await rejects(() => buildBytes(host, merged.order, {})));

  // --- a subset stays re-editable ------------------------------------------
  /* The version this replaced stamped the whole drawing and copied pages out of
     the result, which could not embed the model — its page indices no longer
     lined up — so an extract came out flattened and its markups could never be
     answered again. Building the subset from the *stripped* bytes and running
     the exporter over that is what puts both halves back. */
  RP.store.docBytes = await makeSourcePdf();
  RP.store.docName = 'sheet.pdf';
  RP.store.scale = null;
  RP.store.numbering = null;
  RP.store.pageOrder = null;
  RP.store.baseBytes = null;
  RP.store.sources = null;
  RP.store.encrypted = false;
  RP.store.numPages = 2;
  RP.store.annotations = sampleAnnotations();
  const onPageOne = RP.store.annotations.filter((a) => a.page === 1).length;

  const subset = await RP.pages.subsetPdf([1], 'sheet-page-2.pdf');
  const subsetDoc = await PDFLib.PDFDocument.load(subset);
  check('an extract holds only the pages asked for', subsetDoc.getPageCount() === 1);

  const subsetModel = await RP.exporter.readEmbeddedMarkup(subset);
  check('an extract carries a re-editable markup model',
    !!subsetModel && subsetModel.annotations.length === onPageOne,
    subsetModel ? subsetModel.annotations.length + ' of ' + onPageOne : 'no model');
  check('and its markups are renumbered onto the pages they are now on',
    !!subsetModel && subsetModel.annotations.every((a) => a.page === 0));

  const streams = async (bytes) => {
    const doc = await PDFLib.PDFDocument.load(bytes);
    return doc.getPages().map((page) => {
      const contents = page.node.get(PDFLib.PDFName.of('Contents'));
      return contents && contents.asArray ? contents.asArray().length : 1;
    });
  };
  /* The trap this guards: pages copied out of already-stamped bytes carry the
     stamp baked in, and a model embedded beside it would draw every markup
     twice on re-open — once live and once unreachable. Re-opening the extract
     and saving it again has to be idempotent exactly as the parent is. */
  const reopened = await RP.exporter.splitSaved(subset);
  const child = RP.createStore();
  child.docBytes = reopened.bytes;
  child.docName = 'sheet-page-2.pdf';
  child.annotations = reopened.model.annotations;
  const resaved = await RP.exporter.buildPdf({ store: child });
  check('re-saving an extract does not double-stamp it',
    JSON.stringify(await streams(resaved)) === JSON.stringify(await streams(subset)),
    JSON.stringify(await streams(subset)) + ' -> ' + JSON.stringify(await streams(resaved)));

  // The markups the parent kept are untouched by any of this.
  check('extracting leaves the document it came from alone',
    RP.store.annotations.length === sampleAnnotations().length &&
    RP.store.annotations.some((a) => a.page === 1));

  // --- the numbers land upright in the right corner -------------------------
  if (pdfjs) {
    const uprightAt = [];
    const cornerAt = [];
    const MARGIN = 30;
    const NUM_SIZE = 12;
    for (const angle of [0, 90, 180, 270]) {
      const doc = await PDFLib.PDFDocument.create();
      doc.addPage([612, 792]).setRotation(PDFLib.degrees(angle));

      const numbered = RP.createStore();
      numbered.docBytes = await doc.save();
      numbered.docName = 'numbered.pdf';
      numbered.annotations = [];
      numbered.numbering = {
        prefix: 'BATES-', start: 41, digits: 5, suffix: '',
        position: 'bottom-right', margin: MARGIN, size: NUM_SIZE, from: 0, to: 0
      };
      const stamped = await RP.exporter.buildPdf({ store: numbered });
      const parsed = await pdfjs.getDocument({
        data: new Uint8Array(stamped), useWorkerFetch: false, isEvalSupported: false
      }).promise;
      const pageProxy = await parsed.getPage(1);
      const viewport = pageProxy.getViewport({ scale: 1, rotation: pageProxy.rotate });
      const content = await pageProxy.getTextContent();
      const item = content.items.find((it) => (it.str || '').includes('BATES-00041'));
      if (!item) { check('the number is stamped at ' + angle + '°', false); continue; }

      const device = pdfjs.Util.transform(viewport.transform, item.transform);
      if (Math.abs(device[1]) < 0.01 && device[0] > 0) uprightAt.push(angle);
      /* Bottom right *as displayed*. The viewport is already turned, so the
         expected place is the same pair of numbers at every angle — which is
         the whole point, and is what a number laid along +x in user space
         would fail: it would walk round the sheet as the page turned. */
      const wantRight = viewport.width - MARGIN;
      const wantDown = viewport.height - MARGIN;
      if (Math.abs(device[4] + item.width - wantRight) < 1.5 &&
        Math.abs(device[5] - wantDown) < 1.5) cornerAt.push(angle);
    }
    check('a page number reads horizontally at every /Rotate',
      uprightAt.join(',') === '0,90,180,270', 'upright at ' + uprightAt.join(', ') + '°');
    check('and sits in the same displayed corner however the sheet is turned',
      cornerAt.join(',') === '0,90,180,270', 'in the corner at ' + cornerAt.join(', ') + '°');
  }

  // --- numbering is stripped and re-stamped like everything else ------------
  const numberedStore = RP.createStore();
  numberedStore.docBytes = await makeSet('SHEET', 3);
  numberedStore.docName = 'set.pdf';
  numberedStore.annotations = [];
  numberedStore.numbering = { prefix: '', start: 1, digits: 3, position: 'bottom-centre', from: 0, to: 2 };
  const firstSave = await RP.exporter.buildPdf({ store: numberedStore });
  numberedStore.docBytes = firstSave;
  const secondSave = await RP.exporter.buildPdf({ store: numberedStore });
  check('re-saving a numbered set does not stamp the numbers twice',
    JSON.stringify(await streams(secondSave)) === JSON.stringify(await streams(firstSave)),
    JSON.stringify(await streams(firstSave)) + ' -> ' + JSON.stringify(await streams(secondSave)));

  const label = await pageLabel(firstSave, 1);
  if (label !== null) {
    check('the second sheet is stamped with its own number, not the first\'s',
      label.includes('002') && !label.includes('001'), label);
  }

  /* A print is a dead end, so it carries no model — but it must still carry the
     numbers, or a numbered set would print unnumbered. Built from a clean store
     rather than from `firstSave`, because that is how the app reaches it: the
     bytes a reopened drawing prints from have had the stamp lifted back out of
     them by `splitSaved` before pdf.js ever saw the file. */
  const printStore = RP.createStore();
  printStore.docBytes = await makeSet('SHEET', 3);
  printStore.docName = 'set.pdf';
  printStore.annotations = [];
  printStore.numbering = numberedStore.numbering;
  const printCopy = await RP.exporter.buildPdf({ store: printStore, embed: false });
  check('a print copy carries no re-editable model',
    (await RP.exporter.readEmbeddedMarkup(printCopy)) === null);
  const printLabel = await pageLabel(printCopy, 2);
  if (printLabel !== null) {
    check('but a numbered set still prints numbered',
      printLabel.includes('003'), printLabel);
  }

  RP.store.numbering = null;
}

/** Read the sheet label back out of a page, to prove content moved with it. */
async function pageLabel(bytes, index) {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const text = await (await doc.getPage(index + 1)).getTextContent();
  return text.items.map((item) => item.str).join('').trim();
}

(async () => {
  console.log('Redline PDF — verification');
  try {
    testLayoutContract();
    testAppearance();
    testChrome();
    testNativeAnnotations();
    testGeometry();
    testTakeoff();
    testMarkupStatus();
    testArrange();
    testGrouping();
    testHighlightGeometry();
    testTextSelection();
    testToolArming();
    testCalloutText();
    testCompareMaths();
    testCompareGuards();
    testMarqueeZoom();
    testViewModes();
    testRasterCap();
    await testDetailTiles();
    testNavigator();
    await testLayerQueue();
    testCanvasRetention();
    testScrollPage();
    testSessions();
    testPackaging();
    testSnapshotGeometry();
    await testProtectedDrawings();
    await testSaveTargets();
    await testExport();
    await testReopen();
    await testRotatedStamp();
    await testPageManagement();
    await testPageAssembly();
    await testPrinting();
  } catch (err) {
    failures += 1;
    console.error('\nUnexpected error:', err && err.stack ? err.stack : err);
  }
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
