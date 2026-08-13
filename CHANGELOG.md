# Changelog

All notable changes to Redline PDF are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — though while the
app is pre-1.0 the minor number carries features and the patch number carries
fixes.

Entries describe what changed for *the person marking up a drawing*. Rationale
a future maintainer needs lives in `CLAUDE.md`; roadmap lives in `PLAN.md` and
`BACKLOG.md`.

---

## [0.13.1] — 2026-08-12

### Fixed

- **Large-format sheets no longer go blank when you zoom in.** A big drawing —
  an E-size sheet past about 350%, or a long plot exported from a DWG or DWF in
  one continuous strip, which could go blank barely above fit-width — would
  come back as a white page with nothing to say why. The browser refuses to
  give out a picture that large and does it silently, so the app took the empty
  result for the drawing. It now works out how large a picture it can actually
  have, and draws the sheet slightly softer instead of not at all. Ordinary
  sheets are unaffected; nothing about the drawing, the markups or what gets
  saved changes.
- **A sheet that genuinely cannot be drawn now says so** instead of leaving a
  white page that looks like an empty drawing. If it happens, zooming out will
  bring the sheet back.
- **Long sessions on large sheets stay quicker.** Only the sheets close to the
  one you are on keep their full-resolution picture in memory; on drawings this
  size the previous rule held on to more than it meant to, and every page after
  that took longer to appear the further into the set you had scrolled.

## [0.13.0] — 2026-08-12

### Added

- **Themes.** *Settings → Appearance → Theme* now offers five: the original
  **Dark (CAD pro)**, **Light**, **Warm paper** (light, off-white — easier over
  a long review), **Blueprint** (deep blue chrome, so the sheet is the only
  warm thing on screen) and **High contrast**, which is an accessibility target
  rather than a style: pure white on near-black, every border a visible line.
- **Accent colour.** The redline red is now a choice, not a fixture — amber,
  field green, cyan, drafting blue and violet are the alternatives. Every
  armed tool, active chip, banner and highlight in the interface follows it.
  It changes the *interface* only; markups are drawn in the colour you picked
  for them and are untouched.
- **Interface size.** Compact, normal or large, under the same section. Compact
  gives a laptop more sheet; large makes the toolbars, labels and type readable
  on a high-DPI panel.
- **Paper display modes.** Night mode has become one of five, on the half-moon
  toolbar button (which now drops a menu) and on `Ctrl+Shift+N`, which cycles:
  - **As drawn** — no filter.
  - **Invert** — the old night mode.
  - **Greyscale** — drains the drawing so a red or yellow markup stands off a
    busy multi-colour plot instead of competing with it.
  - **Reduced glare** — a warm off-white rather than a full invert, for a long
    review without the disorientation of inverted linework.
  - **Contrast boost** — for a faded or badly scanned sheet where the linework
    has gone grey.

  All five are viewing aids and nothing more: your markups keep their real
  colours, and nothing reaches the saved file, the print or a copied snapshot.
- Keyboard focus is now visible, and every animation in the interface is
  dropped when Windows is set to reduce motion.

### Changed

- Your existing night mode setting carries across as **Invert** — nothing to
  turn back on.
- The cheat sheet (`?`) and the toolbar tooltip describe the paper display
  modes rather than night mode.

### Fixed

- Changing the theme no longer drops you out of presentation mode. It was
  rewriting every class on the page rather than the one it owned, so the
  toolbars, tab strip and status bar all came back over the drawing.

---

## [0.12.0] — 2026-08-12

### Added

- **Insert pages from another PDF.** *Pages panel → ⋯ → Insert pages from
  another PDF*, or the right-click menu on a thumbnail. Choose a file, choose a
  page range, and say where it goes — a whole issue, or just the two sheets a
  consultant reissued. The pages are *copied in*: this drawing keeps no link to
  the file they came from, so moving or deleting it later changes nothing. The
  markups already on the drawing stay on their own sheets, and `Ctrl+Z` takes
  the insert back out.

- **Split a document into several PDFs.** *Pages panel → ⋯ → Split into
  separate PDFs*. Split into fixed-size files, at each page you have selected,
  or at ranges you type (`1-4, 5-9, 10-`). Every part is a finished drawing:
  the markups on its pages are stamped into it and stay editable. The document
  you split is not changed.

- **Page numbering and Bates stamping.** *Pages panel → ⋯ → Add page numbers*.
  Prefix, first number, zero padding, suffix, corner, type size and margin, over
  a page range of your choosing — so a set with an unnumbered cover sheet works.
  The numbers appear on screen straight away and are stamped into the file when
  you save or print, upright in the same corner however the sheet is plotted.
  They are a property of the document rather than a markup, so inserting or
  deleting a page renumbers the rest by itself, and `Ctrl+Z` undoes the lot in
  one step.

- **Compare against a drawing already open in another tab.** The Compare panel
  now offers **Use an open tab…** beside **Choose PDF…**. The usual case — the
  reissue and the revision it supersedes both open in front of you — no longer
  means going back to the file picker.

### Changed

- **Extracted pages stay editable.** *Extract* used to flatten the markups into
  the new file, so a comment on an extracted sheet could never be moved or
  answered again. The extract now carries the same re-editable markups the
  drawing it came from does, renumbered onto their new page.

- **The crash-recovery snapshot now includes the page arrangement**, the
  measurement calibration and the page numbering — not just the markups. A
  session whose unsaved work was a reordered or renumbered set used to be
  offered back as "0 markups" and lost. A set assembled from other PDFs is the
  exception: those pages cannot be recovered without the files they came from,
  so the arrangement is not offered rather than being offered incomplete.

### Fixed

- **Extracting pages from a password-protected drawing now says no** instead of
  writing a file nothing can open. Same reason every other write is refused on
  one: the pages cannot be rewritten, only damaged.

- **Choosing a new comparison baseline clears the previous run's results**, so
  the change list on screen always belongs to the pair named above it.

---

## [0.11.1] — 2026-08-12

### Fixed

- **A sheet wider than the window can now be scrolled to both of its edges.**
  Zoomed in on a wide drawing, the left-hand side of the paper was simply
  unreachable — the scroll bar was already at its start while the edge of the
  sheet sat off to the left. Both edges are now inside the scroll, so a title
  block on the far right and a keyplan on the far left are equally reachable.

- **Zoom to area now lands on the area you drew, wherever it is on the sheet.**
  A box drawn at the far left or right of a wide drawing zoomed in but stopped
  short of it, for the same reason as above.

- **Zooming is smooth on large sheet sets.** A wheel or trackpad zoom was
  re-rendering every page on every step of the gesture, so each render was
  thrown away by the next one and the drawing stayed blank while you zoomed —
  worse the bigger the document. The drawing is now scaled live and re-drawn
  sharp once the zoom stops, which is a moment of softness instead of a
  stutter.

---

## [0.11.0] — 2026-08-07

### Added

- **Copy and paste markups.** `Ctrl+C` copies the selection, `Ctrl+X` cuts it,
  and `Ctrl+V` drops it **under the pointer** — so stamping your initials, a
  *verify on site*, or the same revision cloud in six places is copy once, then
  point and paste. It works across sheets and across open drawings, the pasted
  markups arrive selected so a nudge is one drag, and the buffer survives a
  paste so the next stamp needs no re-copy. `Copy`, `Cut` and `Paste here` are
  also on the right-click menu, on the drawing and on a markup-list row.

  `Ctrl+C` still copies selected *text* when no markup is selected, so the
  existing habit is unchanged.

- **Arrange a selection.** Right-click two or more markups on a sheet:

  - **Align** left, right, top, bottom, or centred on either axis — to the
    outer edge of the selection, so nothing depends on which markup you picked
    first.
  - **Distribute** three or more evenly, horizontally or vertically. The gaps
    are equalised rather than the centres, which is what "evenly" looks like
    when the markups are different sizes, and the outermost two stay put.
  - **Match size** — every box, oval, cloud, cover or callout takes the largest
    one's dimensions, growing from its own top-left rather than jumping.
  - **Match style** — colour, line weight, opacity and typography from the
    markup you right-clicked onto the rest of the selection. Geometry, text and
    review status are left alone.

  A callout is aligned and sized by its *box*; its arrow stays pinned to what
  it points at. Each command is a single `Ctrl+Z`, and one that would change
  nothing says so instead of leaving a dead undo step behind.

- **The arrow keys move around the drawing.** `←` and `→` turn to the previous
  and next sheet — or spread, when two are facing. `↑` and `↓` read up and down
  the sheet and turn over when they reach the edge of the paper, so a sheet
  taller than the window is not skipped past.

### Fixed

- **Typewriter text now starts where the cursor said it would.** The I-beam's
  hotspot is the middle of the bar, but the click was being read as the *top* of
  the first line, so text landed about half a character below where you aimed —
  and the on-screen editor added a few more pixels of its own border and padding
  on top, then snapped when you pressed `Enter`. The first line now straddles
  the point you clicked, and what you type sits exactly where it commits.

- **A callout wraps in the editor where it wraps on the sheet.** The inline
  editor was wrapping to a fixed inset while the drawing used one that scales
  with the zoom: the two agreed at 100% and diverged from there, so at high zoom
  the last word of each line escaped below the box while you typed.

- **Page and arrow keys no longer reach the drawing through an open dialog.**
  Settings, Print, the diagnostics panel, the markup properties dialog and the
  popup menu all now hold the navigation keys, instead of the sheet set moving
  behind them.

## [0.10.0] — 2026-08-05

### Added

- **Three shapes you click out a point at a time**, rather than dragging in one
  go. Click each point, and double-click, press `Enter` or right-click to
  finish. `Backspace` takes the last point back, `Esc` abandons the shape and
  leaves the tool armed for the next one.

  - **Polyline** (`Y`) — a redline with straight segments and bends, the
    drawing cousin of the pen.
  - **Run length** (`D`) — the same shape, measured. Every segment carries its
    own length and the run carries its total, so a conduit run with three bends
    can be checked against its parts without measuring them again. A segment
    too short to hold a plate is left unlabelled rather than stacked on top of
    its neighbour; the total still accounts for it.
  - **Area** (`Q`) — a closed shape labelled with its area *and* its perimeter,
    washed lightly so the drawing underneath still reads.

  All three use the calibration the Measure tool already sets, and the area
  applies it squared — a 1:100 drawing reports m², not m. Uncalibrated, they
  read in paper inches like every other measurement.

- Markups drawn this way are **selected and edited by their points**: each
  corner gets its own handle, so a room whose wall you clicked in the wrong
  place is fixed by moving that corner, not by re-drawing the shape. They
  save, reopen and re-edit like every other markup, and their readings appear
  in the markup list, the CSV and the PDF report.

### Changed

- A measured area whose outline **crosses itself** says so instead of
  reporting a number. A bow-tie has no area anybody would agree on — the
  arithmetic returns the difference of the two lobes, which looks like an
  answer — so the label reads *outline crosses itself — no area* and shows the
  perimeter, which is still well defined. It says the same thing in the markup
  list, the CSV, the report and on a printed sheet.

## [0.9.0] — 2026-08-05

### Added

- **Page layouts.** Continuous scroll is no longer the only way to read a
  drawing. The new button beside Fit page offers four:

  - **Continuous** — one column, scroll straight through the set. The default,
    and unchanged.
  - **Single page** — one sheet at a time. The wheel turns the sheet once there
    is nothing left to scroll, so a fitted drawing is not inert.
  - **Two pages** — a facing spread at a time, with the cover sheet on its own
    so sheet 2 backs sheet 1 the way the set was issued.
  - **Two pages, continuous** — spreads in one scrolling column.

  `Page Up` / `Page Down` move by a *spread* in the facing layouts, not by one
  sheet — the sheet next door is already in front of you. The layout is
  remembered per tab, so two drawings open side by side can be read
  differently.

- **Fit visible** (`Ctrl+3`, or the zoom dropdown) fits the ink on the sheet
  rather than the sheet. On a plotted drawing that is the difference between
  the border-to-border paper and the part with the drawing on it; on a scan it
  ignores the margin the sheet was scanned onto. A blank sheet, or one whose
  ink already fills it, is left at fit width rather than being fitted to
  nothing.

- **Presentation mode** (`F11`, or the bottom of the layout menu). Fullscreen,
  one sheet at a time, fitted to the screen, with both toolbars, the sidebar,
  the tab strip and the status bar out of the way. `Esc` or `F11` puts
  everything back exactly as it was, including the layout and zoom you were on
  — leaving fullscreen by any other route does the same.

### Changed

- The status bar names the layout beside the zoom when it is not the default,
  and the zoom dropdown ticks Fit visible alongside the other two fits.

## [0.8.0] — 2026-08-05

### Added

- **Copy an area of a drawing as a picture.** Press `S` or pick the new
  toolbar button, drag a box around a detail, and it goes onto the clipboard
  ready to paste into an email or an RFI. There is a `Copy area as image` row
  on the right-click menu too, and `Copy this page as image` beside it. A
  selection made with the Words tool can be copied as a picture as well as as
  text — which is usually what you want for a schedule, where pasting the
  words loses the column alignment that made them readable.

  The copy is **not** a screenshot of what is on screen. The area is redrawn at
  a density chosen for the crop, so a detail copied while you are zoomed out to
  the whole sheet is still legible at the far end — and one copied while you
  are zoomed in comes out at least as sharp as it looked. Your markups are in
  the picture, the drawing's own stamps and comments are in it, and night mode
  is not: you always get the real drawing rather than the inverted one.

- **Password-protected drawings open.** A drawing that needs a password now
  asks for one instead of reporting that the file could not be read. You get
  three attempts, a wrong one says so, and backing out leaves you where you
  were rather than with an empty tab. The same prompt appears when you pick a
  protected file as a comparison baseline.

### Changed

- **A protected drawing is read-only, and says so before you start.** You can
  review it, search it, measure on it, copy text and pictures out of it and
  mark it up — but the markups cannot be saved back into it, and a protected
  drawing now says that when it opens rather than when you first press
  `Ctrl+S`. The status-bar chip reads `Protected — read-only`, and printing and
  page edits are blocked for the same reason. Markups on a protected drawing
  can still go out as a CSV or as a markup report, and the refusal offers both.

  This is a real limit rather than a caution: the library this app writes PDFs
  with cannot rewrite an encrypted one. To save markups into the drawing
  itself, remove the protection first and open the unprotected copy.

### Fixed

- **A drawing protected against editing no longer saves to a damaged file.**
  Not every protected PDF asks for a password — a drawing issued "no editing"
  or "no printing" carries an *owner* password, which gates changes rather than
  opening, so it opened like any other sheet. Marking one up and saving
  produced a file that no viewer could open, and the app reported it as saved.
  Anyone who did that got no warning at the time and a broken file afterwards.
  Those drawings are now recognised as protected on the way in and handled like
  any other protected drawing. **If you have saved a marked-up copy of a
  protected drawing with an earlier version, check that it still opens.**

---

## [0.7.3] — 2026-08-05

### Fixed

- **The update downloads now.** 0.7.2 put a correct `latest.yml` on the
  release, and the installer it named was not there — the app found the
  update, went to fetch it and got a 404. The product name has a space in it,
  and the two ends of the pipe disagreed about what to do with it:
  electron-builder writes the download name with the spaces turned into
  hyphens, GitHub turns them into dots when it takes the upload. The installer
  and the portable exe are now built with names that have no spaces in them at
  all, so there is nothing to disagree about, and the release build checks that
  every file `latest.yml` names is really there before it publishes.

---

## [0.7.2] — 2026-08-05

### Fixed

- **The release actually carries the installer now.** 0.7.1 fixed the drafts
  but the release it produced held nothing except a `.blockmap` — the two
  installers and `latest.yml` went missing, and the build reported success
  the whole time. electron-builder runs one publisher per build target, and
  the two Windows targets raced each other to create the same release; the
  loser's uploads went to a release that no longer existed. Releases are now
  built first and uploaded once, in a single step, and a build that fails to
  produce `latest.yml` stops rather than shipping a release nothing can
  update to.

---

## [0.7.1] — 2026-08-05

### Fixed

- **"Check for updates" now finds the update.** Every release the build
  workflow has ever made was published as a *draft*, which is
  electron-builder's default and not something the workflow said out loud. A
  draft has no `latest.yml` anyone can download and does not count as the
  latest release, so the shipped updater asked GitHub for the newest published
  version, was told there wasn't one, and reported that it could not check —
  on a repository whose releases page looked perfectly full. Releases are now
  published outright.

---

## [0.7.0] — 2026-08-05

### Changed

- **`Enter` now finishes a typewriter text or a callout**, instead of only
  adding a line to it. `Shift+Enter` gives the line break. Most callouts on a
  drawing are one line, and ending each one meant clicking away onto blank
  paper — which, with a text tool still armed, started the next markup where
  you clicked. `Ctrl+Enter` still commits, and `Esc` still cancels.
- **A markup tool now draws one markup and hands back to Select.** Previously
  it stayed armed, so the click meant to select the callout you had just drawn
  started another one on top of it. A drag too small to become a markup leaves
  the tool armed, so a slipped click costs nothing.
- **Double-click a tool button to lock it on** for a run of clouds, dimensions
  or notes — it then stays armed until you pick another tool or press `Esc`. A
  locked tool is underlined on the toolbar. Pressing the tool's shortcut key
  twice does the same thing, and pressing it again unlocks.

### Added

- **The typeface, size, bold and text colour controls now work while you are
  typing.** Reaching for them mid-callout used to commit the markup and
  restyle nothing. The box re-fits to the new face as you change it, and the
  controls stay on the toolbar for the whole edit — including when you
  double-click a finished callout to re-word it.

## [0.6.0] — 2026-08-05

### Added

- **A review status on every markup — open, closed or rejected.** New markups
  start open. Set the status by right-clicking a markup on the drawing or a row
  in the Markups panel, or from the properties dialog. A multiple selection is
  set in one go, and `Ctrl+Z` steps back over the whole thing rather than one
  markup at a time.
- **A status filter in the Markups panel**, and a count that now reads *open of
  total* — the number in the sidebar is what is left to deal with, not how many
  markups the drawing has. Typing a status into the filter box matches on it
  too. The filter, the sort and the text filter are now remembered per drawing,
  so switching tabs no longer carries one drawing's filter onto another's list.
- **Resolved markups are distinguishable on the sheet.** A closed markup draws
  dimmed; a rejected one draws dimmed with a rule through it. Neither is
  hidden — a punch-list item you cannot find is worse than one you cannot tell
  the state of.
- **Status in both exports.** The CSV gains a `Status` column and the PDF
  report gains a status column plus a tally at the top of the first page. The
  report is still ordered by page, because that is how a sheet set is walked.
- The status-bar line for a multiple selection now reads "6 markups selected —
  4 open, 2 closed" rather than just the count.

### Changed

- **A saved or printed drawing carries the status treatment.** Stamped markups
  are dimmed and ruled the same way they are on screen, so a paper copy or a
  PDF handed to somebody without Redline still says which items were dealt
  with.
- The embedded markup model is now **version 3**. The bump records that
  `status` exists; nothing reads it to decide how to parse, because a missing
  status is read as *open* regardless.

### Fixed

- **Reopening a drawing no longer shows every markup twice.** A save writes the
  markups into the file two ways over: drawn into the page so that anyone
  without Redline still sees them, and stored as the editable model so that you
  can go on working. Opening the file drew both, so each markup appeared once
  as itself and once baked into the drawing — where it could not be selected,
  moved or deleted, and where it stayed put until the next save even after you
  deleted the live one. The baked copy is now lifted back out as the file
  opens, and what you see is the markups and nothing else.
- **Typed text and callout text no longer save on their side.** A landscape
  sheet that is stored upright and turned by the file (which is how most
  drawings are plotted) had its text written into the page in the *stored*
  orientation, so a note you typed across the sheet came out reading up the
  side of it. Together with the duplicate above, that is what made a saved
  markup look like it had been stamped twice, once wrong. Text, callout text
  and measurement labels now read horizontally on paper at every rotation, in
  the place they were put on screen.
- **Switching the save mode to *new copy* after an overwrite asks where the
  copy goes** instead of silently writing over the drawing. An overwrite was
  recording the original as though it were the copy it had been given.

### Compatibility

- **Drawings marked up in 0.5 and earlier open with every markup reading as
  open.** That is the honest reading of a review that predates the field.
- **An older Redline build will not lose the statuses it cannot show.** 0.5
  copies whole markup objects both when loading and when saving, so `status`
  rides through its round trip untouched; the only thing it changes is the
  version number, which walks back to 2. (The backlog assumed the field would
  be dropped — it is not, and `test/verify.js` now covers the round trip.)
- A status written by a *newer* build than this one is read as open rather than
  discarded, so a markup can never become invisible or unlistable because of a
  value this version has not heard of.

---

## [0.5.1] — 2026-08-04

### Changed

- **`Ctrl+S` no longer invents a filename.** In the default *new copy* mode the
  first save of a drawing now opens the save dialog with `drawing-markup.pdf`
  pre-filled, so the name and the folder are yours rather than the app's.
  Confirm it once and every later `Ctrl+S` writes over that same copy silently
  — repeat saves neither re-prompt nor stack a second file. Cancelling the
  dialog writes nothing and leaves the drawing unsaved, which the tab-close and
  window-close guards see. Overwrite mode is unchanged: still no dialog, still
  the one-time `.bak`.
- **The `Save → …` chip in the status bar looks like the control it is** — a
  dropdown caret, a press state, and a tooltip that names the three modes it
  cycles through.

### Fixed

- Changing the save mode now clears the remembered "ask each time" answer on
  **every** open document, not just the one in front. A drawing in a background
  tab could otherwise keep saving the way you had answered for it earlier,
  after you had changed the mode.
- A save that resolves its target behind a dialog can no longer land on the
  wrong drawing if you switch tabs while that dialog is up.

---

## [0.5.0] — 2026-08-04

Everything since the 0.4.1 release. Five separate pieces of work landed in
between without a version of their own, so they are gathered here.

### Added

- **An action menu on text selection.** Selecting text with the highlight tool
  no longer commits a highlight the instant you let go. The selection is
  captured and a menu opens at the pointer offering what to do with it:
  highlight, strike out, underline, cloud, box, cover, copy, copy with a page
  reference, turn into a callout or a sticky note, or search the drawing for
  it. Press Escape or click away to keep the selection and do nothing.
- **A text-select tool (`X`).** Drag a box over any part of a sheet and every
  word inside it is selected — no dragging along a line of text, no fighting
  the order the plotter happened to write the entities in. The selection stays
  put after you release, so `Ctrl+C` copies it and right-clicking it opens the
  same action menu. Escape clears it.
- **Three markup types:** strikeout, underline and cover. Strikeout and
  underline follow the selected words the way a highlight does, and size their
  rule from the text so a 3pt schedule note and a 24pt sheet title both read as
  a pen stroke. Cover is an opaque filled box.
- **Typography for text markups.** With the Text or Callout tool active the
  toolbar gains a text group: typeface (sans, serif or mono), size, bold, and —
  for callouts, whose text sits on its own box — the text colour. These set the
  style for the next markup and restyle the current selection, the way the
  colour swatches already do. The same controls sit in a markup's properties
  dialog, and a callout's box regrows to fit whenever the face or size changes.
  The three typefaces map onto fonts every PDF reader already has, so a saved
  sheet reads the same everywhere without carrying a font with it.

### Changed

- Text copied off a drawing now comes out in **reading order** — rows top to
  bottom, words left to right, columns kept apart — rather than in the order
  the entities were plotted. See the note under *Fixed*.
- `Ctrl+C` also copies a standing area selection, in addition to a live text
  selection and the selected markups.
- The right-click menu on a page gains the full set of text actions when the
  click lands inside a standing selection.

### Fixed

- **Highlighting text swept in words from all over the sheet.** Highlight bars
  were built from the raw rectangles the browser handed back for its selection,
  and the browser selects in DOM order while PDF.js emits one span per run in
  content-stream order — the order the plotter wrote the entities. Dragging
  down two lines of a description block therefore highlighted every run written
  in between, scattered across the drawing. The shape that was actually swept
  is now rebuilt geometrically from the press point, growing a horizontal band
  row by row and admitting only the runs that overlap it.
- **Highlights stopped a third of a character short at each end.** PDF.js lays
  a substituted face over a CAD stick font and stretches it to the recorded
  advance, so only the run's total width is guaranteed to line up and the caret
  lands slightly inside where it looks like it should. Measured on a plotted
  sheet the bars came out inset 1 to 2.5pt at each end, which reads as the
  first letter of a word refusing to highlight. Selections are now rounded out
  to whole words before anything is measured.
- **Copying text off a drawing produced a jumble.** The browser concatenates a
  selection in DOM order and PDF.js emits one span per run in content-stream
  order — the order the plotter wrote the entities — so a two-line description
  block came back with its lines interleaved and runs from the far side of the
  sheet dropped in between. Text is now rebuilt from the rows the selection
  actually swept.
- **The text layer did not turn with a rotated sheet.** Most plotted drawings
  carry their own `/Rotate`. The text and annotation layers were left upright
  over a landscape page, so the I-beam appeared over blank paper, highlights
  selected nothing, and links and comment bubbles could not be clicked — which
  reads as a broken file rather than as three missing CSS rules.
- **Clicking a thumbnail could open the sheet before the one clicked.** Page
  tops were measured with `offsetTop`, which is relative to the offsetParent
  rather than to the scroller, so any positioned element appearing in between
  shifted every page top at once. Navigation now measures against the scroller
  itself, clamps to the real scroll extent, and — because a smooth scroll is an
  animation that a relayout can move the target under — checks where it landed
  afterwards, correcting a landing that is a whole page out and recording the
  geometry it saw in the diagnostics log. A scroll of your own mid-flight
  outranks the correction.
- **A callout's inline editor opened away from its box on a rotated sheet.** A
  callout is drawn as the axis-aligned rect of its four corners, but the editor
  was anchored by converting the single top-left PDF corner, which only agrees
  at `/Rotate 0`. On a plotted landscape sheet the text appeared to start below
  the box and snap into place on commit — the committed render had been right
  all along.

### Notes

- **Cover is not redaction.** It draws an opaque box over the words; the text
  itself stays in the file and remains selectable, searchable and extractable
  underneath. Use it to tidy a print, never to hide something confidential.

---

## [0.4.1] and earlier

Recorded in git history only — this changelog starts at 0.5.0. The shipped
feature set up to 0.4.1 is described in `README.md`, and the items marked
**done** in `BACKLOG.md` cover what landed when.
