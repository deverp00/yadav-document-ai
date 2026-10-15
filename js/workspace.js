/* ==========================================================================
   Yadav Document AI
   File: js/workspace.js
   Purpose: Behavior for workspace.html. Combines the Phase 2 tab and status
            logic with the Phase 3 upload, local extraction, preview and
            export wiring.

   Depends on: workspace.html
               css/workspace.css
               js/script.js              (window.YDA)
               js/document-processor.js  (window.YDADocumentProcessor)
               js/export.js              (window.YDAExport)

   Developed by Yadav Web Technologies
   Phase: 3 (Local Document Processing)
   Test status: NOT browser-tested. Awaiting Phase 3 verification.

   --------------------------------------------------------------------------
   Preserved from the Phase 2 file (do not regress):
     - Roving-tabindex tablist with click, ArrowLeft / ArrowRight, Home, End.
     - Initial activation matches the markup's aria-selected tab.
     - Panel visibility via .is-active on .workspace-panel.
     - window.YDAWorkspace.showPanel(name)
     - window.YDAWorkspace.setStatus(message)

   Added in Phase 3:
     - File selection (input and drag and drop), validation, error display.
     - Local extraction through YDADocumentProcessor with progress, per-page
       text and preview callbacks.
     - Text panel editing, live character and word counts, copy and clear.
     - Preview panel with page navigation and zoom via --zoom.
     - Stepper state transitions matching the extraction stages.
     - Enabling of the export dialog and its three format buttons once a
       successful extraction exists.

   Not implemented here (later phases):
     - AI analysis (Worker in Phase 4, ai-service.js in Phase 5).
     - Consent gate, results fields, add-field form (Phase 5).
     - Firebase, history, accounts (Phase 6).
   ========================================================================== */

(function () {
  'use strict';

  var VERSION = 'yda-workspace-2.0.0-phase3';

  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 3;
  var ZOOM_STEP = 1.25;
  var ZOOM_DEFAULT = 1;

  function init() {
    var tabList = document.querySelector('.workspace-tabs');
    if (!tabList) {
      return;
    }

    /* =====================================================================
       DOM references
       ===================================================================== */
    var dom = {
      dropzone: document.querySelector('.dropzone'),
      fileInput: document.getElementById('file-input'),
      fileError: document.getElementById('file-error'),
      fileInfo: document.getElementById('file-info'),
      fileName: document.getElementById('file-name'),
      fileMeta: document.getElementById('file-meta'),
      replaceButton: document.getElementById('replace-file-button'),
      removeButton: document.getElementById('remove-file-button'),

      statusText: document.getElementById('workspace-status-text'),

      previewBadge: document.getElementById('preview-badge'),
      previewEmpty: document.getElementById('preview-empty'),
      previewStage: document.getElementById('preview-stage'),
      previewViewport: document.getElementById('preview-viewport'),
      previewLoading: document.getElementById('preview-loading'),
      prevPageButton: document.getElementById('prev-page-button'),
      nextPageButton: document.getElementById('next-page-button'),
      pageIndicator: document.getElementById('page-indicator'),
      zoomOutButton: document.getElementById('zoom-out-button'),
      zoomInButton: document.getElementById('zoom-in-button'),
      zoomFitButton: document.getElementById('zoom-fit-button'),
      zoomLevel: document.getElementById('zoom-level'),

      extractionBadge: document.getElementById('extraction-badge'),
      copyTextButton: document.getElementById('copy-text-button'),
      clearTextButton: document.getElementById('clear-text-button'),
      charCount: document.getElementById('char-count'),
      wordCount: document.getElementById('word-count'),
      extractedText: document.getElementById('extracted-text'),
      textLoading: document.getElementById('text-loading'),

      exportButton: document.getElementById('export-button'),
      exportDialog: document.getElementById('export-dialog'),
      exportFormatButtons: document.querySelectorAll('[data-export]')
    };

    /* =====================================================================
       State
       ===================================================================== */
    var state = {
      file: null,
      result: null,
      processedAt: null,
      previewPages: [],
      currentPreview: 0,
      zoom: ZOOM_DEFAULT,
      processing: false
    };

    // Ensures that a stale processFile() rejection from a cancelled run
    // cannot overwrite the UI after a new run has started.
    var processGeneration = 0;

    /* =====================================================================
       Tabs (preserved from the Phase 2 file)
       ===================================================================== */
    var tabs = Array.prototype.slice.call(
      tabList.querySelectorAll('[role="tab"]')
    );

    function activateTab(selectedTab) {
      tabs.forEach(function (tab) {
        var isSelected = tab === selectedTab;
        var panel = document.getElementById(tab.getAttribute('aria-controls'));

        tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        tab.setAttribute('tabindex', isSelected ? '0' : '-1');

        if (panel) {
          panel.classList.toggle('is-active', isSelected);
        }
      });
    }

    function focusAndActivate(tab) {
      if (!tab) {
        return;
      }
      tab.focus();
      activateTab(tab);
    }

    tabList.addEventListener('click', function (event) {
      var tab = event.target.closest('[role="tab"]');
      if (tab && tabList.contains(tab)) {
        activateTab(tab);
      }
    });

    tabList.addEventListener('keydown', function (event) {
      var currentIndex = tabs.indexOf(document.activeElement);
      if (currentIndex === -1) {
        return;
      }

      var nextIndex = null;

      switch (event.key) {
        case 'ArrowRight':
          nextIndex = (currentIndex + 1) % tabs.length;
          break;
        case 'ArrowLeft':
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      focusAndActivate(tabs[nextIndex]);
    });

    var initialTab =
      tabs.filter(function (tab) {
        return tab.getAttribute('aria-selected') === 'true';
      })[0] || tabs[0];

    if (initialTab) {
      activateTab(initialTab);
    }

    function showPanel(name) {
      var tab = document.getElementById('tab-' + name);
      if (tab && tabs.indexOf(tab) !== -1) {
        activateTab(tab);
      }
    }

    /* =====================================================================
       Status line
       ===================================================================== */
    function setStatus(message) {
      if (dom.statusText) {
        dom.statusText.textContent = String(message);
      }
    }

    /* =====================================================================
       Small utilities
       ===================================================================== */
    function formatBytes(bytes) {
      if (window.YDA && typeof window.YDA.formatBytes === 'function') {
        return window.YDA.formatBytes(bytes);
      }
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
        return '0 B';
      }
      var units = ['B', 'KB', 'MB', 'GB'];
      var i = 0;
      var v = bytes;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
      }
      var d = v >= 10 || i === 0 ? 0 : 1;
      return v.toFixed(d) + ' ' + units[i];
    }

    function countWords(text) {
      if (!text) {
        return 0;
      }
      var match = String(text).match(/\S+/g);
      return match ? match.length : 0;
    }

    function toast(type, message) {
      if (
        window.YDA &&
        window.YDA.toast &&
        typeof window.YDA.toast[type] === 'function'
      ) {
        window.YDA.toast[type](message);
      }
    }

    function setBadge(element, text, style) {
      if (!element) {
        return;
      }
      element.textContent = text;
      element.classList.remove(
        'badge-neutral',
        'badge-accent',
        'badge-success',
        'badge-warning',
        'badge-danger'
      );
      element.classList.add('badge-' + (style || 'neutral'));
    }

    /* =====================================================================
       Stepper
       ===================================================================== */
    function setStepState(stage, newState) {
      var step = document.querySelector('.step[data-stage="' + stage + '"]');
      if (!step) {
        return;
      }
      step.classList.remove('is-current', 'is-complete', 'is-error');
      step.removeAttribute('aria-current');

      if (newState === 'current') {
        step.classList.add('is-current');
        step.setAttribute('aria-current', 'step');
      } else if (newState === 'complete') {
        step.classList.add('is-complete');
      } else if (newState === 'error') {
        step.classList.add('is-error');
      }
    }

    function resetStepper() {
      var steps = document.querySelectorAll('.step[data-stage]');
      for (var i = 0; i < steps.length; i += 1) {
        steps[i].classList.remove('is-current', 'is-complete', 'is-error');
        steps[i].removeAttribute('aria-current');
      }
    }

    /* =====================================================================
       Loading overlays
       ===================================================================== */
    function showLoading() {
      if (dom.previewLoading) {
        dom.previewLoading.hidden = false;
      }
      if (dom.textLoading) {
        dom.textLoading.hidden = false;
      }
    }

    function hideLoading() {
      if (dom.previewLoading) {
        dom.previewLoading.hidden = true;
      }
      if (dom.textLoading) {
        dom.textLoading.hidden = true;
      }
    }

    /* =====================================================================
       File error helpers
       ===================================================================== */
    function showFileError(message) {
      if (!dom.fileError) {
        return;
      }
      dom.fileError.textContent = String(message || '');
      dom.fileError.hidden = false;
      if (dom.dropzone) {
        dom.dropzone.classList.add('has-error');
      }
    }

    function clearFileError() {
      if (!dom.fileError) {
        return;
      }
      dom.fileError.textContent = '';
      dom.fileError.hidden = true;
      if (dom.dropzone) {
        dom.dropzone.classList.remove('has-error');
      }
    }

    /* =====================================================================
       Text panel helpers
       ===================================================================== */
    function updateTextStats() {
      var text = dom.extractedText ? dom.extractedText.value || '' : '';
      var chars = text.length;
      var words = countWords(text);
      if (dom.charCount) {
        dom.charCount.textContent = 'Characters: ' + chars.toLocaleString();
      }
      if (dom.wordCount) {
        dom.wordCount.textContent = 'Words: ' + words.toLocaleString();
      }
    }

    /* =====================================================================
       Preview helpers
       ===================================================================== */
    function applyZoom() {
      if (dom.previewViewport) {
        dom.previewViewport.style.setProperty('--zoom', String(state.zoom));
      }
    }

    function renderPreviewAt(index) {
      var page = state.previewPages[index];
      if (!page || !dom.previewStage) {
        return;
      }
      dom.previewStage.innerHTML = '';
      var img = document.createElement('img');
      img.src = page.dataUrl;
      img.alt = 'Preview of page ' + page.pageNumber;
      dom.previewStage.appendChild(img);
    }

    function updatePreviewControls() {
      var total = state.previewPages.length;
      var index = state.currentPreview;
      var hasPreview = total > 0;

      if (dom.prevPageButton) {
        dom.prevPageButton.disabled = !hasPreview || index <= 0;
      }
      if (dom.nextPageButton) {
        dom.nextPageButton.disabled = !hasPreview || index >= total - 1;
      }

      if (dom.pageIndicator) {
        if (!hasPreview) {
          dom.pageIndicator.textContent = 'No pages';
        } else {
          var page = state.previewPages[index];
          var totalPages = state.result
            ? state.result.pageCount
            : page.pageNumber;
          dom.pageIndicator.textContent =
            'Page ' + page.pageNumber + ' of ' + totalPages;
        }
      }

      if (dom.zoomOutButton) {
        dom.zoomOutButton.disabled = !hasPreview || state.zoom <= ZOOM_MIN;
      }
      if (dom.zoomInButton) {
        dom.zoomInButton.disabled = !hasPreview || state.zoom >= ZOOM_MAX;
      }
      if (dom.zoomFitButton) {
        dom.zoomFitButton.disabled = !hasPreview || state.zoom === ZOOM_DEFAULT;
      }
      if (dom.zoomLevel) {
        dom.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
      }
    }

    function appendPreview(pageNumber, dataUrl) {
      state.previewPages.push({ pageNumber: pageNumber, dataUrl: dataUrl });

      if (state.previewPages.length === 1) {
        state.currentPreview = 0;
        renderPreviewAt(0);
        if (dom.previewEmpty) {
          dom.previewEmpty.hidden = true;
        }
        if (dom.previewStage) {
          dom.previewStage.hidden = false;
        }
      }
      updatePreviewControls();
    }

    /* =====================================================================
       Reset helpers
       ===================================================================== */
    function disableExport() {
      if (dom.exportButton) {
        dom.exportButton.disabled = true;
      }
      Array.prototype.forEach.call(dom.exportFormatButtons || [], function (b) {
        b.disabled = true;
      });
    }

    function resetResults() {
      state.result = null;
      state.processedAt = null;
      state.previewPages = [];
      state.currentPreview = 0;
      state.zoom = ZOOM_DEFAULT;

      if (dom.extractedText) {
        dom.extractedText.value = '';
        dom.extractedText.disabled = true;
      }
      updateTextStats();

      if (dom.copyTextButton) {
        dom.copyTextButton.disabled = true;
      }
      if (dom.clearTextButton) {
        dom.clearTextButton.disabled = true;
      }

      if (dom.previewStage) {
        dom.previewStage.innerHTML = '';
        dom.previewStage.hidden = true;
      }
      if (dom.previewEmpty) {
        dom.previewEmpty.hidden = false;
      }

      setBadge(dom.previewBadge, 'No document', 'neutral');
      setBadge(dom.extractionBadge, 'Not started', 'neutral');

      disableExport();

      applyZoom();
      updatePreviewControls();
    }

    function resetWorkspace() {
      state.file = null;
      state.processing = false;

      if (dom.fileInfo) {
        dom.fileInfo.hidden = true;
      }
      if (dom.fileName) {
        dom.fileName.textContent = '';
      }
      if (dom.fileMeta) {
        dom.fileMeta.textContent = '';
      }
      if (dom.fileInput) {
        dom.fileInput.value = '';
      }

      resetResults();
      hideLoading();
      resetStepper();
      setStepState('upload', 'current');
      clearFileError();
      setStatus('No document selected.');
    }

    /* =====================================================================
       Progress handling
       ===================================================================== */
    function handleProgress(progress) {
      if (!progress) {
        return;
      }
      setStatus(progress.message || 'Processing...');

      var stage = progress.stage;
      if (stage === 'validating') {
        setStepState('upload', 'current');
      } else if (stage === 'loading-libs' || stage === 'reading-pdf') {
        setStepState('upload', 'complete');
        setStepState('read', 'current');
      } else if (
        stage === 'extracting-text' ||
        stage === 'rendering' ||
        stage === 'ocr'
      ) {
        setStepState('upload', 'complete');
        setStepState('read', 'complete');
        setStepState('extract', 'current');
      }
    }

    /* =====================================================================
       Processing pipeline
       ===================================================================== */
    function runProcessing(file) {
      processGeneration += 1;
      var myGeneration = processGeneration;

      state.processing = true;
      state.previewPages = [];
      state.currentPreview = 0;
      state.zoom = ZOOM_DEFAULT;

      if (dom.extractedText) {
        dom.extractedText.value = '';
        dom.extractedText.disabled = true;
      }
      updateTextStats();

      if (dom.copyTextButton) {
        dom.copyTextButton.disabled = true;
      }
      if (dom.clearTextButton) {
        dom.clearTextButton.disabled = true;
      }
      disableExport();

      if (dom.previewStage) {
        dom.previewStage.innerHTML = '';
        dom.previewStage.hidden = true;
      }
      if (dom.previewEmpty) {
        dom.previewEmpty.hidden = false;
      }

      setBadge(dom.previewBadge, 'Loading', 'accent');
      setBadge(dom.extractionBadge, 'Working', 'accent');

      resetStepper();
      setStepState('upload', 'current');
      setStatus('Starting...');
      showLoading();
      updatePreviewControls();
      applyZoom();

      var startedAt = new Date().toISOString();

      window.YDADocumentProcessor.processFile(file, {
        onProgress: handleProgress,
        onPageText: function (pageResult) {
          if (myGeneration !== processGeneration) {
            return;
          }
          if (!pageResult || !pageResult.text) {
            return;
          }
          if (dom.extractedText) {
            var current = dom.extractedText.value;
            var prefix = current ? '\n\n' : '';
            dom.extractedText.value = current + prefix + pageResult.text;
            updateTextStats();
          }
        },
        onPreview: function (pageNumber, dataUrl) {
          if (myGeneration !== processGeneration) {
            return;
          }
          appendPreview(pageNumber, dataUrl);
        }
      })
        .then(function (result) {
          if (myGeneration !== processGeneration) {
            return;
          }

          state.result = result;
          state.processedAt = startedAt;
          state.processing = false;

          hideLoading();

          if (dom.extractedText) {
            dom.extractedText.value = result.fullText || '';
            dom.extractedText.disabled = false;
          }
          updateTextStats();

          if (dom.copyTextButton) {
            dom.copyTextButton.disabled = false;
          }
          if (dom.clearTextButton) {
            dom.clearTextButton.disabled = false;
          }

          setBadge(dom.extractionBadge, 'Complete', 'success');

          if (result.kind === 'pdf') {
            setBadge(
              dom.previewBadge,
              result.pageCount +
                ' page' +
                (result.pageCount === 1 ? '' : 's'),
              'success'
            );
          } else {
            setBadge(dom.previewBadge, 'Image', 'success');
          }

          setStepState('upload', 'complete');
          setStepState('read', 'complete');
          setStepState('extract', 'complete');
          setStepState('analysis', 'reset');
          setStepState('review', 'current');
          setStepState('export', 'reset');

          if (dom.exportButton) {
            dom.exportButton.disabled = false;
          }
          Array.prototype.forEach.call(
            dom.exportFormatButtons || [],
            function (b) {
              b.disabled = false;
            }
          );

          if (result.warnings && result.warnings.length) {
            setStatus(
              'Extracted text from ' +
                result.pageCount +
                ' page(s). ' +
                result.warnings.length +
                ' warning(s). Review and export when ready.'
            );
            toast('warning', result.warnings[0]);
          } else {
            setStatus(
              'Extracted text from ' +
                result.pageCount +
                ' page(s). Review and export when ready.'
            );
            toast('success', 'Document processed successfully.');
          }

          updatePreviewControls();
        })
        .catch(function (err) {
          if (myGeneration !== processGeneration) {
            return;
          }

          state.processing = false;
          hideLoading();

          if (err && err.code === 'CANCELLED') {
            setStatus('Processing cancelled.');
            setBadge(dom.extractionBadge, 'Cancelled', 'neutral');
            setBadge(dom.previewBadge, 'No document', 'neutral');
            resetStepper();
            setStepState('upload', 'current');
            return;
          }

          var message =
            err && err.userMessage
              ? err.userMessage
              : 'Processing failed. Please try again.';

          showFileError(message);
          setStatus(message);
          setBadge(dom.extractionBadge, 'Error', 'danger');
          setBadge(dom.previewBadge, 'No document', 'neutral');

          var current = document.querySelector('.step.is-current');
          if (current) {
            current.classList.remove('is-current');
            current.classList.add('is-error');
            current.removeAttribute('aria-current');
          }

          toast('error', message);
          updatePreviewControls();
        });
    }

    /* =====================================================================
       File selection
       ===================================================================== */
    function handleFileSelected(file) {
      if (!file) {
        return;
      }
      if (!window.YDADocumentProcessor) {
        showFileError(
          'The processing module is not available. Please reload the page.'
        );
        return;
      }

      // Cancel any in-flight processing before starting a new run.
      if (state.processing && window.YDADocumentProcessor.cancel) {
        window.YDADocumentProcessor.cancel();
      }

      var validation = window.YDADocumentProcessor.validateFile(file);
      if (!validation.valid) {
        showFileError(validation.error.message);
        setStatus(validation.error.message);
        toast('error', validation.error.message);
        return;
      }

      clearFileError();

      state.file = file;

      if (dom.fileName) {
        dom.fileName.textContent = file.name;
      }
      if (dom.fileMeta) {
        dom.fileMeta.textContent =
          formatBytes(file.size) + ' - ' + (file.type || 'unknown type');
      }
      if (dom.fileInfo) {
        dom.fileInfo.hidden = false;
      }

      runProcessing(file);
    }

    /* =====================================================================
       Export
       ===================================================================== */
    function buildExportPayload() {
      if (!state.result) {
        return null;
      }
      return {
        fileName: state.result.fileName,
        fileType: state.result.fileType,
        fileSize: state.result.fileSize,
        kind: state.result.kind,
        pageCount: state.result.pageCount,
        fullText:
          dom.extractedText && dom.extractedText.value
            ? dom.extractedText.value
            : state.result.fullText,
        pages: state.result.pages,
        warnings: state.result.warnings,
        documentType: null,
        fields: [],
        processedAt: state.processedAt,
        analyzedAt: null
      };
    }

    function handleExportClick(format) {
      if (!state.result) {
        return;
      }
      if (!window.YDAExport) {
        toast('error', 'The export module is not available.');
        return;
      }

      try {
        var payload = buildExportPayload();
        var summary = window.YDAExport.download(format, payload);
        toast('success', 'Export started: ' + summary.filename);

        if (dom.exportDialog && window.YDA && window.YDA.modal) {
          window.YDA.modal.close(dom.exportDialog);
        }
      } catch (err) {
        toast(
          'error',
          'Export failed: ' +
            (err && err.message ? err.message : 'unknown error')
        );
      }
    }

    /* =====================================================================
       Clipboard helper
       ===================================================================== */
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () {
            return true;
          },
          function () {
            return false;
          }
        );
      }
      // Fallback for browsers without the async clipboard API.
      try {
        if (dom.extractedText) {
          dom.extractedText.select();
          var ok = document.execCommand('copy');
          return Promise.resolve(Boolean(ok));
        }
      } catch (err) {
        // ignore
      }
      return Promise.resolve(false);
    }

    /* =====================================================================
       Event wiring
       ===================================================================== */

    // Enable upload now that the Phase 3 modules are available.
    if (window.YDADocumentProcessor) {
      if (dom.fileInput) {
        dom.fileInput.disabled = false;
      }
      if (dom.dropzone) {
        dom.dropzone.classList.remove('is-disabled');
      }
    }

    // File input change.
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', function (event) {
        var files = event.target.files;
        if (files && files.length) {
          handleFileSelected(files[0]);
        }
        // Reset so selecting the same file again re-triggers change.
        event.target.value = '';
      });
    }

    // Drag and drop on the dropzone.
    if (dom.dropzone) {
      var dragDepth = 0;

      dom.dropzone.addEventListener('dragenter', function (event) {
        event.preventDefault();
        if (dom.dropzone.classList.contains('is-disabled')) {
          return;
        }
        dragDepth += 1;
        dom.dropzone.classList.add('is-dragover');
      });

      dom.dropzone.addEventListener('dragover', function (event) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      });

      dom.dropzone.addEventListener('dragleave', function (event) {
        event.preventDefault();
        dragDepth -= 1;
        if (dragDepth <= 0) {
          dragDepth = 0;
          dom.dropzone.classList.remove('is-dragover');
        }
      });

      dom.dropzone.addEventListener('drop', function (event) {
        event.preventDefault();
        dragDepth = 0;
        dom.dropzone.classList.remove('is-dragover');
        if (dom.dropzone.classList.contains('is-disabled')) {
          return;
        }
        var files = event.dataTransfer && event.dataTransfer.files;
        if (files && files.length) {
          handleFileSelected(files[0]);
        }
      });
    }

    // Replace and Remove.
    if (dom.replaceButton) {
      dom.replaceButton.addEventListener('click', function () {
        if (dom.fileInput) {
          dom.fileInput.value = '';
          dom.fileInput.click();
        }
      });
    }

    if (dom.removeButton) {
      dom.removeButton.addEventListener('click', function () {
        if (state.processing && window.YDADocumentProcessor.cancel) {
          window.YDADocumentProcessor.cancel();
        }
        resetWorkspace();
      });
    }

    // Text panel.
    if (dom.extractedText) {
      dom.extractedText.addEventListener('input', updateTextStats);
    }

    if (dom.copyTextButton) {
      dom.copyTextButton.addEventListener('click', function () {
        var text = dom.extractedText ? dom.extractedText.value : '';
        if (!text) {
          return;
        }
        copyText(text).then(function (ok) {
          if (ok) {
            toast('success', 'Text copied to clipboard.');
          } else {
            toast('error', 'Could not copy text.');
          }
        });
      });
    }

    if (dom.clearTextButton) {
      dom.clearTextButton.addEventListener('click', function () {
        if (dom.extractedText) {
          dom.extractedText.value = '';
        }
        updateTextStats();
      });
    }

    // Preview page navigation.
    if (dom.prevPageButton) {
      dom.prevPageButton.addEventListener('click', function () {
        if (state.currentPreview > 0) {
          state.currentPreview -= 1;
          renderPreviewAt(state.currentPreview);
          updatePreviewControls();
        }
      });
    }

    if (dom.nextPageButton) {
      dom.nextPageButton.addEventListener('click', function () {
        if (state.currentPreview < state.previewPages.length - 1) {
          state.currentPreview += 1;
          renderPreviewAt(state.currentPreview);
          updatePreviewControls();
        }
      });
    }

    // Zoom controls.
    if (dom.zoomInButton) {
      dom.zoomInButton.addEventListener('click', function () {
        state.zoom = Math.min(ZOOM_MAX, state.zoom * ZOOM_STEP);
        applyZoom();
        updatePreviewControls();
      });
    }

    if (dom.zoomOutButton) {
      dom.zoomOutButton.addEventListener('click', function () {
        state.zoom = Math.max(ZOOM_MIN, state.zoom / ZOOM_STEP);
        applyZoom();
        updatePreviewControls();
      });
    }

    if (dom.zoomFitButton) {
      dom.zoomFitButton.addEventListener('click', function () {
        state.zoom = ZOOM_DEFAULT;
        applyZoom();
        updatePreviewControls();
      });
    }

    // Export format buttons inside the export dialog.
    Array.prototype.forEach.call(dom.exportFormatButtons || [], function (button) {
      button.addEventListener('click', function () {
        var format = button.getAttribute('data-export');
        handleExportClick(format);
      });
    });

    /* =====================================================================
       Initial state
       ===================================================================== */
    resetWorkspace();
    updatePreviewControls();

    /* =====================================================================
       Public API
       ===================================================================== */
    window.YDAWorkspace = Object.freeze({
      VERSION: VERSION,
      showPanel: showPanel,
      setStatus: setStatus
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
