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
