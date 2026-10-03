/* Writing a real .xlsx, without a dependency.
 *
 * A workbook is a ZIP of XML parts, and the subset Excel needs to open one is
 * small enough to write by hand — five parts and a container. The alternative
 * was a library, and in this app that is not one dependency: the smallest
 * credible writer pulls in nine direct and about forty transitive packages,
 * every one of which needs its own entry in the hand-maintained `build.files`
 * array or it is simply absent from the installer and the feature throws on a
 * machine that is not this one. That failure mode has already cost this project
 * a release. Two hundred lines here buys the whole feature with nothing to keep
 * in step.
 *
 * Entries are **stored, not deflated**. A schedule is a few kilobytes of XML,
 * the saving would be invisible, and STORE keeps `build` pure and synchronous —
 * the browser's only deflate is `CompressionStream`, which is async and would
 * push that all the way up through the export path for no gain. If a workbook
 * ever gets big enough to care, that is the one line to revisit.
 *
 * Everything here is pure; `test/verify.js` unzips what it produces.
 */
(function (RP) {
  'use strict';

  /* Excel's own limits on a worksheet name. Exceed them and the file opens with
     a repair prompt, which reads as a corrupt export rather than a bad name. */
  var MAX_SHEET_NAME = 31;
  var BAD_SHEET_CHARS = /[\\/?*[\]:]/g;

  /* Character width is not point width, so this is a rough fit rather than a
     measurement — wide enough to read, capped so one prose column does not push
     everything else off the screen. */
  var MIN_COL_WIDTH = 8;
  var MAX_COL_WIDTH = 60;

  var crcTable = null;

  /** Standard CRC-32, table built once. Pure. */
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  /** XML text content. The apostrophe matters inside attributes. Pure. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      /* Excel rejects the C0 range outright, and a stray control character out
         of a badly encoded PDF is otherwise a repair prompt on open. */
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  var Xlsx = {

    /** A1, B1 … AA1. Pure. */
    cellRef: function (col, row) {
      var name = '';
      var n = col;
      do {
        name = String.fromCharCode(65 + (n % 26)) + name;
        n = Math.floor(n / 26) - 1;
      } while (n >= 0);
      return name + (row + 1);
    },

    /**
     * True when a cell should go in as a number rather than text.
     *
     * Deliberately strict. A part number like `2026-110-AY02`, a size like
     * `1 1/2 FNPT` and a revision like `B` are all text, and a schedule is full
     * of them — guessing generously turns a stock code into a date, which is
     * the single most complained-about behaviour of every other PDF-to-Excel
     * converter. Only a bare integer or decimal qualifies. Pure.
     */
    isNumeric: function (value) {
      return /^-?\d+(\.\d+)?$/.test(String(value).trim()) &&
             Math.abs(Number(value)) < 1e15;
    },

    /** Worksheet names: legal, trimmed, and unique within the book. Pure. */
    sheetNames: function (names) {
      var out = [];
      var seen = {};
      for (var i = 0; i < names.length; i++) {
        var base = String(names[i] || 'Sheet').replace(BAD_SHEET_CHARS, ' ').trim() || 'Sheet';
        if (base.length > MAX_SHEET_NAME) base = base.slice(0, MAX_SHEET_NAME).trim();
        var name = base;
        var n = 2;
        while (seen[name.toLowerCase()]) {
          var suffix = ' (' + n + ')';
          name = base.slice(0, MAX_SHEET_NAME - suffix.length).trim() + suffix;
          n += 1;
        }
        seen[name.toLowerCase()] = true;
        out.push(name);
      }
      return out;
    },

    /** One worksheet part. `rows` is an array of arrays of strings. Pure. */
    sheetXml: function (rows) {
      var widths = [];
      for (var r = 0; r < rows.length; r++) {
        for (var c = 0; c < rows[r].length; c++) {
          var len = String(rows[r][c] || '').length;
          widths[c] = Math.max(widths[c] || MIN_COL_WIDTH, Math.min(len + 2, MAX_COL_WIDTH));
        }
      }

      var cols = widths.length
        ? '<cols>' + widths.map(function (w, i) {
            return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
          }).join('') + '</cols>'
        : '';

      var body = rows.map(function (row, r) {
        var cells = row.map(function (value, c) {
          var text = value === null || value === undefined ? '' : String(value);
          if (!text) return '';
          var ref = Xlsx.cellRef(c, r);
          if (Xlsx.isNumeric(text)) {
            return '<c r="' + ref + '"><v>' + esc(text.trim()) + '</v></c>';
          }
          /* Inline strings rather than a shared-string table: one fewer part to
             keep consistent, and a schedule has little repetition to share. */
          return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
                 esc(text) + '</t></is></c>';
        }).join('');
        return '<row r="' + (r + 1) + '">' + cells + '</row>';
      }).join('');

      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        cols + '<sheetData>' + body + '</sheetData></worksheet>';
    },

    /**
     * A workbook from `[{name, rows}]`, as bytes ready for `files.write`.
     *
     * Pure, and synchronous — see the note at the top about STORE.
     */
    build: function (sheets) {
      if (!sheets || !sheets.length) throw new Error('a workbook needs at least one sheet');
      var names = Xlsx.sheetNames(sheets.map(function (s) { return s.name; }));
      var parts = [];

      parts.push({
        path: '[Content_Types].xml',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          sheets.map(function (s, i) {
            return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
              'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
          }).join('') +
          '</Types>'
      });

      parts.push({
        path: '_rels/.rels',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'
      });

      parts.push({
        path: 'xl/workbook.xml',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          names.map(function (name, i) {
            return '<sheet name="' + esc(name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
          }).join('') +
          '</sheets></workbook>'
      });

      parts.push({
        path: 'xl/_rels/workbook.xml.rels',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          names.map(function (name, i) {
            return '<Relationship Id="rId' + (i + 1) + '" ' +
              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
              'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
          }).join('') +
          '</Relationships>'
      });

      for (var i = 0; i < sheets.length; i++) {
        parts.push({
          path: 'xl/worksheets/sheet' + (i + 1) + '.xml',
          text: Xlsx.sheetXml(sheets[i].rows || [])
        });
      }

      return Xlsx.zip(parts);
    },

    /**
     * A ZIP container over `[{path, text}]`. Stored entries, no directories.
     *
     * Written out by hand rather than assembled from a library for the reason
     * at the top of the file. The layout is the classic one: a local header and
     * the data per entry, then a central directory naming them all, then the
     * end record pointing at that. Pure.
     */
    zip: function (parts) {
      var chunks = [];
      var central = [];
      var offset = 0;

      /* MS-DOS time/date. Fixed rather than `Date.now()` so the same tables
         export to byte-identical files — which is what lets `test/verify.js`
         compare a build against itself, and stops a re-export looking like a
         changed file to whatever the user syncs their job folder with. */
      var dosTime = 0;
      var dosDate = 33;   // 1 Jan 1980

      function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
      function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

      for (var i = 0; i < parts.length; i++) {
        var nameBytes = utf8(parts[i].path);
        var data = utf8(parts[i].text);
        var crc = crc32(data);

        var local = [].concat(
          u32(0x04034B50), u16(20), u16(0x0800), u16(0),
          u16(dosTime), u16(dosDate),
          u32(crc), u32(data.length), u32(data.length),
          u16(nameBytes.length), u16(0)
        );
        chunks.push(new Uint8Array(local), nameBytes, data);

        central.push(new Uint8Array([].concat(
          u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0),
          u16(dosTime), u16(dosDate),
          u32(crc), u32(data.length), u32(data.length),
          u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
          u32(0), u32(offset)
        )));
        central.push(nameBytes);

        offset += local.length + nameBytes.length + data.length;
      }

      var dirStart = offset;
      var dirSize = 0;
      for (var c = 0; c < central.length; c++) dirSize += central[c].length;

      var end = new Uint8Array([].concat(
        u32(0x06054B50), u16(0), u16(0),
        u16(parts.length), u16(parts.length),
        u32(dirSize), u32(dirStart), u16(0)
      ));

      var out = new Uint8Array(dirStart + dirSize + end.length);
      var at = 0;
      function put(source) {
        out.set(source, at);
        at += source.length;
      }
      for (var a = 0; a < chunks.length; a++) put(chunks[a]);
      for (var b = 0; b < central.length; b++) put(central[b]);
      put(end);
      return out;
    }
  };

  RP.xlsx = Xlsx;
})(window.RP);
