# Backlog — "daily driver" work items

Each item below is written to be **self-contained**. Open a fresh chat, paste the
one item you want to work on, and it should have enough context to start without
re-reading the whole codebase. `CLAUDE.md` covers the architecture and the
landmines; every item assumes it has been read.

**Everything in this file has shipped or been settled.** 1–16 and 22–25 are
done; 17 and 19–20 were superseded or decided against. What is left is not
user-visible: **18** (large-file guard rails, mostly overtaken by the canvas
budget and the render queue) and **21**'s headless smoke test — CI itself
landed, the boot test did not. New work is picked from `PLAN.md` now, not from
here.

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
- ~~Copy/paste markups across tabs~~ — **done** (0.11.0), as `RP.edit` and an
  in-app buffer; it works across tabs for exactly the shared-heap reason given
  above. Merging pages from an open tab is still open and still cheap.
- Reopen the tabs you had open on the last run.

---

## Tier 2 — everyday polish (independent, any order)

### 7. View modes — **done** (0.9.0)

Shipped as `src/js/views.js` (`RP.views`) plus the rows in `viewer.js`:
continuous, single page, facing spreads with the cover sheet on its own, facing
continuous, Fit visible on `Ctrl+3`, and presentation mode on `F11`.

The spec above put this in `viewer.js` alone and that was half right. The
grouping, the paged/spread predicates and the fit maths came *out* into
`RP.views` as pure functions so `test/verify.js` could walk every page index in
every mode without a browser — which is what caught the off-by-one that a cover
sheet puts in `index >> 1`. Three things worth knowing before touching it:

- **The page column holds rows, not pages**, and nothing outside `RP.views` may
  divide by the spread. `rowsFor` builds the grouping, `rowOfPage` answers it
  without building; the two disagreeing is how a thumbnail click opens the
  spread next door.
- **In a paged mode only the current row is in the column**, which is what lets
  the existing IntersectionObserver release the rest with no special case — the
  observer still observes pages. But the hidden rows are `display: none`, so
  `pageTops` stops being sorted and both `pageIndexAt` and `pageAt` need their
  guards.
- **Presentation mode is one class on `<body>`**, not each panel hiding itself,
  and `leave-full-screen` comes back over `window:state` so the OS cannot
  strand the app fullscreen with no toolbars.

Nice-to-haves left: a horizontal/book scroll direction, and remembering the
layout per document rather than only per tab.

### 8. Right-click context menu — **done** (0.4.0)

Shipped through the one shared popup, `RP.menu`, which now serves the viewer,
the Pages panel and the toolbar dropdowns. Two implementations would have meant
two sets of outside-click listeners fighting over one press.

### 9. Copy selected text — **done** (0.4.0)

Shipped as `src/js/clip.js` and, later, `src/js/textsel.js`. Not the small job
the spec expected: the browser selects in *DOM order* and pdf.js emits one span
per run in content-stream order, so a copy off a drawing had to be rebuilt in
reading order rather than read off `selection.toString()`. See the sweep and
`textOf` notes in `CLAUDE.md`.

### 10. Invert / night mode — **done** (0.4.0)

Ten lines, as predicted, and `test/verify.js` asserts the rule does not name
`.annot-canvas`.

### 11. Missing muscle-memory shortcuts — **done** (0.4.0)
All bound in `App.wireShortcuts()`, and the `?` cheat sheet is `src/js/keys.js`
— documentation, not wiring, so a new shortcut has to be added in both places.

### 12. Zoom UI — **done** (0.4.0)

Preset dropdown, and trackpad pinch scaled by delta rather than in fixed
notches. Fit visible joined the tick list in 0.9.0.

### 13. Go-to-page box — **done** (0.4.0)

In the status bar, on `Ctrl+G`, with `Home`/`End`. `goToPage` clamps to
`maxScrollTop()` and schedules `confirmLanding` — see `CLAUDE.md`; a landing
that is a whole page out is a real bug this app had.

### 14. Better recents surface — **done** (0.4.0)

Toolbar dropdown and tray submenu, with pin (exempt from the ageing cap) and
remove per entry. Anything persisting a view goes through
`recents:remember-view`, never `recents:add`.

### 15. Copy area as image — **done** (0.8.0)

Shipped as `src/js/snapshot.js` (`RP.snapshot`) plus a `snapshot` tool on the
`S` key, two rows on the viewer context menu, and one in the text-selection
action menu. New IPC `clipboard:write-image`, which puts a real bitmap on the
clipboard through `nativeImage` — writing a data URL as *text* is the naive
version and it pastes into an email as gibberish.

**The spec above says composite the two canvases. That was the wrong call and
the code deliberately does not do it.** The screen canvas is a raster at
whatever zoom you happen to be at, so a detail copied at fit-width on an E-size
sheet lands at roughly one device pixel per three PDF points — unreadable, and
unreadable for a reason nobody can see from the result. The region is instead
re-rendered from the page proxy at a density chosen for the crop, via pdf.js's
`transform` parameter so only the crop is rasterised rather than the whole
sheet at 4x. Three things fell out of that and all three are load-bearing:

- **Density is `plan()`, and it is pure.** Target 2x, floored at the current
  zoom so somebody who zoomed to 400% for a detail gets it at 400%, capped at
  24 megapixels because a canvas Chromium refuses to allocate comes back
  *blank* rather than as an error. `test/verify.js` covers all three rules.
- **No `annotationCanvasMap`,** unlike `viewer.renderPage`. The map exists to
  hand stamps and some free text to a live annotation layer; a crop has none,
  so passing one diverts those marks into canvases nothing reads and a stamped
  sheet copies without its stamp.
- **Night mode cannot travel.** It is a CSS filter on `.pdf-canvas` and a fresh
  render never sees it, so the copy is always the real drawing. Compositing
  would have made this a question; re-rendering makes it impossible.

Nice-to-haves left: "save area as PNG…" beside the copy, and a copy at a chosen
scale for people pasting into a fixed-width template.

### 16. Status bar — **done** (0.4.0)

Page number, zoom, measurement scale, sheet size and a description of the
selection. It has since become where the save-mode chip lives, and where the
layout is named when it is not the default.

---

## Tier 3 — hardening before you ship an installer

### 17. Password-protected PDFs — **superseded by 24**
`getDocument` rejects and `App.loadDocument()` (`src/js/app.js` ~line 133) shows
a generic "could not be read" toast. Catch `PasswordException`, prompt, retry.
Written up properly as item **24** below; work from that one.

### 18. Large / corrupt file guard rails
No limits anywhere. A 500MB scanned set will thrash. Needed: a size warning
before open, lazier text-layer building, and a cap on concurrent render tasks.
Related debt already in `PLAN.md`: virtualise the page list for 200+ pages.

### 19. Code signing — **decided: no**, deliberately

Builds are unsigned. This is a personal tool and a certificate is not worth
buying for it. Two consequences kept in mind: SmartScreen warns on the first
manually downloaded installer (updates fetched by electron-updater carry no
Mark-of-the-Web and install quietly), and electron-updater has no publisher
signature to check, so the trust boundary is HTTPS to github.com. Azure Trusted
Signing at ~$10/month is the upgrade path if this ever goes to anyone else's
machine.

### 20. Auto-update — **done** (0.7.x)

`updater.js` in the main process, deliberately kept in one file with the
reasoning at the top: one `GET` of the release feed a few seconds after launch,
only when `settings.autoUpdate` is on, nothing downloaded without a prompt,
nothing sent outward. Install is queued rather than forced, because
`quitAndInstall` drives straight through the renderer's unsaved-tab guard.

It took three releases to actually work and none of the failures were loud —
draft releases, a racing publisher, and a space in the artifact name. All three
are written up under **Releasing** in `CLAUDE.md`, along with the tripwires in
`release.yml` that now make each of them a red run.

### 21. CI and a smoke test — **half done**

`verify.yml` runs `node test/verify.js` on every push and `release.yml` re-runs
it before building, so the CI half landed. **The headless Electron boot test did
not** — still tracked in `PLAN.md` engineering debt. `test/verify.js` has grown
well past export and page maths (rotation, canvas budget, encryption fixtures,
text sweeps, layer transforms) but everything in it runs the renderer sources
in-process against stubs; nothing yet proves the app *boots*.

---

## Tier 4 — picked for v0.6

Chosen after the first real day of use. **22** is a papercut found in anger and
should go first; it is the smallest of the four. The rest are independent.
**22 shipped in 0.5.1**, **23 in 0.6.0** and **24 in 0.8.0**; 25 is the one
still open.

---

### 22. `Ctrl+S` invents a filename nobody approved — **done** (0.5.1)

**The complaint.** Saving writes `<drawing>-markup.pdf` next to the original
without ever asking, even when the user did not choose "save as a new file".

**What is actually happening.** This is the default behaviour, not a crash.
`DEFAULT_SETTINGS.saveMode` is `'copy'` (`main.js` ~line 56, mirrored in
`FALLBACK_SETTINGS()` at the bottom of `src/js/app.js`), and in copy mode
`App.resolveTarget()` (`src/js/app.js` ~line 327) ends with:

```js
return { path: store.savedTo || this.defaultCopyPath(), backup: false };
```

`defaultCopyPath()` appends `-markup` to the stem and returns it. No dialog is
shown on the *first* save, so the app picks a filename and a folder on the
user's behalf and only mentions it afterwards, in the success toast. The
`Save → new copy` chip in the status bar (`#stSaveMode`) is the only thing
advertising the mode, and it reads as a label rather than a control.

**What to build.** The first copy-mode save of a document opens the save dialog
with `defaultCopyPath()` pre-filled; the user confirms or changes it. Every
later save of that document writes to the confirmed path silently — repeat saves
must not re-prompt, and must not stack files. `store.savedTo` already exists to
carry that decision, so the change is roughly: when `mode === 'copy'` and
`!store.savedTo`, go through `pickSavePath()` and return `null` if the user
cancels. `App.save()` already treats a null target as "did not save" and returns
`false`, which is what the tab-close and window-close guards read.

Also worth doing while in there, all small:

- Make the `#stSaveMode` chip look clickable — it already cycles on click via
  `cycleSaveMode()`, and nothing says so. A cursor and a tooltip is enough.
- `cycleSaveMode()` clears `RP.store.saveModeDecided` for the *focused* store
  only. With tabs, every open store should be cleared, or a background drawing
  keeps honouring a mode the user has since changed.
- A drawing whose markups have been saved to a copy still has `docPath` pointing
  at the original. Decide deliberately whether the tab now represents the copy
  or the original — the title bar, the recents entry and the next save all read
  differently depending on the answer. Current behaviour keeps the original,
  which is defensible; it just needs to be a decision rather than an accident.

**Do not** change the default to `'overwrite'` as part of this. An overwrite is
destructive and the `.bak` safety net only fires once, on the first overwrite of
a given file.

**Acceptance.** Open a drawing, mark it up, `Ctrl+S` → a dialog appears with the
`-markup.pdf` name pre-filled. Accept it. Mark up more, `Ctrl+S` → no dialog,
saves over the same copy, toast names it. Cancel the first dialog → nothing is
written and the document stays dirty. Switch the chip to overwrite → `Ctrl+S`
writes over the original with a one-time `.bak`, no dialog. `node test/verify.js`
still passes.

**How it landed.** `App.resolveTarget()` now takes its store as an argument and,
in copy mode, returns `store.savedTo` when there is one and goes through
`pickSavePath()` when there is not — `null` on cancel. The `-markup` naming moved
out to `RP.copyPath()` in `util.js` so it is pure and testable. All three
side-items were done: the chip got a caret, a press state and a tooltip naming
the cycle; `clearSaveModeDecisions()` walks `RP.tabs.all()` instead of touching
only the focused store; and keeping `docPath` on the original is now written down
as a decision in `CLAUDE.md`, with the reasoning that an overwrite-mode save
after a copy must still mean the original. `test/verify.js` gained a
`Save targets` section — it loads `app.js` in-process and drives `resolveTarget`
against a stubbed dialog, so the "asks once, never twice" contract is covered
rather than asserted in a comment.

---

### 23. Markup status — turn the markup list into a punch list — **done** (0.6.0)

**Why.** A markup currently has a comment and nothing else. A review that gets
handed back needs to say which items are still open, which were resolved and
which were rejected — that is the difference between "some redlines" and a
document somebody can work through.

**The model.** Add `status` to the annotation, one of `'open'`, `'closed'`,
`'rejected'`, defaulting to `'open'` when absent. Set it through
`RP.store.checkpoint()` then a mutation then `store.touch(annot)`, like every
other property edit.

`store.serialize()` (`src/js/store.js` ~line 302) already writes `version: 2`.
Bump it to 3 and make sure `store.load()` (~line 143) treats a missing `status`
as `'open'`, so drawings saved by 0.5 keep opening. **The reverse matters too:**
0.5 will happily open a 0.6 file and silently drop the field on the next save.
That is acceptable, but note it in `CHANGELOG.md` rather than discovering it.

**The UI.**

- **Markup list** (`src/js/sidebar.js`): a status filter alongside the existing
  `#markupFilter` and `#markupSort`, and a status dot on each row. The filter
  state lives on the module the way `this.filter` and `this.sort` do at lines
  9–10 — which means it is per-document state and needs adding to the
  `stash()`/`unstash()` pair in `RP.tabs`, or switching tabs will carry one
  drawing's filter onto another's list. Fold `status` into `describe()` (~line
  49) so the text filter can match on it.
- **Properties dialog** (`src/js/props.js`): a status control in the same
  section pattern as the existing fields.
- **Right-click on a markup**: set status directly, through `RP.menu` — the one
  popup menu. Do not build a second.
- **Status bar**: the selection description already exists; "3 open, 1 closed"
  for a multi-select is a natural fit.

**Rendering.** Resolved markups should be visually distinguishable without
becoming invisible. Suggested: closed draws at reduced opacity, rejected gets a
strike through its own bounding box. Whatever you pick, `RP.render` and
`RP.exporter` must agree — they are the two halves that drift.

**Export.** Add a `Status` column to the CSV header in `src/js/exporter.js`
(~line 523) and to the PDF report. Group the report by status if it is cheap.

**Open question worth deciding, not guessing.** Should status be embedded in the
`RedlineMarkup` catalog entry (so it round-trips through a save and another
Redline user sees it) or held only in the app? Embedded is the obvious answer
and costs nothing, since the model is already serialised there — just confirm
re-save stays idempotent afterwards.

**Acceptance.** Set a markup closed, save, reopen → still closed. Filter to
open-only → list narrows, page canvases unaffected. Export CSV → status column
present. Open a 0.5-saved drawing → every markup reads open. Switch tabs with a
filter active → the filter does not leak. `node test/verify.js` passes.

**How it landed.** `RP.STATUSES` / `RP.STATUS_LABELS` / `RP.statusOf` in
`store.js`, with `store.setStatus(ids, status)` checkpointing once for a whole
selection and `store.statusCounts()` feeding the tallies. `serialize()` is at
version 3.

Four decisions worth knowing, all now in `CLAUDE.md`:

- **Reads normalise, writes refuse.** `statusOf` coerces a missing or unknown
  status to `'open'` so the markup still draws and still lists; `setStatus`
  returns 0 rather than coercing, because a bad write coerced to `'open'` would
  silently reopen a closed item. A test asserting the opposite is what surfaced
  this — the first draft coerced on both sides.
- **The appearance is defined once.** `RP.render.statusAlpha` and
  `statusStrikeLine` (a line in PDF space) are called by the canvas *and* by
  `exporter.js`, so a printed punch list cannot disagree with the screen. Each
  case in `drawAnnotation` sets its own alpha with its own default, so the fade
  goes through a local `alpha(fallback)` helper rather than by rewriting
  `annot.opacity`.
- **Status is searchable but not in `describe()`.** The spec above suggested
  folding it in; that string is also the row's visible text and the status-bar
  line, so it was added to the filter's haystack instead. The word would
  otherwise be printed twice on screen to be typeable once. `test/verify.js`
  asserts both halves.
- **The whole markup-list state is now per document.** The spec called for
  stashing the new status filter; the text filter and the sort had the same leak
  already, so `RP.sidebar.stash()/unstash()` covers all three and `unstash`
  re-syncs the DOM controls.

Two things the spec asked for that were deliberately *not* done. The report is
**not grouped by status** — grouping would have to override the page-order sort,
and page order is how a sheet set is walked; it carries a tally at the top
instead. And the compatibility note turned out to be wrong in our favour: 0.5
does **not** drop the field, because `load` and `serialize` both copy whole
annotation objects. `test/verify.js` covers that round trip and `CHANGELOG.md`
says so.

---

### 24. Password-protected PDFs — **done** (0.8.0), but not as specified

**Read this before touching anything encrypted.** The spec below is kept
because its reasoning is sound and its warning was right; its central factual
claim was not, and the difference changed what got built.

**What the spec got wrong.** It says `ignoreEncryption: true` "does not
preserve encryption, it bypasses it: pdf-lib reads the file and writes an
**unencrypted** one", and proposes announcing that in the toast. pdf-lib does
no such thing. Tested against RC4-128, AES-256 and owner-password-only files:

- It does **not** decrypt the content streams. They are copied through still
  encrypted, so the output is corrupt — pdf.js reports
  `Unknown compression method in flate stream` on it.
- It does **not** drop the `/Encrypt` dictionary. The output still demands a
  password, over streams that no longer match the one it names.
- With object streams — qpdf's default, and common in modern protected PDFs —
  it does not even parse the file; it throws in the loader.

So there was no unencrypted output to announce. "Save it and say so" was not an
option that existed.

**What the spec got right, and understated.** It says the pdf-lib problem "is
already live" but assumed it was unreachable because nothing could open a
protected file yet. It was reachable. An *owner* password gates permissions
rather than opening, so a "no editing" client set opened with no prompt, marked
up, saved, and produced a file nothing could read — with a success toast. That
was shipped behaviour through 0.7.3.

**What landed.** A protected drawing opens read-only.

- `RP.pdfjs.attachPassword(task, ask)` wires the prompt. **`onPassword` belongs
  to the loading task, not to the `getDocument` parameters** — putting it in
  the params is the obvious guess, it is silently ignored, and the result is a
  generic `PasswordException` with no prompt ever shown. A stubbed pdf.js
  agrees with the wrong shape all day, which is why `test/fixtures` holds two
  real encrypted PDFs; they caught it within a minute of existing.
- **How an attempt ended is recorded on the task, not on the error.** pdf.js
  discards the Error handed to `updatePassword`, rejects its own internal
  capability, and that crosses the worker boundary — what reaches the caller is
  a fresh `PasswordException` with nothing of ours on it. `task.rpPassword` is
  how "backed out", "ran out of attempts" and "actually corrupt" stay three
  different messages. Attempts are capped at three in `attachPassword` rather
  than in the prompt, because a broken encryption dictionary answers
  "incorrect" to the *correct* password and would otherwise loop forever.
- **Detection is `doc.getPermissions()`, not "did we prompt".** It is null with
  no `/Encrypt` dictionary and an array of flags with one, so it catches the
  owner-password case that never prompts — the one that was corrupting files.
- `store.encrypted` gates `App.confirmWritable` (before `resolveTarget`, so the
  refusal comes before the where-to-save dialog), `RP.print.show` and
  `RP.pages.ensureBase`. All three write PDFs through pdf-lib. The refusal
  offers the CSV and the markup report, which build documents from scratch and
  are unaffected.
- The status-bar chip reads `Protected — read-only` and explains on click
  rather than cycling a save mode that cannot take effect.

**Permission flags are ignored**, as the spec suggested, and it is in
`README.md`. The presence of the encryption dictionary is what matters here,
not what it permits.

**Still open.** Making protected drawings *saveable* means decrypting them
ourselves — RC4 and AES-128/256 in the main process with Node crypto — which is
a real crypto implementation that has to be exactly right or it silently
corrupts drawings. Its own item, if it is ever wanted.

---

### 24a. The original spec, for its reasoning

Supersedes item 17. Client-issued sets are frequently protected and the app
currently gives up with a generic toast.

**Where it breaks.** `App.loadDocument()` (`src/js/app.js` ~line 183) wraps
`getDocument` in a `try`/`catch` that reports any failure as *"That file could
not be read as a PDF"*. A password-protected file lands there, so the user
cannot tell a protected drawing from a corrupt one.

**The mechanism.** pdf.js does not simply reject — it calls an `onPassword`
callback you pass in the document params, with a reason of
`PasswordResponses.NEED_PASSWORD` or `INCORRECT_PASSWORD`, and waits for you to
call it back with the password. Wire that through `RP.pdfjs.docParams()`
(`src/js/pdfjs-loader.js` ~line 93) so both the ESM and UMD paths get it —
`PasswordResponses` hangs off the library object, so reach it through
`RP.pdfjs.lib` rather than a bare global. The rejected-promise path still needs
handling for the case where the user cancels.

**Two passwords, and they are not the same thing.** A *user* password gates
opening; an *owner* password gates permissions (printing, editing, extraction)
on a file that opens fine without it. pdf.js will open an owner-password file
without asking. Decide what the app does about the permission flags: honouring
them is not required of a local tool and enforcing them badly is worse than not
enforcing them, but silently ignoring a "no printing" flag should at least be a
recorded decision. Suggested: ignore them, note it in `README.md`.

**The part that will actually bite, and it is already live.** pdf-lib is a
*second* reader of the same bytes, and every call site already passes
`{ ignoreEncryption: true }` — `exporter.js` lines 99, 110 and 200, `pages.js`
169 and 584, `print.js` 226. That flag does not preserve encryption, it bypasses
it: pdf-lib reads the file and writes an **unencrypted** one. So the save path
will not throw on a protected drawing; it will quietly hand back a copy with the
protection removed. Nothing in the UI says so today because nothing can open a
protected file yet to find out — item 24 is what makes this reachable, so it has
to be resolved as part of it rather than after. Pick one and be explicit:

- Save the copy unencrypted and say so plainly in the toast and in `README.md`
  ("markups are saved to an unprotected copy"), or
- Refuse to save a protected drawing over itself and force a new copy, or
- Re-encrypt on write, which pdf-lib does not support — so this means a
  dependency, and is almost certainly out of scope.

The first is probably right for a single-user offline tool, but it must not
happen by accident: a user who opens a protected drawing and gets back an
unprotected one without being told has been handed a compliance problem.

**Prompting.** Password entry is a renderer modal, not a native dialog — a
native `dialog.message` has no text input. Follow the existing modal pattern.
Mask the field, allow three attempts, and offer cancel. Never write the password
to `settings`, to the recents entry, or to the diagnostics log — `diag.js`
streams to `%APPDATA%/Redline PDF/redline-pdf.log`, so make sure a failure path
cannot log the parameters.

**Also:** crash-recovery snapshots and autosave key off `docPath`. A recovered
snapshot for a protected drawing will prompt for the password again on reopen,
which is correct, but check it does not throw first.

**Acceptance.** Open a user-password PDF → prompt, correct password opens it,
wrong password re-prompts with a distinguishable message, cancel returns to the
previous view with no blank tab left behind. Open a corrupt file → still the
generic message, not a password prompt. Mark up a protected drawing and save →
whatever behaviour you chose, clearly announced. `node test/verify.js` passes.

---

### 25. Polyline, area and perimeter measurement — **done** (0.10.0)

Shipped as all three: `polyline` (`Y`), `polylength` (`D`) and `area` (`Q`),
sharing one vertex list and one geometry core in `RP.geom`. The spec below was
accurate about where the work landed; four things it did not anticipate are
worth knowing, and all four are written up under **Things that will bite you**
in `CLAUDE.md`:

- **The in-progress state was the whole job.** `RP.tools.pending` is the only
  gesture in this app that outlives a pointer-up, so what matters is not
  building it but *clearing* it — tool change, `doc:reset`, `tab:changed`,
  `pages:rebuilt`, Escape, and a refusal to extend onto another sheet. A shape
  that survived a tab switch would be committed onto the drawing you moved to,
  at coordinates measured on the one you left.
- **The bow-tie question had a real answer.** The spec said decide and
  document; the decision is that a self-intersecting outline reports *no area*
  and shows its perimeter, everywhere it reports anything. The shoelace sum on
  one returns the difference of the two lobes, which looks like an answer.
- **An area applies the calibration squared** — the ratio twice and a `²` on
  the unit. Applying it once is the natural mistake, since it is the same
  field `formatLength` reads, and it under-reports by the scale factor itself.
- **One reading, quoted five ways.** `RP.render.readingLines` is the single
  builder behind the plates on the sheet, the markup list, the properties
  dialog, the CSV and the PDF report. The canvas/exporter pair drifting is the
  recurring bug here, and a takeoff is exactly the feature that cannot afford
  it.

Snapping and orthogonal constraint stayed out of scope, as written below.
Continuous chained dimensions remain open in `PLAN.md`.

**Why.** `measure` is a single two-point segment. Real takeoff is a conduit run
with bends and a room whose area you need — neither is expressible today.

**Three things, sharing one geometry core:**

1. **`polyline`** — a click-per-vertex markup, double-click or Escape to finish.
   Non-measuring; the drawing cousin of `pen`, but with straight segments and
   editable vertices.
2. **`polylength`** — the same shape, labelled with its total length through
   `store.formatLength()` (`src/js/store.js` ~line 291), which already applies
   the calibration. Segment labels as well as a total is the nicer version.
3. **`area`** — a closed polygon labelled with area *and* perimeter. Area needs
   the shoelace formula and the calibration squared; get the unit right, since
   `scale.unit` is linear (`ft`) and the label needs `ft²`.

**Where the work lands.** Follow `measure` through the codebase — it is the
model to copy, and it touches exactly the places these will:

- `src/js/render.js` — a `case` in the draw switch (`measure` is at ~line 485),
  one in the bbox switch (~line 39), one in hit-testing (~line 617), and handles
  in the switch at ~line 564. `RP.geom.distToPolyline` already exists at
  `src/js/util.js` ~line 199 and is what `pen` hit-tests with, so segment
  picking is free. Area needs a point-in-polygon test for interior hits.
- `src/js/exporter.js` — the matching `case` (measure is at ~line 384) drawing
  through pdf-lib. Canvas and exporter must produce the same figure; that pair
  drifting is a recurring bug in this codebase.
- `src/js/tools.js` — multi-click creation is genuinely new. Every existing tool
  is press-drag-release, so there is no in-progress state that survives a
  pointer-up. That state has to live somewhere that a tab switch, a tool change,
  Escape, and a document close all clear, or a half-drawn polygon leaks onto the
  next drawing. Rubber-band the pending segment through the existing preview
  path rather than adding a second one.
- Undo: `checkpoint()` once when the shape is *committed*, not per vertex.
  Per-vertex checkpoints would make Ctrl+Z walk backwards through a 30-vertex
  polygon one click at a time. Backspace removing the last vertex mid-draw is
  the right in-progress affordance.
- Points go in `annot.points` as `[[x, y], ...]` in **PDF user space**, matching
  `pen`. Never CSS pixels.

**Tests.** `test/verify.js` has a `testGeometry()` (~line 582). Add: shoelace
area against a known rectangle and a known triangle; a self-intersecting polygon
(decide and document what it reports rather than returning a plausible wrong
number); perimeter of a closed vs. open run; and area under a calibration,
confirming the unit is squared. All of it is pure maths with no DOM, which is
exactly what that harness is for.

**Deliberately out of scope:** snapping, orthogonal constraint, and continuous
chained dimensions. Ship the shapes first and see whether the drawings you
actually measure want snapping.

**Acceptance.** Draw a 3-segment run on a calibrated sheet → total length
matches the sum of its parts measured individually. Draw a rectangle with the
area tool over a known room → area matches width × height, perimeter matches.
Save, reopen → both re-editable with their vertices intact. Export CSV →
sensible values. Zoom, rotate the sheet 90°, save and reopen → geometry
unchanged. `node test/verify.js` passes.

---

## Notes for whoever picks these up

- Run `node test/verify.js` after touching `exporter.js`, `compare.js`,
  `store.js`, `render.js` geometry, or `pages.js`.
- Renderer modules must stay free of DOM access at load time — `verify.js` runs
  them in-process.
- All annotation geometry stays in PDF user space. Never store CSS pixels.
- New IPC = `ipcMain.handle` + a `window.rp` method + nothing else.
- Tick items off here as they land, and fold the shipped ones into `PLAN.md`.
