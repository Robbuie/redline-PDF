/* Bookmarks: the outline tree the document already carries.

   A spec book or a drawing set is the one thing in this app that genuinely
   needs navigating, and until now the only ways through a 400-sheet PDF were
   the scrollbar and the thumbnail strip. Every set that came out of a plan
   room has an outline; `doc.getOutline()` was simply never called.

   Nothing here is editable and nothing here is saved. The outline lives in the
   base bytes, exactly like RP.annots' native annotations, and this module only
   reads it. Destinations are followed through RP.annots.goToDestination so the
   untrusted-input handling — named-destination lookup, page-ref resolution,
   external URLs going out over IPC for confirmation — stays in one place.

   Two things are deliberate. Child rows are built into the DOM on first
   expand, because a large spec book has thousands of entries and building all
   of them up front costs a visible pause on open. And page numbers resolve in
   a background pass rather than on demand, because the current-page highlight
   needs the page of every entry, not just the visible ones. */
'use strict';

(function (RP) {

  const Outline = {
    /** Flat list of nodes in document order; the tree is in `.children`. */
    items: [],
    /** The doc proxy `items` were read from, so stale passes can bail. */
    docFor: null,
    activeId: null,

    _seq: 0,
    _pass: 0,
    els: null,

    init() {
      this.els = {
        tab: RP.$('.side-tab[data-panel="outline"]'),
        list: RP.$('#outlineList'),
        count: RP.$('#outlineCount'),
        expandAll: RP.$('#outlineExpand'),
        collapseAll: RP.$('#outlineCollapse')
      };
      if (!this.els.list) return;

      this.els.expandAll.addEventListener('click', () => this.setAllOpen(true));
      this.els.collapseAll.addEventListener('click', () => this.setAllOpen(false));

      RP.bus.on('doc:reset', () => this.clear());
      RP.bus.on('doc:loaded', () => this.load());
      // A page rebuild produces a fresh doc proxy whose outline may be gone
      // (pdf-lib does not copy one), so re-read rather than keep stale dests.
      RP.bus.on('pages:rebuilt', () => this.load());
      RP.bus.on('page:changed', (index) => this.syncCurrent(index));

      this.showTab(false);
    },

    // -- loading -----------------------------------------------------------

    clear() {
      this._pass += 1;
      this.items = [];
      this.docFor = null;
      this.activeId = null;
      if (this.els && this.els.list) this.els.list.innerHTML = '';
      if (this.els && this.els.count) this.els.count.textContent = '';
      this.showTab(false);
    },

    async load() {
      const doc = RP.store.doc;
      this.clear();
      if (!doc) return;

      const pass = this._pass;
      let tree = null;
      try {
        tree = await doc.getOutline();
      } catch (err) {
        console.warn('Could not read the document outline', err);
        return;
      }
      if (pass !== this._pass || doc !== RP.store.doc) return;   // superseded
      if (!Array.isArray(tree) || !tree.length) return;

      this.docFor = doc;
      this.items = [];
      const roots = this.flatten(tree, 0, null);

      this.els.count.textContent = String(this.items.length);
      this.showTab(true);
      this.renderInto(this.els.list, roots);
      this.resolvePages(doc, pass);
    },

    /** pdf.js outline -> our node objects, pushed into `items` in doc order. */
    flatten(nodes, depth, parent) {
      const out = [];
      for (const node of nodes) {
        this._seq += 1;
        const item = {
          id: 'ol' + this._seq,
          title: (node.title || '').replace(/\s+/g, ' ').trim() || '(untitled)',
          dest: node.dest === undefined ? null : node.dest,
          url: node.unsafeUrl || null,
          bold: !!node.bold,
          italic: !!node.italic,
          depth,
          parent,
          children: [],
          // pdf.js passes the /Count through: positive means the file asks for
          // this branch to open. Absent or negative means closed, which is the
          // sane default anyway for a set with thousands of sheets.
          open: typeof node.count === 'number' && node.count > 0,
          page: null,
          row: null,
          twist: null,
          pageEl: null,
          kidsHost: null,
          built: false
        };
        this.items.push(item);
        if (node.items && node.items.length) {
          item.children = this.flatten(node.items, depth + 1, item);
        }
        out.push(item);
      }
      return out;
    },

    /**
     * Walk every entry once and remember which page it lands on. This is what
     * makes the current-page highlight possible; it also lets a row show its
     * sheet number. Yields to the event loop so a huge spec book does not
     * freeze the window while it resolves.
     */
    async resolvePages(doc, pass) {
      let sinceYield = 0;
      for (const item of this.items) {
        if (pass !== this._pass) return;
        item.page = await pageOfDest(doc, item.dest);
        if (item.page !== null && item.pageEl) {
          item.pageEl.textContent = 'p' + (item.page + 1);
        }
        sinceYield += 1;
        if (sinceYield >= 25) {
          sinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (pass === this._pass) this.syncCurrent(RP.viewer.currentPage);
    },

    // -- rendering ---------------------------------------------------------

    renderInto(host, nodes) {
      host.innerHTML = '';
      for (const item of nodes) host.appendChild(this.buildNode(item));
    },

    buildNode(item) {
      const hasKids = item.children.length > 0;

      item.twist = hasKids
        ? RP.el('button', {
          class: 'ol-twist',
          type: 'button',
          'aria-label': 'Expand or collapse',
          onclick: (event) => { event.stopPropagation(); this.toggle(item); }
        }, [RP.icon('chev')])
        : RP.el('span', { class: 'ol-twist empty' });

      item.pageEl = RP.el('span', {
        class: 'ol-pg',
        text: item.page === null ? '' : 'p' + (item.page + 1)
      });

      item.row = RP.el('button', {
        class: 'ol-row',
        type: 'button',
        title: item.title,
        onclick: () => this.activate(item),
        ondblclick: () => { if (item.children.length) this.toggle(item); }
      }, [
        RP.el('span', {
          class: 'ol-title' + (item.bold ? ' bold' : '') + (item.italic ? ' italic' : ''),
          text: item.title
        }),
        item.pageEl
      ]);

      item.kidsHost = RP.el('div', { class: 'ol-kids' });
      const node = RP.el('div', { class: 'ol-node', 'data-id': item.id }, [
        RP.el('div', {
          class: 'ol-head' + (hasKids ? ' has-kids' : ''),
          style: { paddingLeft: (4 + item.depth * 13) + 'px' }
        }, [item.twist, item.row]),
        item.kidsHost
      ]);

      if (item.open && hasKids) this.buildKids(item);
      this.paintOpen(item);
      return node;
    },

    /** Children get DOM the first time the branch is opened, not before. */
    buildKids(item) {
      if (item.built || !item.children.length || !item.kidsHost) return;
      item.built = true;
      for (const child of item.children) item.kidsHost.appendChild(this.buildNode(child));
    },

    paintOpen(item) {
      if (!item.children.length || !item.kidsHost) return;
      const open = !!item.open;
      item.kidsHost.hidden = !open;
      item.twist.classList.toggle('open', open);
      item.row.setAttribute('aria-expanded', open ? 'true' : 'false');
    },

    toggle(item, force) {
      if (!item.children.length) return;
      item.open = force === undefined ? !item.open : !!force;
      if (item.open) this.buildKids(item);
      this.paintOpen(item);
    },

    setAllOpen(open) {
      for (const item of this.items) {
        if (!item.children.length) continue;
        item.open = open;
        if (item.row) {           // only branches already in the DOM can paint
          if (open) this.buildKids(item);
          this.paintOpen(item);
        }
      }
    },

    // -- navigation --------------------------------------------------------

    activate(item) {
      this.setActive(item.id);
      if (item.dest !== null && item.dest !== '') {
        RP.annots.goToDestination(item.dest);
      } else if (item.url) {
        // A bookmark can carry a URI action instead of a destination. Same
        // untrusted-input path as a link annotation: main confirms it first.
        RP.annots.openExternal(item.url);
      } else {
        RP.toast('That bookmark has no destination', 'warn');
      }
    },

    setActive(id) {
      this.activeId = id;
      for (const item of this.items) {
        if (item.row) item.row.classList.toggle('active', item.id === id);
      }
    },

    /**
     * Highlight the entry that owns the page in view: the last one, in reading
     * order, that starts on or before it. Ancestors are opened so the
     * highlight is actually visible, but only while the panel is on screen —
     * expanding a tree nobody is looking at just loses their place.
     */
    syncCurrent(pageIndex) {
      if (!this.items.length || typeof pageIndex !== 'number') return;
      let match = null;
      for (const item of this.items) {
        if (item.page === null || item.page > pageIndex) continue;
        match = item;
      }
      if (!match || match.id === this.activeId) return;

      const visible = RP.sidebar.panel === 'outline'
        && !RP.$('#sidebar').classList.contains('collapsed');
      if (visible) {
        // Outermost first: a branch cannot build its children until it has a
        // host of its own, and that only exists once its parent is open.
        const chain = [];
        for (let parent = match.parent; parent; parent = parent.parent) chain.unshift(parent);
        for (const parent of chain) if (!parent.open) this.toggle(parent, true);
      }
      this.setActive(match.id);
      if (visible && match.row) {
        match.row.scrollIntoView({ block: 'nearest' });
      }
    },

    // -- chrome ------------------------------------------------------------

    /** No outline, no tab. An empty panel is worse than a missing one. */
    showTab(on) {
      if (!this.els || !this.els.tab) return;
      this.els.tab.hidden = !on;
      if (!on && RP.sidebar.panel === 'outline') RP.sidebar.show('thumbs');
    },

    // exposed for tests
    pageOfDest
  };

  /** Destination (named or explicit) -> zero-based page index, or null. */
  async function pageOfDest(doc, dest) {
    if (!doc || dest === null || dest === undefined || dest === '') return null;
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      return await RP.annots.resolvePageIndex(doc, explicit[0]);
    } catch (err) {
      return null;   // a broken bookmark is not worth a banner
    }
  }

  RP.outline = Outline;

})(window.RP);
