# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Redline PDF** — a Windows desktop PDF markup tool for electrical drawings.
Electron shell, PDF.js for rendering, pdf-lib for writing markups back into the
PDF. Current version 0.7.1. See `README.md` for user-facing behaviour,
`CHANGELOG.md` for what changed when, and `PLAN.md` for the roadmap and known
engineering debt.

**Every user-visible change gets a `CHANGELOG.md` entry and a version bump in
`package.json`**, and the version line above is part of that bump — it has gone
stale before.

## Commands

```bash
npm install
npm start              # run the app
npm run dev            # run with DevTools detached (--dev)
node test/verify.js    # headless checks — export, re-save idempotency, compare maths
npm run dist           # electron-builder NSIS installer into dist/
npm run pack           # unpacked build, faster for smoke-testing packaging
```

There is no linter, formatter, or test runner beyond `test/verify.js`. Run it
after touching `exporter.js`, `compare.js`, `store.js`, or `render.js` geometry.

## Architecture

Two processes with a single, narrow bridge between them.

**Main** (`main.js`, Node) — windows, native dialogs, all disk I/O, settings and
recents (plain JSON in `app.getPath('userData')`), crash-recovery snapshots,
tray, single-instance lock, `.pdf` file-association handling.

**Preload** (`preload.js`) — exposes `window.rp` via `contextBridge`. This is the
*only* path from renderer to Node. `contextIsolation: true`, `nodeIntegration:
false`.

**Renderer** (`src/`) — the entire app. Served over the privileged `app://`
scheme registered in `main.js`, *not* `file://`, because PDF.js is ESM-only from
v4 onward and module scripts need a real origin. App code is still classic
scripts: every module is an IIFE hanging off the global `RP` namespace, loaded in
dependency order by the `<script>` tags at the bottom of `src/index.html`:

| File | Responsibility |
|---|---|
| `util.js` | `RP.$`, `RP.el`, geometry (`RP.geom`), colours, the `RP.bus` event bus, toasts |
| `diag.js` | error capture, on-screen diagnostics panel, log file streaming |
| `menu.js` | the one popup menu — right-click menus and toolbar dropdowns both |
| `pdfjs-loader.js` | loads PDF.js (ESM v4+ or UMD v3), worker path, `docParams()` |
| `store.js` | `createStore()` — one document's model: annotations, selection, snapshot undo/redo, measurement scale |
| `render.js` | canvas drawing and hit-testing for every markup type |
| `viewer.js` | `createViewer(paneEl, store)` — one pane's continuous-scroll rendering, zoom, text layer, thumbnails |
| `tabs.js` | open documents as tabs, the one-or-two panes they live in, and the tab strip |
| `annots.js` | the file's *own* annotations — pdf.js annotation layer, link service |
| `clip.js` | reading the text-layer selection and writing to the clipboard |
| `textsel.js` | the selected-text *payload*, the standing area selection, and the action menu both gestures open |
| `props.js` | the markup properties dialog |
| `keys.js` | the `?` shortcut cheat sheet (documentation, not wiring) |
| `tools.js` | pointer interaction — creating markups and the select/edit tool |
| `search.js` | per-document text index and find |
| `sidebar.js` | panel switching, markup list, recents |
| `outline.js` | the file's *own* bookmarks — outline tree, dest jumps |
| `compare.js` | revision-compare engine and UI |
| `exporter.js` | pdf-lib export, embedded markup model, CSV/PDF reports |
| `pages.js` | page order model, pdf-lib rebuild, and the Pages panel UI |
| `print.js` | print dialog, page-range parsing, fit-to-paper geometry |
| `app.js` | wiring — boot, toolbar, shortcuts, save pipeline, settings, autosave |

`updater.js` sits beside `main.js` in the main process rather than under
`src/`: it is the app's only network call, and keeping it in one file with the
reasoning at the top is what stops it spreading.

## Tabs, panes and the two live pointers

Several drawings are open at once, so two globals are *pointers*, not objects:

- **`RP.store`** is the focused tab's store. `RP.createStore()` makes one per
  open document; `RP.tabs` reassigns the pointer on every switch.
- **`RP.viewer`** is the focused pane's viewer. `RP.createViewer(paneEl, store)`
  makes one per pane.

Two things follow, and breaking either is how markups end up on the wrong sheet:

- **Read `RP.store` / `RP.viewer` at call time. Never capture them at load
  time**, and never hold one across an `await` that the user could switch
  under — capture the concrete store into a local first, the way `App.writeTo`
  does before it builds bytes.
- **A pane draws `this.store`, not `RP.store`.** In a split both panes paint at
  once and only one of them is focused.

A tab owns the *session* (store, saved view state, search index, compare run); a
pane owns the *viewport* (a `.viewer` scroller, its page DOM, its
IntersectionObservers). Switching a tab inside a pane tears the page DOM down and
rebuilds it — page DOM is deliberately **not** kept per tab, because a hidden
pane's worth of canvases for every open drawing is real memory on a 200-page
sheet set, and pdf.js caches the page proxies so a rebuild is a re-layout rather
than a re-parse.

Anything a background tab does must not repaint the UI, so `store.emit()` stays
silent unless that store is the focused one. The single exception is
`markDirty`, because the tab strip shows the unsaved dot for tabs you are not
looking at and the window-close guard has to see every dirty document.

Search, compare and the Pages selection are one shared instance each but mean
something different per document, so `RP.tabs.stash/unstash` lifts their state
onto the outgoing tab and puts it back on the incoming one. A module that grows
per-document state needs a `stash()`/`unstash()` pair adding there.

## Conventions

- **Adding a renderer module:** create `src/js/<name>.js` as
  `(function (RP) { 'use strict'; ... })(window.RP);`, attach a single object to
  `RP`, and add a `<script>` tag to `index.html` **in dependency order**. Nothing
  resolves imports for you.
- **Module communication goes through `RP.bus`**, not direct calls where it can
  be avoided. Existing events: `doc:reset`, `doc:loaded`, `annots:changed`,
  `selection:changed`, `dirty:changed`, `scale:changed`, `pages:changed`,
  `pages:rebuilt`, `thumbs:built`.
- **All annotation geometry is stored in PDF user space** (points, origin
  bottom-left), never in CSS pixels. Convert at draw time with the pdf.js
  `viewport`. This is what keeps markups correct across zoom, rotation, save and
  re-open — do not break it.
- **Page structure is data, not bytes.** `store.pageOrder` is a list of
  descriptors (`{uid, src, srcIndex, rot, blank}`) and the open document is
  rebuilt from `store.baseBytes` + that list by `RP.pages.buildBytes`. Never
  mutate the page tree in place — add an op to `RP.pages.ops`, which is pure and
  returns `{order, map, clones}` so annotations can be remapped and `verify.js`
  can test it without a browser.
- **Undo is snapshot-based.** Call `RP.store.checkpoint()` *before* a mutation.
  During a drag, checkpoint once at drag start and then use `store.touch(annot)`
  for the live updates. Pass `{noCheckpoint: true}` when loading from a file.
- **New IPC** needs three matching pieces: an `ipcMain.handle` in `main.js`
  returning the `{ok, data, error}` envelope (`ok()` / `fail()` helpers), a method
  on the `window.rp` surface in `preload.js`, and nothing else — never widen the
  bridge to expose Node primitives.
- Style matches the existing files: `'use strict'`, 2-space indent, single
  quotes, semicolons, a short block comment at the top of each file explaining
  *why* it exists.

## Things that will bite you

- **Save must stay atomic.** `file:write` writes to a sibling `.tmp-<ts>` file and
  renames it into place. Drawings are the user's work product; a truncating write
  is unacceptable. The one-time `.bak.pdf` on first overwrite is a separate
  safety net, not a replacement.
- **The app never picks a save location on its own, and `savedTo` is what
  stops it asking twice.** In copy mode the first save of a document goes
  through `pickSavePath()` with `defaultCopyPath()` pre-filled; `store.savedTo`
  records what the user confirmed and every save after it writes there
  silently. Skip the prompt and the app chooses a filename and a folder on the
  user's behalf and only mentions them afterwards in the toast — which is the
  bug this replaced. Skip the `savedTo` reuse and repeat saves stack a new file
  per `Ctrl+S`. A cancelled dialog must resolve to `null`, not to a guessed
  path: `App.save()` reads `null` as "did not save" and returns `false`, and
  that `false` is the only thing stopping the tab-close and window-close guards
  from discarding the work. `savedTo` is recorded for *copies only*: an
  overwrite that claimed it would leave it pointing at the original, and the
  next save after a switch to copy mode would take that as a copy it had
  already been given and write over the drawing without asking.
  `test/verify.js` covers all of it.
- **A copy-saved document keeps its original `docPath`.** `savedTo` moves,
  `docPath` does not, so the tab title, the recents entry, the crash snapshot
  and a later switch to overwrite mode all go on meaning the drawing that was
  opened. That is a decision, not an oversight — the copy is an output of the
  document, not a replacement for it. Re-pointing `docPath` at the copy would
  make the next overwrite-mode save destroy the copy instead of the original,
  which is not what "overwrite" says on the chip.
- **The save mode is global, so changing it must reach every open store.**
  `App.clearSaveModeDecisions()` walks `RP.tabs.all()`; clearing only
  `RP.store.saveModeDecided` leaves a background drawing honouring an "ask each
  time" answer the user has since replaced. Both the status-bar chip and the
  Settings radios go through it.
- **`resolveTarget` takes its store as an argument.** It puts a dialog up, and
  the user can switch tabs while it is open — reading `RP.store` after that
  await resolves the target against a different drawing. `App.save()` captures
  the store before the first await and hands it to both `resolveTarget` and
  `writeTo`.
- **A file this app saved is split as it opens, not rendered as it stands.**
  Every save writes the markups twice — stamped into the page content for other
  viewers, and as the editable model in the catalog for this one. Rasterise the
  file as it is *and* draw the model and every markup is on the sheet twice: the
  baked copy cannot be selected, moved or deleted, and survives deleting the
  live one right up until the next save. `RP.exporter.splitSaved` therefore
  lifts the stamp back out in `App.loadDocument`, before pdf.js ever sees the
  bytes, and the stripped result is both what gets rendered and what goes into
  `store.baseBytes`. Those bytes carry no `RedlineMarkup` entry, so the next
  save stamps from clean and stays idempotent. `test/verify.js` covers it.
- **Text is stamped in the page's *displayed* orientation, everything else in
  user space.** `/Rotate` is applied after the content stream, so a shape drawn
  in user space turns with the page and stays where it was put — but a run of
  text laid along +x reads left-to-right only at `/Rotate 0` and comes out on
  its side on the landscape sheets drawings are plotted as. `exporter.pageFrame`
  returns screen-right and screen-down as user-space vectors; `at`,
  `screenTopLeft` and `screenSize` place text with them, and every `drawText`
  passes `rotate: degrees(frame.angle)`. A callout also wraps to its
  *displayed* width, because that is what the canvas wraps to. Three cases need
  this — `text`, `callout` and the `measure` label — and `test/verify.js` reads
  the stamped run back through pdf.js at all four angles, including a negative
  control that the run really is turned in user space.
- **Re-save must stay idempotent.** Every save embeds the markup model in the PDF
  catalog under `RedlineMarkup` *along with the object refs of everything that
  save stamped*; the next save strips those refs first. Break this and markups
  double up on every save. `test/verify.js` covers it — keep it passing.
- **Rebuild from stripped bytes, never from what is on screen.** A page copied
  out of an already-saved file carries the previous save's stamped markups baked
  into its content stream, and the next save would draw them again on top.
  `RP.pages.ensureBase()` runs the bytes through `RP.exporter.stripToBaseBytes()`
  once and everything rebuilds from that. `test/verify.js` covers it.
- **pdf-lib's copier caches by source object.** Asking one `copyPages` call for
  the same index twice returns the *same* page node, so a duplicated page would
  alias its original and share its rotation. `buildBytes` copies in passes for
  exactly this reason — one pass per extra copy needed.
- **`getViewport({rotation})` is absolute, not additive.** Passing the view
  rotation alone silently flattens pages with their own `/Rotate`, which is most
  scanned or plotted sheets. Always go through `RP.viewer.rotationOf(pageProxy)`.
- **Turning the text and annotation layers is the *stylesheet's* job, and the
  three rules that do it live in `app.css` by hand.** pdf.js sizes both layers
  from `viewport.rawDims` — the raw, never-rotated viewBox — places every child
  as a percentage of that box, and then stamps `data-main-rotation` on the
  container expecting CSS to turn it. Its own `pdf_viewer.css` carries those
  rules at the top level; this app mirrors them rather than importing that
  sheet, so they have to be repeated for `.text-layer` and `.native-annots`
  both. Drop them and a sheet with its own `/Rotate` gets an upright text layer
  over a landscape page: `overflow: clip` eats the overhang, the I-beam appears
  over blank paper, highlights select nothing, and links and comment bubbles
  stop being clickable. It reads as a broken document rather than as missing
  CSS. `test/verify.js` asserts all three angles on both layers, and that they
  rotate about the top-left corner — `rotate()` about the centre swings the
  layer off the sheet, because the `translate()` in each transform assumes a
  top-left origin.
- **Printing must never come off the canvas.** The canvas is a zoom-dependent
  raster; the printer has to get vector content. `RP.print` builds bytes with
  pdf-lib (`RP.exporter.buildPdf({embed: false})` for markups-on,
  `RP.pages.buildBytes` from stripped base bytes for markups-off) and main.js
  serves them to a preview window from memory over
  `app://redline/__print/<token>.pdf`. That window's *top-level document is the
  PDF* — deliberately, not an `<embed>` in an HTML shell, because Chromium
  prints a raster of the host page in that case. Print is therefore issued via
  `printWindow.webContents.print({silent: false})` and the window's chrome is a
  native `Menu`, not markup.
- **Print copies use `{embed: false}`** so they never carry the `RedlineMarkup`
  catalog entry. A print is a dead end, not a save, and embedding the model in
  one would put a re-editable file into circulation that nobody saved.
- **`embedPage` drops `/Rotate`.** Fit-to-paper uses `copyPages` (which keeps
  rotation) and does all its scaling in *unrotated* user space, converting the
  target sheet size back through the rotation first. Get this backwards and
  every landscape-plotted sheet prints off the edge of the paper.
  `test/verify.js` covers it, along with a MediaBox whose origin is not (0,0).
- **Page canvases are on a memory budget, and a released page is not a bug.**
  Nothing frees a canvas on its own, and an E-size sheet at fit-width is ~13
  megapixels per canvas with two per page, so a 77-sheet set scrolled end to end
  would hold over a gigabyte of backing store. Chromium starts evicting under
  that and every later render crawls — which reads as "pages take forever",
  getting worse the longer the document has been open, and is easy to misblame
  on the file or the machine. `RP.viewer.retainCanvases()` therefore releases
  the rastered pages furthest from the viewport once past `CANVAS_BUDGET_PX`,
  and `releasePage` zeroes *both* canvas dimensions — `clearRect` leaves the
  backing store allocated. Pages on screen and the `MIN_RETAINED_PAGES` floor
  are exempt, so the budget is a target and not a ceiling. The CSS size stays
  put, or the scroll column would concertina. `test/verify.js` covers it.
- **Rasterisation is queued, not fired off the observer.** pdf.js has one
  worker, so `requestPage` puts indices in `renderQueue` and `pumpRenders` runs
  at most `MAX_PAGE_RENDERS` at a time, nearest the viewport first. Thumbnails
  go through `requestThumb`/`pumpThumbs`, which will not start while any page is
  pending — they share that worker, and opening the panel on a long set
  otherwise queues 77 thumb rasters ahead of the sheet being read. Call
  `requestPage`, never `renderPage` directly.
- **`redrawAll()` only repaints what is on screen.** It fires on
  `selection:changed`, i.e. every click; repainting every page still holding a
  raster meant clearing 77 canvases per click. Off-screen pages get
  `annotDirty` and are repainted by the page observer when they come back, so a
  new code path that paints into `annotCanvas` has to respect that flag.
- **`onScroll` must not measure the DOM.** Page tops are cached in
  `viewer.pageTops` by `measurePages()` and invalidated by `layout()`; the
  handler binary-searches them. Reading `getBoundingClientRect()` per page there
  forces a layout per page per frame, which was most of the scroll jank on a
  sheet set. Anything that changes page geometry must null `pageTops`.
- **Page tops go through `RP.viewer.topOf`, never `offsetTop`.** `offsetTop` is
  relative to the *offsetParent*, which is `.viewer` only for as long as nothing
  positioned appears between it and `.page`; the day one does, every page top
  comes back short at once and clicking a thumbnail opens the sheet before the
  one clicked. `topOf` measures against the scroller itself. `goToPage` also
  clamps to `maxScrollTop()` and schedules `confirmLanding`, which re-checks the
  arrival, corrects a landing that is a whole page out, and logs the geometry it
  saw to `diag.js` — that log is how a wrong landing gets diagnosed on a machine
  you cannot attach DevTools to. It stands down if `userScrollAt` says the user
  took the wheel mid-flight. `test/verify.js` covers all of it.
- **The browser's text selection is a set of candidates, not the answer.** It
  selects in *DOM order*, and pdf.js emits one span per run in content-stream
  order — the order the plotter wrote the entities, which on a drawing has
  nothing to do with reading order. Dragging down two lines of a description
  block therefore sweeps in every run written in between, scattered across the
  sheet. `RP.tools.hl.sweep` rebuilds what was actually swept from the press
  point, growing a horizontal band row by row and admitting only runs that
  overlap it. The gap rule that decides "one stretch of text" is
  `RP.tools.hl.runs`, shared with the bar merging so the two cannot disagree.
  Nor are the glyphs in the text layer the glyphs on the page: pdf.js stretches
  a substituted face to the recorded advance with `--scale-x`, so the caret
  lands a fraction of a character out and selections are rounded to whole words
  before being measured. `test/verify.js` covers all of it.
- **A text selection must be snapshotted before any menu opens.** Opening
  `RP.menu` moves focus and installs a `pointerdown` listener of its own, and
  the browser's selection survives neither — by the time an item's handler runs
  there is nothing left to read. So `RP.tools.selectionPayload` builds a
  `{pages: Map<pageIndex, rects[]>, text}` payload at *release* and every action
  in `textsel.js` works from that snapshot. Nothing below `RP.textsel.items`
  may call `window.getSelection()`. `test/verify.js` covers it.
- **Text off a drawing has to be rebuilt in reading order, not read off the
  selection.** `selection.toString()` concatenates in DOM order and pdf.js
  emits one span per run in content-stream order — the order the plotter wrote
  the entities — so a two-line description block comes back with its lines
  interleaved and runs from the far side of the sheet dropped in between.
  `RP.tools.hl.textOf` walks the rows `HL.rows`/`HL.runs` already bucketed and
  sorted. It squeezes whitespace per *word* rather than over the finished
  string, because a pass over the whole thing collapses the double space
  separating two schedule columns back down to a word space.
- **The text-select tool is separate from `select` on purpose.** Under `select`
  the ink layer is transparent so the text layer beneath is reachable, which is
  why `bindPane` has to refuse the browser's `mousedown` on every press that is
  not on a glyph. `textselect` instead keeps the ink layer in the pointer path
  and takes the text layer *out* of it, so the browser's selection is never
  started behind the marquee and none of that dance is needed. Folding the two
  tools together would put it back.
- **An area selection admits a word by its *centre*.** Overlap drags in the
  whole of a long run whose first letter the box happened to clip — on a
  schedule that means selecting the column you deliberately stopped short of.
  Containment drops a word whose descender pokes out of the bottom edge.
  `RP.tools.band.centreInBand` is the rule and `test/verify.js` covers all
  three cases. `wordsInBand` also rejects or accepts whole spans on their own
  bounding box first and only word-splits the ones the band actually cuts
  through: one Range per word per span is the expensive part, and a plotted
  title block has hundreds of spans.
- **`cover` is not redaction and must never be described as such.** It is an
  opaque filled rectangle — deliberately its own type rather than `rect` with
  `fill: true`, which exports at a quarter opacity. The text underneath is
  untouched and still selectable, searchable and extractable. The menu row says
  so, and so do `README.md` and `CHANGELOG.md`. If that ever needs to be real
  redaction it is a different feature: the content stream has to be edited.
- **Strikeout and underline size their rule from the text, not from
  `annot.width`.** `RP.render.ruleWeight` takes the run's height, and both the
  canvas and the exporter call it — an E-size sheet carries 3pt schedule text
  and 24pt titles on one page, and a fixed weight either obliterates the first
  or reads as a hairline under the second. The two callers must not drift.
- **Review status normalises on read but not on write.** `RP.statusOf` maps a
  missing or unrecognised status to `'open'`, because a drawing saved before 0.6
  has no status at all and a file from a later build could carry one this
  version has never heard of — either way the markup still has to draw and still
  has to appear in the list. `store.setStatus` deliberately does *not* do the
  same: it refuses a status not in `RP.STATUSES` and returns 0, since coercing a
  bad write to `'open'` would silently reopen a closed item. It also checkpoints
  **once** for the whole set, or `Ctrl+Z` after closing out a marquee's worth of
  markups would walk back through them one at a time. `test/verify.js` covers
  all of it.
- **What a resolved markup looks like is defined once, in `render.js`.**
  `statusAlpha` (the opacity multiplier) and `statusStrikeLine` (the rejected
  rule, returned as a line in *PDF space*) are called by both the canvas and
  `exporter.js`, because a printed punch list that disagrees with the one being
  worked from is worse than no status on paper at all — and canvas/exporter
  drift is a recurring bug here. The strike is drawn at full opacity over the
  faded markup on purpose: the fade is the message, and a rule that faded with
  it would be the one part of a rejected markup you could not read. Note that
  each case in `drawAnnotation` sets its own alpha with its own default (a
  highlight lands at 0.4, a line at 1), which is why the fade goes through the
  local `alpha(fallback)` helper rather than by overwriting `annot.opacity`.
- **The markup list's filter, sort and status are per *document*.** They live on
  `RP.sidebar` as one shared instance, so they go through the
  `stash()`/`unstash()` pair like search, compare and the Pages selection —
  otherwise a filter set on one drawing narrows the next one's list the moment
  you switch to it. `unstash` re-syncs the DOM controls itself: a restored
  filter the box does not display is worse than one that did not restore.
- **Compare is CPU-heavy and currently on the main thread.** Changes to
  `compare.js` should not add per-page work without measuring; moving the
  pipeline to a Web Worker is a tracked item in `PLAN.md`.
- **A failed render is not a difference.** The diff maths cannot tell "this
  sheet was redrawn" from "this sheet never painted": a render that times out
  leaves a white canvas and reads as *everything removed*, and a canvas the
  browser refused to allocate reads back black and reads as *everything added*.
  So `compare.js` times every render out, checks each mask for zero ink and for
  near-total ink, retries the pair once on a smaller grid, and then reports the
  page as **could not be compared** — never as a page where everything changed.
  `test/verify.js` covers the health checks and the verdicts.
- **Fit the baseline sheet onto the grid centred, not cornered**, and let
  `fitCorrection` re-render it at a corrected scale when the ink bounding boxes
  say the sheet was re-plotted. Sheet sizes drift between issues; anchoring the
  smaller one at the origin puts every mark a few hundred pixels from its twin
  and the whole page reports as changed.
- **Nothing translucent goes over a change region.** Old and new glyphs of an
  edited number occupy the same pixels, so a wash of red over a wash of blue is
  unreadable. The overlay paints ink only and the *inspector* — the same crop
  taken from both revisions, magnified side by side — is what answers "changed
  to what?".
- **The CSP in `index.html` is deliberately tight** (`default-src 'self'`, no
  remote origins). No CDNs, no remote fonts, no telemetry. Add dependencies as
  npm packages loaded from `node_modules` and list their dist paths in the
  `build.files` array in `package.json`, or they will be missing from the
  installer.
- **Never assume a PDF.js flavour.** v3 is UMD (`build/pdf.js`, `renderTextLayer`,
  `--scale-factor`); v4+ is ESM (`build/pdf.mjs`, `TextLayer` class,
  `--total-scale-factor` plus `--scale-round-x/y`). `pdfjs-loader.js` picks one
  and `viewer.js` branches on `RP.pdfjs.hasTextLayerClass()`. Both paths must
  keep working — an npm bump across majors is exactly how this app broke once.
- **Always call `getDocument` through `RP.pdfjs.docParams()`** so `cMapUrl`,
  `standardFontDataUrl`, `wasmUrl` and `iccUrl` are set; without them, drawings
  with non-embedded or CJK fonts render with substituted glyphs. Those asset
  folders need entries in `build.files` too.
- **Boot must never be all-or-nothing.** `App.boot()` wires the chrome, then the
  UI, then the PDF engine, each in its own `try`. A failure in a later stage
  leaves earlier stages working and raises the banner. Anything that can throw at
  startup belongs behind its own stage.
- **Errors have to be visible without DevTools.** `diag.js` captures
  `console.error/warn`, `window.onerror` and unhandled rejections into the
  diagnostics panel (`Ctrl+Shift+D`) and streams them to
  `%APPDATA%/Redline PDF/redline-pdf.log`. Main-process problems go through
  `logMain()`. Keep both ends fed.
- **Electron API drift:** `File.path` is gone (use `window.rp.pathForFile`), and
  `console-message` changed signature — `main.js` handles both shapes.
- **The app shell is a flex column, not a grid.** Grid rows are assigned
  positionally, so hiding one child (the error banner) shifted the workspace
  into the wrong row and collapsed the viewer. Every direct child of `<body>`
  must either be `position: absolute/fixed` or declare its own `flex`, and
  exactly one (`.workspace`) may grow. `test/verify.js` asserts this — add a new
  top-level element and it will tell you if you forgot to size it.
- **Icons are `<use href="#symbol">`, which clones into a shadow tree.**
  Stylesheet selectors like `svg path {}` do not apply inside it — only
  *inherited* properties (fill, stroke, stroke-width, stroke-linecap/linejoin)
  cross the boundary, so they live on the `svg` rule in `app.css`. Solid shapes
  set `fill="currentColor" stroke="none"` as presentation attributes in the
  sprite. Style an icon with a CSS class and you get black silhouettes.
- **Closing the window is the renderer's decision, not main's.** `close` cannot
  be awaited and there may be several unsaved drawings behind it, so the first
  attempt is refused, `app:close-request` goes to the renderer, and it comes
  back through `window:close` with `{force: true}` once every tab has cleared —
  or `window:cancel-close` if the user backed out. A renderer that never answers
  is closed anyway after `CLOSE_GUARD_MS`; do not remove that timeout, it is the
  only thing stopping a broken renderer from trapping the app. `cancel-close`
  also clears `quitting`, because the request may have come from the tray's Quit
  and refusing the last window's close cancels the quit.
- **Pointer handling is bound per pane, not once**, by `RP.tools.bindPane`.
  Panes take `pointerdown` in the *capture* phase to repoint `RP.viewer` before
  the delegated handlers below run, which is what lets those handlers keep
  working against the global. Panning captures on the pane's own scroller, so a
  pan in the right-hand pane cannot scroll the left one.
- **Under the select tool the ink layer is transparent to the pointer**, so the
  text layer beneath it can be reached and the drawing's own words selected.
  That re-exposes the browser's selection to every other select gesture, so
  `RP.tools.bindPane` refuses the `mousedown` default on any press that is not
  on a real glyph — otherwise a marquee drag paints a text selection behind
  itself. `RP.clip.isGlyph` is the predicate, and it deliberately returns false
  for the `.text-layer` container, which is `inset: 0` and covers blank paper
  too. Both halves are needed; remove either and one of the two gestures breaks.
- **Night mode filters `.pdf-canvas` and nothing else.** The markup canvas is a
  sibling, so markups keep their real colours — invert them and every redline
  comes back cyan. `test/verify.js` asserts the rule does not name
  `.annot-canvas`.
- **A markup tool is a one-shot, and only a *finished* markup hands it back.**
  `RP.tools.afterCreate()` returns to Select unless `tools.sticky` is set;
  arming the already-armed tool toggles that lock. It is called from the
  places that have actually produced something — `finishDraft` after
  `store.add`, `createNote`, and `closeInlineText` when `made` is true — never
  from the drag code, because `finishDraft` returns early for a drag under the
  minimum size and disarming the tool there means a slipped click costs you a
  trip back to the toolbar. Text and callout are the exception to "hand back
  where you created it": they defer to `closeInlineText`, because `setTool`
  hides the typography group the moment the tool stops being text-ish and it
  has to stay reachable for the whole edit. `test/verify.js` covers all of it.
- **The typography controls act on the markup under an open inline editor, not
  on `store.selected()`.** A callout being created is not selected at all —
  `setTool` cleared the selection on the way in — so without that branch in
  `setTextStyle` the controls look live while you type and do nothing. Three
  things hang off it and all three are load-bearing: the editor's `blur`
  handler must let a click into `#textOptsGroup` through, or the markup commits
  before the control's `change` ever fires; the re-fit must measure
  `inlineText.value` rather than `annot.text`, which on a fresh callout is
  still the empty string; and `placeInlineText` has to run afterwards, or the
  editor keeps wrapping to a width the box no longer has. `syncTextOpts` is
  what keeps the group up for the whole edit regardless of the armed tool,
  since a double-click re-edit happens under Select.
- **A callout's box is sized from its text, so sizing and drawing must wrap
  identically.** `RP.render.wrapLines` is the one wrapper; `measureCalloutHeight`
  runs it in points to size the box and `drawCalloutText` runs it in viewport
  pixels with the *same* inset scaled by `viewport.scale`. A fixed pixel inset
  wraps narrower than the box was measured for at low zoom, and the extra line
  draws below the box. Both must also measure in the same *face*, so
  `measureCalloutHeight` takes the annotation and goes through
  `RP.render.fontSpec` — a bold or serif callout wraps wider than the sans it
  would otherwise be sized for. Anything that changes a callout's text, width,
  font size, family or weight has to re-apply `RP.render.fitCallout` — the
  inline editor, the properties panel, the toolbar's typography group and the
  end of a resize drag all do. `test/verify.js` covers it.
- **The inline text editor is placed from `vpRect`, not from a converted
  corner.** A callout box is *drawn* as the axis-aligned rect of its four
  corners, so anchoring the editor by converting the single top-left PDF corner
  only agrees at `/Rotate 0`. On a plotted landscape sheet the corner maps
  somewhere else and the editor opens away from its box — which reads as text
  that starts below the box and snaps into it on commit, because the committed
  canvas render was right all along. `test/verify.js` checks the anchor against
  the painted box at 0/90/180/270.
- **Text markups pick a face from a fixed list, never a free-text family.**
  `RP.render.FONT_STACKS` (sans/serif/mono) maps one-for-one onto the standard
  14 fonts in `RP.exporter.STANDARD_FONTS`, so anything on screen can be stamped
  without embedding a font program. Only the faces a drawing actually uses get
  embedded. A callout's `color` is its box and leader; its text has its own
  `textColor`, because tying them together would restyle every callout already
  drawn. A typewriter `text` markup has no box, so its `color` *is* its text.
- **There is one popup menu, `RP.menu`.** Two implementations means two sets of
  outside-click listeners fighting over one press. `RP.pages.openMenu` wraps it
  to keep its own async/busy guard; anything else calls `RP.menu.open` directly.
- **Pointer handling is delegated on each pane's `.pages`**, so it also sees events on the
  text layer and on the native annotation layer. The highlighter in text mode
  returns early from `onPointerDown` for exactly this reason — swallowing the
  event there stops native text selection before it starts — and there is a
  second early return for presses that land inside `.native-annots`, so a click
  on someone else's comment does not also start a markup drag. Any new tool
  that wants to cooperate with selection needs the same escape hatch.
- **Panning is the same problem from the other side.** It is wired on the pane's
  `.viewer` in the *capture* phase and calls `stopPropagation`, because a pan can start in
  the gutter between pages where there is no `.page` to hit, and because the
  press must not also reach the delegated handlers below. `onPointerDown` has a
  matching early return so a second pointer cannot start a markup mid-pan. The
  browser's text selection and Windows' middle-click autoscroll are default
  actions of `mousedown`, so those are refused there rather than on
  `pointerdown`, which is too late for both.
- **`RP.viewer.zoomToRect` compounds off the current zoom.** `vpRect` reports CSS
  pixels at the scale in force, so the marquee factor multiplies `viewer.zoom`
  rather than replacing it, and `revealRect` does the centring afterwards against
  the rebuilt viewports. `test/verify.js` covers it against a stubbed viewport —
  which is why `viewer.js` must keep its DOM access inside `init()` and handlers
  like every other renderer module. `test/verify.js` builds a viewer with
  `RP.createViewer({querySelector: () => null})`, so a DOM read in the factory
  body would break the suite immediately.
- **Anything that persists a view goes through `recents:remember-view`**, never
  `recents:add`. Page and zoom are written on every scroll and zoom step, and
  `recents:add` reorders the list and resets `openedAt`, which would shuffle the
  recents panel under the user. Window bounds are flushed synchronously on
  `close` and `before-quit`, because `saveSettings` is debounced and both
  quitting and hiding to tray end in `close`.
- **The bookmarks panel builds child rows lazily**, so anything that opens a
  branch has to work outermost-first — a node has no `kidsHost` until its own
  parent is open. `RP.outline.syncCurrent` reverses the ancestor chain for this
  reason. It also re-reads the outline on `pages:rebuilt`, because pdf-lib does
  not copy one and stale bookmarks would point at pages that have moved.
- **`.native-annots` is read-only and must stay that way.** It renders the
  annotations already in the file (`RP.annots`). They never enter `RP.store`
  and `RP.exporter` never writes them, so they survive a save only because they
  are part of the base bytes — stamping or stripping them would destroy another
  reviewer's work. It is before `.annot-canvas` in the DOM but carries
  `z-index: 4`, because `.ink-layer` is a later sibling and would otherwise eat
  every click before a link annotation saw it.
- **A URL out of a PDF is untrusted input.** The renderer never navigates and
  never calls `shell.openExternal`. Link anchors get `href="#"` with the real
  URL in `dataset.externalUrl`; clicking goes over `shell:open-external`, which
  allow-lists `http/https/mailto` and confirms the *resolved* href with the user
  first. `setWindowOpenHandler` denies everything for the same reason. Do not
  add a second path out.
- **`page.render()` already draws annotations that have an appearance stream**
  (`annotationMode` defaults to `ENABLE`), so the annotation layer is there for
  the interactive and text-bearing parts — links, popups, widgets — not to draw
  ink a second time. `renderForms` stays `false`: widgets arrive through the
  canvas as read-only pictures, and live `<input>`s would accept typing that
  nothing ever saves.
- `test/verify.js` runs renderer sources in-process (not in a `vm` context) so
  pdf-lib `instanceof` checks work. Renderer modules must therefore stay free of
  DOM access at load time — only inside `init()` and handlers. `app.js` is in
  that list too, so the only thing it may do at load time is register its
  `DOMContentLoaded` handler; anything else it runs on load has to survive the
  stub `document` at the top of the test.

## Releasing

`npm version patch && git push --follow-tags` is the whole release. The `v*`
tag runs `.github/workflows/release.yml`, which re-runs `test/verify.js` and
then has electron-builder publish the NSIS installer, the portable exe, the
`.blockmap` files and `latest.yml` to a GitHub release. The GitHub publish
provider infers owner and repo from the `origin` remote, so there is nothing to
configure — but the repo has to stay **public**, or the shipped updater would
need a token baked into it to read releases. `verify.yml` runs the headless
checks on every push.

**`publish.releaseType` must stay `"release"`.** electron-builder defaults it to
`"draft"`, and a draft is not a release as far as anything outside the web UI is
concerned: its assets are not downloadable anonymously, and `/releases/latest`
does not resolve to it, so `electron-updater` asks for the newest published
version, is told there is none, and reports that it *could not check for
updates*. The releases page looks full the whole time, which is what makes this
one expensive to diagnose — the tags are in the atom feed whether a release
exists or not, so a feed listing `v0.7.0` proves only that the tag was pushed.
Every release up to 0.7.0 was published this way and none of them was ever
installable by the updater. If drafts appear on the releases page again, this
setting is what regressed.

Before tagging, `CHANGELOG.md` needs the entry for what is going out and its
heading needs the real date — `npm version` bumps `package.json` and the lock
file but knows nothing about either. If `package.json` has already been bumped
by hand, `npm version <same> --allow-same-version` still makes the commit and
the tag; the point is that the tag, the manifest, the lock file, the changelog
heading and the version line at the top of this file all say the same thing.
Four separate pieces of work once reached `main` between 0.4.1 and 0.5.0 with
none of them recorded anywhere, which is what this file now exists to stop.

Builds are **unsigned**, deliberately: this is a personal tool and a
certificate is not worth buying for it. Two consequences to keep in mind.
SmartScreen warns on the first manually downloaded installer (updates fetched
by electron-updater carry no Mark-of-the-Web and install quietly). And
electron-updater has no publisher signature to check, so the trust boundary is
HTTPS to github.com. Signing is the upgrade path if this ever goes to anyone
else's machine — Azure Trusted Signing at ~$10/month is the realistic option,
and electron-builder takes it through `win.azureSignOptions`.

## Scope

Offline, single-user, local-file desktop app. No accounts, no telemetry, no
analytics, and no drawing ever leaves the machine. Keep it that way unless
explicitly asked.

**The one exception is the update check** (`updater.js`), and it is narrow on
purpose: one `GET` of the release feed a few seconds after launch, only when
`settings.autoUpdate` is on, nothing downloaded without a prompt, and nothing
sent outward. Install is queued rather than forced — `quitAndInstall` would
tear the windows down itself and drive straight through the renderer's
unsaved-tab guard, so `autoInstallOnAppQuit` stages the installer and "Quit and
install" goes through the same path as the tray's Quit. If you add a second
network call, that is a new decision, not an extension of this one.
