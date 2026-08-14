# Redline PDF

A fast, keyboard-driven PDF markup tool built for electrical drawings — highlight,
sticky notes, redlines, typewriter text, measurements and takeoff, and a revision
compare that shows only the differences that are actually real.

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

## What's new in 0.13

**Themes.** Five of them, under **Settings → Appearance**: the original dark, a
light, a warm off-white **paper**, a deep **blueprint** blue, and a **high
contrast** set built for legibility rather than looks.

**Accent colour.** The redline red is the default, not a requirement — pick
amber, green, cyan, drafting blue or violet and every armed tool, active chip
and highlight in the interface follows it. This is the *interface* accent; it
does not change the colour any markup is drawn in.

**Interface size.** Compact, normal or large. Compact gives a laptop more sheet;
large makes the toolbars and type readable on a 4K panel.

**Paper display modes** replace the old night mode — invert, greyscale, reduced
glare and contrast boost. See *Paper display* under Tools and shortcuts.

---

## What's new in 0.12

**Assembling a set.** The Pages panel's ⋯ button now holds the three operations
that act on the whole document: **insert pages from another PDF**, **split into
separate PDFs**, and **page numbering**.

Inserting copies the chosen pages in — this drawing keeps no link to the file
they came from, so moving or deleting it later changes nothing. Splitting can
cut into fixed-size files, at each page you have selected, or at ranges you type
(`1-4, 5-9, 10-`), and every part comes out a finished drawing with its markups
still editable. So does an **extract**, which used to flatten them.

**Page numbers and Bates stamps** take a prefix, a first number, zero padding, a
suffix, a corner, a type size and a margin, over a page range — so a set with an
unnumbered cover sheet works. They show on screen straight away and are stamped
into the file when you save or print, upright in the same corner however the
sheet is plotted. They belong to the document rather than being markups, so
inserting or deleting a page renumbers the rest by itself and `Ctrl+Z` takes the
whole numbering back in one step.

**Compare against an open tab.** The compare panel offers *Use an open tab…*
beside *Choose PDF…*, for the usual case where the reissue and the revision it
supersedes are both already in front of you.

**Crash recovery now covers the page arrangement**, the calibration and the
numbering, not only the markups.

---

## What's new in 0.10

**Three shapes you click out a point at a time.** Click each point;
double-click, `Enter` or right-click finishes. `Backspace` takes the last point
back and `Esc` abandons the shape without disarming the tool.

- **Polyline** (`Y`) — a redline with straight segments and bends.
- **Run length** (`D`) — the same shape, measured: every segment carries its
  own length and the run carries its total, so a conduit run with three bends
  can be checked against its parts.
- **Area** (`Q`) — a closed shape labelled with its area and its perimeter.

All three use the calibration the Measure tool sets, and an area applies it
squared — a 1:100 drawing reports m², not m. Each corner gets its own handle
afterwards, so a wall clicked in the wrong place is fixed by moving that
corner.

**An area whose outline crosses itself says so** rather than reporting a
number: a bow-tie has no area anybody would agree on, so the label reads
*outline crosses itself — no area* and shows the perimeter, which is still well
defined. It says the same in the markup list, the CSV, the report and on paper.

## What's new in 0.9

**Page layouts.** The button beside Fit page offers continuous scroll (the
default), one sheet at a time, facing spreads with the cover sheet on its own,
or spreads in a scrolling column. `Page Up` / `Page Down` move by a spread when
two sheets are facing. Each tab remembers its own layout.

**Fit visible** (`Ctrl+3`) fits the ink on the sheet rather than the sheet —
the drawing, not the plot margin.

**Presentation mode** (`F11`) goes fullscreen with one sheet fitted to the
screen and every toolbar and panel out of the way. `Esc` or `F11` puts it all
back where it was.

## What's new in 0.8

**Copy an area as a picture.** Press `S`, drag a box around a detail, and it is
on the clipboard ready to paste into an email or an RFI — with your markups on
it, and with the drawing's own stamps and comments. `Copy area as image` and
`Copy this page as image` are on the right-click menu too, and a Words
selection can be copied as a picture as well as as text, which is usually what
you want for a schedule.

The crop is redrawn rather than screenshotted, at a density picked for the
picture rather than for your current zoom, so a detail copied from a
zoomed-out view is still readable at the other end. The paper display mode
never travels into the copy — you get the real drawing.

**Password-protected drawings open — and are read-only.** A drawing that needs
a password now asks for one, with three attempts and a clear message when one
is wrong, instead of reporting the file as unreadable. You can review, search,
measure, mark up and copy from a protected drawing.

What you cannot do is save the markups back into it, or print it, or change its
pages. That is a limit of the PDF library this app writes with: it cannot
rewrite an encrypted file, and attempting it produces a damaged one. A
protected drawing therefore says so as it opens, the status-bar chip reads
`Protected — read-only`, and the refusal offers the two exports that do work —
the CSV summary and the markup report. To get markups into the drawing itself,
remove the protection first and open the unprotected copy.

**Permission flags are ignored, deliberately.** A PDF can carry an *owner*
password that grants opening but withholds printing, editing or extraction.
Redline PDF opens those drawings and does not enforce those flags: it is a
local single-user review tool, not a rights boundary, and half-enforcing them
would obstruct the person doing the work without stopping anybody else. It does
recognise those drawings as encrypted, because they cannot be written either —
which is a change, and a fix. Before 0.8 they opened silently, saved silently,
and produced a file nothing could read.

---

## What's new in 0.6

**The markup list is a punch list.** Every markup now carries a review status —
**open**, **closed** or **rejected** — and starts open. Set it from the
right-click menu on the drawing or on a list row, or from the properties
dialog; a multiple selection is closed out in one go and undoes in one step.

The Markups panel gained a status filter and its count now reads *open of
total*, so the number in the sidebar is what is left rather than what exists.
Resolved items stay visible on the sheet — a closed markup dims, a rejected one
dims and gets a rule through it — because an item you cannot find is worse than
one you cannot tell the state of.

Status travels with the drawing. It is stored in the same embedded model the
markups are, so it survives a save, a reopen and a hand-off to another Redline
user, and it appears as a column in both the CSV export and the PDF report
(which also gains a tally at the top). A saved or printed sheet shows the same
dimming and rules you were reviewing against, so a paper copy says which items
were dealt with.

Drawings marked up in 0.5 and earlier open with every markup reading as open,
which is the honest answer for a review that predates the field. Going the
other way, an older Redline build will open a 0.6 drawing, keep the statuses it
cannot display, and hand them back intact on save.

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
| **New copy** (default) | a copy you name — the first `Ctrl+S` on a drawing opens the save dialog with `drawing-markup.pdf` pre-filled | original never touched |
| **Overwrite original** | back to `drawing.pdf` | one-time `drawing.bak.pdf` (toggleable) |
| **Ask each time** | prompts on the first save of each document | remembers your answer for that document |

In new-copy mode only the *first* save of a document asks. Once you have
confirmed a name and a folder, every later `Ctrl+S` writes over that same copy
without a dialog, so repeat saves never stack files. Cancel the dialog and
nothing is written — the drawing stays unsaved. The tab itself goes on
representing the original drawing; the copy is an output of it.

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
| Extract | Toolbar ⇱ — writes the selected pages out as their own PDF, markups included and still editable |
| Delete | Toolbar 🗑 or `Del` while the panel has focus |
| Insert from another PDF | Toolbar ⋯ — choose a file, a page range and where it goes |
| Split | Toolbar ⋯ — into fixed-size files, at the selected pages, or at typed ranges |
| Page numbers | Toolbar ⋯ — prefix, first number, padding, suffix, corner, size, margin, range |

Everything above is also on the right-click menu, and everything is undoable with
`Ctrl+Z` like any other edit — page order rides in the same history as markups.
Markups follow their pages: they move when a page moves, they are copied when a
page is duplicated, and they are deleted with the page (you get a warning first if
that page carries any).

Nothing is written to disk until you save. Page edits mark the document dirty and
go out through the normal save pipeline, so your save-mode choice still applies.
Extract and split are the exceptions — they ask where the new files go and write
immediately, leaving the document you are working on alone.

Pages inserted from another PDF are **copied**, not linked. Once they are in,
this drawing no longer depends on the file they came from. That file is held in
memory for as long as this drawing is open, which is what lets `Ctrl+Z` and
`Ctrl+Y` take the insert out and put it back.

Rotating a page turns the page itself, so the rotation is in the saved file and any
viewer shows it. That is different from the toolbar's rotate button, which only
turns your view.

---

## Revision compare

`Compare` in the toolbar, or the compare tab in the sidebar. Pick the baseline
(older) revision — **Choose PDF…** for a file on disk, or **Use an open tab…**
for a drawing already open in another tab. The drawing you have open in front of
you is the current one.

A baseline taken from a tab is read as that drawing stands *now*, without this
app's markups on it, so a comparison says what changed on the sheet rather than
what somebody has written on it since.

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
| `C` | Revision cloud | | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Fit width / page / visible |
| `T` | Typewriter text | | `Ctrl` + wheel | Zoom at cursor |
| `O` | Callout | | `Ctrl+A` | Select all on page |
| `M` | Measure | | `Del` | Delete selection |
| `Y` | Polyline | | `Esc` | Abandon the shape, or deselect |
| `D` | Run length (measured, with bends) | | `Space` + drag | Pan, from any tool |
| `Q` | Area and perimeter | | `Enter` | Finish the shape being drawn |
| `G` | Pan (hand) | | `Backspace` | Undo the last point of a shape |
| `Z` | Marquee zoom | | | |
| `S` | Copy an area as a picture | | | |

| Tabs | | | Getting around | |
|---|---|---|---|---|
| `Ctrl+T` | Open another drawing | | `Ctrl+G` | Go to page |
| `Ctrl+W` | Close this drawing | | `Home` / `End` | First / last page |
| `Ctrl+Shift+T` | Reopen the tab you closed | | `Page Up` / `Page Down` | Previous / next sheet or spread |
| `Ctrl+\\` | Split / rejoin the view | | `←` / `→` | Previous / next sheet |
| | | | `↑` / `↓` | Up / down the sheet, turning over at the edge |
| | | | `F11` | Presentation mode |
| | | | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste markups |
| | | | `Ctrl+Shift+N` | Cycle paper display |
| `Ctrl+Tab` | Next tab | | `?` | Show every shortcut |
| `Alt+1`…`Alt+9` | Jump to a tab | | `Ctrl+Shift+D` | Diagnostics |

Press **`?`** at any time for the full list, grouped by what you are trying to do.

**Right-click anywhere on a drawing** for copy text, copy an area or the page as
an image, markup properties, copy/cut/paste markups, delete, "add note here" and
print. Right-click a page thumbnail for the page operations.

**Copy and paste markups.** `Ctrl+C` copies whatever markups are selected,
`Ctrl+X` cuts them, and `Ctrl+V` drops them **under the pointer** — so stamping
your initials, a *verify on site* or the same revision cloud in six places is
copy once, then point and paste. It works across sheets and across open
drawings; the pasted markups arrive selected, so nudging them into place is one
drag; and the copy stays on the clipboard, so the next stamp needs no re-copy.
Pasting into anything outside Redline PDF still gives you the markups' readings
as text, one per line, for an email or an RFI.

**Group markups.** Select two or more on a sheet and press **`Ctrl+Shift+G`**,
or pick *Group* from the right-click menu. From then on they behave as one
thing: clicking any of them selects all of them, they move together, they take a
colour or a line weight together, and they copy, paste and delete together. The
group gets a single frame with eight handles — drag one and everything inside
scales with it, keeping its arrangement. `Ctrl+Shift+U` breaks it up again.

A group lives on one sheet, which is what lets it be dragged safely; grouping a
selection that spans sheets is refused rather than attempted. Grouping a
selection that already contains groups makes one new group of the lot rather
than nesting them. Copying a group and pasting it gives you a *separate* group,
so the copy and the original never move together — and copying only part of one
gives you loose markups. Delete all but one member and the survivor stops being
a group of one. Grouping is one `Ctrl+Z`, and it is stored in the drawing, so it
survives saving and re-opening.

**Arrange several markups.** Select two or more on a sheet and right-click:

| | |
|---|---|
| Align left / right / top / bottom | to the outer edge of what you selected |
| Centre horizontally / vertically | on the middle of what you selected |
| Distribute horizontally / vertically | three or more, with the gaps equalised and the outer two left alone |
| Match size | boxes, ovals, clouds, covers and callouts take the largest one's dimensions |
| Match style | colour, line weight, opacity and typography from the markup you right-clicked |

A callout lines up and resizes by its box; its arrow stays pinned to what it
points at. Each command is a single `Ctrl+Z`. The same rows are on the
right-click menu of the markup list, and they only appear when the selection is
on one sheet — arranging across sheets would move markups you cannot see.

**Selecting and copying text.** The Select tool now yields to the drawing's own
text: press on actual words and you get a normal text selection, press anywhere
else and you get the usual marquee. `Ctrl+C` copies the text selection when no
markup is selected; with markups selected it copies those instead — into the
drawing, and as text for everywhere else.

**Paper display** (the half-moon button, or `Ctrl+Shift+N` to cycle) filters the
drawing on screen without touching your markups or anything that leaves the app:

- **Invert** — the old night mode. A white E-size sheet is not a floodlight at 11pm.
- **Greyscale** — drains the drawing so a red or yellow markup stands off a busy
  multi-colour plot instead of competing with it.
- **Reduced glare** — a warm off-white instead of a full invert, for a long
  review without the disorientation of inverted linework.
- **Contrast boost** — for a faded or badly scanned sheet where the linework is
  grey mush.

Your markups are drawn on a separate canvas and keep their real colours — red
stays red. None of these reach the saved file, the print, or a copied snapshot;
they are viewing aids and nothing more.

**Zoom.** The percentage box takes a typed value, and the caret beside it drops a
list of presets (25–400%, fit width, fit page, fit visible, actual size). `Ctrl`
+ wheel zooms at the pointer; a trackpad pinch does the same, scaled by how far
you pinched rather than in fixed steps. **Fit visible** (`Ctrl+3`) fits the ink
on the sheet instead of the sheet, which on a plotted drawing means the part
with the drawing on it rather than the paper it was plotted on.

**Page layout.** The button beside Fit page picks how the sheets are arranged:
continuous scroll, one sheet at a time, facing spreads (with the cover sheet on
its own, so sheet 2 backs sheet 1), or spreads in a scrolling column. In the
one-at-a-time layouts the wheel turns the sheet once there is nothing left to
scroll, and `Page Up` / `Page Down` move by a spread rather than by a sheet when
two are facing. Each tab keeps its own layout, so a split view can show one
drawing continuously and the other a spread at a time. The arrow keys work in
every layout: `←` and `→` turn the sheet, `↑` and `↓` read up and down it and
turn over once they reach the edge of the paper.

**Presentation mode** (`F11`, or the last row of the layout menu) goes
fullscreen with one sheet fitted to the screen and every toolbar, panel and the
status bar out of the way. `Esc` or `F11` restores the layout, zoom and panels
exactly as they were — as does leaving fullscreen any other way.

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

A tool draws **one** markup and hands back to Select, so the click you make
next selects what you just drew instead of starting another one. For a run of
clouds or dimensions, **double-click the tool button** (or press its shortcut
twice) to lock it on — it's underlined while locked, and stays armed until you
pick another tool or press **Esc**.

While you're typing a text or callout, **Enter** finishes it and **Shift+Enter**
gives you a new line; **Esc** throws it away. The typography controls work
while you type, so you can change the typeface or size mid-callout and watch
the box re-fit.

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
shows the calibration; click it to reset. Run lengths and areas use the same
calibration, and an area squares it, so it reports square units.

**Takeoff:** the run length tool measures a path with bends and labels each
segment as well as the total; the area tool closes the shape and reports its
area and perimeter. Both are clicked out a point at a time — double-click,
`Enter` or right-click to finish, `Backspace` to take a point back, `Esc` to
abandon it. An outline that crosses itself reports *no area* rather than a
number, since a bow-tie has none; its perimeter is still shown.

---

## How markups are stored

Two things happen on every save:

- markups are drawn into the page content, so **any** PDF viewer shows them
- sticky notes also become real PDF `/Text` annotations, so other viewers show the
  comment popups
- the full markup model is embedded in the document catalog under `RedlineMarkup`,
  along with the object references of everything this save stamped

Page numbers are stamped the same way, from a single spec rather than one markup
per page — which is why inserting a page renumbers the rest by itself.

That last part is what makes re-editing and idempotent re-saving work. Review
status rides in the same model, so it round-trips with everything else, and so
does the page-numbering spec; the model is at version 4 as of 0.12, and a
missing status is read as *open*. An older build reading one of these files
keeps the statuses it cannot show but drops the numbering spec — the numbers
stay stamped into the pages either way, only the ability to re-edit them here
is lost.

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
src/js/views.js    page layout modes: row grouping and fit maths (pure)
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

### Going back a version

Every tagged release keeps its installer on the
[releases page](https://github.com/Robbuie/redline-pdf/releases) — nothing is
ever deleted — so rolling back is downloading the older `Setup` exe and running
it over the top. Two things to know:

- **Your drawings are safe either way.** The markup model in a saved PDF has not
  changed since 0.14, so a drawing marked up on a newer build opens, edits and
  re-saves on an older one. Settings and recents are shared between versions and
  survive the swap.
- **The app will offer to update you again** at the next launch. Take *Skip this
  version* on the prompt, or turn the startup check off in Settings → Updates,
  or it will keep asking.

The portable exe on the same release is the other option: it never
auto-updates, installs nothing, and reverting is deleting the file.

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
- **Encrypted PDFs are read-only, whichever kind of password they carry.** They
  open — with a prompt for a user password, without one for an owner password —
  and can be reviewed, searched, measured, marked up and copied from, but they
  cannot be saved, printed or re-paginated. `pdf-lib` cannot rewrite an
  encrypted file: it neither decrypts the content streams nor drops the
  encryption dictionary, so what it writes still demands a password and no
  longer matches it. Markups go out as a CSV or a report instead. Permission
  flags on an owner-password file are not enforced.
- A page edit rebuilds the document in memory, which takes a moment on very large
  sheet sets — the status bar says when it is working.
- On a large-format sheet the drawing is redrawn at full resolution a moment
  after you stop scrolling or zooming, not while you are still moving. There is
  a hard limit on how large a single bitmap the browser will hand over, and an
  ANSI E sheet at 400% is several times past it, so what is on screen mid-scroll
  is the whole sheet at whatever resolution did fit — slightly soft, and it
  sharpens when you stop. Nothing about this reaches what is saved, printed or
  copied out.
- Crash recovery covers the markups, the page arrangement, the calibration and
  the page numbering — but **not** pages inserted from another PDF. Those pages
  cannot be rebuilt without the files they came from, and the app does not copy
  other people's drawings into its own settings folder. A set assembled that way
  is offered back with its markups and the pages as they are on disk, rather
  than being offered back incomplete.
- Page numbering is one run per document. A set that needs both a drawing number
  and a separate Bates stamp needs two, which is not supported yet.
- Annotations that came with the file are shown, not edited. You can read another
  reviewer's comment and follow their links; you cannot reply to one or delete
  it. Form fields display their values but are not fillable — typing into one
  would be thrown away on save, so the app does not pretend otherwise.
