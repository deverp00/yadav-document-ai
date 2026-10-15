/* ==========================================================================
   Yadav Document AI
   File: js/export.js
   Purpose: Local export generation for processed documents. Builds TXT, JSON
            and CSV content from a plain payload object, and triggers a
            browser download. Everything runs in the browser; nothing is
            uploaded anywhere.

   Depends on: none at runtime. Loads after js/script.js and
               js/document-processor.js. When window.YDA is available it uses
               YDA.announce for accessibility, but this file also works
               without it.

   Developed by Yadav Web Technologies
   Phase: 3 (Local Document Processing)
   Test status: NOT browser-tested. Awaiting Phase 3 verification.

   --------------------------------------------------------------------------
   PUBLIC API - window.YDAExport (frozen)

     YDAExport.VERSION
       String identifier of this module.

     YDAExport.FORMATS
       Array of supported format identifiers: ['txt', 'json', 'csv'].

     YDAExport.build(format, payload)
       -> { content: string, mimeType: string, extension: string, filename: string }
       Pure builder. Does not touch the DOM.

     YDAExport.buildTxt(payload)   -> string
     YDAExport.buildJson(payload)  -> string
     YDAExport.buildCsv(payload)   -> string

     YDAExport.buildFilename(payload, extension, options) -> string

     YDAExport.download(format, payload, options)
       -> { filename: string, bytes: number, mimeType: string }
       Builds the content and triggers a browser download. Returns a small
       summary object so callers can report success without re-reading the
       Blob.

   --------------------------------------------------------------------------
   Payload shape

   The exporter accepts a plain object. All fields are optional; missing
   values are rendered as empty strings or omitted from structured output.
   The expected shape (produced by js/document-processor.js and augmented by
   js/workspace.js after AI analysis) is:

     {
       fileName:      string,
       fileType:      string,
       fileSize:      number (bytes),
       kind:          'pdf' | 'image',
       pageCount:     number,
       fullText:      string,
       pages: [
         { pageNumber, text, method, usedOcr, charCount }
       ],
       warnings:      string[],

       // Optional, added later in Phase 5
       documentType:  string | null,
       fields: [
         { label, value, source?, uncertain? }
       ],
       processedAt:   string (ISO) | null,
       analyzedAt:    string (ISO) | null
     }

   --------------------------------------------------------------------------
   Design notes

   - No UI and no DOM beyond the temporary anchor used to trigger a download.
   - CSV is UTF-8 with a BOM and CRLF line endings so Excel opens it
     correctly regardless of locale.
   - Filenames are sanitised for cross-platform safety.
   - Content is generated entirely in memory; nothing is persisted.
   ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
     Constants
     ======================================================================== */

  var VERSION = 'yda-export-1.0.0-phase3';
  var FORMATS = ['txt', 'json', 'csv'];

  var MIME_TYPES = {
    txt: 'text/plain;charset=utf-8',
    json: 'application/json;charset=utf-8',
    csv: 'text/csv;charset=utf-8'
  };

  var EXTENSIONS = {
    txt: 'txt',
    json: 'json',
    csv: 'csv'
  };

  var FORMAT_LABELS = {
    txt: 'Plain text',
    json: 'Structured data',
    csv: 'Spreadsheet'
  };

  var MAX_FILENAME_BASE = 80;

  /* ========================================================================
     Small helpers
     ======================================================================== */

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeString(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
      return '';
    }
    var units = ['B', 'KB', 'MB', 'GB'];
    var index = 0;
    var value = bytes;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    var digits = value >= 10 || index === 0 ? 0 : 1;
    return value.toFixed(digits) + ' ' + units[index];
  }

  function isoNow() {
    try {
      return new Date().toISOString();
    } catch (err) {
      return '';
    }
  }

  function stripControlChars(value) {
    return safeString(value).replace(/[\u0000-\u001F\u007F]/g, '');
  }

  function sanitiseBaseName(value) {
    var base = safeString(value);
    // Remove any path separators and control characters.
    base = base.replace(/[\\/]+/g, '_');
    base = stripControlChars(base);
    // Replace anything not letters, digits, dot, dash or underscore.
    base = base.replace(/[^A-Za-z0-9._-]+/g, '_');
    // Collapse repeated underscores.
    base = base.replace(/_+/g, '_');
    // Trim leading/trailing separators and dots.
    base = base.replace(/^[._-]+|[._-]+$/g, '');
    if (base.length > MAX_FILENAME_BASE) {
      base = base.slice(0, MAX_FILENAME_BASE);
    }
    return base || 'document';
  }

  function stripExtension(name) {
    var value = safeString(name);
    var dot = value.lastIndexOf('.');
    if (dot <= 0) {
      return value;
    }
    return value.slice(0, dot);
  }

  /* ========================================================================
     CSV helpers (RFC 4180 compliant with UTF-8 BOM)
     ======================================================================== */

  function csvEscape(value) {
    var text = safeString(value);
    if (text === '') {
      return '';
    }
    // Quote when the value contains comma, quote, CR or LF.
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function csvRow(cells) {
    return cells.map(csvEscape).join(',') + '\r\n';
  }

  /* ========================================================================
     TXT builder
     ======================================================================== */

  function buildTxt(payload) {
    var data = payload || {};
    var lines = [];

    lines.push('Yadav Document AI - Export');
    lines.push('Generated: ' + (data.exportedAt || isoNow()));
    lines.push('Generator: ' + VERSION);
    lines.push('');

    // Document section.
    lines.push('DOCUMENT');
    lines.push('  File name:     ' + safeString(data.fileName || ''));
    lines.push('  File type:     ' + safeString(data.fileType || ''));
    lines.push('  File size:     ' + formatBytes(data.fileSize));
    lines.push('  Kind:          ' + safeString(data.kind || ''));
    lines.push('  Pages:         ' + safeString(data.pageCount || ''));
    lines.push(
      '  Document type: ' + safeString(data.documentType || 'Not analyzed')
    );
    lines.push(
      '  Processed at:  ' + safeString(data.processedAt || '')
    );
    if (data.analyzedAt) {
      lines.push('  Analyzed at:   ' + safeString(data.analyzedAt));
    }
    lines.push('');

    // Fields section.
    var fields = toArray(data.fields);
    if (fields.length) {
      lines.push('FIELDS');
      for (var i = 0; i < fields.length; i += 1) {
        var field = fields[i] || {};
        lines.push('  ' + (i + 1) + '. ' + safeString(field.label || 'Field'));
        lines.push('     Value:     ' + safeString(field.value || ''));
        if (field.source) {
          lines.push('     Source:    ' + safeString(field.source));
        }
        if (field.uncertain) {
          lines.push('     Uncertain: Yes');
        }
      }
      lines.push('');
    }

    // Warnings section.
    var warnings = toArray(data.warnings);
    if (warnings.length) {
      lines.push('WARNINGS');
      for (var w = 0; w < warnings.length; w += 1) {
        lines.push('  - ' + safeString(warnings[w]));
      }
      lines.push('');
    }

    // Extracted text.
    lines.push('EXTRACTED TEXT');
    lines.push('----------------------------------------');
    lines.push(safeString(data.fullText || ''));
    lines.push('----------------------------------------');
    lines.push('');

    lines.push('Export produced locally in the browser by Yadav Document AI.');

    return lines.join('\n');
  }

  /* ========================================================================
     JSON builder
     ======================================================================== */

  function buildJson(payload) {
    var data = payload || {};

    var pages = toArray(data.pages).map(function (page) {
      var source = page || {};
      return {
        pageNumber:
          typeof source.pageNumber === 'number' ? source.pageNumber : null,
        method: safeString(source.method || ''),
        usedOcr: Boolean(source.usedOcr),
        charCount:
          typeof source.charCount === 'number' ? source.charCount : null,
        text: safeString(source.text || '')
      };
    });

    var fields = toArray(data.fields).map(function (field) {
      var source = field || {};
      return {
        label: safeString(source.label || ''),
        value: safeString(source.value || ''),
        source: source.source ? safeString(source.source) : '',
        uncertain: Boolean(source.uncertain)
      };
    });

    var output = {
      generator: VERSION,
      exportedAt: data.exportedAt || isoNow(),
      document: {
        fileName: safeString(data.fileName || ''),
        fileType: safeString(data.fileType || ''),
        fileSize:
          typeof data.fileSize === 'number' ? data.fileSize : null,
        kind: safeString(data.kind || ''),
        pageCount:
          typeof data.pageCount === 'number' ? data.pageCount : null,
        documentType: safeString(data.documentType || ''),
        processedAt: safeString(data.processedAt || ''),
        analyzedAt: safeString(data.analyzedAt || '')
      },
      fields: fields,
      warnings: toArray(data.warnings).map(safeString),
      pages: pages,
      fullText: safeString(data.fullText || '')
    };

    return JSON.stringify(output, null, 2);
  }

  /* ========================================================================
     CSV builder
     ======================================================================== */

  function buildCsv(payload) {
    var data = payload || {};
    var rows = [];

    // Section 1 - document metadata.
    rows.push(csvRow(['Section', 'Key', 'Value']));
    rows.push(csvRow(['Metadata', 'File name', safeString(data.fileName)]));
    rows.push(csvRow(['Metadata', 'File type', safeString(data.fileType)]));
    rows.push(csvRow(['Metadata', 'File size', formatBytes(data.fileSize)]));
    rows.push(csvRow(['Metadata', 'Kind', safeString(data.kind)]));
    rows.push(csvRow(['Metadata', 'Pages', safeString(data.pageCount)]));
    rows.push(
      csvRow(['Metadata', 'Document type', safeString(data.documentType)])
    );
    rows.push(
      csvRow(['Metadata', 'Processed at', safeString(data.processedAt)])
    );
    if (data.analyzedAt) {
      rows.push(
        csvRow(['Metadata', 'Analyzed at', safeString(data.analyzedAt)])
      );
    }
    rows.push(csvRow(['Metadata', 'Exported at', data.exportedAt || isoNow()]));
    rows.push(csvRow(['Metadata', 'Generator', VERSION]));
    rows.push(csvRow([]));

    // Section 2 - fields.
    rows.push(csvRow(['Section', 'Label', 'Value', 'Source', 'Uncertain']));
    var fields = toArray(data.fields);
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i] || {};
      rows.push(
        csvRow([
          'Field',
          safeString(field.label || ''),
          safeString(field.value || ''),
          safeString(field.source || ''),
          field.uncertain ? 'Yes' : 'No'
        ])
      );
    }
    rows.push(csvRow([]));

    // Section 3 - warnings.
    var warnings = toArray(data.warnings);
    if (warnings.length) {
      rows.push(csvRow(['Section', 'Message']));
      for (var w = 0; w < warnings.length; w += 1) {
        rows.push(csvRow(['Warning', safeString(warnings[w])]));
      }
      rows.push(csvRow([]));
    }

    // Section 4 - page summary. Full text is not duplicated here because
    // the TXT export and the JSON export already carry it; the CSV keeps a
    // compact per-page summary instead.
    var pages = toArray(data.pages);
    if (pages.length) {
      rows.push(
        csvRow(['Section', 'Page', 'Method', 'Used OCR', 'Characters'])
      );
      for (var p = 0; p < pages.length; p += 1) {
        var page = pages[p] || {};
        rows.push(
          csvRow([
            'Page',
            safeString(page.pageNumber),
            safeString(page.method),
            page.usedOcr ? 'Yes' : 'No',
            safeString(page.charCount)
          ])
        );
      }
      rows.push(csvRow([]));
    }

    // UTF-8 BOM so Excel and other spreadsheet apps detect the encoding.
    return '\uFEFF' + rows.join('');
  }

  /* ========================================================================
     Filename builder
     ======================================================================== */

  function buildFilename(payload, extension, options) {
    var data = payload || {};
    var opts = options || {};
    var base = stripExtension(data.fileName || '') || 'document';
    base = sanitiseBaseName(base);

    var stamp = '';
    if (opts.includeTimestamp !== false) {
      try {
        var now = new Date();
        var yyyy = now.getFullYear();
        var mm = String(now.getMonth() + 1).padStart(2, '0');
        var dd = String(now.getDate()).padStart(2, '0');
        var hh = String(now.getHours()).padStart(2, '0');
        var mi = String(now.getMinutes()).padStart(2, '0');
        stamp = '_' + yyyy + mm + dd + '-' + hh + mi;
      } catch (err) {
        stamp = '';
      }
    }

    var ext = sanitiseBaseName(extension || 'txt');
    return base + stamp + '.' + ext;
  }

  /* ========================================================================
     Unified build
     ======================================================================== */

  function build(format, payload) {
    var fmt = FORMATS.indexOf(format) !== -1 ? format : 'txt';
    var enriched = Object.assign({}, payload || {});

    if (!enriched.exportedAt) {
      enriched.exportedAt = isoNow();
    }

    var content;
    if (fmt === 'json') {
      content = buildJson(enriched);
    } else if (fmt === 'csv') {
      content = buildCsv(enriched);
    } else {
      content = buildTxt(enriched);
    }

    return {
      content: content,
      mimeType: MIME_TYPES[fmt],
      extension: EXTENSIONS[fmt],
      filename: buildFilename(enriched, EXTENSIONS[fmt])
    };
  }

  /* ========================================================================
     Download trigger
     ======================================================================== */

  function download(format, payload, options) {
    var opts = options || {};
    var built = build(format, payload);

    if (opts.filename) {
      built.filename = sanitiseBaseName(opts.filename);
      if (built.filename.indexOf('.') === -1) {
        built.filename += '.' + built.extension;
      }
    }

    var blob = new Blob([built.content], { type: built.mimeType });
    var url = URL.createObjectURL(blob);

    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = built.filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    document.body.appendChild(anchor);

    try {
      anchor.click();
    } finally {
      document.body.removeChild(anchor);
      // Revoke a moment later so slower browsers can start the download.
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    }

    // Announce for assistive technology when the shared helper is present.
    if (
      window.YDA &&
      typeof window.YDA.announce === 'function' &&
      opts.silent !== true
    ) {
      try {
        window.YDA.announce(
          FORMAT_LABELS[format] + ' export started: ' + built.filename
        );
      } catch (err) {
        /* non-fatal */
      }
    }

    return {
      filename: built.filename,
      bytes:
        typeof Blob !== 'undefined' && blob.size ? blob.size : built.content.length,
      mimeType: built.mimeType
    };
  }

  /* ========================================================================
     Public API
     ======================================================================== */

  window.YDAExport = Object.freeze({
    VERSION: VERSION,
    FORMATS: FORMATS.slice(),
    MIME_TYPES: Object.freeze(Object.assign({}, MIME_TYPES)),

    build: build,
    buildTxt: buildTxt,
    buildJson: buildJson,
    buildCsv: buildCsv,
    buildFilename: buildFilename,
    download: download
  });
})();
