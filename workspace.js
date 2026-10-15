/* ==========================================================================
   Yadav Document AI
   File: js/workspace.js
   Purpose: Behavior for workspace.html.
   Depends on: workspace.html, css/workspace.css, js/script.js
   Developed by Yadav Web Technologies

   Current scope (Phase 2): panel tabs and the status line.
   Upload, document processing, AI analysis and export are added in Phase 3
   and later; this file is replaced in full when they are.

   Public API (window.YDAWorkspace):
     YDAWorkspace.showPanel('preview' | 'text' | 'results')
     YDAWorkspace.setStatus(message)

   Tabs below 1280px: one panel is visible at a time. From 1280px the tab bar
   is hidden by CSS and every panel is visible, so nothing here needs to react
   to the viewport size.
   ========================================================================== */

(function () {
  'use strict';

  var tabList = document.querySelector('.workspace-tabs');
  if (!tabList) {
    return;
  }

  var tabs = Array.prototype.slice.call(tabList.querySelectorAll('[role="tab"]'));

  /* ------------------------------------------------------------------------
     Tabs
     Pattern: roving tabindex with automatic activation. Only the selected tab
     is in the Tab order; arrow keys move between tabs.
     ------------------------------------------------------------------------ */

  /** Show one panel and update every tab to match. */
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

  // Make the initial state match the markup's aria-selected tab.
  var initialTab = tabs.filter(function (tab) {
    return tab.getAttribute('aria-selected') === 'true';
  })[0] || tabs[0];

  if (initialTab) {
    activateTab(initialTab);
  }

  /* ------------------------------------------------------------------------
     Status line
     The element is a role="status" region, so changes are announced.
     ------------------------------------------------------------------------ */
  var statusText = document.getElementById('workspace-status-text');

  function setStatus(message) {
    if (statusText) {
      statusText.textContent = String(message);
    }
  }

  /* ------------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------------ */

  /** Show a panel by name: 'preview', 'text' or 'results'. */
  function showPanel(name) {
    var tab = document.getElementById('tab-' + name);
    if (tab && tabs.indexOf(tab) !== -1) {
      activateTab(tab);
    }
  }

  window.YDAWorkspace = Object.freeze({
    showPanel: showPanel,
    setStatus: setStatus
  });
})();
