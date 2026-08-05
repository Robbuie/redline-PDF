/* Open documents as tabs, and the one-or-two panes they live in.

   Two things are modelled here and they are deliberately not the same thing:

   - A **tab** owns a document *session*: its `RP.store`, the view state it was
     last left at, its search index and its compare run. Nothing about a tab
     touches the DOM of the drawing.
   - A **pane** owns a *viewport*: a `.viewer` scroll container, the page DOM
     inside it, and one `RP.createViewer` instance. A pane shows exactly one of
     its tabs at a time.

   `RP.store` and `RP.viewer` are live pointers into whichever tab and pane has
   focus. Every other module reads them at call time, so a switch is: stash the
   outgoing tab's view state, repoint, rebuild the pane from the incoming
   document, restore. The page DOM is *not* kept per tab — a hidden pane's worth
   of canvases for every open drawing is real memory on a 200-page sheet set,
   and pdf.js already caches the page proxies, so a rebuild is a re-layout
   rather than a re-parse.

   Splitting moves a tab to a second pane. Both panes render at once, so a pane
   that does not have focus still has to paint its own document — that is why
   the viewer draws `this.store` and not `RP.store`. */
'use strict';

(function (RP) {

  const MAX_PANES = 2;

  const Tabs = {
    panes: [],
    focused: null,       // the pane the toolbar and sidebar act on
    els: {},
    dragging: null,
    /** Paths of recently closed tabs, newest last. Drives Ctrl+Shift+T. */
    closedStack: [],

    // =====================================================================
    // Boot
    // =====================================================================

    init() {
      this.els.host = RP.$('#panes');
      this.els.empty = RP.$('#emptyState');
      if (!this.els.host) return;

      this.addPane();
      this.wireShortcuts();
      this.syncStrip();
    },

    // =====================================================================
    // Panes
    // =====================================================================

    addPane() {
      const strip = RP.el('div', { class: 'pane-tabs' });
      const list = RP.el('div', { class: 'tab-list' });
      const newBtn = RP.el('button', {
        class: 'tab-new', title: 'Open another drawing  (Ctrl+T)',
        onclick: () => RP.app.openDialog({ pane: pane, newTab: true })
      }, [RP.icon('open')]);
      const splitBtn = RP.el('button', {
        class: 'tab-split', title: 'Show two drawings side by side  (Ctrl+\\)',
        onclick: () => this.split()
      }, [RP.icon('compare')]);
      strip.append(list, newBtn, splitBtn);

      const pagesEl = RP.el('div', { class: 'pages' });
      const viewerEl = RP.el('div', { class: 'viewer', tabindex: '0' }, [pagesEl]);
      const el = RP.el('div', { class: 'pane' }, [strip, viewerEl]);

      const pane = {
        id: RP.uid('pane'),
        el,
        strip,
        list,
        tabs: [],
        active: null,
        viewer: null
      };

      // Splitters sit between panes, so a new pane brings its own leading one.
      if (this.panes.length) this.els.host.appendChild(this.makeSplitter());
      this.els.host.appendChild(el);
      this.panes.push(pane);

      pane.viewer = RP.createViewer(el, RP.store).init();

      // Focus follows the pane you press in, and it has to happen in the
      // capture phase: the delegated markup handlers below run against
      // `RP.viewer`, so the pointer has to have repointed it before they see
      // the same event.
      el.addEventListener('pointerdown', () => this.focusPane(pane), true);
      // Ctrl+wheel zooms the pane under the cursor, so the toolbar's zoom box
      // has to follow the pointer there too.
      el.addEventListener('wheel', () => this.focusPane(pane), { capture: true, passive: true });
      el.addEventListener('focusin', () => this.focusPane(pane));

      this.wireStrip(pane);
      RP.tools.bindPane(pane);

      if (!this.focused) this.focusPane(pane);
      this.els.host.classList.toggle('split', this.panes.length > 1);
      return pane;
    },

    makeSplitter() {
      const bar = RP.el('div', { class: 'pane-splitter', title: 'Drag to resize' });
      bar.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        bar.setPointerCapture(event.pointerId);
        const host = this.els.host;
        const rect = host.getBoundingClientRect();
        const move = (e) => {
          const fraction = RP.clamp((e.clientX - rect.left) / rect.width, 0.2, 0.8);
          host.style.setProperty('--split', String(fraction));
          for (const pane of this.panes) if (pane.viewer.fitMode) pane.viewer.applyFit();
        };
        const up = () => {
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          try { bar.releasePointerCapture(event.pointerId); } catch (err) { /* ignore */ }
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
      });
      return bar;
    },

    /** Point `RP.store` / `RP.viewer` at a pane and repaint the shared chrome. */
    focusPane(pane) {
      if (!pane || this.focused === pane) return;
      if (this.focused) {
        // Whatever we are leaving keeps its scroll position for when we return.
        if (this.focused.active) this.focused.active.view = this.focused.viewer.viewState();
        this.focused.el.classList.remove('focused');
      }
      this.focused = pane;
      pane.el.classList.add('focused');
      this.pointAt(pane.active);
      this.afterSwitch(pane.active, { rebuilt: false });
    },

    removePane(pane) {
      const index = this.panes.indexOf(pane);
      if (index < 0 || this.panes.length < 2) return;
      const other = this.panes[index === 0 ? 1 : index - 1];
      for (const tab of pane.tabs.slice()) this.moveToPane(tab, other, { silent: true });

      const splitter = index === 0
        ? pane.el.nextElementSibling
        : pane.el.previousElementSibling;
      if (splitter && splitter.classList.contains('pane-splitter')) splitter.remove();

      pane.viewer.destroy();
      this.panes.splice(index, 1);
      if (this.focused === pane) { this.focused = null; this.focusPane(other); }
      this.els.host.classList.toggle('split', this.panes.length > 1);
      this.syncStrip();
    },

    // =====================================================================
    // Tabs
    // =====================================================================

    /** Every open document, in strip order, left pane first. */
    all() {
      return this.panes.reduce((list, pane) => list.concat(pane.tabs), []);
    },

    active() { return this.focused ? this.focused.active : null; },

    /** The tab already showing a given file, so a re-open raises it instead. */
    findByPath(docPath) {
      if (!docPath) return null;
      const wanted = String(docPath).toLowerCase();
      return this.all().find((tab) => tab.store.docPath &&
        String(tab.store.docPath).toLowerCase() === wanted) || null;
    },

    /**
     * A brand new session. The store is created here rather than by the caller
     * so that every tab is guaranteed to have one even if the load that follows
     * fails — a tab that failed to open still has to be closable.
     */
    create(opts) {
      const options = opts || {};
      const pane = options.pane || this.focused || this.panes[0];
      const store = RP.createStore();
      store.author = (RP.app && RP.app.settings && RP.app.settings.defaultAuthor) || RP.store.author || '';

      const tab = {
        id: RP.uid('tab'),
        store,
        pane,
        view: null,        // stashed viewer.viewState()
        search: null,      // stashed search index and hits
        textsel: null,     // stashed standing area text selection
        compare: null,     // stashed compare run
        pageSel: null,     // stashed Pages-panel selection
        el: null
      };

      const at = options.after ? pane.tabs.indexOf(options.after) + 1 : pane.tabs.length;
      pane.tabs.splice(at, 0, tab);
      this.syncStrip();
      return tab;
    },

    /**
     * Stash whatever the pane was showing and repoint the globals at `tab`,
     * without touching the page DOM. `activate` rebuilds straight after;
     * `RP.app.loadDocument` instead loads into the pane itself, which is why
     * this half is separate — a tab being filled for the first time must not
     * have the outgoing document's thumbnails built for it on the way through.
     */
    prepare(tab) {
      const pane = tab.pane;
      const switching = pane.active !== tab;
      if (pane.active && switching) {
        pane.active.view = pane.viewer.viewState();
        this.stash(pane.active);
      }
      pane.active = tab;
      if (this.focused !== pane) {
        if (this.focused) this.focused.el.classList.remove('focused');
        this.focused = pane;
        pane.el.classList.add('focused');
      }
      this.pointAt(tab);
      this.syncStrip();
      return switching;
    },

    /**
     * Bring a tab to the front of its pane. Rebuilds that pane's page DOM from
     * the incoming document unless it is already the one on screen.
     */
    async activate(tab) {
      if (!tab) return;
      const pane = tab.pane;
      if (pane.active === tab && this.focused === pane) return;

      const rebuilding = this.prepare(tab);

      if (rebuilding && tab.store.doc) {
        RP.status('Switching to ' + tab.store.docName + '…');
        try {
          await pane.viewer.open(tab.store.doc, tab.store);
          pane.viewer.applyViewState(tab.view);
        } catch (err) {
          console.error('Could not re-open ' + tab.store.docName + ' in this pane', err);
          RP.toast('Could not show ' + tab.store.docName + ': ' + err.message, 'error');
        }
        RP.status('');
      }

      this.afterSwitch(tab, { rebuilt: rebuilding });
    },

    /** Repoint the globals. Does no DOM work — callers decide about rebuilds. */
    pointAt(tab) {
      const pane = this.focused;
      RP.viewer = pane ? pane.viewer : null;
      RP.store = tab ? tab.store : RP.createStore();
      // The pane draws its own store, so the two must never drift apart — least
      // of all when the last tab has just gone and both should be the same
      // empty one rather than two different empty ones.
      if (pane && pane.viewer) pane.viewer.store = RP.store;
    },

    /**
     * Everything the shared chrome has to be told after the pointers moved.
     * `doc:loaded` is re-emitted by hand because the store was not re-set —
     * the sidebar, bookmarks and page manager all key off it, and they are the
     * parts that show the *focused* document rather than a pane's.
     */
    afterSwitch(tab, opts) {
      const options = opts || {};
      this.syncStrip();
      if (!tab) {
        RP.app.updateTitle();
        RP.app.updateStatus();
        this.syncEmpty();
        return;
      }
      // A freshly loaded document has already emitted this from `setDocument`.
      if (options.emitLoaded !== false) RP.bus.emit('doc:loaded', tab.store);
      this.unstash(tab);
      if (RP.viewer) { RP.viewer.buildThumbs(); RP.viewer.redrawAll(); }
      RP.app.updateTitle();
      RP.app.updateStatus();
      this.syncEmpty();
      RP.bus.emit('tab:changed', tab);
      if (opts && opts.rebuilt) RP.app.rememberView();
    },

    /**
     * Close a tab, asking about unsaved markups first. Returns false if the
     * user backed out, so the window-close guard can stop on the first
     * "Cancel" rather than marching through the rest.
     */
    async close(tab, opts) {
      if (!tab) return true;
      const silent = opts && opts.silent;
      if (tab.store.dirty && !silent) {
        await this.activate(tab);
        const answer = await window.rp.dialog.message({
          type: 'warning',
          message: 'Unsaved markups in ' + tab.store.docName,
          detail: 'Save them before closing this tab?',
          buttons: ['Save', 'Discard', 'Cancel'],
          defaultId: 0,
          cancelId: 2
        });
        if (answer.response === 2) return false;
        if (answer.response === 0) {
          const saved = await RP.app.save();
          if (saved === false) return false;
        }
      }

      const pane = tab.pane;
      const index = pane.tabs.indexOf(tab);
      pane.tabs.splice(index, 1);

      /* Remember the path so Ctrl+Shift+T can put it back. Only the path — the
         store is about to be torn down, and reopening reads the file again
         rather than resurrecting a half-destroyed session. A drawing that was
         never on disk cannot be reopened, so it is not recorded. */
      if (tab.store.docPath) {
        this.closedStack.push(tab.store.docPath);
        if (this.closedStack.length > 12) this.closedStack.shift();
      }

      if (tab.store.doc) { try { tab.store.doc.destroy(); } catch (err) { /* ignore */ } }
      tab.store.reset();

      if (pane.active === tab) {
        pane.active = null;
        const next = pane.tabs[index] || pane.tabs[index - 1] || null;
        if (next) {
          await this.activate(next);
        } else if (this.panes.length > 1) {
          this.removePane(pane);
        } else {
          pane.viewer.close();
          this.pointAt(null);
          RP.bus.emit('doc:reset');
          this.afterSwitch(null);
        }
      }
      this.syncStrip();
      this.syncEmpty();
      return true;
    },

    /**
     * Ctrl+Shift+T. Walks back up the stack until it finds a drawing that is
     * not already open again, so holding the shortcut down steps through the
     * tabs you closed rather than fighting the "already open" guard.
     */
    async reopenClosed() {
      while (this.closedStack.length) {
        const docPath = this.closedStack.pop();
        if (this.findByPath(docPath)) continue;
        const exists = await window.rp.files.exists(docPath).catch(() => false);
        if (!exists) continue;
        await RP.app.openPath(docPath, { newTab: true });
        return true;
      }
      RP.status('No recently closed drawing to reopen', 'warn');
      return false;
    },

    /** Ask about every dirty tab. Used by the window-close guard. */
    async closeAll() {
      for (const tab of this.all()) {
        if (!(await this.close(tab))) return false;
      }
      return true;
    },

    next(step) {
      const list = this.all();
      if (list.length < 2) return;
      const at = list.indexOf(this.active());
      this.activate(list[(at + step + list.length) % list.length]);
    },

    // =====================================================================
    // Splitting
    // =====================================================================

    /** Put the focused tab in a pane of its own beside the current one. */
    async split(tab) {
      const source = tab || this.active();
      if (!source) return;
      if (this.panes.length >= MAX_PANES) { this.unsplit(); return; }
      if (source.pane.tabs.length < 2 && this.all().length < 2) {
        RP.toast('Open a second drawing to split the view', 'warn');
        return;
      }
      const pane = this.addPane();
      await this.moveToPane(source, pane);
    },

    unsplit() {
      if (this.panes.length < 2) return;
      this.removePane(this.panes[this.panes.length - 1]);
    },

    async moveToPane(tab, pane, opts) {
      if (!tab || !pane || tab.pane === pane) return;
      const from = tab.pane;
      const at = from.tabs.indexOf(tab);
      const wasShowing = from.active === tab;
      from.tabs.splice(at, 1);
      if (wasShowing) {
        tab.view = from.viewer.viewState();
        from.active = null;
        from.viewer.close();
      }
      tab.pane = pane;
      pane.tabs.push(tab);

      if (opts && opts.silent) { this.syncStrip(); return; }

      // The pane it came from needs something on screen before we hand focus to
      // the destination, otherwise it is left showing nothing.
      if (wasShowing && from.tabs.length) {
        await this.activate(from.tabs[Math.min(at, from.tabs.length - 1)]);
      }
      await this.activate(tab);
      if (!from.tabs.length && this.panes.length > 1) this.removePane(from);
    },

    // =====================================================================
    // Per-tab state that lives in shared modules
    // =====================================================================

    /* Search, compare and the page selection are single instances shared by the
       whole app, but they mean something different per document. Rather than
       make three more modules per-session, the state is lifted onto the tab on
       the way out and put back on the way in. */

    stash(tab) {
      if (!tab) return;
      if (RP.search && RP.search.stash) tab.search = RP.search.stash();
      if (RP.textsel && RP.textsel.stash) tab.textsel = RP.textsel.stash();
      if (RP.compare && RP.compare.stash) tab.compare = RP.compare.stash();
      if (RP.pages) tab.pageSel = { selection: new Set(RP.pages.selection), anchor: RP.pages.anchor };
    },

    unstash(tab) {
      if (!tab) return;
      if (RP.search && RP.search.unstash) RP.search.unstash(tab.search);
      if (RP.textsel && RP.textsel.unstash) RP.textsel.unstash(tab.textsel);
      if (RP.compare && RP.compare.unstash) RP.compare.unstash(tab.compare);
      if (RP.pages) {
        RP.pages.selection = new Set(tab.pageSel ? tab.pageSel.selection : []);
        RP.pages.anchor = tab.pageSel ? tab.pageSel.anchor : null;
        RP.pages.sync();
      }
    },

    // =====================================================================
    // Strip
    // =====================================================================

    wireStrip(pane) {
      pane.list.addEventListener('pointerdown', (event) => this.onStripPointerDown(pane, event));
      pane.list.addEventListener('auxclick', (event) => {
        const tab = this.tabFromEvent(pane, event);
        if (tab && event.button === 1) { event.preventDefault(); this.close(tab); }
      });
      pane.list.addEventListener('dblclick', (event) => {
        if (!this.tabFromEvent(pane, event)) RP.app.openDialog({ pane });
      });
    },

    tabFromEvent(pane, event) {
      const el = event.target.closest ? event.target.closest('.tab') : null;
      return el ? pane.tabs.find((t) => t.el === el) || null : null;
    },

    /**
     * Reorder and cross-pane moves are done with raw pointer events rather than
     * HTML5 drag-and-drop, because the window already has a `drop` handler for
     * opening dropped PDFs and a dragged tab would go through it.
     */
    onStripPointerDown(pane, event) {
      if (event.button !== 0) return;
      const tab = this.tabFromEvent(pane, event);
      if (!tab) return;

      if (event.target.closest('.tab-close')) {
        event.preventDefault();
        this.close(tab);
        return;
      }

      this.activate(tab);

      const startX = event.clientX;
      let moved = false;
      const list = pane.list;
      try { list.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }

      const move = (e) => {
        if (!moved && Math.abs(e.clientX - startX) < 5) return;
        moved = true;
        tab.el.classList.add('dragging');
        const overPane = this.paneAt(e.clientX, e.clientY);
        if (overPane && overPane !== tab.pane) {
          // `moveToPane` awaits a page rebuild; without this latch the next
          // pointermove would start a second one on top of the first.
          if (this.moving) return;
          this.moving = true;
          this.moveToPane(tab, overPane).finally(() => { this.moving = false; });
          return;
        }
        const target = this.tabAtX(tab.pane, e.clientX);
        if (target && target !== tab) {
          const tabs = tab.pane.tabs;
          tabs.splice(tabs.indexOf(tab), 1);
          tabs.splice(tabs.indexOf(target), 0, tab);
          this.syncStrip();
        }
      };
      const up = () => {
        list.removeEventListener('pointermove', move);
        list.removeEventListener('pointerup', up);
        list.removeEventListener('pointercancel', up);
        try { list.releasePointerCapture(event.pointerId); } catch (err) { /* ignore */ }
        if (tab.el) tab.el.classList.remove('dragging');
      };
      list.addEventListener('pointermove', move);
      list.addEventListener('pointerup', up);
      list.addEventListener('pointercancel', up);
    },

    paneAt(x, y) {
      return this.panes.find((pane) => {
        const rect = pane.el.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }) || null;
    },

    tabAtX(pane, x) {
      return pane.tabs.find((t) => {
        if (!t.el) return false;
        const rect = t.el.getBoundingClientRect();
        return x >= rect.left && x <= rect.right;
      }) || null;
    },

    syncStrip() {
      // Reachable before init: a store created during boot marks itself clean.
      if (!this.els.host) return;
      for (const pane of this.panes) {
        pane.list.innerHTML = '';
        for (const tab of pane.tabs) {
          const name = tab.store.docName || 'Untitled';
          const el = RP.el('div', {
            class: 'tab' + (pane.active === tab ? ' active' : '') + (tab.store.dirty ? ' dirty' : ''),
            title: tab.store.docPath || name
          }, [
            RP.el('span', { class: 'tab-name', text: name }),
            RP.el('span', { class: 'tab-dot', text: '•' }),
            RP.el('button', { class: 'tab-close', title: 'Close  (Ctrl+W)' }, [RP.icon('close')])
          ]);
          tab.el = el;
          pane.list.appendChild(el);
        }
        pane.strip.classList.toggle('empty', !pane.tabs.length);
      }
      this.els.host.classList.toggle('split', this.panes.length > 1);
      // The strip appears as soon as anything is open, not only once a second
      // document arrives — otherwise "open another" and "split" have nowhere to
      // live and the feature is invisible until you already know about it.
      this.els.host.classList.toggle('tabbed', this.all().length > 0);
      for (const pane of this.panes) {
        const split = pane.strip.querySelector('.tab-split');
        if (split) split.title = this.panes.length > 1
          ? 'Rejoin the panes  (Ctrl+\\)'
          : 'Show two drawings side by side  (Ctrl+\\)';
      }
    },

    syncEmpty() {
      if (!this.els.empty) return;
      this.els.empty.hidden = this.all().length > 0;
    },

    // =====================================================================
    // Shortcuts
    // =====================================================================

    wireShortcuts() {
      document.addEventListener('keydown', (event) => {
        const ctrl = event.ctrlKey || event.metaKey;
        const target = event.target;
        const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

        if (ctrl && event.key === 'Tab') {
          event.preventDefault();
          this.next(event.shiftKey ? -1 : 1);
          return;
        }
        if (ctrl && (event.key === 'PageDown' || event.key === 'PageUp')) {
          event.preventDefault();
          this.next(event.key === 'PageDown' ? 1 : -1);
          return;
        }
        if (ctrl && !typing) {
          const key = event.key.toLowerCase();
          if (key === 't' && event.shiftKey) { event.preventDefault(); this.reopenClosed(); return; }
          if (key === 't') { event.preventDefault(); RP.app.openDialog({ newTab: true }); return; }
          if (key === 'w') { event.preventDefault(); this.close(this.active()); return; }
          if (key === '\\') { event.preventDefault(); this.split(); return; }
        }
        // Ctrl+1/2 are already fit-width and fit-page, so tabs take Alt.
        if (event.altKey && !ctrl && /^[1-9]$/.test(event.key)) {
          const list = this.all();
          const wanted = event.key === '9' ? list[list.length - 1] : list[Number(event.key) - 1];
          if (wanted) { event.preventDefault(); this.activate(wanted); }
        }
      });
    }
  };

  RP.tabs = Tabs;

})(window.RP);
