/* Sidebar: panel switching, the live markup list, and the recents list on the
   empty state. */
'use strict';

(function (RP) {

  const Sidebar = {
    panel: 'thumbs',
    // These three describe *one document's* markup list, not the app's, so they
    // are lifted onto the outgoing tab and put back on the incoming one by
    // RP.tabs.stash/unstash. Leaving them here alone meant a status filter — or
    // a typed filter, which had the same bug before — narrowing another
    // drawing's list the moment you switched to it.
    filter: '',
    sort: 'page',
    status: 'all',

    init() {
      RP.$$('.side-tab[data-panel]').forEach((tab) => {
        tab.addEventListener('click', () => this.show(tab.dataset.panel));
      });

      RP.$('#sideCollapse').addEventListener('click', () => {
        RP.$('#sidebar').classList.toggle('collapsed');
      });

      const filterInput = RP.$('#markupFilter');
      filterInput.addEventListener('input', RP.debounce(() => {
        this.filter = filterInput.value.trim().toLowerCase();
        this.renderMarkups();
      }, 120));

      const sortSelect = RP.$('#markupSort');
      sortSelect.addEventListener('change', () => {
        this.sort = sortSelect.value;
        this.renderMarkups();
      });

      const statusSelect = RP.$('#markupStatus');
      statusSelect.addEventListener('change', () => {
        this.status = statusSelect.value;
        this.renderMarkups();
      });

      RP.bus.on('annots:changed', () => this.renderMarkups());
      RP.bus.on('selection:changed', () => this.syncSelection());
      RP.bus.on('doc:loaded', () => this.renderMarkups());
    },

    show(panel) {
      this.panel = panel;
      const sidebar = RP.$('#sidebar');
      sidebar.classList.remove('collapsed');
      RP.$$('.side-tab[data-panel]').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panel));
      RP.$$('.side-panel').forEach((section) => section.classList.toggle('active', section.dataset.panel === panel));
      if (panel === 'search') setTimeout(() => RP.$('#searchInput').focus(), 30);
    },

    // -- markup list -------------------------------------------------------

    describe(annot) {
      if (annot.type === 'note') return annot.note || '(empty note)';
      if (annot.type === 'text' || annot.type === 'callout') return annot.text || '(no text)';
      // The three text markups all carry the words they were made from, which
      // is what makes the markup list searchable by what was marked up rather
      // than only by where.
      if (annot.type === 'highlight' || annot.type === 'strikeout' || annot.type === 'underline') {
        return annot.text || annot.note || '';
      }
      if (annot.type === 'measure') {
        const len = RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2);
        return (annot.label || RP.store.formatLength(len)) + (annot.note ? ' — ' + annot.note : '');
      }
      return annot.note || '';
    },

    visibleAnnotations() {
      let list = RP.store.annotations.slice();
      if (this.status !== 'all') {
        list = list.filter((a) => RP.statusOf(a) === this.status);
      }
      if (this.filter) {
        list = list.filter((a) => {
          // The status word is searchable but deliberately not part of
          // `describe()`: that string is also the row's own text and the status
          // bar's line, and folding "closed" into it would print the state
          // twice on screen to make it typeable once.
          const haystack = [
            RP.store.typeLabel(a.type),
            RP.STATUS_LABELS[RP.statusOf(a)],
            this.describe(a),
            a.author || '',
            'page ' + (a.page + 1)
          ].join(' ').toLowerCase();
          return haystack.includes(this.filter);
        });
      }
      if (this.sort === 'created') list.sort((a, b) => b.created - a.created);
      else if (this.sort === 'type') list.sort((a, b) => (a.type + a.page).localeCompare(b.type + b.page) || a.page - b.page);
      else list.sort((a, b) => a.page - b.page || b.created - a.created);
      return list;
    },

    renderMarkups() {
      const list = RP.$('#markupList');
      const count = RP.$('#markupCount');
      if (!list) return;
      const items = this.visibleAnnotations();
      // The count is what is left to do, not what exists — an all-closed
      // drawing reading "12" is the opposite of the answer a punch list wants.
      const counts = RP.store.statusCounts();
      if (count) {
        count.textContent = counts.open + ' / ' + RP.store.annotations.length;
        count.title = RP.STATUSES
          .map((key) => counts[key] + ' ' + RP.STATUS_LABELS[key].toLowerCase())
          .join(' · ');
      }
      list.innerHTML = '';

      if (!RP.store.annotations.length) {
        list.appendChild(RP.el('div', {
          class: 'side-empty',
          text: 'No markups yet. Pick a tool and mark up the drawing — everything you add lands here.'
        }));
        return;
      }
      if (!items.length) {
        list.appendChild(RP.el('div', { class: 'side-empty', text: 'Nothing matches that filter.' }));
        return;
      }

      for (const annot of items) {
        const note = this.describe(annot);
        const status = RP.statusOf(annot);
        const row = RP.el('button', {
          class: 'markup-row st-' + status + (RP.store.selection.has(annot.id) ? ' active' : ''),
          'data-id': annot.id,
          onclick: (e) => this.focusAnnot(annot, e.shiftKey),
          ondblclick: () => {
            if (annot.type === 'note') RP.tools.openNotePopup(annot);
          }
        }, [
          RP.el('span', { class: 'mk-dot', style: { background: annot.color || '#ff2f2f' } }),
          RP.el('span', { class: 'mk-main' }, [
            RP.el('span', { class: 'mk-type', text: RP.store.typeLabel(annot.type) }),
            note ? RP.el('span', { class: 'mk-note', text: note }) : null
          ]),
          RP.el('span', { class: 'mk-meta' }, [
            RP.el('span', { text: 'p' + (annot.page + 1) }),
            // Open is the default and goes unmarked — badging every row of a
            // fresh review says nothing.
            status === 'open' ? null : RP.el('span', {
              class: 'mk-status ' + status,
              text: RP.STATUS_LABELS[status]
            })
          ])
        ]);
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (!RP.store.selection.has(annot.id)) RP.store.select(annot.id);
          RP.menu.open(event.clientX, event.clientY, RP.app.statusMenuItems());
        });
        list.appendChild(row);
      }
    },

    /* Per-document list state, lifted onto the tab on the way out and put back
       on the way in. The DOM controls are re-synced here rather than by the
       caller, because the value and the control that shows it have to move
       together — a restored filter that the box does not display is worse than
       one that did not restore. */
    stash() {
      return { filter: this.filter, sort: this.sort, status: this.status };
    },

    unstash(state) {
      const next = state || { filter: '', sort: 'page', status: 'all' };
      this.filter = next.filter || '';
      this.sort = next.sort || 'page';
      this.status = next.status || 'all';
      const filterInput = RP.$('#markupFilter');
      const sortSelect = RP.$('#markupSort');
      const statusSelect = RP.$('#markupStatus');
      if (filterInput) filterInput.value = this.filter;
      if (sortSelect) sortSelect.value = this.sort;
      if (statusSelect) statusSelect.value = this.status;
      this.renderMarkups();
    },

    focusAnnot(annot, additive) {
      RP.store.select(annot.id, additive);
      RP.tools.setTool('select');
      const box = RP.render.bbox(annot);
      RP.viewer.revealRect(annot.page, {
        x: box.x - 20, y: box.y - 20, w: box.w + 40, h: box.h + 40
      });
    },

    syncSelection() {
      RP.$$('#markupList .markup-row').forEach((row) => {
        row.classList.toggle('active', RP.store.selection.has(row.dataset.id));
      });
    },

    // -- recents -----------------------------------------------------------

    /**
     * The empty state's recents list. Entries arrive already in display order
     * — pinned first — from main, so this only has to draw them.
     *
     * Pin and remove are per row here as well as in the toolbar dropdown,
     * because this is the list you are looking at when you first open the app
     * and notice the baseline you want to keep.
     */
    renderRecents(recents) {
      const host = RP.$('#recentList');
      if (!host) return;
      host.innerHTML = '';
      if (!recents || !recents.length) return;
      host.appendChild(RP.el('div', { class: 'recents-title', text: 'Recent drawings' }));

      for (const entry of recents.slice(0, 6)) {
        const open = RP.el('button', {
          class: 'recent-row',
          title: entry.path,
          onclick: () => RP.app.openPath(entry.path)
        }, [
          RP.icon('open'),
          RP.el('span', { class: 'rp', text: entry.name || RP.basename(entry.path) }),
          RP.el('span', { class: 'rd', text: entry.pinned ? 'pinned' : RP.fmtRelative(entry.openedAt) })
        ]);

        const mini = (text, title, on, run) => RP.el('button', {
          class: 'recent-mini' + (on ? ' on' : ''),
          title,
          text,
          onclick: (event) => { event.stopPropagation(); run(); }
        });

        host.appendChild(RP.el('div', { class: 'recent-item' }, [
          open,
          mini('📌', entry.pinned ? 'Unpin' : 'Pin to the top of the list', entry.pinned, async () => {
            const list = await window.rp.recents.pin(entry.path, !entry.pinned);
            RP.app.settings.recents = list;
            this.renderRecents(list);
          }),
          mini('✕', 'Remove from this list', false, async () => {
            const list = await window.rp.recents.remove(entry.path);
            RP.app.settings.recents = list;
            this.renderRecents(list);
          })
        ]));
      }
    }
  };

  RP.sidebar = Sidebar;

})(window.RP);
