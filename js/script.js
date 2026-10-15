/* ==========================================================================
   Yadav Document AI
   File: js/script.js
   Purpose: Shared behavior used by every page.
   Depends on: css/style.css, css/components.css
   Developed by Yadav Web Technologies

   Load on every page, before page-specific scripts:
     <script src="js/script.js" defer></script>

   Public API (window.YDA):
     YDA.toast.show(message, { type, duration })
     YDA.toast.success / error / warning / info (message, options)
     YDA.modal.open(dialog) / YDA.modal.close(dialog)
     YDA.setBusy(button, isBusy)    YDA.isBusy(button)
     YDA.setProgress(progressEl, percent)
     YDA.announce(message)          Screen-reader live announcement
     YDA.formatBytes(bytes)
     YDA.debounce(fn, wait)
     YDA.nav.open() / YDA.nav.close() / YDA.nav.isOpen()

   Markup hooks this file understands:
     [data-nav-toggle]            Button that opens the drawer (aria-controls="sidebar")
     [data-nav-close]             Button inside the drawer that closes it
     #sidebar                     The sidebar element
     .sidebar-overlay             Backdrop element
     body[data-page="name"]       Marks the current page
     .nav-link[data-page="name"]  Receives aria-current="page" when it matches
     .nav-link.is-upcoming        Shows an "upcoming" notice instead of navigating
     [data-modal-open="id"]       Opens the <dialog> with that id
     [data-modal-close]           Closes the enclosing <dialog>
     [data-connection-status]     Badge updated with online/offline state
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     Constants
     ------------------------------------------------------------------------ */
  var DESKTOP_QUERY = '(min-width: 1024px)';
  var MODAL_EXIT_MS = 250;        // matches --duration-slow in style.css
  var TOAST_EXIT_MS = 200;        // matches --duration-base in style.css
  var TOAST_MAX_VISIBLE = 4;
  var TOAST_DURATION = { success: 4000, info: 5000, warning: 6000, error: 8000 };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /* ------------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------------ */

  /** Format a byte count as a readable string, e.g. 1.5 MB. */
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
      return '0 B';
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

  /** Return a debounced version of fn. */
  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var context = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(context, args);
      }, wait);
    };
  }

  function getFocusable(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll(FOCUSABLE),
      function (element) {
        return element.offsetParent !== null || element === document.activeElement;
      }
    );
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ------------------------------------------------------------------------
     Screen-reader announcements
     A single polite live region, created on demand.
     ------------------------------------------------------------------------ */
  var liveRegion = null;

  function ensureLiveRegion() {
    if (liveRegion && document.body.contains(liveRegion)) {
      return liveRegion;
    }
    liveRegion = document.createElement('div');
    liveRegion.className = 'visually-hidden';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('aria-atomic', 'true');
    document.body.appendChild(liveRegion);
    return liveRegion;
  }

  /** Announce a message to assistive technology without showing it. */
  function announce(message) {
    var region = ensureLiveRegion();
    // Clear first so repeated identical messages are announced again.
    region.textContent = '';
    window.setTimeout(function () {
      region.textContent = String(message);
    }, 50);
  }

  /* ------------------------------------------------------------------------
     Busy buttons and duplicate-submission guard
     ------------------------------------------------------------------------ */

  /** Put a button into or out of its loading state. */
  function setBusy(button, isBusy) {
    if (!button) {
      return;
    }
    if (isBusy) {
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.removeAttribute('aria-busy');
      button.removeAttribute('aria-disabled');
    }
  }

  function isBusy(button) {
    return Boolean(button) && button.getAttribute('aria-busy') === 'true';
  }

  /**
   * Capture-phase guard: clicks on busy or aria-disabled buttons are stopped
   * before any other listener sees them. This prevents double submissions
   * from mouse, touch, and keyboard activation while keeping focus in place.
   */
  function installClickGuard() {
    document.addEventListener(
      'click',
      function (event) {
        var target = event.target.closest
          ? event.target.closest('button, [role="button"], a.btn')
          : null;
        if (
          target &&
          (target.getAttribute('aria-busy') === 'true' ||
            target.getAttribute('aria-disabled') === 'true')
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
  }

  /* ------------------------------------------------------------------------
     Progress helper
     ------------------------------------------------------------------------ */

  /** Update a .progress element. Pass a number from 0 to 100. */
  function setProgress(progressEl, percent) {
    if (!progressEl) {
      return;
    }
    var value = Math.max(0, Math.min(100, Number(percent) || 0));
    var bar = progressEl.querySelector('.progress-bar');
    progressEl.classList.remove('is-indeterminate');
    progressEl.setAttribute('aria-valuenow', String(Math.round(value)));
    if (bar) {
      bar.style.setProperty('--progress', value + '%');
      bar.style.setProperty('--progress-ratio', String(value / 100));
    }
  }

  /* ------------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------------ */
  var toastRegion = null;

  function ensureToastRegion() {
    if (toastRegion && document.body.contains(toastRegion)) {
      return toastRegion;
    }
    toastRegion = document.createElement('div');
    toastRegion.className = 'toast-region';
    toastRegion.setAttribute('role', 'region');
    toastRegion.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(toastRegion);
    return toastRegion;
  }

  function createCloseIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    svg.appendChild(path);
    return svg;
  }

  function removeToast(toast) {
    if (!toast || toast.dataset.removing === 'true') {
      return;
    }
    toast.dataset.removing = 'true';
    toast.classList.remove('is-visible');
    window.setTimeout(function () {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, prefersReducedMotion() ? 0 : TOAST_EXIT_MS);
  }

  /**
   * Show a non-intrusive notification.
   * options.type: 'success' | 'error' | 'warning' | 'info' (default 'info')
   * options.duration: milliseconds; 0 keeps it until dismissed
   */
  function showToast(message, options) {
    var settings = options || {};
    var type = TOAST_DURATION.hasOwnProperty(settings.type) ? settings.type : 'info';
    var duration =
      typeof settings.duration === 'number' ? settings.duration : TOAST_DURATION[type];
    var text = String(message);
    var region = ensureToastRegion();

    // Avoid stacking identical messages.
    var existing = region.querySelectorAll('.toast:not([data-removing="true"])');
    for (var i = 0; i < existing.length; i += 1) {
      if (existing[i].dataset.message === text && existing[i].dataset.type === type) {
        return existing[i];
      }
    }

    // Cap the number of visible toasts by removing the oldest.
    while (existing.length >= TOAST_MAX_VISIBLE) {
      removeToast(existing[0]);
      existing = region.querySelectorAll('.toast:not([data-removing="true"])');
    }

    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.dataset.message = text;
    toast.dataset.type = type;
    // Errors interrupt screen readers; everything else is polite.
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    var label = document.createElement('p');
    label.className = 'toast-message';
    var prefix = { success: 'Success: ', error: 'Error: ', warning: 'Warning: ', info: '' };
    label.textContent = prefix[type] + text;

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.appendChild(createCloseIcon());
    close.addEventListener('click', function () {
      removeToast(toast);
    });

    toast.appendChild(label);
    toast.appendChild(close);
    region.appendChild(toast);

    // Next frame so the enter transition runs.
    window.requestAnimationFrame(function () {
      toast.classList.add('is-visible');
    });

    if (duration > 0) {
      var timer = window.setTimeout(function () {
        removeToast(toast);
      }, duration);

      // Pause auto-dismiss while the user is reading or interacting.
      var pause = function () {
        window.clearTimeout(timer);
      };
      var resume = function () {
        timer = window.setTimeout(function () {
          removeToast(toast);
        }, duration);
      };
      toast.addEventListener('mouseenter', pause);
      toast.addEventListener('mouseleave', resume);
      toast.addEventListener('focusin', pause);
      toast.addEventListener('focusout', resume);
    }

    return toast;
  }

  var toast = {
    show: showToast,
    success: function (message, options) {
      return showToast(message, Object.assign({}, options, { type: 'success' }));
    },
    error: function (message, options) {
      return showToast(message, Object.assign({}, options, { type: 'error' }));
    },
    warning: function (message, options) {
      return showToast(message, Object.assign({}, options, { type: 'warning' }));
    },
    info: function (message, options) {
      return showToast(message, Object.assign({}, options, { type: 'info' }));
    }
  };

  /* ------------------------------------------------------------------------
     Navigation drawer
     Below 1024px the sidebar is a drawer. At 1024px and above it is
     permanent, so any open state is cleared when the viewport grows.
     ------------------------------------------------------------------------ */
  var desktopMedia = window.matchMedia(DESKTOP_QUERY);
  var navState = { lastToggle: null };

  function getSidebar() {
    return document.getElementById('sidebar');
  }

  function isNavOpen() {
    return document.body.classList.contains('nav-open');
  }

  function syncToggleState(open) {
    var toggles = document.querySelectorAll('[data-nav-toggle]');
    for (var i = 0; i < toggles.length; i += 1) {
      toggles[i].setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function openNav(triggerElement) {
    var sidebar = getSidebar();
    if (!sidebar || desktopMedia.matches || isNavOpen()) {
      return;
    }
    navState.lastToggle = triggerElement || document.activeElement;
    document.body.classList.add('nav-open');
    syncToggleState(true);

    // Move focus into the drawer once it is visible.
    window.setTimeout(function () {
      var items = getFocusable(sidebar);
      if (items.length) {
        items[0].focus();
      }
    }, 30);
  }

  function closeNav(restoreFocus) {
    if (!isNavOpen()) {
      return;
    }
    document.body.classList.remove('nav-open');
    syncToggleState(false);

    if (restoreFocus !== false && navState.lastToggle && navState.lastToggle.focus) {
      navState.lastToggle.focus();
    }
    navState.lastToggle = null;
  }

  function trapDrawerFocus(event) {
    if (event.key !== 'Tab' || !isNavOpen()) {
      return;
    }
    var sidebar = getSidebar();
    if (!sidebar) {
      return;
    }
    var items = getFocusable(sidebar);
    if (!items.length) {
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];

    if (!sidebar.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function initNavigation() {
    var sidebar = getSidebar();
    if (!sidebar) {
      return;
    }

    // Toggle buttons.
    var toggles = document.querySelectorAll('[data-nav-toggle]');
    for (var i = 0; i < toggles.length; i += 1) {
      toggles[i].setAttribute('aria-controls', 'sidebar');
      toggles[i].setAttribute('aria-expanded', 'false');
    }

    // One delegated listener handles toggle, close, overlay, and link clicks.
    document.addEventListener('click', function (event) {
      var toggle = event.target.closest('[data-nav-toggle]');
      if (toggle) {
        if (isNavOpen()) {
          closeNav();
        } else {
          openNav(toggle);
        }
        return;
      }

      if (event.target.closest('[data-nav-close]')) {
        closeNav();
        return;
      }

      if (event.target.closest('.sidebar-overlay')) {
        closeNav();
        return;
      }

      // Following a real link inside the drawer closes it without
      // stealing focus from the page that is about to load.
      var link = event.target.closest('#sidebar .nav-link');
      if (link && !link.classList.contains('is-upcoming') && isNavOpen()) {
        closeNav(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isNavOpen()) {
        event.preventDefault();
        closeNav();
        return;
      }
      trapDrawerFocus(event);
    });

    // Clear drawer state when the viewport becomes desktop-sized.
    var onBreakpointChange = function (event) {
      if (event.matches) {
        closeNav(false);
      }
    };
    if (desktopMedia.addEventListener) {
      desktopMedia.addEventListener('change', onBreakpointChange);
    } else if (desktopMedia.addListener) {
      desktopMedia.addListener(onBreakpointChange);
    }
  }

  /** Mark the current page link and handle sections that are not built yet. */
  function initNavLinks() {
    var currentPage = document.body.dataset.page;
    var links = document.querySelectorAll('.nav-link');

    for (var i = 0; i < links.length; i += 1) {
      var link = links[i];

      if (currentPage && link.dataset.page === currentPage) {
        link.setAttribute('aria-current', 'page');
      }

      if (link.classList.contains('is-upcoming')) {
        link.setAttribute('aria-disabled', 'true');
      }
    }

    // Upcoming sections explain themselves instead of silently doing nothing.
    document.addEventListener('click', function (event) {
      var link = event.target.closest('.nav-link.is-upcoming');
      if (!link) {
        return;
      }
      event.preventDefault();
      var nameNode = link.querySelector('.nav-label');
      var name = nameNode ? nameNode.textContent.trim() : 'This section';
      toast.info(name + ' is an upcoming feature and is not available yet.');
    });
  }

  /* ------------------------------------------------------------------------
     Modal dialogs (native <dialog>)
     ------------------------------------------------------------------------ */
  var modalOpeners = new WeakMap();

  function openModal(dialog, triggerElement) {
    if (!dialog || dialog.open) {
      return;
    }
    modalOpeners.set(dialog, triggerElement || document.activeElement);

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      // Very old browsers: fall back to a plain open dialog.
      dialog.setAttribute('open', '');
    }

    // Next frame so the enter transition runs.
    window.requestAnimationFrame(function () {
      dialog.classList.add('is-open');
    });
  }

  function closeModal(dialog) {
    if (!dialog || !dialog.open || dialog.dataset.closing === 'true') {
      return;
    }
    dialog.dataset.closing = 'true';
    dialog.classList.remove('is-open');

    var finish = function () {
      delete dialog.dataset.closing;
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
      var opener = modalOpeners.get(dialog);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus();
      }
      modalOpeners.delete(dialog);
    };

    if (prefersReducedMotion()) {
      finish();
    } else {
      window.setTimeout(finish, MODAL_EXIT_MS);
    }
  }

  function initModals() {
    document.addEventListener('click', function (event) {
      var opener = event.target.closest('[data-modal-open]');
      if (opener) {
        var target = document.getElementById(opener.getAttribute('data-modal-open'));
        if (target) {
          event.preventDefault();
          openModal(target, opener);
        }
        return;
      }

      var closer = event.target.closest('[data-modal-close]');
      if (closer) {
        event.preventDefault();
        closeModal(closer.closest('dialog'));
        return;
      }

      // The dialog fills the viewport, so a click that lands on the dialog
      // element itself is a click on the backdrop area.
      if (event.target.matches && event.target.matches('dialog.modal[open]')) {
        closeModal(event.target);
      }
    });

    // Escape fires "cancel"; route it through the animated close.
    document.addEventListener(
      'cancel',
      function (event) {
        if (event.target.matches && event.target.matches('dialog.modal')) {
          event.preventDefault();
          closeModal(event.target);
        }
      },
      true
    );
  }

  /* ------------------------------------------------------------------------
     Connection status
     Updates any [data-connection-status] badge and informs the user when the
     connection drops or returns. The text states the status, so the meaning
     never depends on color alone.
     ------------------------------------------------------------------------ */
  function renderConnectionStatus() {
    var online = navigator.onLine !== false;
    var nodes = document.querySelectorAll('[data-connection-status]');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      node.textContent = online ? 'Online' : 'Offline';
      node.classList.remove('badge-success', 'badge-warning', 'badge-neutral');
      node.classList.add(online ? 'badge-success' : 'badge-warning');
    }
    return online;
  }

  function initConnectionStatus() {
    renderConnectionStatus();

    window.addEventListener('offline', function () {
      renderConnectionStatus();
      toast.warning(
        'You are offline. Local text extraction still works, but AI analysis needs a connection.',
        { duration: 8000 }
      );
      announce('You are offline.');
    });

    window.addEventListener('online', function () {
      renderConnectionStatus();
      toast.success('Connection restored.');
      announce('Connection restored.');
    });
  }

  /* ------------------------------------------------------------------------
     Initialisation
     ------------------------------------------------------------------------ */
  function init() {
    installClickGuard();
    initNavigation();
    initNavLinks();
    initModals();
    initConnectionStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ------------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------------ */
  window.YDA = Object.freeze({
    toast: Object.freeze(toast),
    modal: Object.freeze({ open: openModal, close: closeModal }),
    nav: Object.freeze({
      open: openNav,
      close: closeNav,
      isOpen: isNavOpen
    }),
    setBusy: setBusy,
    isBusy: isBusy,
    setProgress: setProgress,
    announce: announce,
    formatBytes: formatBytes,
    debounce: debounce
  });
})();
