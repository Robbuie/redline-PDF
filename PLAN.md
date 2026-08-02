# Roadmap

## Done — v0.4 (in progress)

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

## Next — v0.4

**View modes** *(the one architectural item left in this batch)*
Continuous scroll is still the only layout. Wanted: single-page, facing/spread
with a cover page on its own, fit-visible, and a fullscreen presentation mode on
`F11`. `viewer.js` `layout()` and the `IntersectionObserver` setup both assume a
single vertical stack of pages, so `layout()` has to become row-based and the
observer has to observe rows rather than pages.

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
- Polyline and polygon tools; area and perimeter measurement with the same
  calibration
- Continuous/chained dimensions
- Group and align markups; copy/paste, including across pages and documents
- Markup layers with show/hide, so trade markups can be toggled independently

**Review workflow**
- Status on each markup (open / closed / rejected) with a filter, so the markup
  list works as a real punch list
- Import/export a markup-only file (`.rpmk`) to send comments without the drawing
- Merge two reviewers' markup files onto the same drawing

## Later — v0.4+

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
