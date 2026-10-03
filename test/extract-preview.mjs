/*
 * See what the schedule finder makes of a drawing, without opening the app.
 *
 *     node test/extract-preview.mjs "some drawing.pdf"
 *     node test/extract-preview.mjs "some drawing.pdf" out.xlsx
 *
 * This loads the *shipped* modules rather than carrying its own copy of the
 * extraction — a second implementation here would be a second answer to what
 * counts as a table, and the one that drifts is always the one nobody runs.
 * `test/verify.js` covers the behaviour; this is for pointing at a customer's
 * drawing and reading what came back, which is how the thresholds in
 * `tables.js` were chosen in the first place.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1') + '/..';

globalThis.DOMMatrix ||= class { constructor(v) { v = Array.isArray(v) ? v : [1, 0, 0, 1, 0, 0]; [this.a, this.b, this.c, this.d, this.e, this.f] = v; } };
globalThis.Path2D ||= class { addPath() {} moveTo() {} lineTo() {} closePath() {} };
globalThis.ImageData ||= class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
global.window = global;
global.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
global.addEventListener = () => {};
global.document = {
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, getContext: () => null }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, dataset: {}, appendChild() {} }
};

const globalEval = eval;
for (const file of ['util.js', 'store.js', 'render.js', 'views.js', 'pdfjs-loader.js',
  'search.js', 'analyse.js', 'tables.js', 'xlsx.js']) {
  globalEval(fs.readFileSync(path.join(ROOT, 'src', 'js', file), 'utf8'));
}
const RP = global.RP;

const source = process.argv[2];
if (!source) {
  console.error('usage: node test/extract-preview.mjs <drawing.pdf> [out.xlsx]');
  process.exit(2);
}

const pdfjs = await import(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'));
RP.pdfjs.lib = pdfjs;

const doc = await pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(source)), useWorkerFetch: false, isEvalSupported: false
}).promise;

const sheets = [];
for (let n = 1; n <= doc.numPages; n++) {
  const pageProxy = await doc.getPage(n);
  const content = await RP.analyse.pageContent({ index: n - 1, pageProxy });
  const view = pageProxy.view;
  const found = RP.tables.findOnPage(content.rules, content.runs.items,
    { width: view[2] - view[0], height: view[3] - view[1] });
  for (const table of found) {
    table.page = n - 1;
    table.name = RP.tables.nameOf(table, n - 1, content.runs.items);
    console.log(`\n=== sheet ${n} — "${table.name}"  ${table.rows}x${table.columns}` +
      `  density ${table.score.density.toFixed(2)} ===`);
    for (const row of table.cells) {
      console.log('   ' + row.map((c) => c || '·').join(' | ').slice(0, 160));
    }
    sheets.push({ name: table.name, rows: table.cells });
  }
}

if (!sheets.length) {
  console.log('\nNo ruled schedules found.');
} else if (process.argv[3]) {
  fs.writeFileSync(process.argv[3], RP.xlsx.build(sheets));
  console.log(`\nwrote ${process.argv[3]} — ${sheets.length} worksheet(s)`);
} else {
  console.log(`\n${sheets.length} table(s). Pass an output path to write a workbook.`);
}
