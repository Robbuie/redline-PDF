/* Copying a region of a drawing as a picture.

   The obvious implementation is to composite the two on-screen canvases over
   the dragged box and call `toBlob`. It is also wrong, for one reason that
   matters every time: the screen canvas is a raster at whatever zoom you
   happen to be at. Reading a schedule at fit-width on an E-size sheet puts
   roughly one device pixel on three PDF points, and the detail pasted into an
   RFI is unreadable — exactly the detail somebody is asking a question about.

   So a region is *re-rendered* from the page proxy at a density chosen for the
   crop rather than for the screen, and the markups are drawn over it through
   the same `RP.render.drawAnnotation` the viewer uses, at that same density.
   pdf.js renders a sub-region by way of the `transform` parameter — the canvas
   is the size of the crop and the transform slides the page under it — so
   nothing renders the whole sheet at 4x to throw away all but a corner of it.

   Two things follow from re-rendering that are easy to undo by accident:

   - **Night mode does not travel.** The invert is a CSS filter on
     `.pdf-canvas`, and a fresh render never sees it, so the copy is the real
     drawing whatever the screen is doing. Anybody "fixing" that has misread
     what night mode is for.
   - **A released page still copies.** `retainCanvases` zeroes the backing
     store of pages away from the viewport, so compositing would hand back a
     blank image for a page that is merely off-screen. This path never touches
     those canvases. */
'use strict';

(function (RP) {

  // A crop is aimed at ~2x PDF user space (144dpi against the 72dpi base),
  // which is what makes 3pt schedule text legible when pasted at 100%.
  const TARGET_SCALE = 2;
  // ...but an E-size sheet is 2448x3168pt, so a whole-sheet crop at 2x would
  // be 31 megapixels. The cap is what stops "copy this page" from allocating a
  // canvas Chromium refuses, which comes back as a blank image rather than an
  // error.
  const MAX_PIXELS = 24e6;
  // Below this a drag is a slipped click, not a region.
  const MIN_SIDE_PX = 4;

  const Snapshot = {

    /**
     * Work out the canvas for a crop. Pure — no DOM, no pdf.js — so
     * `verify.js` can check the density rules against a stubbed viewport.
     *
     * `rect` is in PDF user space; `viewport` is a scale-1 viewport for the
     * page *at its display rotation*, which is what makes the crop come out
     * the way the sheet looks rather than the way it is stored.
     *
     * Returns the crop in scale-1 viewport pixels (`x/y/w/h`), the scale
     * chosen for it, and the pixel size of the canvas to allocate.
     */
    plan(viewport, rect, opts) {
      const options = opts || {};
      const view = RP.render.vpRect(viewport, rect);
      const w = Math.max(0, view.w);
      const h = Math.max(0, view.h);
      if (w < 1 || h < 1) return null;

      // Never coarser than what is already on screen: somebody who zoomed to
      // 400% to read a detail has said what density they want it at.
      let scale = Math.max(TARGET_SCALE, options.floor || 0);
      const cap = Math.sqrt(MAX_PIXELS / (w * h));
      if (cap < scale) scale = cap;
      // A crop bigger than the cap even at 1:1 still has to produce something.
      if (!(scale > 0) || !isFinite(scale)) scale = 1;

      return {
        x: view.x,
        y: view.y,
        w,
        h,
        scale,
        pixelW: Math.max(1, Math.round(w * scale)),
        pixelH: Math.max(1, Math.round(h * scale))
      };
    },

    /** True when a drag was big enough to mean a region. */
    isRegion(view) {
      return !!view && view.w >= MIN_SIDE_PX && view.h >= MIN_SIDE_PX;
    },

    /**
     * Render `rect` of `pageIndex` and return a PNG blob.
     *
     * The store is taken as an argument rather than read off `RP.store`: there
     * are awaits either side of the markup pass and a tab switch across one of
     * them would draw another drawing's markups onto this crop.
     */
    async render(pageIndex, rect, store) {
      const record = RP.viewer.pages[pageIndex];
      if (!record || !record.pageProxy) return null;
      const pageProxy = record.pageProxy;

      // Scale 1 so `plan` can work in page units and pick its own density;
      // the rotation is the displayed one, so a landscape sheet crops
      // landscape.
      const base = pageProxy.getViewport({ scale: 1, rotation: RP.viewer.rotationOf(pageProxy) });
      const plan = this.plan(base, rect, { floor: RP.viewer.zoom });
      if (!plan) return null;

      const canvas = document.createElement('canvas');
      canvas.width = plan.pixelW;
      canvas.height = plan.pixelH;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      /* The crop, as a transform. pdf.js prepends this to the viewport
         transform, so scaling by `plan.scale` and translating by the crop
         origin puts the wanted region at the canvas origin — the page renders
         only where the canvas is, rather than being rendered whole and cut
         down afterwards. */
      const k = plan.scale;
      const transform = [k, 0, 0, k, -plan.x * k, -plan.y * k];

      /* No `annotationCanvasMap` here, unlike `viewer.renderPage` — and that is
         the point rather than an omission. The map is how pdf.js hands back
         annotations that render onto a canvas of their own (Bluebeam stamps,
         some free text) for a live annotation layer to adopt and position. A
         crop has no annotation layer to adopt them, so passing a map would
         divert those marks into canvases nothing reads and leave a stamped
         sheet copying without its stamp. Left off, they are drawn straight
         into the page canvas, which is exactly the flattened picture wanted. */
      const task = pageProxy.render({
        canvasContext: ctx,
        viewport: base,
        transform
      });
      await task.promise;

      // Markups on top, in the same space and through the same code the viewer
      // paints with, so a crop cannot disagree with what it was taken from —
      // status fade and the rejected rule included.
      ctx.setTransform(k, 0, 0, k, -plan.x * k, -plan.y * k);
      for (const annot of store.forPage(pageIndex)) {
        // `selected` is deliberately false: selection handles are a state of
        // the app, not a mark on the drawing, and nobody wants them in a crop.
        RP.render.drawAnnotation(ctx, annot, base, { selected: false });
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    },

    /**
     * Render a region and put it on the clipboard. Returns true when the
     * clipboard actually took it.
     */
    async copy(pageIndex, rect, store) {
      const forStore = store || RP.store;
      RP.status('Copying that area…');
      try {
        const blob = await this.render(pageIndex, rect, forStore);
        if (!blob) { RP.status('That area was too small to copy', 'warn'); return false; }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await window.rp.clipboard.writeImage(bytes);
        RP.status('Area copied as an image — paste it into an email or an RFI');
        return true;
      } catch (err) {
        console.error('Copy area as image failed', err);
        RP.status('');
        RP.toast('Could not copy that area: ' + err.message, 'error');
        return false;
      }
    },

    /** Copy the whole of a page. Used by the context menu. */
    copyPage(pageIndex, store) {
      const record = RP.viewer.pages[pageIndex];
      if (!record || !record.pageProxy) return Promise.resolve(false);
      const base = record.pageProxy.getViewport({ scale: 1, rotation: 0 });
      // The full page in PDF user space. `viewBox` is the crop box origin and
      // extent, which is not always (0,0) — a sheet with an offset MediaBox
      // would otherwise copy a strip of blank paper next to the drawing.
      const box = base.viewBox;
      return this.copy(pageIndex, {
        x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1]
      }, store || RP.store);
    }
  };

  RP.snapshot = Snapshot;

})(window.RP);
