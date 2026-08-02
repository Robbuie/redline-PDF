# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Redline PDF** — a Windows desktop PDF markup tool for electrical drawings.
Electron shell, PDF.js for rendering, pdf-lib for writing markups back into the
PDF. Current version 0.3.0. See `README.md` for user-facing behaviour and
`PLAN.md` for the roadmap and known engineering debt.

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
- **Compare is CPU-heavy and currently on the main thread.** Changes to
  `compare.js` should not add per-page work without measuring; moving the
  pipeline to a Web Worker is a tracked item in `PLAN.md`.
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
  DOM access at load time — only inside `init()` and handlers.

## Releasing

`npm version patch && git push --follow-tags` is the whole release. The `v*`
tag runs `.github/workflows/release.yml`, which re-runs `test/verify.js` and
then has electron-builder publish the NSIS installer, the portable exe, the
`.blockmap` files and `latest.yml` to a GitHub release. The GitHub publish
provider infers owner and repo from the `origin` remote, so there is nothing to
configure — but the repo has to stay **public**, or the shipped updater would
need a token baked into it to read releases. `verify.yml` runs the headless
checks on every push.

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
