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
global.document = {
  createElement: () => ({
    style: {}, appendChild() {}, setAttribute() {}, addEventListener() {},
    getContext: () => measuringContext()
  }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { add() {}, remove() {}, contains: () => false }, dataset: {}, appendChild() {} }
};

const globalEval = eval; // indirect eval => runs in global scope
for (const file of ['util.js', 'store.js', 'render.js', 'compare.js', 'exporter.js', 'pages.js',
  'print.js', 'annots.js', 'viewer.js']) {
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
    { page: 1, type: 'text', color: '#2f8fff', fontSize: 11, opacity: 1, x: 100, y: 120, text: 'MONO NOTE', fontFamily: 'mono' }
  ].map((a, i) => Object.assign({ id: 'mk' + i, created: Date.now(), modified: Date.now(), author: 'Tester', note: a.note || '' }, a));
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

  const embedded = await RP.exporter.readEmbeddedMarkup(saved);
  check('markup model round-trips for re-editing',
    !!embedded && embedded.annotations.length === RP.store.annotations.length,
    embedded ? embedded.annotations.length + ' markups recovered' : 'nothing recovered');
  check('measurement scale round-trips',
    !!embedded && embedded.scale && embedded.scale.realLength === 7.5);
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
      container: { offsetTop: 0, offsetLeft: 0 }
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
     400% is tens of megapixels on its own. The floor is what stops the viewer
     evicting everything and rendering nothing. */
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
    huge.rasterStats().rastered >= 3, huge.rasterStats().rastered + ' pages held');
  check('the retained ones are the pages nearest the viewport',
    huge.pages[3].pdfCanvas.width > 0, 'current page held');
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
  viewer.pages = [];
  for (let i = 0; i < 77; i += 1) {
    viewer.pages.push({
      index: i,
      container: { offsetTop: i * (PAGE_H + GAP), offsetHeight: PAGE_H }
    });
  }
  viewer.highlightThumb = function () {};
  viewer.emit = function () {};

  // The probe sits min(140, 30% of height) below the top of the pane.
  const scroller = { scrollTop: 0, clientHeight: 900 };
  viewer.els = { viewer: scroller };
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
 * The chrome added for view/copy/navigation: night mode, the clipboard path,
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
    ['js/props.js', 'js/tools.js'], ['js/keys.js', 'js/app.js']]) {
    check(module + ' is loaded before ' + before,
      html.indexOf(module) > 0 && html.indexOf(module) < html.indexOf(before));
  }

  // --- night mode -----------------------------------------------------------
  // The whole point is that the drawing inverts and the markups do not. A
  // filter that reaches .annot-canvas turns every redline cyan.
  const nightRules = (css.match(/body\.night[^{]*\{[^}]*\}/g) || []).join('\n');
  check('night mode filters the PDF canvas', /\.pdf-canvas/.test(nightRules) &&
    /invert\(1\)/.test(nightRules));
  check('night mode never touches the markup canvas', !/annot-canvas/.test(nightRules));
  check('night mode is persisted, not just toggled',
    /nightMode/.test(main) && /nightMode/.test(app));
  check('night mode is applied at boot', /applyNight\(this\.settings\.nightMode\)/.test(app));

  // --- clipboard ------------------------------------------------------------
  const clip = fs.readFileSync(path.join(ROOT, 'src', 'js', 'clip.js'), 'utf8');
  check('the clipboard IPC exists on all three required sides',
    /ipcMain\.handle\(\s*'clipboard:write-text'/.test(main) &&
    /call\(\s*'clipboard:write-text'/.test(preload) &&
    /window\.rp\.clipboard\.writeText/.test(clip));
  check('Ctrl+C is bound', /key === 'c'[\s\S]{0,120}RP\.clip\.copySelection\(\)/.test(app));
  check('the text layer is reachable under the select tool',
    /body\[data-tool="select"\]\s+\.page\s+\.ink-layer\s*\{[^}]*pointer-events:\s*none/.test(css));
  // Without this the browser paints a text selection behind every marquee.
  check('the browser selection is refused on presses that are not on glyphs',
    /mousedown[\s\S]{0,400}RP\.clip\.isGlyph\(event\.target\)[\s\S]{0,80}preventDefault/.test(tools));
  check('a glyph press yields to the browser instead of marqueeing',
    /RP\.clip\.isGlyph\(event\.target\)\)\s*\{[\s\S]{0,120}return;/.test(tools));

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
    testChrome();
    testNativeAnnotations();
    testGeometry();
    testCalloutText();
    testCompareMaths();
    testCompareGuards();
    testMarqueeZoom();
    testCanvasRetention();
    testScrollPage();
    testSessions();
    testPackaging();
    await testExport();
    await testPageManagement();
    await testPrinting();
  } catch (err) {
    failures += 1;
    console.error('\nUnexpected error:', err && err.stack ? err.stack : err);
  }
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
