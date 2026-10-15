/* ==========================================================================
   Yadav Document AI
   File: js/document-processor.js
   Purpose: Local document processing engine. Validates files, extracts
            selectable PDF text, and falls back to in-browser OCR. No network
            upload of the document ever happens in this file.

   Depends on:
     js/script.js      (only for optional YDA helpers when present)
     CDN: pdfjs-dist   (lazy-loaded, version-pinned)
     CDN: tesseract.js (lazy-loaded, version-pinned)

   Developed by Yadav Web Technologies
   Phase: 3 (Local Document Processing)
   Test status: NOT browser-tested. Awaiting Phase 3 verification.

   --------------------------------------------------------------------------
   PUBLIC API - window.YDADocumentProcessor (frozen)

     YDADocumentProcessor.VERSION
       String identifier of this module.

     YDADocumentProcessor.SUPPORTED_TYPES
       Array of accepted MIME types.

     YDADocumentProcessor.validateFile(file)
       -> { valid: boolean, kind: 'pdf' | 'image' | null,
            error: { code, message } | null }
       Synchronous check for type, size, and emptiness.

     YDADocumentProcessor.processFile(file, options)
       -> Promise<DocumentResult>
       options (all optional):
         maxFileSizeBytes   number  default 50 * 1024 * 1024
         minPdfTextLength   number  default 20 (chars per page before OCR fallback)
         ocrLanguage        string  default 'eng'
         ocrMaxPages        number  default 30 (safety cap)
         pdfRenderScale     number  default 2 (used when rendering for OCR)
         signal             AbortSignal  optional cancellation
         onProgress         function(progress)
         onPageText         function(pageResult)
         onPreview          function(pageNumber, dataUrl)

       progress = {
         stage:     'validating' | 'loading-libs' | 'reading-pdf'
                  | 'extracting-text' | 'rendering' | 'ocr'
                  | 'complete' | 'cancelled' | 'error',
         percent:   number 0..100  (best-effort)
         page:      number | null
         totalPages:number | null
         message:   string  (short, human-readable)
       }

     YDADocumentProcessor.cancel()
       Attempts to abort the currently running processFile() call.

     YDADocumentProcessor.destroy()
       -> Promise<void>
       Releases PDF.js and Tesseract.js worker resources. Safe to call
       even when nothing has been loaded.

   --------------------------------------------------------------------------
   DocumentResult shape

     {
       fileName:  string,
       fileSize:  number,
       fileType:  string,
       kind:      'pdf' | 'image',
       pageCount: number,
       fullText:  string,     // concatenated text with page separators
       pages: [
         {
           pageNumber: number,          // 1-based
           text:       string,
           method:     'selectable' | 'ocr' | 'mixed',
           usedOcr:    boolean,
           charCount:  number
         }
       ],
       warnings:  string[]   // non-fatal issues (e.g. OCR used, page skipped)
     }

   --------------------------------------------------------------------------
   Design notes
     - No DOM is touched by this module. Workspace.js owns all UI updates;
       this file only reports progress and results through callbacks.
     - Everything is client-side. The original File object never leaves the
       browser tab in this file.
     - Libraries are only fetched from the CDN the first time they are
       actually needed, then cached for the lifetime of the page.
     - Long loops yield to the event loop so the interface stays responsive.
     - Extracted results are held in memory only; nothing is persisted.
   ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
     Constants
     ======================================================================== */

  var VERSION = 'yda-docproc-1.0.1-phase3';

  var SUPPORTED_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ];

  var SUPPORTED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];

  /* Version-pinned CDN endpoints. Change deliberately, not casually. */
  var PDFJS_VERSION = '3.11.174';
  var PDFJS_MAIN_URL =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' +
    PDFJS_VERSION +
    '/pdf.min.js';
  var PDFJS_WORKER_URL =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' +
    PDFJS_VERSION +
    '/pdf.worker.min.js';

  var TESSERACT_VERSION = '4.1.1';
  var TESSERACT_MAIN_URL =
    'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/' +
    TESSERACT_VERSION +
    '/tesseract.min.js';

  var DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
  var DEFAULT_MIN_PDF_TEXT = 20;                // characters per page
  var DEFAULT_OCR_LANGUAGE = 'eng';
  var DEFAULT_OCR_MAX_PAGES = 30;
  var DEFAULT_PDF_RENDER_SCALE = 2;

  var ERROR_CODES = {
    INVALID_TYPE: 'INVALID_TYPE',
    FILE_EMPTY: 'FILE_EMPTY',
    FILE_TOO_LARGE: 'FILE_TOO_LARGE',
    FILE_CORRUPT: 'FILE_CORRUPT',
    LIB_LOAD_FAILED: 'LIB_LOAD_FAILED',
    PDF_PARSE_FAILED: 'PDF_PARSE_FAILED',
    PDF_RENDER_FAILED: 'PDF_RENDER_FAILED',
    OCR_FAILED: 'OCR_FAILED',
    NO_TEXT_FOUND: 'NO_TEXT_FOUND',
    CANCELLED: 'CANCELLED',
    UNKNOWN: 'UNKNOWN'
  };

  var ERROR_MESSAGES = {
    INVALID_TYPE:
      'This file type is not supported. Please choose a PDF, JPG, JPEG, PNG, or WEBP file.',
    FILE_EMPTY:
      'This file is empty and cannot be processed.',
    FILE_TOO_LARGE:
      'This file is larger than the allowed size. Please choose a smaller document.',
    FILE_CORRUPT:
      'This file appears to be damaged and could not be read.',
    LIB_LOAD_FAILED:
      'A required processing library could not be loaded. Check your connection and try again.',
    PDF_PARSE_FAILED:
      'This PDF could not be read. It may be damaged or password-protected.',
    PDF_RENDER_FAILED:
      'A page of this PDF could not be rendered for text recognition.',
    OCR_FAILED:
      'Text recognition failed for this document.',
    NO_TEXT_FOUND:
      'No readable text was found in this document.',
    CANCELLED: 'Processing was cancelled.',
    UNKNOWN: 'An unexpected error occurred while processing the document.'
  };

  /* ========================================================================
     Module state
     ======================================================================== */

  var pdfjsLib = null;                  // cached PDF.js namespace
  var pdfjsLoadingPromise = null;       // in-flight PDF.js load
  var tesseractLib = null;              // cached Tesseract namespace
  var tesseractLoadingPromise = null;   // in-flight Tesseract load
  var tesseractWorker = null;           // cached Tesseract worker
  var tesseractWorkerLang = null;       // language the worker was created for

  var activeAbort = null;               // internal AbortController for cancel()

  /* ========================================================================
     Small helpers
     ======================================================================== */

  function isFunction(value) {
    return typeof value === 'function';
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function makeError(code, detail) {
    var base = ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN;
    var message = detail ? base + ' (' + detail + ')' : base;
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function yieldToUi() {
    return new Promise(function (resolve) {
      // Prefer requestAnimationFrame when available so we yield a full frame.
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
          resolve();
        });
      } else {
        window.setTimeout(resolve, 0);
      }
    });
  }

  function safeCall(fn, a, b, c) {
    if (!isFunction(fn)) {
      return;
    }
    try {
      fn(a, b, c);
    } catch (err) {
      // Never let a consumer's callback crash the processor.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[YDADocumentProcessor] progress callback error:', err);
      }
    }
  }

  /* ========================================================================
     Error / progress reporting
     ======================================================================== */

  function makeProgressReporter(onProgress) {
    return function report(stage, percent, page, totalPages, message) {
      safeCall(onProgress, {
        stage: stage,
        percent: typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0,
        page: typeof page === 'number' ? page : null,
        totalPages: typeof totalPages === 'number' ? totalPages : null,
        message: message || ''
      });
    };
  }

  /* ========================================================================
     File validation
     ======================================================================== */

  function fileExtension(name) {
    if (!isNonEmptyString(name)) {
      return '';
    }
    var dot = name.lastIndexOf('.');
    if (dot === -1) {
      return '';
    }
    return name.slice(dot).toLowerCase();
  }

  function detectKind(file) {
    var type = (file && file.type) ? file.type.toLowerCase() : '';
    if (type === 'application/pdf') {
      return 'pdf';
    }
    if (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp') {
      return 'image';
    }

    // Browsers occasionally report an empty type. Fall back to extension.
    var ext = fileExtension(file && file.name);
    if (ext === '.pdf') {
      return 'pdf';
    }
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') {
      return 'image';
    }
    return null;
  }

  function validateFile(file, options) {
    var settings = options || {};
    var maxBytes =
      typeof settings.maxFileSizeBytes === 'number'
        ? settings.maxFileSizeBytes
        : DEFAULT_MAX_FILE_SIZE;

    if (!file) {
      return {
        valid: false,
        kind: null,
        error: { code: ERROR_CODES.INVALID_TYPE, message: ERROR_MESSAGES.INVALID_TYPE }
      };
    }

    if (typeof file.size !== 'number' || file.size <= 0) {
      return {
        valid: false,
        kind: null,
        error: { code: ERROR_CODES.FILE_EMPTY, message: ERROR_MESSAGES.FILE_EMPTY }
      };
    }

    if (file.size > maxBytes) {
      return {
        valid: false,
        kind: null,
        error: {
          code: ERROR_CODES.FILE_TOO_LARGE,
          message: ERROR_MESSAGES.FILE_TOO_LARGE
        }
      };
    }

    var kind = detectKind(file);
    if (!kind) {
      return {
        valid: false,
        kind: null,
        error: {
          code: ERROR_CODES.INVALID_TYPE,
          message: ERROR_MESSAGES.INVALID_TYPE
        }
      };
    }

    return { valid: true, kind: kind, error: null };
  }

  /* ========================================================================
     Library loading (lazy, cached)
     ======================================================================== */

  /**
   * Append a script tag and resolve once it has loaded, or reject if the
   * network or CDN fails. Always returns a Promise.
   */
  function loadScriptOnce(url) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(makeError(ERROR_CODES.LIB_LOAD_FAILED, url));
      };
      document.head.appendChild(script);
    });
  }

  function loadPdfJs() {
    if (pdfjsLib) {
      return Promise.resolve(pdfjsLib);
    }
    if (pdfjsLoadingPromise) {
      return pdfjsLoadingPromise;
    }

    pdfjsLoadingPromise = loadScriptOnce(PDFJS_MAIN_URL).then(function () {
      var lib = window.pdfjsLib;
      if (!lib) {
        throw makeError(ERROR_CODES.LIB_LOAD_FAILED, 'pdfjsLib missing');
      }
      // Wire the worker. Using the matching version avoids API drift.
      try {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      } catch (err) {
        // Non-fatal: some builds skip the worker and run on the main thread.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[YDADocumentProcessor] PDF.js worker not set:', err);
        }
      }
      pdfjsLib = lib;
      return lib;
    });

    // If loading fails, allow a retry later.
    pdfjsLoadingPromise.catch(function () {
      pdfjsLoadingPromise = null;
    });

    return pdfjsLoadingPromise;
  }

  function loadTesseract() {
    if (tesseractLib) {
      return Promise.resolve(tesseractLib);
    }
    if (tesseractLoadingPromise) {
      return tesseractLoadingPromise;
    }

    tesseractLoadingPromise = loadScriptOnce(TESSERACT_MAIN_URL).then(function () {
      var lib = window.Tesseract;
      if (!lib) {
        throw makeError(ERROR_CODES.LIB_LOAD_FAILED, 'Tesseract missing');
      }
      tesseractLib = lib;
      return lib;
    });

    tesseractLoadingPromise.catch(function () {
      tesseractLoadingPromise = null;
    });

    return tesseractLoadingPromise;
  }

  /**
   * Return a Tesseract worker for the given language, reusing one if the
   * language matches. Creating a worker is expensive; reuse is important.
   */
  function getTesseractWorker(language) {
    if (tesseractWorker && tesseractWorkerLang === language) {
      return Promise.resolve(tesseractWorker);
    }

    // If a worker exists for a different language, terminate it first.
    var disposing = Promise.resolve();
    if (tesseractWorker) {
      disposing = Promise.resolve(tesseractWorker.terminate()).catch(function () {});
      tesseractWorker = null;
      tesseractWorkerLang = null;
    }

    return disposing
      .then(loadTesseract)
      .then(function (lib) {
        return lib.createWorker(language);
      })
      .then(function (worker) {
        tesseractWorker = worker;
        tesseractWorkerLang = language;
        return worker;
      });
  }

  /* ========================================================================
     Cancellation
     ======================================================================== */

  function throwIfAborted(signal) {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      throw makeError(ERROR_CODES.CANCELLED);
    }
  }

  /* ========================================================================
     PDF text extraction
     ======================================================================== */

  function pdfPageTextFromItems(items) {
    if (!items || !items.length) {
      return '';
    }
    // PDF.js text items are laid out individually. Concatenating with a space
    // between runs produces reasonable prose for typical documents.
    var parts = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item && typeof item.str === 'string' && item.str.length) {
        parts.push(item.str);
      }
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function getPageText(page) {
    return page.getTextContent().then(function (content) {
      return pdfPageTextFromItems(content.items);
    });
  }

  /**
   * Render a PDF page to a data URL at the given scale so it can be handed to
   * Tesseract without a canvas element on the page. Everything happens in an
   * offscreen canvas owned by this module.
   */
  function renderPageToDataUrl(page, scale) {
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    var context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    var renderTask = page.render({ canvasContext: context, viewport: viewport });
    return renderTask.promise.then(function () {
      try {
        return canvas.toDataURL('image/png');
      } catch (err) {
        throw makeError(ERROR_CODES.PDF_RENDER_FAILED, 'canvas.toDataURL failed');
      }
    });
  }

  /* ========================================================================
     OCR
     ======================================================================== */

  function ocrDataUrl(dataUrl, language, onProgress, pageLabel) {
    return getTesseractWorker(language).then(function (worker) {
      return worker.recognize(dataUrl, {
        // Tesseract's logger is called frequently; throttle to meaningful
        // changes so the UI does not flicker.
        logger: function (message) {
          if (
            message &&
            message.status === 'recognizing text' &&
            typeof message.progress === 'number'
          ) {
            var pct = Math.round(message.progress * 100);
            safeCall(onProgress, pct, pageLabel);
          }
        }
      });
    });
  }

  /* ========================================================================
     PDF pipeline
     ======================================================================== */

  function processPdf(file, settings, report, options) {
    var onPageText = options.onPageText;
    var onPreview = options.onPreview;
    var signal = options.signal;

    var warnings = [];
    var pages = [];
    var fullTextParts = [];
    var documentProxy = null;

    report('reading-pdf', 5, null, null, 'Reading PDF');

    return loadPdfJs()
      .then(function (lib) {
        throwIfAborted(signal);
        var arrayBufferPromise = file.arrayBuffer
          ? file.arrayBuffer()
          : new Promise(function (resolve, reject) {
              var reader = new FileReader();
              reader.onload = function () {
                resolve(reader.result);
              };
              reader.onerror = function () {
                reject(makeError(ERROR_CODES.FILE_CORRUPT));
              };
              reader.readAsArrayBuffer(file);
            });

        return arrayBufferPromise.then(function (buffer) {
          // PDF.js expects a Uint8Array for reliable parsing.
          var data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
          return lib.getDocument({ data: data }).promise;
        });
      })
      .then(function (doc) {
        documentProxy = doc;
        var total = doc.numPages;
        var capped = Math.min(total, settings.ocrMaxPages);

        report(
          'extracting-text',
          10,
          1,
          total,
          'Extracting text from ' + total + ' page' + (total === 1 ? '' : 's')
        );

        var chain = Promise.resolve();

        for (var i = 1; i <= capped; i += 1) {
          (function (pageNumber) {
            chain = chain.then(function () {
              throwIfAborted(signal);
              return doc.getPage(pageNumber).then(function (page) {
                return getPageText(page).then(function (text) {
                  var trimmed = (text || '').trim();
                  var usedOcr = false;
                  var method = 'selectable';

                  if (trimmed.length >= settings.minPdfTextLength) {
                    return {
                      pageNumber: pageNumber,
                      text: trimmed,
                      method: 'selectable',
                      usedOcr: false,
                      charCount: trimmed.length
                    };
                  }

                  // Fall back to OCR for this page.
                  usedOcr = true;
                  method = trimmed.length > 0 ? 'mixed' : 'ocr';
                  report(
                    'rendering',
                    percentFor(pageNumber, total, 10, 40),
                    pageNumber,
                    total,
                    'Preparing page ' + pageNumber + ' for text recognition'
                  );

                  return yieldToUi()
                    .then(function () {
                      return renderPageToDataUrl(page, settings.pdfRenderScale);
                    })
                    .then(function (dataUrl) {
                      if (isFunction(onPreview)) {
                        safeCall(onPreview, pageNumber, dataUrl);
                      }
                      report(
                        'ocr',
                        percentFor(pageNumber, total, 40, 90),
                        pageNumber,
                        total,
                        'Recognizing text on page ' + pageNumber
                      );
                      return ocrDataUrl(
                        dataUrl,
                        settings.ocrLanguage,
                        function (pct) {
                          var overall = percentFor(
                            pageNumber,
                            total,
                            40 + (pct / 100) * 50,
                            90
                          );
                          report(
                            'ocr',
                            overall,
                            pageNumber,
                            total,
                            'Recognizing text on page ' +
                              pageNumber +
                              ' (' +
                              pct +
                              '%)'
                          );
                        },
                        pageNumber
                      );
                    })
                    .then(function (result) {
                      var ocrText =
                        result && result.data && result.data.text
                          ? result.data.text.trim()
                          : '';
                      if (!ocrText) {
                        warnings.push(
                          'Page ' + pageNumber + ' produced no recognisable text.'
                        );
                      }
                      return {
                        pageNumber: pageNumber,
                        text: ocrText,
                        method: method,
                        usedOcr: usedOcr,
                        charCount: ocrText.length
                      };
                    });
                });
              });
            }).then(function (pageResult) {
              pages.push(pageResult);
              fullTextParts.push(
                '--- Page ' + pageResult.pageNumber + ' ---\n' + pageResult.text
              );
              if (isFunction(onPageText)) {
                safeCall(onPageText, pageResult);
              }
              report(
                pageResult.usedOcr ? 'ocr' : 'extracting-text',
                percentFor(pageResult.pageNumber, total, 10, 95),
                pageResult.pageNumber,
                total,
                'Finished page ' + pageResult.pageNumber
              );
            });
          })(i);
        }

        return chain.then(function () {
          if (total > capped) {
            warnings.push(
              'Only the first ' +
                capped +
                ' pages were processed. ' +
                (total - capped) +
                ' page(s) were skipped.'
            );
          }

          var fullText = fullTextParts.join('\n\n').trim();
          if (!fullText) {
            throw makeError(ERROR_CODES.NO_TEXT_FOUND);
          }

          return {
            fileName: file.name || 'document.pdf',
            fileSize: file.size,
            fileType: file.type || 'application/pdf',
            kind: 'pdf',
            pageCount: pages.length,
            pages: pages,
            fullText: fullText,
            warnings: warnings
          };
        });
      })
      .then(function (result) {
        if (documentProxy && isFunction(documentProxy.destroy)) {
          try {
            documentProxy.destroy();
          } catch (err) {
            /* non-fatal */
          }
        }
        return result;
      })
      .catch(function (err) {
        if (documentProxy && isFunction(documentProxy.destroy)) {
          try {
            documentProxy.destroy();
          } catch (cleanupErr) {
            /* non-fatal */
          }
        }
        throw err;
      });
  }

  /* ========================================================================
     Image pipeline
     ======================================================================== */

  function processImage(file, settings, report, options) {
    var onPreview = options.onPreview;
    var signal = options.signal;
    var warnings = [];

    report('loading-libs', 5, null, null, 'Preparing text recognition');

    return loadTesseract()
      .then(function () {
        throwIfAborted(signal);
        report('ocr', 15, 1, 1, 'Recognizing text in image');

        var dataUrlPromise = new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            resolve(reader.result);
          };
          reader.onerror = function () {
            reject(makeError(ERROR_CODES.FILE_CORRUPT));
          };
          reader.readAsDataURL(file);
        });

        return dataUrlPromise.then(function (dataUrl) {
          if (isFunction(onPreview)) {
            safeCall(onPreview, 1, dataUrl);
          }
          return ocrDataUrl(
            dataUrl,
            settings.ocrLanguage,
            function (pct) {
              report(
                'ocr',
                15 + (pct / 100) * 80,
                1,
                1,
                'Recognizing text (' + pct + '%)'
              );
            },
            1
          ).then(function (result) {
            var text =
              result && result.data && result.data.text
                ? result.data.text.trim()
                : '';
            if (!text) {
              warnings.push('The image produced no recognisable text.');
            }
            return text;
          });
        });
      })
      .then(function (text) {
        if (!text) {
          throw makeError(ERROR_CODES.NO_TEXT_FOUND);
        }
        var page = {
          pageNumber: 1,
          text: text,
          method: 'ocr',
          usedOcr: true,
          charCount: text.length
        };
        return {
          fileName: file.name || 'image',
          fileSize: file.size,
          fileType: file.type || 'image',
          kind: 'image',
          pageCount: 1,
          pages: [page],
          fullText: text,
          warnings: warnings
        };
      });
  }

  /* ========================================================================
     Progress helper
     ======================================================================== */

  function percentFor(pageNumber, totalPages, low, high) {
    if (!totalPages || totalPages <= 0) {
      return high;
    }
    var fraction = (pageNumber - 1) / totalPages;
    return Math.round(low + (high - low) * fraction);
  }

  /* ========================================================================
     Main entry point
     ======================================================================== */

  function processFile(file, options) {
    var opts = options || {};
    var settings = {
      maxFileSizeBytes:
        typeof opts.maxFileSizeBytes === 'number'
          ? opts.maxFileSizeBytes
          : DEFAULT_MAX_FILE_SIZE,
      minPdfTextLength:
        typeof opts.minPdfTextLength === 'number'
          ? opts.minPdfTextLength
          : DEFAULT_MIN_PDF_TEXT,
      ocrLanguage:
        isNonEmptyString(opts.ocrLanguage) ? opts.ocrLanguage : DEFAULT_OCR_LANGUAGE,
      ocrMaxPages:
        typeof opts.ocrMaxPages === 'number'
          ? Math.max(1, opts.ocrMaxPages)
          : DEFAULT_OCR_MAX_PAGES,
      pdfRenderScale:
        typeof opts.pdfRenderScale === 'number'
          ? Math.max(0.5, opts.pdfRenderScale)
          : DEFAULT_PDF_RENDER_SCALE
    };

    var report = makeProgressReporter(opts.onProgress);

    // Establish an internal abort controller so cancel() can reach this run.
    if (typeof AbortController === 'function') {
      activeAbort = new AbortController();
    } else {
      activeAbort = null;
    }

    // Combine the caller's signal with our own internal one.
    var signal = opts.signal || null;
    if (activeAbort && !signal) {
      signal = activeAbort.signal;
    } else if (activeAbort && signal) {
      // If either is aborted, treat as aborted. We do not create a merged
      // signal; throwIfAborted checks the caller's signal, and cancel()
      // will also trigger the internal one.
    }

    return Promise.resolve()
      .then(function () {
        report('validating', 2, null, null, 'Checking file');

        var check = validateFile(file, settings);
        if (!check.valid) {
          var err = makeError(check.error.code, '');
          err.userMessage = check.error.message;
          throw err;
        }
        return check.kind;
      })
      .then(function (kind) {
        throwIfAborted(signal);
        report(
          'loading-libs',
          5,
          null,
          null,
          kind === 'pdf'
            ? 'Opening PDF'
            : 'Preparing text recognition'
        );
        if (kind === 'pdf') {
          return processPdf(file, settings, report, {
            onPageText: opts.onPageText,
            onPreview: opts.onPreview,
            signal: signal
          });
        }
        return processImage(file, settings, report, {
          onPreview: opts.onPreview,
          signal: signal
        });
      })
      .then(function (result) {
        report('complete', 100, null, null, 'Processing complete');
        activeAbort = null;
        return result;
      })
      .catch(function (err) {
        activeAbort = null;
        var code = err && err.code ? err.code : ERROR_CODES.UNKNOWN;
        var message =
          err && err.userMessage
            ? err.userMessage
            : err && err.message
              ? err.message
              : ERROR_MESSAGES.UNKNOWN;

        if (code === ERROR_CODES.CANCELLED) {
          report('cancelled', 0, null, null, ERROR_MESSAGES.CANCELLED);
        } else {
          report('error', 0, null, null, message);
        }

        // Preserve the original error object but ensure code/message are set
        // for downstream consumers.
        if (!err.code) {
          err.code = code;
        }
        err.userMessage = message;
        throw err;
      });
  }

  /* ========================================================================
     Cancellation and teardown
     ======================================================================== */

  function cancel() {
    if (activeAbort && !activeAbort.signal.aborted) {
      activeAbort.abort();
    }
  }

  function destroy() {
    var work = [];

    if (tesseractWorker) {
      work.push(
        Promise.resolve(tesseractWorker.terminate()).catch(function () {
          /* non-fatal */
        })
      );
      tesseractWorker = null;
      tesseractWorkerLang = null;
    }

    return Promise.all(work).then(function () {
      // PDF.js document proxies are per-call; nothing global to release.
      // We deliberately keep pdfjsLib / tesseractLib cached so a second
      // processFile() call does not re-download from the CDN.
    });
  }

  /* ========================================================================
     Public API
     ======================================================================== */

  window.YDADocumentProcessor = Object.freeze({
    VERSION: VERSION,
    SUPPORTED_TYPES: SUPPORTED_TYPES.slice(),
    SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS.slice(),
    ERROR_CODES: Object.freeze(Object.assign({}, ERROR_CODES)),

    validateFile: validateFile,
    processFile: processFile,
    cancel: cancel,
    destroy: destroy
  });
})();
