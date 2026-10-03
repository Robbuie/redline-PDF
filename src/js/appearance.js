/* Appearance — theme, accent, chrome density and the paper display mode,
 * plus the font, the corners and the right-pane accent beside them.
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
  /* 0.20 brought back the six themes the file manager added in its 0.48 —
     graphite, control room, phosphor, dusk, frost, ink — with its greys copied
     verbatim, so the family shares one set of numbers again. `light` says
     which side of the line a theme is on: "follow Windows" picks one of each,
     and a few chrome rules need a darker accent on pale chrome. */
  const THEMES = [
    { id: 'dark', label: 'Dark (CAD pro)', note: 'The default. Neutral greys, drawing forward.' },
    { id: 'light', label: 'Light', light: true, note: 'For bright rooms and shared screens.' },
    { id: 'paper', label: 'Warm paper', light: true, note: 'Light, off-white. Easier over a long review.' },
    { id: 'blueprint', label: 'Blueprint', note: 'Deep blue chrome; the sheet is the only warm thing on screen.' },
    { id: 'contrast', label: 'High contrast', note: 'Maximum separation — an accessibility target, not a style.' },
    { id: 'graphite', label: 'Graphite', note: 'True black, for OLED panels and dim rooms.' },
    { id: 'control', label: 'Control room', light: true, note: 'Calm mid greys after modern HMI screens; colour kept for what needs attention.' },
    { id: 'phosphor', label: 'Phosphor', note: 'Green on black. Suits the monospace font and the green accent.' },
    { id: 'dusk', label: 'Dusk', note: 'Warm dark browns, easier late in the day.' },
    { id: 'frost', label: 'Frost', light: true, note: 'A cool, bright light theme with steel-blue greys.' },
    { id: 'ink', label: 'Ink', light: true, note: 'Black on white with real lines for borders, like a printed drawing. Suits square corners.' }
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

  /* The right-hand pane of a split can carry a second accent, so a glance
     says which side the toolbar is acting on. `same` is the default and means
     no second colour at all. */
  const RIGHT_ACCENTS = [{ id: 'same', label: 'Same as the accent', rgb: '' }].concat(ACCENTS);

  /* Typeface and corners are choices beside the four axes, not part of a
     theme — Phosphor does not force the monospace font and Ink does not force
     square corners, for the axes' reason: a theme that also set a font would
     be a theme half of whose combinations nobody asked for. */
  const FONTS = [
    { id: 'ui', label: 'Segoe UI', note: 'The default.' },
    { id: 'variable', label: 'Segoe UI Variable', note: 'The Windows 11 face. Falls back to Segoe UI where it is missing.' },
    { id: 'mono', label: 'Cascadia Mono throughout', note: 'Every label in the monospace face. Suits Phosphor.' }
  ];

  const CORNERS = [
    { id: 'round', label: 'Rounded', note: 'The default.' },
    { id: 'square', label: 'Square', note: 'Nearly square chrome. Suits Ink.' }
  ];

  /* The theme can change by itself: follow Windows' light or dark setting,
     or switch by the clock between a light and a dark theme. */
  const FOLLOW = [
    { id: 'off', label: 'Never', note: 'Always the theme above.' },
    { id: 'windows', label: 'Follow Windows', note: 'Light or dark, the way Windows is set for apps.' },
    { id: 'schedule', label: 'By time of day', note: 'Light from the first hour, dark from the second.' }
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

  const DEFAULTS = {
    theme: 'dark', accent: 'redline', density: 'normal', paperMode: 'normal',
    accentRight: 'same', font: 'ui', corners: 'round',
    themeFollow: 'off', themeLight: 'light', themeDark: 'dark', dayFrom: 7, nightFrom: 19
  };

  const hourOf = (value, fallback) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
  };

  // -------------------------------------------------------------------------
  // Normalisers
  // -------------------------------------------------------------------------

  const has = (list, id) => list.some((item) => item.id === id);
  const pick = (list, id, fallback) => (has(list, id) ? id : fallback);

  const Appearance = {
    THEMES, ACCENTS, RIGHT_ACCENTS, DENSITIES, PAPER_MODES, FONTS, CORNERS, FOLLOW, DEFAULTS,

    themeOf: (value) => pick(THEMES, value, DEFAULTS.theme),
    accentOf: (value) => pick(ACCENTS, value, DEFAULTS.accent),
    rightAccentOf: (value) => pick(RIGHT_ACCENTS, value, DEFAULTS.accentRight),
    densityOf: (value) => pick(DENSITIES, value, DEFAULTS.density),
    fontOf: (value) => pick(FONTS, value, DEFAULTS.font),
    cornersOf: (value) => pick(CORNERS, value, DEFAULTS.corners),
    followOf: (value) => pick(FOLLOW, value, DEFAULTS.themeFollow),
    isLight: (id) => THEMES.some((item) => item.id === id && item.light),

    /**
     * The theme to draw with, given the settings and the moment.
     *
     * Pure — the clock and Windows' light/dark answer are passed in — so the
     * part that decides is tested without either. `windowsLight` is null when
     * it cannot be read, and then, like any choice that names no theme, the
     * answer is the picker's own theme rather than one nobody chose. A day
     * that starts after it ends is somebody on nights: "day" runs over
     * midnight. Same rules as the file manager's `themeswitch.pick`.
     */
    pickTheme(settings, now) {
      const s = settings || {};
      const at = now || {};
      const fixed = this.themeOf(s.theme);
      const follow = this.followOf(s.themeFollow);
      const light = has(THEMES, s.themeLight) ? s.themeLight : fixed;
      const dark = has(THEMES, s.themeDark) ? s.themeDark : fixed;
      if (follow === 'windows') {
        if (at.windowsLight === null || at.windowsLight === undefined) return fixed;
        return at.windowsLight ? light : dark;
      }
      if (follow === 'schedule') {
        const from = hourOf(s.dayFrom, DEFAULTS.dayFrom);
        const to = hourOf(s.nightFrom, DEFAULTS.nightFrom);
        const hour = hourOf(at.hour, 12);
        if (from === to) return fixed;
        const daytime = from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
        return daytime ? light : dark;
      }
      return fixed;
    },

    /** Windows' app light/dark setting as the renderer sees it, or null. */
    windowsLight() {
      try {
        if (typeof window === 'undefined' || !window.matchMedia) return null;
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return true;
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) return false;
      } catch (err) { /* fall through */ }
      return null;
    },

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
      document.body.classList.toggle('light-chrome', this.isLight(id));
      return id;
    },

    /**
     * The second accent, for the right-hand pane of a split. `same` removes
     * the property and the stylesheet falls back to the main accent; there is
     * no copy of the main triple to fall out of step with it.
     */
    applyRightAccent(value) {
      const id = this.rightAccentOf(value);
      const found = RIGHT_ACCENTS.find((item) => item.id === id);
      if (id === 'same') document.documentElement.style.removeProperty('--accent-right-rgb');
      else document.documentElement.style.setProperty('--accent-right-rgb', found.rgb);
      return id;
    },

    applyFont(value) {
      const id = this.fontOf(value);
      document.body.dataset.font = id;
      return id;
    },

    applyCorners(value) {
      const id = this.cornersOf(value);
      document.body.dataset.corners = id;
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
      const rightRgb = (document.documentElement.style.getPropertyValue('--accent-right-rgb') || '').trim();
      const right = rightRgb ? ACCENTS.find((item) => item.rgb === rightRgb) : null;
      return {
        theme: theme ? theme.id : DEFAULTS.theme,
        accent: accent ? accent.id : DEFAULTS.accent,
        accentRight: right ? right.id : 'same',
        density: pick(DENSITIES, body.dataset.density, DEFAULTS.density),
        paperMode: pick(PAPER_MODES, body.dataset.paper, DEFAULTS.paperMode),
        font: pick(FONTS, body.dataset.font, DEFAULTS.font),
        corners: pick(CORNERS, body.dataset.corners, DEFAULTS.corners)
      };
    },

    /** Everything at once, from a settings object. Used at boot. */
    applyAll(settings) {
      const state = {
        theme: this.applyTheme(this.pickTheme(settings, {
          windowsLight: this.windowsLight(),
          hour: new Date().getHours()
        })),
        accent: this.applyAccent(settings && settings.accent),
        accentRight: this.applyRightAccent(settings && settings.accentRight),
        density: this.applyDensity(settings && settings.density),
        paperMode: this.applyPaperMode(this.paperModeOf(settings)),
        font: this.applyFont(settings && settings.font),
        corners: this.applyCorners(settings && settings.corners)
      };
      return state;
    }
  };

  RP.appearance = Appearance;

})(window.RP);
