/* One popup menu for the whole app.

   This started life inside pages.js, which needed a right-click menu on the
   thumbnails. The viewer needs the same thing, and two independent menus would
   mean two sets of dismiss listeners fighting over the same outside-click — so
   the implementation lives here and there is only ever one menu on screen.

   Items are plain objects: {label, run, danger, disabled, checked, hint} or
   {separator: true}. `run` is called after the menu has closed, so a handler is
   free to open another one. */
'use strict';

(function (RP) {

  const EDGE = 8;   // px kept between the menu and the window edge

  const Menu = {
    el: null,
    onAway: null,
    onKey: null,

    /**
     * Open at viewport coordinates. Flips rather than clips when the menu would
     * run off the bottom or right, which is what a press near the status bar or
     * in the right-hand pane of a split does.
     */
    open(x, y, items) {
      this.close();
      const list = (items || []).filter(Boolean);
      if (!list.length) return null;

      const menu = RP.el('div', { class: 'ctx-menu', role: 'menu' });
      for (const item of list) {
        if (item.separator) {
          menu.appendChild(RP.el('div', { class: 'ctx-sep' }));
          continue;
        }
        if (item.heading) {
          menu.appendChild(RP.el('div', { class: 'ctx-head', text: item.heading }));
          continue;
        }
        const button = RP.el('button', {
          class: 'ctx-item' +
            (item.danger ? ' danger' : '') +
            (item.checked ? ' checked' : ''),
          role: 'menuitem',
          disabled: item.disabled ? true : null,
          onclick: () => {
            // Closed first: a handler may want to open a menu of its own, and
            // it would otherwise be torn down again by this call.
            this.close();
            if (typeof item.run === 'function') item.run();
          }
        }, [
          RP.el('span', { class: 'ctx-label', text: item.label }),
          item.hint ? RP.el('span', { class: 'ctx-hint', text: item.hint }) : null
        ]);

        // Trailing per-row buttons — pin and remove on a recents entry. They
        // sit inside the menu, so their own click must not also fire the row.
        if (item.actions && item.actions.length) {
          const row = RP.el('div', { class: 'ctx-row' }, [button]);
          for (const action of item.actions) {
            row.appendChild(RP.el('button', {
              class: 'ctx-mini' + (action.on ? ' on' : ''),
              title: action.title || '',
              text: action.text || '',
              onclick: (event) => {
                event.stopPropagation();
                // Deliberately left open: pinning three drawings in a row
                // should not mean opening the menu three times.
                if (action.keepOpen) { action.run(); return; }
                this.close();
                action.run();
              }
            }));
          }
          menu.appendChild(row);
          continue;
        }
        menu.appendChild(button);
      }

      document.body.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)) + 'px';
      menu.style.top = Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE)) + 'px';
      this.el = menu;

      this.onAway = (event) => { if (!menu.contains(event.target)) this.close(); };
      this.onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } };
      // Deferred by a turn, or the very pointerdown that opened this menu would
      // be the one that dismisses it.
      setTimeout(() => {
        window.addEventListener('pointerdown', this.onAway, true);
        window.addEventListener('keydown', this.onKey, true);
        window.addEventListener('blur', this.onAway);
      }, 0);
      return menu;
    },

    /** Open directly below an element — for dropdowns hung off a toolbar button. */
    openUnder(anchorEl, items) {
      if (!anchorEl) return null;
      const rect = anchorEl.getBoundingClientRect();
      return this.open(rect.left, rect.bottom + 4, items);
    },

    close() {
      if (!this.el) return;
      this.el.remove();
      this.el = null;
      window.removeEventListener('pointerdown', this.onAway, true);
      window.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('blur', this.onAway);
    },

    isOpen() { return !!this.el; }
  };

  RP.menu = Menu;

})(window.RP);
