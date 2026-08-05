# Redline PDF

A fast, keyboard-driven PDF markup tool built for electrical drawings — highlight,
sticky notes, redlines, typewriter text, measurements, and a revision compare that
shows only the differences that are actually real.

Electron + PDF.js (rendering) + pdf-lib (writing markups back into the PDF).

---

## Getting started

```bash
cd C:\Users\rjokr\Projects\redline-pdf
npm install
npm start
```

Build a Windows installer:

```bash
npm run dist
```

The installer lands in `dist/`. After installing, set Redline PDF as your default
PDF handler: **Settings → Apps → Default apps → Choose defaults by file type → .pdf**.

Run the headless checks (export pipeline, compare maths, geometry):

```bash
node test/verify.js
```

---

## Updates

Redline PDF checks GitHub for a new release a few seconds after it starts, and
that is the only time it uses the network. Nothing is sent — no telemetry, no
accounts, and no drawing ever leaves the machine. A new version is offered, not
installed: you choose whether to download it, and it is applied the next time
you quit, so nothing interrupts what you are doing.

Turn the check off, or run one on demand, under **Settings → Updates**. The
tray menu has a **Check for updates…** item too.

Builds are unsigned. Windows SmartScreen will warn the first time you run a
downloaded installer — **More info → Run anyway**. Updates installed by the app
itself do not trigger it. The portable build cannot update itself; download the
new exe and replace it.

### Cutting a release

```bash
npm version patch        # bumps package.json and tags v0.3.1
git push --follow-tags
```

The tag triggers the `release` workflow: it re-runs `test/verify.js`, then
builds and publishes the installer, the portable exe and the update feed to a
GitHub release. Every push runs the headless checks on their own.

---

## What's new in 0.5

**Selecting text asks what you want to do with it.** Dragging across text with
the highlighter no longer commits a highlight the moment you let go. The
selection is captured and a menu opens over it:

| | |
|---|---|
| Highlight / Strike out / Underline | follow the words, the way a marker or a pen would |
| Cloud / Box around it | the revision-cloud idiom, sized to what you selected |
| Cover it | an opaque box — **not** redaction, see below |
| Copy text | plain, or with a `p12` page reference for a comment log |
| Callout / Sticky note with this text | pre-filled with the words you selected |
| Find this in the drawing | hands it to `Ctrl+F` |

Escape or click away and the selection is left alone — nothing is added.

**A text-select tool (`X`).** Drag a box over any part of a sheet and every
word inside it is selected. No dragging along a line, no fighting the order the
plotter happened to write the entities in — the box says what you want. The
selection stays put after you release, so `Ctrl+C` copies it and right-clicking
it opens the same menu. Escape clears it.

Text copied by either route comes out in **reading order** — rows top to
bottom, words left to right, columns kept apart — rather than in the order the
entities were plotted, which is what the browser's own selection gives you and
why copying off a drawing has always produced a jumble.

> **Cover is not redaction.** It draws an opaque box over the words. The text
> is still in the file, still selectable, still searchable and still
> extractable underneath it. Use it to tidy a print, never to hide something
> confidential.

0.5 also brings **typography for text and callout markups** — typeface, size,
bold and a separate text colour, in the toolbar and in the properties dialog
(see *Typography* further down) — and fixes three things that made rotated and
long drawings behave oddly: the text layer not turning with a plotted landscape
sheet, thumbnails opening the sheet before the one clicked, and a callout's
inline editor opening away from its box. `CHANGELOG.md` has the detail.

---

## What's new in 0.2

**Saving — you choose, and the default is safe.**
The status bar has a `Save → …` chip; click it to cycle the behaviour, or set it in
Settings.

| Mode | Ctrl+S writes | Safety net |
|---|---|---|
| **New copy** (default) | `drawing-markup.pdf` next to the original | original never touched |
| **Overwrite original** | back to `drawing.pdf` | one-time `drawing.bak.pdf` (toggleable) |
| **Ask each time** | prompts on the first save of each document | remembers your answer for that document |

Every write goes to a temp file and is renamed into place, so a crash mid-save can
never truncate a drawing.

**Markups stay editable.** Saving embeds the markup model inside the PDF. Re-open
that file in Redline PDF and every markup is live again — movable, recolourable,
deletable. Re-saving strips what the previous save stamped, so markups never
double up no matter how many times you save the same file.

**Editing after the fact.** The Select tool (`V`) moves, resizes, recolours and
deletes anything you've drawn. Drag a marquee to grab several at once, drag the
endpoint handles on lines/arrows/measurements, or drag the corner handles on
boxes, clouds and freehand strokes. Colour, width and opacity controls apply to
the current selection as well as to the next thing you draw.

**Highlighting, two ways.** Pick the highlighter (`H`) and a **Text / Area**
switch appears in the toolbar:

- **Text** (default) — drag across real text and the highlight snaps to the text
  rows, exactly like a marker. Double-click grabs a word.
- **Area** — drag a rectangle, for scanned sheets that have no text layer.

Hold **Shift** to flip modes temporarily. If you try to select text on a page
that has none, the app tells you rather than doing nothing.

**Markup list.** A live, filterable list of every markup — page, type, comment,
colour. Click to jump to it; it doubles as a punch list.

**Thumbnails and search.** A page thumbnail rail with per-page markup counts, and
`Ctrl+F` full-document search with a hit list and in-page highlighting.

**Bookmarks.** If the file has an outline — nearly every spec book and issued
drawing set does — a Bookmarks tab appears in the sidebar with the tree, page
numbers, and expand/collapse. Click an entry to jump to it, and as you scroll the
entry covering the sheet you are on highlights itself. The tab is simply absent
on a document with no outline. These are the file's own bookmarks: Redline PDF
reads them and never rewrites them.

**Somebody else's markups.** Comments, sticky notes, links and form fields that
were already in the file — from Bluebeam, Acrobat or anywhere else — show up and
work. Click a note to read the comment. Internal links jump to the right spot on
the right sheet. An external link asks first and shows you the full address it
would open before anything leaves the app. You cannot edit these, but nothing
Redline PDF does disturbs them either: they are still there, untouched, in
whatever you save.

**Revision compare.** See below — this is the big one.

**Summary export.** Send every markup to CSV (for a punch list / RFI log) or to a
printable PDF report.

**Printing.** `Ctrl+P` opens a print dialog with page range, markups on or off,
and — the one that matters — **actual size or fit to paper**. Actual size is the
default: the sheet goes to the printer exactly as it is, so a drawing at
1/4" = 1'-0" still scales off the paper. Fit to paper rescales onto Letter,
Tabloid, A3, ARCH C/D and the rest, and says so, because you cannot measure off a
fitted print. Nothing is ever printed from the on-screen canvas — the printer
gets the same vector content the file holds, at plotter resolution, whatever zoom
you happened to be at.

**Fast open.** Optional tray-resident mode keeps the app warm so double-clicking a
PDF opens near-instantly. Recents are on the start screen, and a crash-recovery
snapshot of unsaved markups is written every minute.

---

## Organising pages

The **Pages** panel is now a page manager, not just a set of thumbnails.

| Action | How |
|---|---|
| Select pages | Click; `Ctrl`+click to add one; `Shift`+click for a run |
| Reorder | Drag the thumbnails — a line shows where they will land |
| Insert a blank page | Toolbar ⊕, dropped in after the selection at the same sheet size |
| Duplicate | Toolbar ⧉ — the copy brings that page's markups with it |
| Rotate | Toolbar ↺ / ↻, in 90° steps, applied to the page itself |
| Extract | Toolbar ⇱ — writes the selected pages out as their own PDF, markups stamped in |
| Delete | Toolbar 🗑 or `Del` while the panel has focus |

Everything above is also on the right-click menu, and everything is undoable with
`Ctrl+Z` like any other edit — page order rides in the same history as markups.
Markups follow their pages: they move when a page moves, they are copied when a
page is duplicated, and they are deleted with the page (you get a warning first if
that page carries any).

Nothing is written to disk until you save. Page edits mark the document dirty and
go out through the normal save pipeline, so your save-mode choice still applies.
Extract is the exception — it asks for a filename and writes immediately, leaving
the document you are working on alone.

Rotating a page turns the page itself, so the rotation is in the saved file and any
viewer shows it. That is different from the toolbar's rotate button, which only
turns your view.

---

## Revision compare

`Compare` in the toolbar, or the compare tab in the sidebar. Pick the baseline
(older) revision; the drawing you have open is the current one.

The comparison is designed to answer *"what actually changed?"* rather than
*"which pixels differ?"*. Per page:

1. both revisions render onto the same pixel grid at 150 DPI; a baseline sheet
   that is a **different size** is fitted and centred on that grid rather than
   pinned to a corner
2. each is reduced to a binary **ink mask** (anything darker than the threshold)
3. both masks are **sanity-checked**. A render that comes back empty or solid
   black is a failure, not a result — it is retried once on a smaller grid and
   then the page is reported as *could not be compared* rather than as a sheet
   where everything changed
4. a global **plot shift is estimated and cancelled** — coarsely from the ink
   bounding boxes, which also recovers a sheet **re-plotted at a slightly
   different scale**, then finely by projection correlation
5. each mask is **dilated by the tolerance radius**, then
   `removed = baseline AND NOT dilated(current)` and
   `added = current AND NOT dilated(baseline)`, so a line that merely moved
   half a pixel cancels out completely
6. surviving pixels below the **minimum change size** are dropped (scanner specks,
   dithering, JPEG mush)
7. what's left is clustered into **labelled change regions** you can click through

Results read as: **red = removed**, **blue = added**, **light grey = unchanged
context**. The overlay paints ink only — no translucent wash over the change —
because an edited number has its old and new digits in the same pixels and any
colour fill turns that into mud. Regions are outlined and listed in the sidebar
with page and size. Three view modes: overlay, side-by-side, and a swipe slider.

**Region inspector.** Click a change — in the list or straight on the sheet — and
a panel opens under the drawing showing that patch cropped out of *both*
revisions and magnified, baseline and current beside the diff. This is how you
read a changed dimension or panel schedule figure: the two values sit side by
side instead of on top of each other. Step through every change on the sheet with
the arrows, and set the magnification or leave it on Fit.

**Cloud changes** turns every detected region into a revision cloud on your live
drawing, so the compare result becomes markup you can save and issue.

Tuning: raise the tolerance if a noisy scan still bleeds through, lower it if you
need to catch hairline changes. Raise the minimum change size to ignore small
text tweaks; lower it to catch them.

Pages that exist in only one revision are reported as whole-page added/removed.

---

## Several drawings at once

Opening a second drawing no longer closes the first — it arrives in its own tab.
The strip above the sheet shows what's open, with a dot on anything unsaved.
Drag tabs to reorder them, middle-click to close one, and press
<kbd>Ctrl</kbd>+<kbd>\\</kbd> (or the split button at the right of the strip)
to put two drawings side by side. Drag a tab across the divider to choose which
side it sits on.

Each drawing keeps its own everything — markups, undo history, page order,
measurement scale, search results, comparison, and the page and zoom you left it
at — so flipping between a plan and its riser diagram puts you back exactly
where you were on each. Dropping a PDF onto a particular pane opens it there,
and re-opening a drawing that's already up just raises its tab rather than
loading a second copy you could save over the first.

Closing the window asks about every unsaved drawing, not just the one in front.

## Tools and shortcuts

| Key | Tool | | Key | Action |
|---|---|---|---|---|
| `V` | Select / edit | | `Ctrl+O` | Open |
| `H` | Highlight (Shift flips mode) | | `Ctrl+S` | Save |
| `X` | Select text by dragging a box | | `Ctrl+Shift+S` | Save As |
| `N` | Sticky note | | `Right-click` | Act on the selection |
| `P` | Freehand redline | | `Ctrl+P` | Print |
| `L` | Line | | `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `A` | Arrow | | `Ctrl+F` | Find |
| `R` | Rectangle | | `F3` / `Shift+F3` | Next / previous hit |
| `E` | Ellipse | | `Ctrl+0` | 100% |
| `C` | Revision cloud | | `Ctrl+1` / `Ctrl+2` | Fit width / fit page |
| `T` | Typewriter text | | `Ctrl` + wheel | Zoom at cursor |
| `O` | Callout | | `Ctrl+A` | Select all on page |
| `M` | Measure | | `Del` | Delete selection |
| `G` | Pan (hand) | | `Esc` | Deselect / back to Select |
| `Z` | Marquee zoom | | `Space` + drag | Pan, from any tool |

| Tabs | | | Getting around | |
|---|---|---|---|---|
| `Ctrl+T` | Open another drawing | | `Ctrl+G` | Go to page |
| `Ctrl+W` | Close this drawing | | `Home` / `End` | First / last page |
| `Ctrl+Shift+T` | Reopen the tab you closed | | `Ctrl+C` | Copy selected text |
| `Ctrl+\\` | Split / rejoin the view | | `Ctrl+Shift+N` | Night mode |
| `Ctrl+Tab` | Next tab | | `?` | Show every shortcut |
| `Alt+1`…`Alt+9` | Jump to a tab | | `Ctrl+Shift+D` | Diagnostics |

Press **`?`** at any time for the full list, grouped by what you are trying to do.

**Right-click anywhere on a drawing** for copy text, markup properties, delete,
"add note here" and print. Right-click a page thumbnail for the page operations.

**Selecting and copying text.** The Select tool now yields to the drawing's own
text: press on actual words and you get a normal text selection, press anywhere
else and you get the usual marquee. `Ctrl+C` copies the selection — or, if
nothing is selected but markups are, copies those as text, one per line, ready
to paste into an email or an RFI.

**Night mode** (`Ctrl+Shift+N`, or the half-moon button) inverts the drawing so a
white E-size sheet is not a floodlight at 11pm. Your markups are drawn on a
separate canvas and keep their real colours — red stays red.

**Zoom.** The percentage box takes a typed value, and the caret beside it drops a
list of presets (25–400%, fit width, fit page, actual size). `Ctrl` + wheel zooms
at the pointer; a trackpad pinch does the same, scaled by how far you pinched
rather than in fixed steps.

**Open Recent** hangs off the caret next to the Open button, and off the tray
icon when Redline PDF is staying resident. Pin a drawing to keep it at the top of
the list — pinned entries never age out — or remove one you would rather not see.

**The status bar** carries the page box, the zoom, the measurement scale, the size
of the current sheet, and a description of whatever markup is selected.

**Getting around a big sheet.** Hold `Space` and drag — or drag with the middle
mouse button — to shove the drawing around without leaving the tool you're in.
`G` arms the hand permanently if you'd rather. `Z` gives you a marquee: drag a
box around a title block or a panel schedule and it fills the window; a plain
click zooms in a step on the point you clicked.

Redline PDF reopens a drawing at the page and zoom you left it at, and starts up
at the window size and position you closed it at. The first of those can be
turned off under Settings → Startup.

**Callouts** work in one gesture: press on the detail you're pointing at — that
pins the arrow — then drag away and release where you want the text box to sit.
Afterwards the two are independent: drag the box and the arrow stays pointing at
the same spot; drag the leader line to move the whole callout; drag the arrow
handle to re-aim it. The box resizes without disturbing the arrow, and grows to
fit whatever you type.

Double-click any markup to attach or edit a comment. Double-click a text or
callout markup to edit its text. Hold **Shift** while drawing to constrain lines
to 45° steps and boxes to squares.

**Typography.** With the Text or Callout tool active the toolbar gains a text
group: typeface (sans, serif or mono), size, bold, and — for callouts, whose
text sits on its own white box — the text colour. These set the style for the
next markup you draw, and restyle the current selection if you have one, the way
the colour swatches already do. The same controls sit in a markup's properties
dialog for editing one after the fact, and a callout's box regrows to fit
whenever the face or size changes. The three typefaces map onto fonts every PDF
reader already has, so a saved sheet reads the same everywhere without carrying
a font with it. A callout's colour is its box and leader; its text is coloured
separately. A typewriter note has no box, so its colour *is* its text.

**Measuring:** draw a measurement over a known distance and enter its real length
once — every measurement on that drawing then reads in real units. The status bar
shows the calibration; click it to reset.

---

## How markups are stored

Two things happen on every save:

- markups are drawn into the page content, so **any** PDF viewer shows them
- sticky notes also become real PDF `/Text` annotations, so other viewers show the
  comment popups
- the full markup model is embedded in the document catalog under `RedlineMarkup`,
  along with the object references of everything this save stamped

That last part is what makes re-editing and idempotent re-saving work.

---

## Layout

```
main.js            Electron main: windows, dialogs, file I/O, settings, tray
preload.js         the only bridge into the renderer (contextIsolation on)
src/index.html     app shell + icon sprite
src/css/app.css    dark CAD-pro theme (light theme included)
src/js/util.js     helpers, geometry, event bus
src/js/store.js    one document's annotation model and undo/redo
src/js/render.js   canvas drawing, hit testing, transforms
src/js/viewer.js   one pane's page rendering, zoom, text layer, thumbnails
src/js/tabs.js     open documents as tabs, and the panes they live in
src/js/tools.js    pointer interaction, creation and editing
src/js/search.js   text index and find
src/js/sidebar.js  panels, markup list, recents
src/js/compare.js  revision compare engine and UI
src/js/exporter.js pdf-lib export, embedded markup, CSV/PDF reports
src/js/app.js      wiring: toolbar, shortcuts, save pipeline, settings
test/verify.js     headless checks
```

## If something goes wrong

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> (or the bug icon in the title
bar) for **Diagnostics**: versions, install paths, which PDF.js flavour loaded,
and every error from this session. **Copy all** puts the lot on the clipboard.

Everything is also streamed to a log file — `Show log folder` in that panel opens
it, or find it at `%APPDATA%\Redline PDF\redline-pdf.log`.

A red banner across the top means startup hit a problem it could work around;
the app stays usable and the banner says what broke.

**"PDF engine could not be loaded"** almost always means dependencies are missing
or half-installed. Run `npm install` in the project folder and restart.

### A note on PDF.js versions

PDF.js is ESM-only from v4 onward, so the renderer is served over a privileged
`app://` scheme rather than `file://` — ES modules need a real origin. The loader
in `src/js/pdfjs-loader.js` handles both the modern ESM build and the older UMD
build, so `pdfjs-dist` can be upgraded without the app going dark.

## Known limits

- Compare works on rendered ink, so a purely colour-only change (same geometry,
  different colour) is not flagged.
- Rotated-view editing is supported, but markups are stored unrotated — rotating
  the view does not rotate existing markups relative to the sheet, which is what
  you want.
- Encrypted PDFs open read-only if the owner password blocks modification.
- A page edit rebuilds the document in memory, which takes a moment on very large
  sheet sets — the status bar says when it is working.
- Crash recovery snapshots cover markups only. If the app dies after a page edit
  but before a save, the recovered markups come back on the document as it was on
  disk, not as you had rearranged it.
- Extracted pages have their markups stamped in but not re-editable, because the
  markup model's page numbers would no longer match the smaller document.
- Annotations that came with the file are shown, not edited. You can read another
  reviewer's comment and follow their links; you cannot reply to one or delete
  it. Form fields display their values but are not fillable — typing into one
  would be thrown away on save, so the app does not pretend otherwise.
