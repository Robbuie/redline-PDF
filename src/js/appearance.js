/* Appearance — theme, accent, chrome density and the paper display mode.
 *
 * These are four *independent* axes and they are kept that way deliberately.
 * A theme sets the greys, the accent sets one colour, the density sets the
 * chrome metrics, and the paper mode filters the drawing. Any two of them
 * folded together ("dark compact", "night theme") means the combinations
 * multiply and most of them never get looked at.
 *
 * Everything below the catalogs is a *normaliser* — `themeOf`, `accentOf` and
 * friends all take whatever was in the settings file and hand back something
 * the CSS can use. Settings written by a later build, or hand-edited, or left
 * over from a version where the option did not exist, must not be able to put
 * the app into a state with no readable chrome. That is why nothing here
 * trusts its input and why the applying functions call the normalisers rather
 * than the other way round.
 *
 * DOM access lives inside the functions, never at load time: `test/verify.js`
 * runs renderer sources in-process against a stub document.
 */
'use strict';

(function (RP) {

  // -------------------------------------------------------------------------
  // Catalogs
  // -------------------------------------------------------------------------

  /* `dark` is the `:root` block in app.css and has no class of its own, but it
     is listed here anyway — the settings <select> is built from this list, and
     a catalog that omits the default is one the UI cannot offer. */
  const THEMES = [
    { id: 'dark', label: 'Dark (CAD pro)', note: 'The default. Neutral greys, drawing forward.' },
    { id: 'light', label: 'Light', note: 'For bright rooms and shared screens.' },
    { id: 'paper', label: 'Warm paper', note: 'Light, off-white. Easier over a long review.' },
    { id: 'blueprint', label: 'Blueprint', note: 'Deep blue chrome; the sheet is the only warm thing on screen.' },
    { id: 'contrast', label: 'High contrast', note: 'Maximum separation — an accessibility target, not a style.' }
  ];

  /* Channel triples, not hex, because app.css derives every tint of the accent
     with rgba(var(--accent-rgb), a). See the note at the top of that file. */
  const ACCENTS = [
    { id: 'redline', label: 'Redline red', rgb: '255, 91, 74' },
    { id: 'amber', label: 'Amber', rgb: '242, 165, 60' },
    { id: 'green', label: 'Field green', rgb: '70, 201, 139' },
    { id: 'cyan', label: 'Cyan', rgb: '54, 191, 210' },
    { id: 'blue', label: 'Drafting blue', rgb: '74, 145, 255' },
    { id: 'violet', label: 'Violet', rgb: '154, 122, 255' }
  ];

  const DENSITIES = [
    { id: 'compact', label: 'Compact', note: 'Least chrome — more sheet on a laptop.' },
    { id: 'normal', label: 'Normal', note: 'The default.' },
    { id: 'large', label: 'Large', note: 'Bigger targets and type for high-DPI panels.' }
  ];

  /* Viewing aids only. None of these reaches the exported bytes, the print
     copy or a snapshot crop — see the block comment on the rules in app.css. */
  const PAPER_MODES = [
    { id: 'normal', label: 'As drawn', note: 'No filter.' },
    { id: 'invert', label: 'Invert (night)', note: 'White paper goes black. Markups keep their colours.' },
    { id: 'grey', label: 'Greyscale', note: 'Drains the drawing so markups stand off it.' },
    { id: 'soft', label: 'Reduced glare', note: 'Warm off-white instead of inverting. Long reviews.' },
    { id: 'contrast', label: 'Contrast boost', note: 'For faded or badly scanned sheets.' }
  ];

  const DEFAULTS = { theme: 'dark', accent: 'redline', density: 'normal', paperMode: 'normal' };

  // -------------------------------------------------------------------------
  // Normalisers
  // -------------------------------------------------------------------------

  const has = (list, id) => list.some((item) => item.id === id);
  const pick = (list, id, fallback) => (has(list, id) ? id : fallback);

  const Appearance = {
    THEMES, ACCENTS, DENSITIES, PAPER_MODES, DEFAULTS,

    themeOf: (value) => pick(THEMES, value, DEFAULTS.theme),
    accentOf: (value) => pick(ACCENTS, value, DEFAULTS.accent),
    densityOf: (value) => pick(DENSITIES, value, DEFAULTS.density),

    /**
     * The paper mode, with the pre-0.13 `nightMode` boolean folded in.
     *
     * A settings file written by an older build has `nightMode: true` and no
     * `paperMode` at all, and dropping that on the floor would silently turn
     * night mode off for everyone who had it on — a setting quietly reverting
     * on upgrade is the kind of thing people blame on the app forgetting
     * rather than report. `paperMode` wins when it is present, so once the
     * user has touched the new control the legacy flag stops mattering.
     */
    paperModeOf(settings) {
      const value = settings && settings.paperMode;
      if (value !== undefined && value !== null && value !== '') {
        return pick(PAPER_MODES, value, DEFAULTS.paperMode);
      }
      return settings && settings.nightMode ? 'invert' : DEFAULTS.paperMode;
    },

    accentRgb(value) {
      const found = ACCENTS.find((item) => item.id === this.accentOf(value));
      return found.rgb;
    },

    label(list, id) {
      const found = list.find((item) => item.id === id);
      return found ? found.label : id;
    },

    // -----------------------------------------------------------------------
    // Applying
    // -----------------------------------------------------------------------

    /**
     * Swap the theme class.
     *
     * This toggles *only* the `theme-*` classes and leaves everything else on
     * <body> alone. Assigning `body.className` wholesale — which is what this
     * did up to 0.12 — takes `presenting` off with it, so changing the theme
     * from inside a full-screen presentation dropped every toolbar back into
     * view over the drawing, and did the same to any future state class.
     */
    applyTheme(theme) {
      const id = this.themeOf(theme);
      for (const item of THEMES) {
        document.body.classList.toggle('theme-' + item.id, item.id === id);
      }
      return id;
    },

    /* One custom property; app.css derives the ten tints of it. */
    applyAccent(accent) {
      const id = this.accentOf(accent);
      document.documentElement.style.setProperty('--accent-rgb', this.accentRgb(id));
      return id;
    },

    applyDensity(density) {
      const id = this.densityOf(density);
      document.body.dataset.density = id;
      return id;
    },

    applyPaperMode(mode) {
      const id = pick(PAPER_MODES, mode, DEFAULTS.paperMode);
      document.body.dataset.paper = id;
      return id;
    },

    /**
     * What is actually applied right now, read back off the document.
     *
     * The settings dialog is filled from this rather than from the settings
     * object, because every one of these can be changed from somewhere else —
     * the toolbar dropdown, Ctrl+Shift+N — and the settings object is only
     * updated when an async patch resolves. A dialog filled from the stale
     * copy opens showing the wrong mode and invites the user to "fix" it back
     * to what it already is.
     */
    current() {
      const body = document.body;
      const theme = THEMES.find((item) => body.classList.contains('theme-' + item.id));
      const rgb = (document.documentElement.style.getPropertyValue('--accent-rgb') || '').trim();
      const accent = ACCENTS.find((item) => item.rgb === rgb);
      return {
        theme: theme ? theme.id : DEFAULTS.theme,
        accent: accent ? accent.id : DEFAULTS.accent,
        density: pick(DENSITIES, body.dataset.density, DEFAULTS.density),
        paperMode: pick(PAPER_MODES, body.dataset.paper, DEFAULTS.paperMode)
      };
    },

    /** Everything at once, from a settings object. Used at boot. */
    applyAll(settings) {
      const state = {
        theme: this.applyTheme(settings && settings.theme),
        accent: this.applyAccent(settings && settings.accent),
        density: this.applyDensity(settings && settings.density),
        paperMode: this.applyPaperMode(this.paperModeOf(settings))
      };
      return state;
    }
  };

  RP.appearance = Appearance;

})(window.RP);
