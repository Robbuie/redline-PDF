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

    /**
     * The two reasons pdf.js asks for a password, as this build spells them.
     *
     * `PasswordResponses` hangs off the library object rather than being a
     * bare global, and the ESM and UMD builds expose it in different places —
     * so it is reached through `this.lib` and given defaults. The numbers are
     * stable across every pdf.js that has shipped them, but a build that
     * exported neither would otherwise make every prompt read as a first
     * attempt, which is the one thing the message has to get right.
     */
    passwordReasons() {
      const codes = (this.lib && this.lib.PasswordResponses) || {};
      return {
        need: typeof codes.NEED_PASSWORD === 'number' ? codes.NEED_PASSWORD : 1,
        incorrect: typeof codes.INCORRECT_PASSWORD === 'number' ? codes.INCORRECT_PASSWORD : 2
      };
    },

    /** True for the error pdf.js rejects with when a password was never given. */
    isPasswordError(err) {
      return !!(err && (err.name === 'PasswordException' || err.name === 'PasswordError'));
    },

    /**
     * Attach password handling to a loading task. Returns the task.
     *
     * **`onPassword` belongs to the loading task, not to the `getDocument`
     * parameters.** Putting it in the parameter object is the obvious guess,
     * it is silently ignored, and what you get is the generic
     * `PasswordException` with no prompt ever shown — which reads as "this
     * app cannot open protected files" rather than as a wiring mistake. The
     * test fixtures in `test/fixtures` exist because a stubbed pdf.js will
     * happily agree with the wrong shape.
     *
     * pdf.js does not simply reject an encrypted file: it calls back and
     * *waits*, so this is a callback bridging to an async prompt rather than a
     * promise to await. Handing `updatePassword` an Error rejects the task,
     * which is how both a cancel and a run of wrong answers get out — without
     * it a user who backs out leaves a document loading forever.
     *
     * `ask({reason, attempt, attempts})` returns the password, or null to give
     * up. Attempts are capped here rather than in the prompt so every caller
     * gets the cap, and so a file that answers "incorrect" to a *correct*
     * password — a broken encryption dictionary, which does happen — cannot
     * loop forever.
     *
     * **How the outcome comes back matters.** The Error handed to
     * `updatePassword` does *not* reach the caller: pdf.js rejects that
     * internal capability, the rejection crosses the worker boundary, and what
     * finally rejects `task.promise` is pdf.js's own `PasswordException` with
     * its own message. Any property put on our Error is gone by then. So the
     * outcome is recorded on *this* side, as `task.rpPassword` — the caller
     * reads that in its `catch` to tell "the user backed out" from "the
     * password was never right" from "this file is actually corrupt", which
     * are three different things to say and only one of them is an error.
     */
    attachPassword(task, ask, opts) {
      if (!task || typeof ask !== 'function') return task;
      const limit = (opts && opts.attempts) || 3;
      const reasons = this.passwordReasons();
      let attempt = 0;

      const giveUp = (updatePassword, outcome, message) => {
        task.rpPassword = outcome;
        updatePassword(new Error(message));
      };

      task.onPassword = (updatePassword, reason) => {
        attempt += 1;
        if (attempt > limit) {
          giveUp(updatePassword, 'exhausted', 'Too many password attempts');
          return;
        }
        Promise.resolve(ask({
          reason: reason === reasons.incorrect ? 'incorrect' : 'need',
          attempt,
          attempts: limit
        })).then((password) => {
          // A cancel and an empty box are the same answer: an empty string is
          // a *valid* password to try, and passing it would spend an attempt
          // on nothing and report the wrong reason next time round.
          if (password === null || password === undefined || password === '') {
            giveUp(updatePassword, 'cancelled', 'Password entry cancelled');
            return;
          }
          updatePassword(password);
        }).catch((err) => {
          task.rpPassword = 'failed';
          updatePassword(err);
        });
      };
      return task;
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
