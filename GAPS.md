# Gap analysis — what other PDF apps have that Redline PDF does not

Written against 0.17.4. Measured against Bluebeam Revu (the direct competitor,
~$260–400/user/yr), Acrobat Pro (~$240/yr), Foxit PDF Editor Pro, PDF-XChange
Editor, and the free readers.

The app is already past most of them on *markup ergonomics* — groups, align and
distribute, match style, point-at-a-time shapes, paste under the pointer, the
punch-list statuses, the thumbnail navigator, tiled full-resolution rendering,
the compare engine. What follows is what is genuinely absent, ranked by what it
would be worth on an electrical drawing set.

---

## Tier 1 — the ones that hurt on this specific job

### 1. Count tool
Every takeoff on an electrical drawing starts by counting devices: receptacles,
fixtures, JBs, smokes, panels. Click each one, get a running total, each count
type its own symbol and colour, totals in the markup list.

The app has Measure, Run length and Area but **no count** — which is the most-used
takeoff tool of the three on a lighting or power plan. Bluebeam's count tool is
the single feature people name when asked why they pay for Revu.

Worth adding: count as a markup type, a symbol picker (cross, dot, triangle, a
letter), a per-type running total in the status bar, and a "count similar" that
pattern-matches the symbol under the pointer across the sheet. The last part is
where Bluebeam charges — visual search for a symbol and auto-place a count on
every match.

### 2. Tool Chest — a saved library of markups and stamps
Copy/paste works, but it dies with the session and with the document. What
everyone else ships is a persistent, named library: your revision cloud at your
weight and colour, your *VERIFY ON SITE*, your initials, your device symbols —
one click to arm, grouped into sets you can switch by project or discipline, and
exportable so a crew shares one.

**Dynamic stamps** are the paid half of this: a stamp whose text fills itself in
— date, user, sheet number, a serial that increments each time it is placed.
Bluebeam, Acrobat and Foxit all charge for them.

The model is already there — a markup is JSON with geometry in user space. A
tool chest is a settings-folder store of markup templates plus a panel. This is
probably the highest value-per-line-of-code item on the list.

### 3. OCR
A scanned as-built, an old sheet, a marked-up plan someone printed and rescanned
— none of them have a text layer, so on those sheets Find returns nothing, text
selection selects nothing, and copy-as-text gives nothing. That is a cliff, not a
degradation, and half of what lands in a review folder falls off it.

Everyone charges for this: Acrobat Pro, Bluebeam, Foxit Pro, PDF-XChange.

`tesseract.js` runs entirely locally and would keep the offline promise intact.
The work is: rasterise the page, run recognition, write an invisible text layer
back into the page (pdf-lib can do it — text render mode 3), reindex for search.
Batch it across a set with a progress bar and it also unlocks item 4.

### 4. Search across the whole set, not one document
Find is per-document. "Every mention of panel LP-1" across a 200-sheet set plus
the specs is exactly the question a review asks, and Acrobat's index search and
PDF-XChange's folder search both answer it. Here it means opening files one at a
time.

Two steps: search across all open tabs first (cheap — the index already exists per
document), then search a folder on disk, building and caching an index. Results
grouped by file and sheet, click to open at the hit.

### 5. Redaction
The app is called Redline PDF and cannot redact. Drawing a black rectangle over a
name is not redaction — the text is still under it and comes out with a copy/paste
in any other reader. Real redaction removes the content stream operators and the
text, then draws the box.

Acrobat gates this to Pro. Bluebeam has it. Foxit charges for it. And *search and
redact* — mark every occurrence of a pattern across the document — is the part
that makes it usable.

pdf-lib will not do this on its own; it needs content-stream rewriting, which is
real work but bounded, and the rasterise-the-region fallback (replace the page
region with a flattened image minus the text) is a legitimate first version.

### 6. Form filling
README already concedes it: form fields display but are not fillable, and
`renderForms: false` is deliberate. Transmittals, RFI forms, submittal cover
sheets and inspection checklists are AcroForms, and **every free reader fills
them** — Edge and Chrome do it. This is the one gap where the app is behind the
free tier rather than the paid one.

pdf.js already has the machinery (`renderForms: true` + `annotationStorage`), and
pdf-lib has a full form API for writing values back. The work is mostly plumbing
the storage into the save pipeline and deciding how flattening interacts with the
existing markup stamping.

---

## Tier 2 — paid features on the sheet-set workflow

### 7. Sets and slip-sheeting
Bluebeam's **Sets** treats a folder of PDFs as one navigable set: sheet numbers
and titles pulled from the title block, one page list, and **slip-sheet** — drop
in Rev C and it replaces Rev B in place, keeping your markups and your position,
with the superseded revision still reachable underneath.

Compare already does the hard visual half. Slip-sheeting is the workflow half, and
it is what a drawing office actually does every reissue.

### 8. Batch processing
Apply one thing to a folder: stamp every sheet, add a header, number a set, flatten
markups, export every file, split every file. Bluebeam sells Batch Link, Batch Sign
& Seal and Batch Slip Sheet as headline features; Acrobat has Actions.

The single-document versions of most of these already exist here — insert, split,
numbering, export. Batch is a queue, a file picker and a progress dialog over code
already written.

### 9. Markup list: custom columns, subtotals and cost
The markup list is fixed. Bluebeam lets you add your own columns — item, room,
system, unit cost — and gives you subtotals and formula columns, so a takeoff comes
out as `qty × unit price = extended`, grouped and totalled, straight to Excel.

Without cost columns the takeoff is half a takeoff: you get lengths and areas but
have to leave the app to price them. The CSV export exists, so the plumbing to
Excel is there; what is missing is user-defined columns on the model and a group-by
with subtotals in the list and the report.

### 10. Legends
Auto-generate a legend on the sheet from the takeoff: each count type or measurement
type with its symbol, colour, count and total, placed as a markup that updates as
you add more. Standard in Revu, and the thing that makes a takeoff readable to
someone who was not the one doing it.

### 11. Digital signatures — sign, seal and validate
PE stamps are a legal requirement on issued drawings, and the app can neither apply
a certificate-based signature nor tell you whether an incoming signed drawing is
valid or has been tampered with — it just draws the widget's appearance stream.

Three separate things, in order of value: **validate** existing signatures (show
signer, time, and whether the document changed after signing), **sign** with a
PKCS#12 certificate, and **batch sign & seal** a set. Acrobat Pro, Bluebeam and
Foxit Pro all charge for the second and third.

Signing needs a PDF signature dictionary with a byte-range digest — pdf-lib can
build the structure, `node-forge` or Node's own crypto can produce the CMS blob.
Validation is the cheaper half and worth doing first.

### 12. Markup exchange — XFDF import/export
Two reviewers mark up the same set separately; today there is no way to merge their
comments. Acrobat exports and imports FDF/XFDF **for free**, and it is how comment
merging has worked for twenty years. It is also the offline-friendly answer to
Bluebeam Studio's cloud sessions, which do not fit this app's no-network stance.

The model is already serialisable — this is a format adapter plus a merge that
resolves ids, and it makes the app interoperable with everything else in the
building.

### 13. Dynamic fill / auto-area
Click inside a room and get its area — the walls bound the fill. Bluebeam's Dynamic
Fill + Measure, and one of the features that justifies the price for anyone doing
floor-area takeoff. A flood fill on the rendered ink mask, which the compare engine
already knows how to build.

### 14. Per-page and per-viewport scale
Calibration is one ratio for the whole document (`store.scale`). A real set has a
1:100 floor plan, a 1:20 detail and an unscaled schedule in the same file, and
Bluebeam keeps a scale per page and even per viewport region on a page. Right now
measuring a detail after calibrating on the plan gives a confidently wrong number.

This is a correctness gap, not just a feature gap, and it is cheap: move `scale`
to a per-page map with a document default.

---

## Tier 3 — everyday things that are free elsewhere

Each of these is small on its own; together they are most of what makes an app feel
like it is missing pieces.

- **Bookmark editing.** The outline panel reads bookmarks; it cannot create, rename,
  reorder or delete them, or auto-generate them from sheet numbers. Free in
  PDF-XChange and Foxit Reader.
- **Reply to and delete existing annotations.** README concedes it. Threaded replies
  on someone else's comment are standard everywhere, free tier included.
- **Page labels.** Show and navigate by `A-101`, not "page 7", in the go-to box, the
  thumbnails and the status bar. Sheet numbers are how anyone actually refers to a
  drawing.
- **Hyperlink creation.** Link a detail bubble to the sheet the detail is on; auto-link
  every `3/A-501` pattern across a set. Bluebeam sells this as Batch Link.
- **Crop pages / page boxes.** Trim the scanned border, set the crop box, apply to a
  range. Free in PDF-XChange.
- **Resize and scale pages.** Normalise a mixed set to one sheet size before printing.
- **Headers, footers and watermarks.** Page numbering exists; the general case does not
  — `NOT FOR CONSTRUCTION` across every sheet, a filename-and-date footer, a
  transmittal stamp. Free or near-free everywhere.
- **Document properties.** View and edit title, author, subject, keywords. Free.
- **Attachments.** Show embedded files, add one, and attach a file as an annotation —
  a calc sheet attached to the cloud that asks for it.
- **Optional-content layers.** CAD PDFs carry OCG layers; `optionalContentConfig` is
  already read, but there is no panel to toggle them. Turning off the survey layer or
  the background architectural is routine on a coordination review. Also worth putting
  markups on their own layer so they can be switched off in any reader.
- **Spell check** on typewriter and callout text.
- **Vector snapshot.** Copy-an-area is raster; Bluebeam pastes a region as vector, which
  matters when it lands in a Word RFI and gets scaled.
- **Export the text** of a document, and export pages as PNG/TIFF/JPEG at a chosen dpi.
- **Compress / optimise.** Downsample images, subset fonts, drop unused objects. A 300 MB
  scanned set that will not email is an everyday problem and Acrobat Pro charges for the
  fix.
- **Set a password / permissions.** Encrypted files open read-only; the app cannot
  *apply* encryption. This one is blocked by pdf-lib and needs a different writer or
  hand-rolled encryption.

---

## Tier 4 — the big paid pillars, probably out of scope

Listed for completeness, and because each is somebody's entire product.

- **Editing the document's own text and objects.** Acrobat's, Foxit's and Nitro's
  headline paid feature. Fixing a typo in a title block without going back to CAD.
  Genuinely hard — font metrics, reflow, subsetting — but even a narrow version
  (edit one text run in place, delete an object) covers most real uses.
- **Export to Word / Excel / PowerPoint.** Acrobat Pro's biggest upsell. The useful
  subset here is narrow and achievable: **PDF table → Excel**, aimed at panel
  schedules and equipment lists, which is a table-structure problem on text the app
  already extracts.
- **Create PDF from other formats.** Images and Office files in, PDF out.
- **PDF/A conversion and preflight.** An archiving requirement on public work.
- **Accessibility — tags, reflow, read-out-loud, PDF/UA.** Acrobat Pro only, and a
  procurement requirement on government jobs.
- **Real-time collaborative review** (Bluebeam Studio). Against this app's offline
  design; item 12 is the version that fits.
- **Text-based compare.** The compare engine diffs ink, which is right for drawings and
  wrong for specifications — a word-level diff of a 300-page spec is a different
  algorithm and Acrobat charges for it.
- **Mac / iPad / Linux.** Windows-only today. Bluebeam's iPad app is half of why field
  staff have licences.
- **Plugins and a CLI.** Revit/AutoCAD/Office plugins in Bluebeam; an Acrobat SDK.
  Cheapest useful slice: command-line flags to open at a page, or export a report
  headlessly.
- **Code signing.** Already on the list in BACKLOG.md as a deliberate "no" — worth
  re-reading now that the app is being handed to other people, since SmartScreen is the
  first thing anyone sees.

---

## If you only do five

1. **Count tool** — the missing third of takeoff, and the one an electrician notices first.
2. **Tool Chest with dynamic stamps** — the highest value per line of code; the model already supports it.
3. **OCR** — removes the cliff that scanned sheets fall off, and unlocks search across a set.
4. **Form filling** — the one place the app is behind free readers.
5. **Per-page scale** — a small change that fixes measurements that are currently, quietly, wrong.

Redaction is sixth and would be first if the app ever leaves the drawing office.
