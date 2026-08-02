# Backlog — "daily driver" work items

Each item below is written to be **self-contained**. Open a fresh chat, paste the
one item you want to work on, and it should have enough context to start without
re-reading the whole codebase. `CLAUDE.md` covers the architecture and the
landmines; every item assumes it has been read.

Suggested order: start at **7** (1–6 have shipped). Items 7–16 are
independent and can be picked up in any order. Items 17–21 are pre-release
hardening.

---

## Tier 1 — blockers for replacing a daily PDF viewer

### 1. Printing — **done**

Shipped as `src/js/print.js` + the `print:document` / `print:dialog` /
`print:close` IPC. `Ctrl+P` and a toolbar button open a dialog with page range
(all / current / on-screen / `1-3, 7, 11-`), markups on-off, and actual-size
vs. fit-to-paper with a paper picker. Actual size is the default and the fit
option carries a warning, because a fitted print cannot be measured off.

Two decisions worth knowing before touching it:

- **The preview window loads the PDF as its top-level document**, served from
  memory over `app://redline/__print/<token>.pdf`. Wrapping the bytes in an
  `<embed>` inside an HTML page would have let us draw our own toolbar, but
  Chromium then prints a raster of the host page. Printing has to be issued on
  a webContents whose document *is* the PDF. Hence the native window menu
  (Ctrl+P / Ctrl+W) instead of HTML chrome.
- **Fit-to-paper does its maths in unrotated user space.** `/Rotate` is applied
  after the content stream, so a landscape sheet stored as portrait + `/Rotate
  90` has to be fitted to the *pre-rotation* box. `embedPage` would have been
  the obvious tool and it silently drops rotation; `copyPages` +
  `scaleContent`/`translateContent` preserves it. `test/verify.js` covers this,
  plus the offset-MediaBox case.

Remaining nice-to-haves: printer/copies selection inside our own dialog rather
than the OS one, and a "skip preview" setting.

---

### 2. Native PDF annotations — **done**

Shipped as `src/js/annots.js` (`RP.annots`) plus a `.native-annots` div per
page, built from `pageProxy.getAnnotations()` at the end of
`RP.viewer.renderPage()` and sitting between the text layer and `annot-canvas`.
Read-only by design: `RP.store` never sees these and `RP.exporter` never writes
them, so a save round-trips them untouched inside the base bytes.

**The premise was half wrong, and the correction is worth knowing.**
`page.render()` defaults to `annotationMode: ENABLE`, so any annotation with an
appearance stream — which is nearly everything Bluebeam and Acrobat write — was
*already* being rasterised into the page canvas. A reviewed sheet was not
opening blank. What was actually missing was everything interactive or
text-bearing: links did nothing, comment popups never opened so the note body
was unreadable, form fields were frozen pictures, and annotations with no `/AP`
drew nothing at all. The trust problem was real, just narrower than "invisible".

Decisions worth knowing before touching it:

- **`renderForms` is deliberately `false`.** Widgets already arrive through the
  canvas as their appearance streams, which is the read-only display we want.
  Turning it on swaps in live `<input>`s that look editable, accept typing, and
  then drop it on the floor because nothing writes `annotationStorage` back.
- **The layer carries `z-index: 4`.** It is *before* `.ink-layer` in the DOM, as
  specified, but `.ink-layer` is a later sibling and would otherwise swallow
  every click before a link saw it. `tools.js` has a matching escape hatch —
  the same one the text-mode highlighter uses — so a press landing inside the
  layer never starts a markup drag. CSS drops the layer back out of the pointer
  path entirely whenever a drawing tool is armed.
- **A URL out of a PDF is untrusted input and never touches the renderer.**
  `linkService.addLinkAttributes` sets `href="#"` and stashes the real URL in
  `dataset`; clicking calls `shell:open-external`, which allow-lists
  `http/https/mailto` and shows the *resolved* href — not the link text — in a
  native confirm dialog before `shell.openExternal`. `setWindowOpenHandler` was
  tightened at the same time: it used to `openExternal` any `https:` URL without
  asking, which was a way around the dialog.
- **`annotationCanvasMap` is passed to `page.render()`.** Stamps and some free
  text are `hasOwnCanvas` — pdf.js hands those back through the map for the
  annotation layer to adopt, and they are simply missing without it.
- **`web/images/` is in `build.files`.** Sticky-note icons are `<img>` loads
  over `app://`; leaving them out of the installer renders every comment in a
  reviewed drawing as a broken image.

The annotationLayer CSS is hand-mirrored into `app.css` scoped to
`.native-annots`, the same way the text-layer rules already were, rather than
linking `pdf_viewer.css` — that stylesheet also restyles `.textLayer`,
`:root` and the XFA layer, and cannot be scoped from a `<link>`.

Out of scope, as specified: editing these annotations. Reasonable next steps are
a sidebar listing the file's own comments alongside ours, and answering a
comment by converting it into a Redline markup.

---

### 3. Bookmarks / outline panel — **done**

Shipped as `src/js/outline.js` (`RP.outline`) plus a `data-panel="outline"` tab
and section in `src/index.html`. Read-only, like `RP.annots`: the outline lives
in the base bytes, nothing here is stored or saved.

Decisions worth knowing before touching it:

- **Destinations are followed through `RP.annots.goToDestination`, not
  `RP.viewer.goToPage`.** That path already resolves named destinations, handles
  a page Ref vs. a raw page number, and converts `XYZ`/`FitH`/`FitR` into a rect
  for `revealRect`, so a bookmark lands on the *spot* rather than the top of the
  sheet. Re-implementing it here would have been a second, weaker copy of the
  untrusted-input handling. A bookmark carrying a URI action instead of a
  destination goes out over the same confirmed `shell:open-external` path.
- **Child rows are built into the DOM on first expand.** A spec book runs to
  thousands of entries and building them all at open is a visible pause. The
  model is flat and complete from the start; only the DOM is lazy. Anything that
  opens a branch must therefore work outermost-first — a node cannot build its
  children until its own `kidsHost` exists, which happens when *its* parent
  opens. `syncCurrent` reverses the ancestor chain for exactly this reason.
- **Page numbers resolve in a yielding background pass**, not on demand, because
  the current-page highlight needs the page of every entry rather than just the
  visible ones. The pass is guarded by `_pass` so a document swapped out
  mid-resolve abandons it.
- **`pages:rebuilt` re-reads the outline.** A page edit rebuilds the bytes
  through pdf-lib, which does not copy the outline, so the tab usually
  disappears after one. That is the honest outcome — keeping stale bookmarks
  pointing at pages that have moved or gone would be worse than losing them.
- **`.side-tab[hidden] { display: none }` is a real rule, not noise.** The
  `display: grid` on `.side-tab` beats the UA `[hidden]` rule, so hiding the tab
  needs saying twice.

Nice-to-haves left: a filter box over the tree, and remembering expansion state
across a reopen.

---

### 4. Pan tool and marquee zoom — **done**

Shipped in `src/js/tools.js` (`initPan`, `finishZoomRect`) with
`RP.viewer.zoomToRect` doing the geometry, and two `data-tool` buttons sitting in
the *view* group of toolbar row 1 rather than in `#toolGroup`. `G` arms the hand,
`Z` arms marquee zoom; holding Space or dragging with the middle button pans from
any tool.

Decisions worth knowing before touching it:

- **Panning is wired on `#viewer` in the capture phase**, not alongside the
  delegated handling on `#pages`. Two reasons: a pan can start in the grey gutter
  between pages, where there is no `.page` to hit; and taking the event on the
  way down with `stopPropagation` is what stops the press underneath from *also*
  starting a markup drag, a marquee or a text selection. `onPointerDown` has a
  matching early return for the reverse case — a second pointer arriving while a
  pan is already in flight.
- **`mousedown` is refused separately from `pointerdown`.** Text selection and,
  on Windows, middle-click autoscroll are default actions of `mousedown`;
  cancelling `pointerdown` is too late for either.
- **The grab cursor is driven by a body class as well as `[data-tool]`**, because
  Space-panning happens under whatever tool is armed. `body.panning` uses
  `!important` to beat the per-layer cursors, including the text layer's `text`.
- **Marquee zoom's factor is relative to the zoom already in force.** `vpRect`
  reports CSS pixels at the current scale, so the factor compounds off
  `viewer.zoom` rather than replacing it. `zoomToRect` sets the zoom and then
  lets `revealRect` centre the rect against the rebuilt viewports.
  `test/verify.js` covers this with a stubbed viewport.
- **`finishZoomRect` drops `this.drag` before zooming**, because the relayout
  redraws every page through `drawPreview`, which would otherwise paint the
  rubber-band rectangle back onto the canvas it just cleared.
- **Tool buttons are matched by `.tbtn.tool[data-tool]`, not `#toolGroup .tool`,**
  now that two of them live outside that group. The group they are in is
  deliberately not `.tools`: that class is the tall labelled treatment used by the
  markup row.

Nice-to-haves left: kinetic/inertial panning, and a zoom-out modifier
(Alt-click) on the marquee tool.

---

### 5. Remember page, zoom and window geometry — **done**

Window bounds live in `settings.window`; per-drawing page and zoom live on the
recents entry that already declared them. A `Reopen drawings where you left them`
toggle sits under Startup in the settings modal, on by default. The optional
"reopen last session's document on launch" was **not** built — declined as
unwanted.

Decisions worth knowing before touching it:

- **Bounds are clamped into the work area of `screen.getDisplayMatching`** at
  boot. A window remembered on a monitor that has since been unplugged otherwise
  opens at coordinates nothing can reach. Size is shrunk to the display, then
  position is slid back inside it — a window that merely hangs off the bottom is
  moved, not resized.
- **`getNormalBounds`, not `getBounds`.** A maximized window must still record
  the size to restore *to*.
- **Settings are flushed synchronously on `close` and `before-quit`.**
  `saveSettings` is debounced, and both quitting and hiding to tray end in
  `close`, so the last move would otherwise be lost.
- **The maximized state is reported in `app:ready-info` as well as over
  `window:state`.** The renderer draws its own titlebar buttons, and a window
  restored maximized reached that state before anything was listening.
- **Page/zoom writes go through `recents:remember-view`, not `recents:add`.**
  They ride on every scroll and zoom step; `recents:add` would reorder the list
  and reset `openedAt` each time, shuffling the recents panel under the user.
  `rememberRecent` was also taught to carry `page`/`zoom` across, or reopening a
  drawing would forget the position it is being reopened at.
- **`restoreView` clears `fitMode` explicitly.** `setZoom` bails out early when
  the remembered zoom happens to match the fit just applied, which would leave
  fit-width armed and snap the drawing back on the next window resize.

---

### 6. Tabs — more than one document at once — **done**

Shipped as `src/js/tabs.js` plus a per-document `RP.createStore()` and a
per-pane `RP.createViewer()`. Route **(b)**, in-app tabs, was taken over the
cheaper multi-window route: cross-referencing is the whole point of the feature,
and the v0.4 items that follow it — copy markups between drawings, pull pages in
from another open sheet, compare against a tab rather than a file — all need the
documents to share one JS heap.

What you get: tabs with unsaved dots, drag to reorder, drag across the splitter
to move a drawing between panes, middle-click to close, `Ctrl+T` / `Ctrl+W` /
`Ctrl+Tab` / `Alt+1-9`, and `Ctrl+\` to split the view side by side.

Decisions worth knowing before touching it — the long version is in `CLAUDE.md`
under "Tabs, panes and the two live pointers":

- **A tab owns a session, a pane owns a viewport.** These are separate on
  purpose: a split needs two viewports over two of the same tabs' sessions.
- **Page DOM is not kept per tab.** Switching rebuilds the pane from the
  document's pdf.js proxies, which are cached, so it is a re-layout and not a
  re-parse. Keeping every open drawing's canvases resident was measured against
  200-page sheet sets and rejected.
- **`RP.store` and `RP.viewer` are pointers.** Read them at call time; capture
  the concrete store into a local before any `await` that a tab switch could
  race, as `App.writeTo` does.
- **A background store cannot emit.** `store.emit()` is gated on being the
  focused store so a background tab cannot repaint the viewer with another
  document's markups. `markDirty` is the one deliberate exception.
- **Closing the window is the renderer's call.** Main bounces the first `close`,
  asks over `app:close-request`, and closes anyway after a timeout so a broken
  renderer cannot trap the app.

Still open, and worth doing next:

- Compare a tab against **another open tab** instead of only against a file on
  disk. The engine already takes two `PDFDocumentProxy`s; this is a picker.
- Copy/paste markups across tabs, and merging pages from an open tab, both of
  which the shared heap now makes cheap.
- Reopen the tabs you had open on the last run.

---

## Tier 2 — everyday polish (independent, any order)

### 7. View modes
Continuous scroll is the only option. Add single-page, facing/spread,
fit-visible, and a fullscreen presentation mode (F11). Lives in
`src/js/viewer.js`; `layout()` and the `IntersectionObserver` setup are the
places that assume a vertical stack.

### 8. Right-click context menu
There is no context menu on the viewer at all (only `src/js/pages.js` has one,
~line 265 — follow that pattern). Wanted: copy text, copy area as image, markup
properties, delete markup, "add note here", print.

### 9. Copy selected text
The text layer works and is selectable, but `Ctrl+C` is not wired and there is no
clipboard path for it. Small job, high daily value.

### 10. Invert / night mode
A CSS filter on `.pdf-canvas` (`invert(1) hue-rotate(180deg)`), toggled from the
toolbar and persisted in settings. Must **not** apply to `.annot-canvas` or
markup colours will invert too. Roughly ten lines.

### 11. Missing muscle-memory shortcuts
`Ctrl+P`, `Ctrl+W`, `Ctrl+T`, `Ctrl+Shift+T`, `Ctrl+G` (go to page), `Home`/`End`
(first/last page) are all unbound. See `App.wireShortcuts()`, `src/js/app.js`
~line 477. Also worth adding: a shortcuts cheat-sheet overlay on `?`.

### 12. Zoom UI
`#zoomInput` accepts a typed value but there is no preset dropdown (25/50/75/100/
125/150/200/400, Fit Width, Fit Page, Actual Size). Also no pinch-zoom / trackpad
gesture handling — only `Ctrl+wheel` (`src/js/viewer.js` ~line 47).

### 13. Go-to-page box
No direct page entry anywhere. Add "Page ▢ of N" to the toolbar or a status bar,
wired to `RP.viewer.goToPage()`.

### 14. Better recents surface
Recents only appear in the empty state (`#recentList`). Add an Open Recent menu,
a tray submenu, and pin/remove per entry.

### 15. Copy area as image
Drag a region, get a PNG on the clipboard. Extremely useful for pasting a detail
into an email or RFI. Composite `pdf-canvas` + `annot-canvas` for the region.

### 16. Status bar
There is no persistent status bar — page number, zoom, measurement scale,
selected-markup info, and document dimensions all currently have nowhere to live.

---

## Tier 3 — hardening before you ship an installer

### 17. Password-protected PDFs
`getDocument` rejects and `App.loadDocument()` (`src/js/app.js` ~line 133) shows
a generic "could not be read" toast. Catch `PasswordException`, prompt, retry.

### 18. Large / corrupt file guard rails
No limits anywhere. A 500MB scanned set will thrash. Needed: a size warning
before open, lazier text-layer building, and a cap on concurrent render tasks.
Related debt already in `PLAN.md`: virtualise the page list for 200+ pages.

### 19. Code signing
An unsigned NSIS installer gets SmartScreen-blocked. Even an inexpensive cert
materially changes the install experience. Decide before first release.

### 20. Auto-update
No `publish` config in `package.json`. electron-builder supports NSIS
differential updates. Retrofitting this alongside signing later is worse than
doing it now — decide whether you want it at all (the app is deliberately
offline; auto-update is the one exception you'd be making, so it is a real
choice, not a default).

### 21. CI and a smoke test
`test/verify.js` is good but only covers export, re-save idempotency and page
maths. Wanted: a headless Electron boot test that opens a sample drawing
(already tracked in `PLAN.md` engineering debt), plus GitHub Actions running
`node test/verify.js` on push.

---

## Notes for whoever picks these up

- Run `node test/verify.js` after touching `exporter.js`, `compare.js`,
  `store.js`, `render.js` geometry, or `pages.js`.
- Renderer modules must stay free of DOM access at load time — `verify.js` runs
  them in-process.
- All annotation geometry stays in PDF user space. Never store CSS pixels.
- New IPC = `ipcMain.handle` + a `window.rp` method + nothing else.
- Tick items off here as they land, and fold the shipped ones into `PLAN.md`.
