/* Loads PDF.js and copes with both flavours it ships in:

     v4 and newer  -> ESM only  (build/pdf.mjs, module worker)
     v3 and older  -> UMD       (build/pdf.js, classic worker)

   ESM needs a real origin, which is why the renderer is served over the
   privileged app:// protocol registered in main.js rather than file://.
   If everything fails we surface exactly what was tried, because a silent
   failure here takes the whole app down with it. */
'use strict';

(function (RP) {

  const BASE = '../node_modules/pdfjs-dist/';

  const Loader = {
    lib: null,
    version: null,
    flavour: null,
    workerSrc: null,
    attempts: [],

    resolve(rel) {
      return new URL(BASE + rel, document.baseURI).href;
    },

    async load() {
      if (this.lib) return this.lib;

      // 1. modern ESM build
      try {
        const url = this.resolve('build/pdf.mjs');
        const mod = await import(/* webpackIgnore: true */ url);
        if (mod && typeof mod.getDocument === 'function') {
          this.adopt(mod, 'esm', this.resolve('build/pdf.worker.mjs'));
          return this.lib;
        }
        this.attempts.push('build/pdf.mjs loaded but exported no getDocument');
      } catch (err) {
        this.attempts.push('import build/pdf.mjs -> ' + (err && err.message ? err.message : err));
      }

      // 2. legacy ESM build (older browsers / odd packaging)
      try {
        const url = this.resolve('legacy/build/pdf.mjs');
        const mod = await import(/* webpackIgnore: true */ url);
        if (mod && typeof mod.getDocument === 'function') {
          this.adopt(mod, 'esm-legacy', this.resolve('legacy/build/pdf.worker.mjs'));
          return this.lib;
        }
      } catch (err) {
        this.attempts.push('import legacy/build/pdf.mjs -> ' + (err && err.message ? err.message : err));
      }

      // 3. classic UMD build (pdfjs-dist 3.x)
      for (const rel of ['build/pdf.js', 'legacy/build/pdf.js']) {
        try {
          await injectScript(this.resolve(rel));
          const global = window.pdfjsLib;
          if (global && typeof global.getDocument === 'function') {
            this.adopt(global, 'umd', this.resolve(rel.replace('pdf.js', 'pdf.worker.js')));
            return this.lib;
          }
          this.attempts.push(rel + ' loaded but window.pdfjsLib was not set');
        } catch (err) {
          this.attempts.push('script ' + rel + ' -> ' + (err && err.message ? err.message : err));
        }
      }

      const error = new Error('PDF.js could not be loaded');
      error.attempts = this.attempts.slice();
      throw error;
    },

    adopt(mod, flavour, workerSrc) {
      this.lib = mod;
      this.flavour = flavour;
      this.workerSrc = workerSrc;
      this.version = mod.version || (mod.build ? 'build ' + mod.build : 'unknown');
      window.pdfjsLib = mod;
      try {
        mod.GlobalWorkerOptions.workerSrc = workerSrc;
      } catch (err) {
        this.attempts.push('setting workerSrc failed -> ' + err.message);
      }
    },

    /**
     * Parameters every getDocument call should carry. Without these, PDFs that
     * rely on the standard 14 fonts, CJK encodings or JPEG2000 images render
     * with substituted glyphs or blank tiles — common in issued drawing sets.
     */
    docParams(extra) {
      const params = Object.assign({
        cMapUrl: this.resolve('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: this.resolve('standard_fonts/')
      }, extra || {});
      if (this.flavour !== 'umd') {
        params.wasmUrl = this.resolve('wasm/');
        params.iccUrl = this.resolve('iccs/');
      }
      return params;
    },

    /** True when this build uses the TextLayer class instead of renderTextLayer. */
    hasTextLayerClass() {
      return !!(this.lib && typeof this.lib.TextLayer === 'function');
    },

    /**
     * True when AnnotationLayer is an instantiable class (v4+). v3 shipped the
     * same name as a bare namespace with a *static* render(), so the two are
     * told apart by whether the prototype carries the method.
     */
    hasAnnotationLayerClass() {
      const layer = this.lib && this.lib.AnnotationLayer;
      return !!(layer && layer.prototype && typeof layer.prototype.render === 'function');
    },

    /** Where pdf.js looks for its annotation icons (note, comment, pushpin…). */
    imageResourcesPath() {
      return this.resolve('web/images/');
    },

    describe() {
      return {
        flavour: this.flavour,
        version: this.version,
        workerSrc: this.workerSrc,
        attempts: this.attempts
      };
    }
  };

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-pdfjs="' + src + '"]');
      if (existing) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.dataset.pdfjs = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('not found (' + src + ')'));
      document.head.appendChild(script);
    });
  }

  RP.pdfjs = Loader;

})(window.RP);
