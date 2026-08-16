/* The keyboard shortcut cheat sheet, opened with `?`.

   The table below is documentation, not wiring — the bindings themselves live
   where they are handled (`App.wireShortcuts`, `RP.tabs.wireShortcuts`,
   `RP.tools`, `RP.pages`). That split is deliberate: a shortcut belongs next to
   the thing it drives, but a user looking for "how do I get to the last page"
   needs one list, not five.

   Keeping the two in step is a manual job. If you add a binding, add a row. */
'use strict';

(function (RP) {

  const GROUPS = [
    {
      title: 'File',
      keys: [
        ['Ctrl+O', 'Open a drawing'],
        ['Ctrl+T', 'Open another drawing in a new tab'],
        ['Ctrl+W', 'Close the current tab'],
        ['Ctrl+Shift+T', 'Reopen the tab you just closed'],
        ['Ctrl+S', 'Save'],
        ['Ctrl+Shift+S', 'Save a copy…'],
        ['Ctrl+P', 'Print']
      ]
    },
    {
      title: 'Navigate',
      keys: [
        ['Ctrl+G', 'Go to page'],
        ['Home / End', 'First / last page'],
        ['Page Up / Down', 'Previous / next sheet — or spread, when two are facing'],
        ['← / →', 'Previous / next sheet'],
        ['↑ / ↓', 'Up / down the sheet — turns over at the edge of the paper'],
        ['Ctrl+Tab', 'Next tab'],
        ['Alt+1…9', 'Jump to a tab'],
        ['Ctrl+\\', 'Split the view in two'],
        ['Space+drag', 'Pan from any tool'],
        ['Middle-drag', 'Pan from any tool']
      ]
    },
    {
      title: 'View',
      keys: [
        ['Ctrl+=  /  Ctrl+-', 'Zoom in / out'],
        ['Ctrl+wheel', 'Zoom at the pointer'],
        ['Ctrl+0', 'Actual size'],
        ['Ctrl+1', 'Fit width'],
        ['Ctrl+2', 'Fit page'],
        ['Ctrl+3', 'Fit visible — fits the ink, not the paper'],
        ['F11', 'Presentation mode'],
        ['Ctrl+Shift+N', 'Cycle paper display (invert, greyscale, glare, contrast)'],
        ['Ctrl+F', 'Find in the drawing'],
        ['F3 / Shift+F3', 'Next / previous hit']
      ]
    },
    {
      title: 'Tools',
      keys: [
        ['V', 'Select'],
        ['H', 'Highlight'],
        ['X', 'Select text by dragging a box'],
        ['N', 'Sticky note'],
        ['P', 'Pen'],
        ['L', 'Line'],
        ['A', 'Arrow'],
        ['R', 'Box'],
        ['E', 'Oval'],
        ['C', 'Revision cloud'],
        ['T', 'Typewriter text'],
        ['O', 'Callout'],
        ['M', 'Measure'],
        ['Y', 'Polyline'],
        ['D', 'Run length — a measurement with bends'],
        ['Q', 'Area and perimeter'],
        ['G', 'Pan'],
        ['Z', 'Zoom to a box'],
        ['S', 'Copy an area as a picture']
      ]
    },
    {
      title: 'Pages',
      keys: [
        ['Ctrl+]', 'Rotate this page right — the page itself, so it saves'],
        ['Ctrl+[', 'Rotate this page left'],
        ['Right-click a sheet', 'Rotate, turn over, or straighten the whole set'],
        ['Toolbar ↻', 'Rotate the view only — the file is untouched']
      ]
    },
    {
      title: 'Markups',
      keys: [
        ['Ctrl+C', 'Copy the selected markups — or the selected text'],
        ['Ctrl+X', 'Cut the selected markups'],
        ['Ctrl+V', 'Paste under the pointer — any sheet, any open drawing'],
        ['Ctrl+Shift+G', 'Group the selection — it then moves and styles as one'],
        ['Ctrl+Shift+U', 'Ungroup'],
        ['Right-click 2+', 'Group, align, distribute, match size or style'],
        ['Right-click text', 'Highlight, strike out, underline, cloud, copy…'],
        ['Ctrl+A', 'Select every markup on this page'],
        ['Ctrl+Z', 'Undo'],
        ['Ctrl+Y', 'Redo'],
        ['Delete', 'Delete the selection'],
        ['Shift+drag', 'Constrain, or add to the selection'],
        ['Double-click', 'Edit a markup’s text or comment'],
        ['Enter', 'Finish the text, callout or shape being drawn'],
        ['Shift+Enter', 'New line inside a text or callout'],
        ['Backspace', 'Undo the last point of a shape being drawn'],
        ['Double-click a tool', 'Lock it on — it draws one markup otherwise'],
        ['Right-click', 'Context menu — or finish the shape being drawn'],
        ['Esc', 'Abandon the shape being drawn, or clear the selection']
      ]
    },
    {
      title: 'Windows',
      keys: [
        ['?', 'This list'],
        ['Ctrl+Shift+D', 'Diagnostics and log'],
        ['Esc', 'Close whatever is open']
      ]
    }
  ];

  const Keys = {
    el: null,

    toggle() { if (this.el) this.close(); else this.show(); },

    show() {
      if (this.el) return;
      const backdrop = RP.el('div', { class: 'modal-backdrop' });
      const modal = RP.el('div', { class: 'modal keys-modal' }, [
        RP.el('header', {}, [
          RP.el('h2', { text: 'Keyboard shortcuts' }),
          RP.el('button', { class: 'np-close', onclick: () => this.close() }, [RP.icon('close')])
        ]),
        RP.el('div', { class: 'modal-body' }, [
          RP.el('div', { class: 'keys-cols' }, GROUPS.map((group) =>
            RP.el('div', { class: 'keys-group' }, [
              RP.el('h3', { text: group.title })
            ].concat(group.keys.map(([combo, what]) =>
              RP.el('div', { class: 'keys-row' }, [
                RP.el('span', { class: 'keys-what', text: what }),
                RP.el('kbd', { text: combo })
              ])
            )))
          ))
        ])
      ]);

      backdrop.appendChild(modal);
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) this.close(); });
      document.body.appendChild(backdrop);
      this.el = backdrop;

      this.onKey = (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); this.close(); }
      };
      document.addEventListener('keydown', this.onKey, true);
    },

    close() {
      if (!this.el) return;
      this.el.remove();
      this.el = null;
      document.removeEventListener('keydown', this.onKey, true);
    },

    isOpen() { return !!this.el; }
  };

  RP.keys = Keys;

})(window.RP);
