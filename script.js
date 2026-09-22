/* =========================================================================
   NASS – script.js
   1. Config
   2. Storage helpers
   3. Search engine abstraction  (searchEngine.search(query))
   4. Tabs + per-tab history
   5. UI: address bar, home, results, menu, theme, recents
   ========================================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     1. CONFIG – edit these to customise NASS
     --------------------------------------------------------------------- */

  // Which search provider NASS uses. Only "google" (your Programmable Search
  // Engine) is implemented. See the note above `providers` to add another.
  const SEARCH_PROVIDER = 'google';

  // Name the Programmable Search "results" element is registered under.
  // Must match data-gname in index.html.
  const CSE_GNAME = 'nass';

  // Site shortcuts on the home page. They open in a NEW browser tab, because
  // Google and most big sites forbid being displayed inside another page.
  const SHORTCUTS = [
    { name: 'Google',    url: 'https://www.google.com',    color: '#4285f4' },
    { name: 'YouTube',   url: 'https://www.youtube.com',   color: '#ff2d2d' },
    { name: 'Wikipedia', url: 'https://www.wikipedia.org', color: '#5b5b6b' },
    { name: 'GitHub',    url: 'https://github.com',        color: '#7a3cf0' },
    { name: 'Gmail',     url: 'https://mail.google.com',   color: '#ea4335' },
    { name: 'Maps',      url: 'https://maps.google.com',   color: '#0f9d58' }
  ];

  const MAX_RECENTS = 8;
  const SEARCH_TIMEOUT_MS = 15000;

  /* ---------------------------------------------------------------------
     2. Storage helpers (never throw – storage can be blocked)
     --------------------------------------------------------------------- */
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('nass.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('nass.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  /* ---------------------------------------------------------------------
     3. Search engine abstraction
     The rest of the app only ever calls   searchEngine.search(query)
     and listens with                      searchEngine.on(fn)
     Events: {state: 'loading' | 'ready' | 'empty' | 'error', query}

     ADDING ANOTHER PROVIDER LATER (e.g. Bing):
       - NEVER put an API key in this file. Create a backend endpoint such as
         /api/search?q=... that holds the key and returns JSON.
       - Add an entry to `providers` below whose search(query) calls that
         endpoint, renders the results into your own markup, and emits the same
         events. Then change SEARCH_PROVIDER. Nothing else needs to change.
     --------------------------------------------------------------------- */
  const providers = {
    // Google's own "ready" callback tells us a response arrived, but its result
    // count is not a reliable signal across widget versions, so instead of
    // trusting it we watch the actual rendered DOM inside #cseHold and classify
    // the outcome from what Google put there. This is slower to write but far
    // more robust than trusting undocumented callback parameters.
    google: (function () {
      let emit = function () {};
      let errorTimer = null;
      let settleTimer = null;
      let observer = null;
      let pendingQuery = null;
      let resolved = false;

      const RESULT_SELECTOR = '.gsc-webResult, .gs-webResult, .gsc-imageResult, .gsc-result';
      const NO_RESULTS_SELECTOR = '.gs-no-results-result, .gsc-no-results-result';

      function clearAll() {
        clearTimeout(errorTimer); errorTimer = null;
        clearTimeout(settleTimer); settleTimer = null;
      }

      function finish(state, query) {
        if (resolved) return;
        resolved = true;
        clearAll();
        if (observer) { observer.disconnect(); observer = null; }
        emit({ state: state, query: query });
      }

      function classify() {
        const hold = document.getElementById('cseHold');
        if (!hold) return null;
        if (hold.querySelector(RESULT_SELECTOR)) return 'ready';
        if (hold.querySelector(NO_RESULTS_SELECTOR)) return 'empty';
        return null;
      }

      function watch(query) {
        pendingQuery = query;
        resolved = false;
        clearAll();
        const hold = document.getElementById('cseHold');
        if (observer) observer.disconnect();
        if (hold) {
          observer = new MutationObserver(function () {
            // Debounce: classify once the DOM has been quiet for a moment,
            // since Google clears old nodes before inserting new ones.
            clearTimeout(settleTimer);
            settleTimer = setTimeout(function () {
              const result = classify();
              if (result) finish(result, query);
            }, 220);
          });
          observer.observe(hold, { childList: true, subtree: true });
        }
        // Absolute ceiling: if nothing definitive happens in time, surface an error
        // instead of leaving the person staring at a permanent loading skeleton.
        errorTimer = setTimeout(function () { finish('error', query); }, SEARCH_TIMEOUT_MS);
      }

      return {
        // Runs immediately, BEFORE cse.js loads, so callbacks are registered in time.
        init: function (emitFn) {
          emit = emitFn;
          window.__gcse = {
            parsetags: 'onload',
            searchCallbacks: {
              web: {
                starting: function (gname, query) { emit({ state: 'loading', query: query }); },
                error: function (gname, query) { finish('error', query); }
              }
            }
          };
        },

        // Waits (up to 10 s) for the search widget to finish loading, then runs the query.
        search: function (query) {
          return new Promise(function (resolve, reject) {
            const started = Date.now();
            (function poll() {
              let el = null;
              try { el = window.google.search.cse.element.getElement(CSE_GNAME); } catch (e) { /* not loaded yet */ }
              if (el) {
                watch(query);
                el.execute(query);
                resolve();
              } else if (Date.now() - started > 10000) {
                reject(new Error('search unavailable'));
              } else {
                setTimeout(poll, 120);
              }
            })();
          });
        }
      };
    })()
    // bing: { init(emit) {...}, search(query) {...} }   <- add here later, via a backend
  };

  const searchEngine = (function () {
    const provider = providers[SEARCH_PROVIDER];
    const listeners = [];
    const emit = function (s) { listeners.forEach(function (fn) { fn(s); }); };
    provider.init(emit);
    return {
      on: function (fn) { listeners.push(fn); },
      search: function (query) {
        emit({ state: 'loading', query: query });
        return provider.search(query).catch(function () { emit({ state: 'error', query: query }); });
      }
    };
  })();

  /* ---------------------------------------------------------------------
     4. Tabs + history
     Each tab has its own history stack of entries:
        {type:'home'}  or  {type:'search', query:'...'}
     --------------------------------------------------------------------- */
  const tabs = [];
  let activeId = null;
  let nextId = 1;

  const $ = function (id) { return document.getElementById(id); };
  const el = {
    tabs: $('tabs'), newTab: $('newTabBtn'), brand: $('brandBtn'),
    back: $('backBtn'), forward: $('forwardBtn'), refresh: $('refreshBtn'), home: $('homeBtn'),
    omniForm: $('omniForm'), omni: $('omniInput'), omniClear: $('omniClear'),
    menuBtn: $('menuBtn'), menu: $('menu'), themeSeg: $('themeSeg'),
    remember: $('rememberToggle'), clearRecents: $('clearRecentsBtn'),
    progress: $('progress'), page: $('page'),
    homeView: $('homeView'), resultsView: $('resultsView'),
    homeForm: $('homeForm'), homeInput: $('homeInput'), homeClear: $('homeClear'),
    clock: $('clock'), shortcuts: $('shortcuts'), recents: $('recents'), recentList: $('recentList'),
    skeleton: $('skeleton'), errorState: $('errorState'), emptyState: $('emptyState'),
    emptyQuery: $('emptyQuery'), retry: $('retryBtn'), hold: $('cseHold'),
    about: $('aboutDialog'), toast: $('toast')
  };

  function activeTab() { return tabs.find(function (t) { return t.id === activeId; }); }
  function currentEntry(tab) { return tab.history[tab.index]; }

  function createTab(entry, activate) {
    const tab = { id: nextId++, history: [entry || { type: 'home' }], index: 0, fresh: true };
    tabs.push(tab);
    if (activate !== false) activeId = tab.id;
    return tab;
  }

  function navigate(entry, opts) {
    const tab = activeTab();
    const cur = currentEntry(tab);
    const same = cur.type === entry.type && cur.query === entry.query;
    if (!(opts && opts.replace) && !same) {
      tab.history = tab.history.slice(0, tab.index + 1);
      tab.history.push(entry);
      tab.index = tab.history.length - 1;
    }
    render();
  }

  function goBack()    { const t = activeTab(); if (t.index > 0) { t.index--; render(); } }
  function goForward() { const t = activeTab(); if (t.index < t.history.length - 1) { t.index++; render(); } }
  function goHome()    { navigate({ type: 'home' }); }
  function reload()    { render(true); }

  function newTab() {
    createTab({ type: 'home' });
    render();
    el.homeInput.focus();
  }

  function closeTab(id) {
    const i = tabs.findIndex(function (t) { return t.id === id; });
    if (i < 0) return;
    tabs.splice(i, 1);
    if (!tabs.length) createTab({ type: 'home' });
    else if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)].id;
    render();
  }

  function selectTab(id) { if (id !== activeId) { activeId = id; render(); } }

  /* ---------------------------------------------------------------------
     5. UI
     --------------------------------------------------------------------- */

  /* ----- Rendering ----- */
  let shownQuery = null;       // the query currently displayed in the results view
  let lastRenderedTab = null;

  function tabTitle(tab) {
    const e = currentEntry(tab);
    return e.type === 'search' ? e.query : 'New tab';
  }

  function renderTabs() {
    el.tabs.textContent = '';
    tabs.forEach(function (tab) {
      const isActive = tab.id === activeId;
      const wrap = document.createElement('div');
      wrap.className = 'tab';
      wrap.dataset.active = String(isActive);
      wrap.setAttribute('role', 'presentation');
      if (!tab.fresh) wrap.style.animation = 'none';
      tab.fresh = false;

      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'tab-btn';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(isActive));
      btn.tabIndex = isActive ? 0 : -1;
      const img = document.createElement('img'); img.src = 'favicon.png'; img.alt = '';
      const label = document.createElement('span'); label.textContent = tabTitle(tab);
      btn.append(img, label);
      btn.addEventListener('click', function () { selectTab(tab.id); });

      const close = document.createElement('button');
      close.type = 'button'; close.className = 'tab-close';
      close.setAttribute('aria-label', 'Close tab: ' + tabTitle(tab));
      close.innerHTML = '<svg class="ico"><use href="#i-x"/></svg>';
      close.addEventListener('click', function (ev) { ev.stopPropagation(); closeTab(tab.id); });

      wrap.append(btn, close);
      el.tabs.appendChild(wrap);
      if (isActive) wrap.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  }

  function showResultsState(which) { // 'loading' | 'ready' | 'empty' | 'error'
    const loading = which === 'loading';
    el.progress.classList.toggle('on', loading);
    el.skeleton.hidden = !(loading && shownQuery !== currentQueryForSkeleton);
    el.errorState.hidden = which !== 'error';
    el.emptyState.hidden = which !== 'empty';
    // Keep the widget in the DOM but hidden while it isn't showing results.
    const showCse = which === 'ready' || (loading && shownQuery === currentQueryForSkeleton);
    el.hold.dataset.hold = showCse ? 'false' : 'true';
  }
  let currentQueryForSkeleton = null;

  function render(force) {
    const tab = activeTab();
    const entry = currentEntry(tab);
    const isSearch = entry.type === 'search';

    renderTabs();

    // toolbar
    el.back.disabled = tab.index === 0;
    el.forward.disabled = tab.index >= tab.history.length - 1;
    el.omni.value = isSearch ? entry.query : '';
    el.omniClear.hidden = !el.omni.value;
    document.title = isSearch ? entry.query + ' – NASS' : 'NASS';

    // keep the address of the page shareable (?q=...)
    try {
      const url = isSearch ? '?q=' + encodeURIComponent(entry.query) : location.pathname;
      history.replaceState(null, '', url);
    } catch (e) { /* file:// or sandboxed – ignore */ }

    // views
    el.homeView.hidden = isSearch;
    el.resultsView.hidden = !isSearch;

    if (isSearch) {
      currentQueryForSkeleton = entry.query;
      // Don't re-run the search if we're just switching back to the same query
      // that is already on screen (unless the user pressed Reload).
      if (force || shownQuery !== entry.query || lastRenderedTab !== tab.id) {
        shownQuery = null;
        el.page.scrollTop = 0;
        searchEngine.search(entry.query);
      }
    } else {
      el.progress.classList.remove('on');
      el.homeInput.value = '';
      el.homeClear.hidden = true;
      renderRecents();
      updateClock();
      if (force) { el.homeView.style.animation = 'none'; void el.homeView.offsetWidth; el.homeView.style.animation = ''; }
    }
    lastRenderedTab = tab.id;
  }

  /* React to search events from the engine */
  searchEngine.on(function (s) {
    const entry = currentEntry(activeTab());
    if (entry.type !== 'search' || s.query !== entry.query) return; // stale event
    if (s.state === 'ready') shownQuery = s.query;
    if (s.state === 'empty') { shownQuery = null; el.emptyQuery.textContent = '“' + s.query + '”'; }
    if (s.state === 'loading' && shownQuery !== s.query) shownQuery = null;
    showResultsState(s.state);
    if (s.state === 'ready') el.page.scrollTop = Math.min(el.page.scrollTop, 0);
  });

  el.retry.addEventListener('click', function () { reload(); });

  /* ----- Submitting text from either search bar ----- */
  const URL_RE = /^(localhost|([a-z0-9-]+\.)+[a-z]{2,})(:\d{2,5})?([/?#]\S*)?$/i;

  function toWebAddress(text) {
    if (/^https?:\/\/\S+$/i.test(text)) return text;
    if (URL_RE.test(text)) return 'https://' + text;
    return null;
  }

  function openExternal(url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
    try { showToast('Opened ' + new URL(url).hostname + ' in a new tab'); } catch (e) { /* ignore */ }
  }

  function submit(raw) {
    const text = (raw || '').trim();
    if (!text) return;
    const addr = toWebAddress(text);
    if (addr) { openExternal(addr); return; }
    addRecent(text);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    navigate({ type: 'search', query: text });
  }

  el.omniForm.addEventListener('submit', function (e) { e.preventDefault(); submit(el.omni.value); });
  el.homeForm.addEventListener('submit', function (e) { e.preventDefault(); submit(el.homeInput.value); });

  el.omni.addEventListener('input', function () { el.omniClear.hidden = !el.omni.value; });
  el.omni.addEventListener('focus', function () { el.omni.select(); });
  el.omniClear.addEventListener('click', function () { el.omni.value = ''; el.omniClear.hidden = true; el.omni.focus(); });

  el.homeInput.addEventListener('input', function () { el.homeClear.hidden = !el.homeInput.value; });
  el.homeClear.addEventListener('click', function () { el.homeInput.value = ''; el.homeClear.hidden = true; el.homeInput.focus(); });

  /* ----- Toolbar buttons ----- */
  el.back.addEventListener('click', goBack);
  el.forward.addEventListener('click', goForward);
  el.refresh.addEventListener('click', reload);
  el.home.addEventListener('click', goHome);
  el.brand.addEventListener('click', goHome);
  el.newTab.addEventListener('click', newTab);

  /* ----- Home: shortcuts, recents, clock ----- */
  function buildShortcuts() {
    SHORTCUTS.forEach(function (s) {
      const a = document.createElement('a');
      a.className = 'shortcut'; a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const b = document.createElement('b'); b.textContent = s.name.charAt(0); b.style.background = s.color; b.setAttribute('aria-hidden', 'true');
      const t = document.createElement('span'); t.textContent = s.name;
      a.append(b, t);
      el.shortcuts.appendChild(a);
    });
  }

  let recents = store.get('recents', []);
  let remember = store.get('remember', true);

  function addRecent(q) {
    if (!remember) return;
    recents = [q].concat(recents.filter(function (r) { return r.toLowerCase() !== q.toLowerCase(); })).slice(0, MAX_RECENTS);
    store.set('recents', recents);
  }

  function renderRecents() {
    el.recentList.textContent = '';
    recents.forEach(function (q) {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      b.innerHTML = '<svg class="ico"><use href="#i-clock"/></svg>';
      const s = document.createElement('span'); s.textContent = q; b.appendChild(s);
      b.addEventListener('click', function () { submit(q); });
      li.appendChild(b);
      el.recentList.appendChild(li);
    });
    el.recents.hidden = !recents.length;
    el.clearRecents.disabled = !recents.length;
  }

  function updateClock() {
    const d = new Date();
    const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    el.clock.textContent = date + ', ' + time;
  }
  setInterval(function () { if (!el.homeView.hidden) updateClock(); }, 20000);

  /* ----- Menu ----- */
  function menuItems() { return Array.prototype.filter.call(el.menu.querySelectorAll('[role="menuitem"]'), function (b) { return !b.disabled; }); }

  function openMenu() {
    el.menu.hidden = false;
    el.menuBtn.setAttribute('aria-expanded', 'true');
    const first = menuItems()[0]; if (first) first.focus();
  }
  function closeMenu(returnFocus) {
    if (el.menu.hidden) return;
    el.menu.hidden = true;
    el.menuBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) el.menuBtn.focus();
  }

  el.menuBtn.addEventListener('click', function () { el.menu.hidden ? openMenu() : closeMenu(true); });
  document.addEventListener('click', function (e) {
    if (!el.menu.hidden && !el.menu.contains(e.target) && !el.menuBtn.contains(e.target)) closeMenu(false);
  });
  el.menu.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = menuItems(); const i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  el.menu.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-action]'); if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'clear-recents') {
      recents = []; store.set('recents', recents); renderRecents(); showToast('Recent searches cleared'); return;
    }
    closeMenu(false);
    if (action === 'new-tab') newTab();
    else if (action === 'home') goHome();
    else if (action === 'reload') reload();
    else if (action === 'about') el.about.showModal();
  });

  /* Theme */
  function applyTheme(value) {
    document.documentElement.dataset.theme = value;
    Array.prototype.forEach.call(el.themeSeg.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-checked', String(b.dataset.themeValue === value));
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    const dark = value === 'dark' || (value === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (meta) meta.content = dark ? '#14142a' : '#ebebf4';
  }
  el.themeSeg.addEventListener('click', function (e) {
    const b = e.target.closest('[data-theme-value]'); if (!b) return;
    store.set('theme', b.dataset.themeValue); applyTheme(b.dataset.themeValue);
  });

  /* Remember-recents switch */
  el.remember.checked = remember;
  el.remember.addEventListener('change', function () {
    remember = el.remember.checked; store.set('remember', remember);
    if (!remember) { recents = []; store.set('recents', recents); renderRecents(); }
  });

  /* ----- Toast ----- */
  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg; el.toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
  }

  /* ----- Keyboard shortcuts ----- */
  document.addEventListener('keydown', function (e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') { closeMenu(true); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); el.omni.focus(); return; }
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); (el.homeView.hidden ? el.omni : el.homeInput).focus();
    }
  });

  /* ----- Start-up ----- */
  applyTheme(store.get('theme', 'auto'));
  buildShortcuts();

  const initialQuery = (new URLSearchParams(location.search).get('q') || '').trim();
  createTab(initialQuery ? { type: 'search', query: initialQuery } : { type: 'home' });
  render();
  if (!initialQuery) el.homeInput.focus({ preventScroll: true });
})();
