/* Getting text out of a drawing and onto the clipboard.

   The text layer has always been selectable, but nothing ever read the
   selection: the highlighter consumed it on mouseup and turned it into a
   markup, and Ctrl+C was unbound. This module is the missing half — it reads
   whatever is selected in a page's text layer, and falls back to the text
   carried by the selected markups when there is no text selection at all, so
   Ctrl+C means something whichever of the two you have in front of you.

   Writing goes through main (`window.rp.clipboard`) rather than
   `navigator.clipboard`, which needs a user-activation gesture the context
   menu no longer has by the time its handler runs. */
'use strict';

(function (RP) {

  const Clip = {

    // -- reading -----------------------------------------------------------

    /**
     * True for the leaf spans pdf.js lays over the glyphs, false for the
     * `.text-layer` container itself — which is `inset: 0` and therefore
     * covers the whole sheet, blank areas included. Everything that decides
     * "is the pointer over actual text" has to make that distinction.
     */
    isGlyph(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.classList.contains('text-layer')) return false;
      return !!(node.closest && node.closest('.text-layer'));
    },

    /** The live text-layer selection, or '' when there is not one. */
    selectedText() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
      const anchor = selection.anchorNode;
      const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      // A selection somewhere else in the chrome — the diagnostics pane, a
      // note popup — is not this document's text and must not be reported as
      // if it were.
      if (!el || !el.closest || !el.closest('.text-layer')) return '';
      return normalise(selection.toString());
    },

    hasTextSelection() { return this.selectedText().length > 0; },

    /**
     * The selected markups as text, one per line. Deliberately close to the
     * CSV export's shape so a pasted markup reads the same way in an email as
     * it does in the summary report.
     */
    selectedMarkupText() {
      const selected = RP.store.selected();
      if (!selected.length) return '';
      return selected
        .slice()
        .sort((a, b) => a.page - b.page || a.created - b.created)
        .map((annot) => {
          const body = RP.sidebar.describe(annot);
          return 'p' + (annot.page + 1) + '  ' + RP.store.typeLabel(annot.type) +
            (body ? ' — ' + body : '');
        })
        .join('\n');
    },

    // -- writing -----------------------------------------------------------

    /** Put text on the clipboard. Returns a promise resolving to true/false. */
    async write(text) {
      const value = String(text === null || text === undefined ? '' : text);
      if (!value) return false;
      try {
        await window.rp.clipboard.writeText(value);
        return true;
      } catch (err) {
        console.error('Clipboard write failed', err);
        RP.toast('Could not write to the clipboard', 'error');
        return false;
      }
    },

    /** Copy the text selection. Reports what happened; returns true if it did. */
    async copyText(opts) {
      const text = this.selectedText();
      if (!text) {
        if (!opts || opts.quiet !== true) {
          RP.status('Select some text on the drawing first', 'warn');
        }
        return false;
      }
      if (!(await this.write(text))) return false;
      const words = text.trim().split(/\s+/).length;
      RP.status('Copied ' + words + (words === 1 ? ' word' : ' words'));
      return true;
    },

    /**
     * What Ctrl+C should do, in the order the three things can be in front of
     * you: a live text-layer selection, then a standing area selection, then
     * the selected markups. Returns true when something was copied, so the
     * caller knows whether it is entitled to swallow the keystroke.
     *
     * The live selection wins over the standing one because it is the more
     * recent gesture — you cannot make one without the other having been made
     * first, and a text-layer drag that did not clear the standing selection
     * still means "this, now".
     */
    copySelection() {
      const text = this.selectedText();
      if (text) { this.copyText(); return true; }

      if (RP.textsel && RP.textsel.has()) {
        const selected = RP.textsel.text();
        const words = RP.textsel.wordCount(RP.textsel.current);
        this.write(selected).then((done) => {
          if (done) RP.status('Copied ' + words + (words === 1 ? ' word' : ' words'));
        });
        return true;
      }

      const markups = this.selectedMarkupText();
      if (markups) {
        const count = RP.store.selection.size;
        this.write(markups).then((done) => {
          if (done) RP.status('Copied ' + count + (count === 1 ? ' markup' : ' markups'));
        });
        return true;
      }
      return false;
    }
  };

  /**
   * pdf.js puts one span per text run, so a selection spanning a wrapped line
   * arrives with the line breaks intact but with the run boundaries showing up
   * as runs of spaces. Collapse those without touching the newlines, which are
   * the only structure a drawing's text has.
   */
  function normalise(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  RP.clip = Clip;

})(window.RP);
