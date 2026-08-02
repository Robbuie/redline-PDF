/* Sidebar: panel switching, the live markup list, and the recents list on the
   empty state. */
'use strict';

(function (RP) {

  const Sidebar = {
    panel: 'thumbs',
    filter: '',
    sort: 'page',

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
      if (annot.type === 'highlight') return annot.text || annot.note || '';
      if (annot.type === 'measure') {
        const len = RP.geom.dist(annot.x1, annot.y1, annot.x2, annot.y2);
        return (annot.label || RP.store.formatLength(len)) + (annot.note ? ' — ' + annot.note : '');
      }
      return annot.note || '';
    },

    visibleAnnotations() {
      let list = RP.store.annotations.slice();
      if (this.filter) {
        list = list.filter((a) => {
          const haystack = [
            RP.store.typeLabel(a.type),
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
      if (count) count.textContent = String(RP.store.annotations.length);
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
        const row = RP.el('button', {
          class: 'markup-row' + (RP.store.selection.has(annot.id) ? ' active' : ''),
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
          RP.el('span', { class: 'mk-meta', text: 'p' + (annot.page + 1) })
        ]);
        list.appendChild(row);
      }
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
