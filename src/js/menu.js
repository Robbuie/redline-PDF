/* One popup menu for the whole app.

   This started life inside pages.js, which needed a right-click menu on the
   thumbnails. The viewer needs the same thing, and two independent menus would
   mean two sets of dismiss listeners fighting over the same outside-click — so
   the implementation lives here and there is only ever one menu on screen.

   Items are plain objects: {label, run, danger, disabled, checked, hint} or
   {separator: true} or {heading: '...'}. `run` is called after the menu has
   closed, so a handler is free to open another one.

   0.20 added submenus: {label, submenu: [items]}. They exist because the
   right-click menu on the drawing had grown to fifty rows inside a text
   selection — every command was its own row because there was nowhere else
   to put it. A submenu is still part of the *one* menu: it lives on the same
   stack, is dismissed by the same outside-click and the same Escape, and
   closes with its parent. A second, independent popup for the submenu is
   exactly the two-sets-of-listeners problem this file exists to prevent.

   Null entries are dropped, separators at either end or doubled up are
   dropped, and a submenu whose list comes out empty is not shown at all —
   callers build lists with `cond ? item : null` and should not have to tidy
   up after themselves. */
'use strict';

(function (RP) {

  const EDGE = 8;          // px kept between the menu and the window edge
  const OPEN_DELAY = 140;  // hover before a submenu opens
  const CLOSE_DELAY = 260; // grace for a diagonal move from a row into its submenu

  /**
   * Drop nulls, empty submenus, and separators that would sit at an end or
   * next to another separator. A heading followed by nothing is dropped too.
   */
  function tidy(items) {
    const out = [];
    for (const raw of items || []) {
      if (!raw) continue;
      if (raw.submenu) {
        const kids = tidy(raw.submenu);
        if (!kids.some((k) => !k.separator && !k.heading)) continue;
        out.push(Object.assign({}, raw, { submenu: kids }));
        continue;
      }
      if (raw.separator) {
        if (!out.length || out[out.length - 1].separator) continue;
      }
      out.push(raw);
    }
    while (out.length && (out[out.length - 1].separator || out[out.length - 1].heading)) out.pop();
    return out;
  }

  const Menu = {
    /** Root menu element, or null. `stack[0]` is the same element. */
    el: null,
    stack: [],
    onAway: null,
    onKey: null,
    timer: null,

    /**
     * Open at viewport coordinates. Flips rather than clips when the menu would
     * run off the bottom or right, which is what a press near the status bar or
     * in the right-hand pane of a split does.
     */
    open(x, y, items) {
      this.close();
      const list = tidy(items);
      if (!list.length) return null;

      const menu = this.build(list, 0);
      document.body.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)) + 'px';
      menu.style.top = Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE)) + 'px';
      this.el = menu;
      this.stack = [menu];

      this.onAway = (event) => {
        if (event.type === 'blur' || !this.stack.some((m) => m.contains(event.target))) this.close();
      };
      this.onKey = (event) => this.key(event);
      // Deferred by a turn, or the very pointerdown that opened this menu would
      // be the one that dismisses it.
      setTimeout(() => {
        if (this.el !== menu) return;
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

    /** Build one level. `level` is its index in the stack once shown. */
    build(list, level) {
      const menu = RP.el('div', { class: 'ctx-menu', role: 'menu' });
      menu.dataset.level = String(level);
      // Moving into a submenu cancels the pending close its parent row started.
      menu.addEventListener('pointerenter', () => this.clearTimer());

      for (const item of list) {
        if (item.separator) {
          menu.appendChild(RP.el('div', { class: 'ctx-sep' }));
          continue;
        }
        if (item.heading) {
          menu.appendChild(RP.el('div', { class: 'ctx-head', text: item.heading }));
          continue;
        }
        if (item.submenu) {
          menu.appendChild(this.buildParent(item, level));
          continue;
        }
        const button = RP.el('button', {
          class: 'ctx-item' +
            (item.danger ? ' danger' : '') +
            // A row that *could* be ticked keeps the tick's room either way,
            // so a list of choices lines up whichever one is picked.
            (typeof item.checked === 'boolean' ? ' checkable' : '') +
            (item.checked ? ' checked' : ''),
          role: 'menuitem',
          title: item.title || null,
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
        // Hovering an ordinary row closes any submenu open beside it, after a
        // grace period so a diagonal move toward that submenu survives.
        button.addEventListener('pointerenter', () => this.schedule(() => this.truncate(level + 1), CLOSE_DELAY));

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
      return menu;
    },

    /** A row that opens a submenu: on hover, on click, and on ArrowRight. */
    buildParent(item, level) {
      const button = RP.el('button', {
        class: 'ctx-item ctx-parent',
        role: 'menuitem',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: item.title || null,
        onclick: () => { this.clearTimer(); this.openSub(button, item.submenu, level + 1, false); }
      }, [
        RP.el('span', { class: 'ctx-label', text: item.label }),
        item.hint ? RP.el('span', { class: 'ctx-hint', text: item.hint }) : null,
        RP.icon('chev', 'ctx-chev')
      ]);
      button.addEventListener('pointerenter', () => {
        if (button.getAttribute('aria-expanded') === 'true') { this.clearTimer(); return; }
        this.schedule(() => this.openSub(button, item.submenu, level + 1, false), OPEN_DELAY);
      });
      return button;
    },

    /**
     * Show `items` beside `row` as stack level `level`, closing anything at
     * that level or deeper first. Opens to the right, and to the left when the
     * right would run off the window — the right-hand pane of a split.
     */
    openSub(row, items, level, focusFirst) {
      if (!this.el) return;
      if (this.stack[level] && this.stack[level].dataset.owner === row.dataset.ownerId) {
        if (focusFirst) this.focusIn(this.stack[level], 1);
        return;
      }
      this.truncate(level);
      const sub = this.build(items, level);
      if (!row.dataset.ownerId) row.dataset.ownerId = RP.uid('menu');
      sub.dataset.owner = row.dataset.ownerId;
      sub.classList.add('ctx-sub');
      document.body.appendChild(sub);

      const r = row.getBoundingClientRect();
      const s = sub.getBoundingClientRect();
      let left = r.right - 2;
      if (left + s.width > window.innerWidth - EDGE) left = Math.max(EDGE, r.left - s.width + 2);
      // Lined up so the first row of the submenu sits level with its parent:
      // 4px menu padding plus the 1px border.
      const top = Math.max(EDGE, Math.min(r.top - 5, window.innerHeight - s.height - EDGE));
      sub.style.left = left + 'px';
      sub.style.top = top + 'px';

      row.setAttribute('aria-expanded', 'true');
      row.classList.add('open');
      this.stack[level] = sub;
      if (focusFirst) this.focusIn(sub, 1);
    },

    /** Close every menu at `level` and deeper. */
    truncate(level) {
      while (this.stack.length > level && this.stack.length > 1) {
        const sub = this.stack.pop();
        sub.remove();
        const owner = this.stack[this.stack.length - 1]
          .querySelector('.ctx-parent[data-owner-id="' + sub.dataset.owner + '"]');
        if (owner) { owner.setAttribute('aria-expanded', 'false'); owner.classList.remove('open'); }
      }
    },

    schedule(fn, delay) {
      this.clearTimer();
      this.timer = setTimeout(() => { this.timer = null; fn(); }, delay);
    },

    clearTimer() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    },

    /** Move keyboard focus through the enabled rows of one menu level. */
    focusIn(menu, dir) {
      const rows = Array.from(menu.querySelectorAll('.ctx-item:not(:disabled)'));
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement);
      const next = at < 0 ? (dir > 0 ? 0 : rows.length - 1) : (at + dir + rows.length) % rows.length;
      rows[next].focus();
    },

    key(event) {
      const top = this.stack[this.stack.length - 1];
      if (!top) return;
      const k = event.key;
      if (k === 'Escape' || (k === 'ArrowLeft' && this.stack.length > 1)) {
        event.preventDefault();
        event.stopPropagation();
        if (this.stack.length > 1) {
          const sub = this.stack[this.stack.length - 1];
          this.truncate(this.stack.length - 1);
          const owner = this.stack[this.stack.length - 1]
            .querySelector('.ctx-parent[data-owner-id="' + sub.dataset.owner + '"]');
          if (owner) owner.focus();
        } else {
          this.close();
        }
        return;
      }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        this.focusIn(top, k === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (k === 'ArrowRight') {
        const row = document.activeElement;
        if (row && row.classList && row.classList.contains('ctx-parent') && top.contains(row)) {
          event.preventDefault();
          event.stopPropagation();
          row.click();
          const sub = this.stack[this.stack.length - 1];
          if (sub !== top) this.focusIn(sub, 1);
        }
        return;
      }
      // Enter and Space reach the focused <button> natively. Anything else is
      // swallowed only if it would otherwise drive the drawing underneath.
      if (k !== 'Enter' && k !== ' ' && k !== 'Tab') event.stopPropagation();
    },

    close() {
      this.clearTimer();
      if (!this.el) return;
      for (const m of this.stack) m.remove();
      this.stack = [];
      this.el = null;
      window.removeEventListener('pointerdown', this.onAway, true);
      window.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('blur', this.onAway);
    },

    isOpen() { return !!this.el; }
  };

  Menu.tidy = tidy;
  RP.menu = Menu;

})(window.RP);
