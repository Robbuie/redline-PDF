# Roadmap

## Done — v0.11

- **A markup clipboard.** Copy, cut and paste markups across sheets and across
  open drawings, pasting **under the pointer** so stamping the same markup in
  several places needs no drag after each one. Deliberately an in-app buffer:
  copying markups already wrote their readings to the Windows clipboard for an
  email or an RFI, and `RP.edit.copy` now fills both so neither use loses
- **Arrange a selection** — align six ways, distribute on either axis, match
  size, match style. The geometry is pure (`alignOffsets`, `distributeOffsets`,
  `sizeTargets`: boxes in, offsets out) because PDF space has y pointing *up*,
  which makes "align top" a maximum and is not a thing a screenshot settles
- Every command in `edit.js` is one undo step and one repaint, and one that
  changed nothing pops its own checkpoint back off. `store.addMany` is the same
  contract on the insert side
- **The arrow keys move around the drawing** — `←`/`→` turn the sheet, `↑`/`↓`
  read down it and turn over at the edge of the paper. Nothing focuses
  `.viewer`, so the browser's own arrow scrolling never fired and the step is
  issued by hand through `RP.viewer.nudgeScroll`
- Navigation keys no longer reach the drawing through an open dialog
- **Typewriter text starts where the I-beam said it would.** The click was being
  read as the top of the first line rather than its middle, and the inline
  editor added its own border, padding and half-leading on top — it now
  measures those back off instead of assuming them, and a callout wraps in the
  editor where it wraps on the sheet at every zoom

## Done — v0.10

- **Polyline, run length and area** — three markups on one vertex list,
  clicked out a point at a time. A run labels every segment and its total; an
  area labels its area and perimeter, applying the calibration *squared*. The
  geometry core (`RP.geom.polygonArea`, `polygonPerimeter`, `polygonCentroid`,
  `pointInPolygon`, `selfIntersects`) is pure and tested without a browser
- **A self-intersecting outline reports that it has no area**, on the sheet, in
  the list, in the CSV and on paper. The shoelace sum on a bow-tie is the
  difference of its two lobes — a plausible number, which is the dangerous kind
- `RP.tools.pending` is the app's first gesture that outlives a pointer-up.
  What it needed was not the building but the clearing: tool change,
  `doc:reset`, `tab:changed`, `pages:rebuilt`, Escape, and a refusal to extend
  onto another sheet
- `RP.render.readingLines` is the one builder behind every place a measurement
  is quoted, and `measureLabels` places the plates from it

## Done — v0.9

- **Page layouts.** Continuous, single page, facing spreads with the cover
  sheet on its own, and facing continuous. The page column is a list of *rows*
  now: `RP.views` owns the grouping and the paged/spread predicates as pure
  functions, and `viewer.js` holds the rows themselves. In the paged modes only
  the current row is in the column, which is also what makes the existing
  IntersectionObserver release the rest without a special case — so the
  observer still observes pages, not rows
- **Fit visible** — fits the ink on the sheet rather than the sheet, measured
  by rendering the page small on its own and taking the ink bounding box.
  Asynchronous, cached per page, and thrown away on rotate
- **Presentation mode** on `F11` — fullscreen, single page, fitted, chrome
  hidden by one class on `<body>`. `leave-full-screen` comes back over
  `window:state` so the OS cannot strand the app with no toolbars

## Done — v0.8

- **Copy an area as a picture** (`S`, or the right-click menu). The region is
  re-rendered from the page proxy at a density chosen for the crop rather than
  composited off the screen canvases, so a detail stays legible whatever the
  zoom was. `RP.snapshot.plan` holds the density rules; `clipboard:write-image`
  puts a real bitmap on the clipboard
- **Password-protected drawings open read-only.** Prompt with three attempts on
  the loading task, encryption detected through `getPermissions()` so
  owner-password files are caught too, and save, print and page edits refused
  with an explanation — pdf-lib cannot rewrite an encrypted PDF and fails by
  producing a damaged file rather than by throwing
- Fixed: an owner-password drawing used to open silently and save to a file
  nothing could read

## Done — v0.7

- **Auto-update** (`updater.js`) — the app's only network call, and the one
  exception to "nothing leaves the machine": one `GET` of the release feed a
  few seconds after launch, prompt before download, install queued rather than
  forced so it cannot drive through the unsaved-tab guard
- **The release pipeline itself.** electron-builder builds, `gh` publishes,
  releases go out published rather than as drafts, and no artifact name carries
  a space. Each of those was a silent failure that left the shipped updater
  reporting it could not check for updates; `release.yml` now has a tripwire for
  each. See **Releasing** in `CLAUDE.md`
- **A markup tool draws one markup and hands back to Select**, with
  double-click (or the shortcut twice) to lock it on for a run. `Enter`
  finishes a text or callout; `Shift+Enter` is the line break
- The typography controls act on the markup under an open inline editor, so
  reaching for them mid-callout restyles it instead of committing it

## Done — v0.6

- **Markup status** — open / closed / rejected on every markup, set from the
  right-click menu on the drawing or the list, or from the properties dialog;
  a multiple selection is set in one gesture and one undo step. Status filter
  and an *open of total* count in the Markups panel, a `Status` column in the
  CSV and the PDF report, and a tally in the report header
- Resolved markups dim rather than hide, and a rejected one gets a rule through
  it — on screen, in a saved file and on a print, from one shared rule in
  `render.js` that `exporter.js` also calls
- The markup list's filter, sort and status are per document now, stashed on
  the tab like search and compare

## Done — v0.5

- **An action menu on a text selection** — highlight, strike out, underline,
  cloud, box, cover, copy, copy with a page reference, turn into a callout or a
  note, or search for it. The selection is snapshotted at release, because
  opening the menu destroys the browser's own
- **A text-select tool (`X`)** — drag a box and take every word whose *centre*
  falls in it, so a schedule column you deliberately stopped short of is not
  dragged in. The selection survives the release
- **Strikeout, underline and cover** markups. The first two size their rule
  from the text rather than from `annot.width`. Cover is an opaque box and is
  not redaction
- **Typography for text markups** — typeface, size, bold and text colour, off a
  fixed list that maps onto the standard 14 fonts so nothing needs embedding
- **`Ctrl+S` no longer invents a filename.** The first copy-mode save asks where
  it goes; `savedTo` is what stops it asking twice, and a cancelled dialog
  resolves to `null` so the close guards still see an unsaved drawing

## Done — v0.4

- **Tabs.** Several drawings open at once, each with its own store, undo
  history, page order, search index, comparison and remembered view. Tab strip
  with unsaved markers, drag to reorder, `Ctrl+T`/`Ctrl+W`/`Ctrl+Tab`/`Alt+1-9`
- **Split view.** `Ctrl+\` puts two drawings side by side in resizable panes;
  drag a tab across the divider to move it. Both panes render at once
- Window close now asks about every unsaved drawing, not just the focused one
- **Text selection and copy.** The select tool yields to the text layer on a
  press over real glyphs, so words can be selected without arming the
  highlighter; `Ctrl+C` copies the selection, or the selected markups as text
- **Right-click menu on the drawing** — copy text, markup properties, delete,
  add a note here, print. One shared popup (`RP.menu`) now serves this and the
  Pages panel
- **Markup properties dialog** with the details, the style controls and the
  comment in one place
- **Night mode** (`Ctrl+Shift+N`) — a filter on `.pdf-canvas` only, so markups
  keep their colours; persisted in settings
- **Zoom presets** dropdown, and trackpad pinch scaled by delta rather than in
  fixed notches
- **Go-to-page box** in the status bar (`Ctrl+G`), `Home`/`End`, and a `?`
  shortcut cheat sheet
- **Status bar** gained the sheet size and a description of the selection
- **Recents** are now a toolbar dropdown and a tray submenu, with pin (exempt
  from the ageing cap) and remove per entry
- `Ctrl+Shift+T` reopens the tab you just closed

## Done — v0.3

- Navigation: hand tool (`G`, Space-drag, middle-drag) and marquee zoom (`Z`),
  both armed like any other tool
- Window size, position and maximized state persist across launches, clamped to
  a display that still exists; drawings reopen at the page and zoom you left
  them at, with a settings toggle

- Page manager in the Pages panel: multi-select, drag-to-reorder, insert blank,
  duplicate, rotate, extract, delete — all undoable, with markups following their
  pages
- Page structure modelled as data (`store.pageOrder`) and rebuilt from stripped
  base bytes, so a page edit never double-stamps a previously saved markup
- Per-page `/Rotate` is honoured in the viewer and thumbnails (it used to be
  flattened to zero)
- The file's *own* annotations are rendered read-only in a pdf.js annotation
  layer: working internal links, comment popups you can actually open and read,
  and form fields. External links go out through a main-process confirm dialog
  showing the resolved URL — the renderer never navigates

## Done — v0.2

- Save modes: new copy (default), overwrite original with one-time `.bak`, or ask
  per document; atomic temp-file writes
- Markups embedded in the PDF and fully re-editable on re-open; idempotent re-save
- Select tool: move, resize, recolour, restyle, delete, marquee multi-select
- True text-selection highlighting (Shift for area highlight)
- Markup list sidebar with filter, sort and jump-to
- Page thumbnails with markup counts; `Ctrl+F` document search with hit list
- Revision compare: ink masking, shift auto-alignment, tolerance dilation, speck
  filtering, clustered change regions, overlay / side-by-side / swipe, and
  "cloud changes" back onto the drawing
- Markup summary export to CSV and to a printable PDF report
- Printing with a preview window: page range, markups on/off, and actual-size
  vs. fit-to-paper (actual size is the default, so scaled drawings stay scaled)
- Recents, per-document autosave/crash recovery, optional tray-resident fast open
- Dark CAD-pro UI with a light theme, custom title bar, drag-and-drop open

## Next

`BACKLOG.md` is now empty of user-visible work, so this is where the next
thing gets picked from. It is a menu, not a queue — nothing below is chosen
yet.

**Finishing the page manager**
- Merge: pull pages in from another PDF. `store.sources` and the descriptor's
  `src` field already carry a key per source document, so this is an import
  dialog and one `ops.insert` call away
- Split a document into several files at chosen boundaries
- Page numbering / Bates stamping with prefix, start value and position
- Extract with the markup model remapped, so extracted pages stay re-editable
- Include the page order in the crash-recovery snapshot



**Stamps and signatures** *(deferred from v0.2 by choice)*
A stamp library — APPROVED, AS-BUILT, REVIEWED, FOR CONSTRUCTION, plus custom
PNG/logo stamps — and a saved signature you can drop and scale. Stamps would be
stored as embedded images so they export cleanly.

**Compare upgrades**
- Region-level classification: distinguish *moved* from *added + removed* by
  matching blob shapes between the two revisions
- Text-aware diff on vector PDFs: diff the extracted text runs as well as the ink,
  so a changed callout reports the old and new string, not just a box
- Compare against **another open tab** rather than only a file on disk — the
  engine already takes two `PDFDocumentProxy`s, so this is a picker
- Compare a page against a different page number (for re-ordered sheet sets)
- Export the comparison itself as a PDF with the change list appended

**Markup depth**
- Continuous/chained dimensions (deliberately out of scope for 25 — ship the
  shapes first)
- **Group** markups, so a set moves and styles as one thing rather than as a
  selection that has to be re-made (align, distribute and copy/paste landed in
  0.11; grouping is the part that needs a model change)
- Markup layers with show/hide, so trade markups can be toggled independently

**Review workflow**
- Import/export a markup-only file (`.rpmk`) to send comments without the drawing
- Merge two reviewers' markup files onto the same drawing

## Later

- Decrypt protected drawings (RC4, AES-128/256) in the main process so they can
  be saved rather than only reviewed. A real crypto implementation that has to
  be exactly right or it corrupts drawings silently — its own release
- OCR (Tesseract) so scanned sheets get a text layer for search and true highlight
- Sheet-set awareness: open a folder of drawings, jump between sheets, search all
- Batch operations: apply a stamp or compare a whole folder against a baseline set
- Redaction with real content removal
- Form filling and digital signature verification
- Measurement takeoff export (counts and lengths by layer) to Excel

## Engineering debt

- Move the compare pipeline into a Web Worker; large sheet sets currently block
  the UI between page steps
- Cache compare results per page instead of recomputing on navigation
- Replace snapshot undo with a command log once markup counts get into the
  thousands
- Virtualise the page list for very large documents (200+ pages)
- Add a smoke test that boots Electron headless and opens a sample drawing
