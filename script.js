/* ==========================================================================
   NASS — script.js
   1. Config
   2. Storage, settings, theme
   3. Search engine abstraction (providers)
   4. App state: tabs + per-tab history
   5. UI: views, tabs, search boxes, menu, dialogs, clock
   6. Boot

   This file is loaded in <head>, BEFORE the search widget script, so the
   widget callbacks (window.__gcse) exist when the widget loads. Everything that
   touches the page waits for DOMContentLoaded.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     1. CONFIG
     ------------------------------------------------------------------------ */
  // Which search provider NASS uses. Add another provider in section 3, register it
  // in `providers`, then change this value. The interface never shows the provider.
  const SEARCH_PROVIDER = 'google';

  const SEARCH_TIMEOUT_MS = 15000;  // give up (and show the error state) after this long
  const MAX_TABS = 8;
  const MAX_RECENTS = 10;
  const MAX_ENTRIES_PER_TAB = 50;
  const MAX_QUERY_LENGTH = 300;

  /* ------------------------------------------------------------------------
     2. STORAGE, SETTINGS, THEME
     ------------------------------------------------------------------------ */
  const store = {
    get: (k, fb) => read(() => localStorage, k, fb),
    set: (k, v) => write(() => localStorage, k, v),
    sget: (k, fb) => read(() => sessionStorage, k, fb),
    sset: (k, v) => write(() => sessionStorage, k, v)
  };
  function read(area, k, fb) {
    try { const v = area().getItem(k); return v === null ? fb : JSON.parse(v); } catch (_) { return fb; }
  }
  function write(area, k, v) {
    try { area().setItem(k, JSON.stringify(v)); } catch (_) { /* storage blocked: NASS still works, it just won't remember */ }
  }

  function prefers24h() {
    try {
      const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
      return hc === 'h23' || hc === 'h24';
    } catch (_) { return false; }
  }

  const settings = Object.assign(
    { theme: 'system', showClock: true, clock24: prefers24h(), saveRecents: true },
    store.get('nass:settings', {})
  );
  let recents = store.get('nass:recents', []);
  if (!Array.isArray(recents)) recents = [];
  const saveSettings = () => store.set('nass:settings', settings);

  const root = document.documentElement;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = settings.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme;
    root.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#080a0f' : '#e9ebf3');
  }
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });
  applyTheme();   // runs before first paint, so there is no flash of the wrong theme

  function addRecent(q) {
    if (!settings.saveRecents) return;
    const key = q.toLowerCase();
    recents = [q].concat(recents.filter(r => r.toLowerCase() !== key)).slice(0, MAX_RECENTS);
    store.set('nass:recents', recents);
  }

  /* ------------------------------------------------------------------------
     3. SEARCH ENGINE ABSTRACTION
     ------------------------------------------------------------------------
     A provider is an object with:
       init(ui)        called once at boot. `ui` has:
                         ui.container            the element to render into
                         ui.state(name, query)   'loading' | 'results' | 'empty' | 'error'
                         ui.rendered(query)      results are on screen
       search(query)   Promise: resolves 'results' | 'empty' | 'superseded', rejects on failure
       clear()         cancel work and clear any rendered results

     The rest of the app only ever calls searchEngine.search(query).
     ------------------------------------------------------------------------ */

  /* ---- Provider: Programmable Search (uses the widget loaded in index.html) ---- */
  function createGoogleProvider() {
    const NAME = 'nass';            // matches data-gname on #nassResults
    let ui = null, pending = null, timer = null, poll = null, scriptFailed = false;

    const stopTimers = () => { clearTimeout(timer); clearInterval(poll); };
    const armTimer = () => { clearTimeout(timer); timer = setTimeout(fail, SEARCH_TIMEOUT_MS); };
    function settle(status) {
      stopTimers();
      if (pending) { const p = pending; pending = null; p.resolve(status); }
    }
    function fail() {
      stopTimers();
      if (ui) ui.state('error');
      if (pending) { const p = pending; pending = null; p.reject(new Error('search-failed')); }
    }

    // Callbacks the widget calls while it searches (also fires for page changes and tab switches inside results)
    const callbacks = {
      starting: (name, q) => { armTimer(); if (ui) ui.state('loading', q); return q; },
      ready: (name, q, promos, results) => {
        clearTimeout(timer);
        if (!results || !results.length) {          // nothing found: show NASS's own empty state
          if (ui) ui.state('empty', q);
          settle('empty');
          return false;                             // false = don't draw the widget's own "no results"
        }
        if (ui) ui.state('results', q);
        return true;                                // true = draw the results (styled by style.css)
      },
      rendered: (name, q) => { clearTimeout(timer); if (ui) ui.rendered(q); settle('results'); }
    };
    window.__gcse = { parsetags: 'onload', searchCallbacks: { web: callbacks, image: callbacks } };

    // If the widget script itself fails to load (offline, blocked), show the error state.
    window.addEventListener('error', e => {
      const t = e.target;
      if (t && t.tagName === 'SCRIPT' && /cse\.google\.com/.test(t.src || '')) { scriptFailed = true; fail(); }
    }, true);

    function getElement() {
      const w = window.google;
      const api = w && w.search && w.search.cse && w.search.cse.element;
      return api ? api.getElement(NAME) : null;
    }

    return {
      init(u) { ui = u; },
      search(query) {
        return new Promise((resolve, reject) => {
          if (pending) pending.resolve('superseded');
          pending = { query, resolve, reject };
          stopTimers();
          ui.state('loading', query);
          armTimer();
          if (scriptFailed) { fail(); return; }

          const attempt = () => {
            const el = getElement();
            if (!el) return false;                  // widget not ready yet
            try { el.execute(query); } catch (_) { fail(); }
            return true;
          };
          if (!attempt()) {                          // wait for the widget to finish loading
            poll = setInterval(() => { if (attempt()) clearInterval(poll); }, 150);
          }
        });
      },
      clear() {
        stopTimers();
        if (pending) { const p = pending; pending = null; p.resolve('superseded'); }
        try { const el = getElement(); if (el && el.clearAllResults) el.clearAllResults(); } catch (_) { /* ignore */ }
      }
    };
  }

  /* ---- FUTURE: another provider (e.g. Bing) through YOUR OWN backend ----------
     Never put an API key in this file. Build a server endpoint (for example /api/search?q=...)
     that holds the key and returns JSON such as { results: [{ title, url, snippet }] }.
     Then implement the same interface as above and register it below:

     function createProxyProvider(endpoint) {
       let ui;
       return {
         init(u) { ui = u; },
         async search(q) {
           ui.state('loading', q);
           const res = await fetch(endpoint + '?q=' + encodeURIComponent(q));
           if (!res.ok) { ui.state('error'); throw new Error('search-failed'); }
           const data = await res.json();
           if (!data.results.length) { ui.state('empty', q); return 'empty'; }
           // build result elements with textContent (not innerHTML) and append to ui.container
           ui.state('results', q); ui.rendered(q); return 'results';
         },
         clear() { ui.container.replaceChildren(); }
       };
     }
     providers.bing = createProxyProvider('/api/search');   // then set SEARCH_PROVIDER = 'bing'
     ---------------------------------------------------------------------------- */
  const providers = { google: createGoogleProvider() };

  const searchEngine = {
    provider: providers[SEARCH_PROVIDER],
    init(ui) { if (this.provider) this.provider.init(ui); },
    search(query) { return this.provider ? this.provider.search(query) : Promise.reject(new Error('no-provider')); },
    clear() { if (this.provider) this.provider.clear(); }
  };

  /* ------------------------------------------------------------------------
     4. APP STATE — tabs, each with its own history stack
        entry = { q: '' }  → home / new tab
        entry = { q: 'cats' } → search results
     ------------------------------------------------------------------------ */
  let tabs = [];
  let activeId = null;
  let seq = 0;
  let booted = false;

  const activeTab = () => tabs.find(t => t.id === activeId);
  const entryOf = t => t.entries[t.index];
  const currentQuery = () => { const t = activeTab(); return t ? entryOf(t).q : ''; };

  function normalizeQuery(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH); }

  // Only explicit web addresses open a site; everything else is a search.
  function toUrl(s) {
    if (/\s/.test(s)) return null;
    if (/^https?:\/\/[^\s/.]+\.[^\s]+$/i.test(s) || /^https?:\/\/localhost(:\d+)?(\/\S*)?$/i.test(s)) return s;
    if (/^www\.[^\s.]+\.[^\s]{2,}$/i.test(s)) return 'https://' + s;
    return null;
  }

  /* ------------------------------------------------------------------------
     5. UI
     ------------------------------------------------------------------------ */
  const $ = id => document.getElementById(id);
  let el = {};                 // element cache, filled at boot
  const tabEls = new Map();
  let loading = false;

  /* ---- helpers ---- */
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-on'), 2600);
  }
  function announce(msg) {
    el.srStatus.textContent = '';
    setTimeout(() => { el.srStatus.textContent = msg; }, 60);
  }

  /* ---- navigation actions ---- */
  function navigate(raw) {
    const q = normalizeQuery(raw);
    if (!q) { goHome(); return; }

    const url = toUrl(q);
    if (url) { openExternal(url); return; }

    const t = activeTab();
    addRecent(q);
    if (entryOf(t).q === q) { runSearch(); focusMain(); return; }   // same query again = refresh

    t.entries.splice(t.index + 1);
    t.entries.push({ q });
    if (t.entries.length > MAX_ENTRIES_PER_TAB) t.entries.shift();
    t.index = t.entries.length - 1;
    commit({ search: true });
    focusMain();
  }

  function openExternal(url) {          // NASS can't embed other sites, so they open in a real browser tab
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Opened in a new browser tab');
    el.omniInput.value = currentQuery();
    syncClearButtons();
  }

  function goBack() { const t = activeTab(); if (t.index > 0) { t.index--; commit({ search: true }); } }
  function goForward() { const t = activeTab(); if (t.index < t.entries.length - 1) { t.index++; commit({ search: true }); } }

  function goHome() {
    const t = activeTab();
    if (entryOf(t).q) {
      t.entries.splice(t.index + 1);
      t.entries.push({ q: '' });
      t.index = t.entries.length - 1;
      commit({});
    }
    el.homeInput.focus({ preventScroll: true });
  }

  function reload() {
    if (currentQuery()) { runSearch(); }
    else { updateClock(); flashReload(); }
  }
  function flashReload() {
    el.chrome.classList.add('is-loading');
    setTimeout(() => { if (!loading) el.chrome.classList.remove('is-loading'); }, 500);
  }

  function runSearch() {
    const q = currentQuery();
    if (!q) return;
    announce('Searching for ' + q);
    searchEngine.search(q).catch(() => { /* the error state is already showing */ });
  }

  function focusMain() { el.main.focus({ preventScroll: true }); }

  /* ---- tabs ---- */
  function newTab(q) {
    if (tabs.length >= MAX_TABS) { toast('You can have up to ' + MAX_TABS + ' tabs open.'); return; }
    const t = { id: 't' + (++seq), entries: [{ q: q || '' }], index: 0 };
    tabs.push(t);
    activeId = t.id;
    commit({ search: !!q });
    if (!q) el.homeInput.focus({ preventScroll: true });
  }

  function closeTab(id, viaKeyboard) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (!tabs.length) { seq++; tabs.push({ id: 't' + seq, entries: [{ q: '' }], index: 0 }); }
    if (activeId === id) activeId = (tabs[i] || tabs[i - 1]).id;
    commit({ search: true });
    if (viaKeyboard) { const b = tabEls.get(activeId); if (b) b.querySelector('.tab-main').focus(); }
    if (!currentQuery()) el.homeInput.value = '';
  }

  function activateTab(id, focus) {
    if (id === activeId) return;
    activeId = id;
    commit({ search: true });
    if (focus) tabEls.get(id).querySelector('.tab-main').focus();
  }

  function buildTab(t) {
    const wrap = document.createElement('div');
    wrap.className = 'tab' + (booted ? ' is-entering' : '');
    wrap.setAttribute('role', 'presentation');
    wrap.dataset.id = t.id;
    wrap.innerHTML =
      '<button class="tab-main" type="button" role="tab" aria-controls="main">' +
      '<img class="tab-ico" src="assets/logo-64.png" width="16" height="16" alt="">' +
      '<span class="tab-title"></span></button>' +
      '<button class="tab-close" type="button"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button>';
    return wrap;
  }

  function renderTabs() {
    const ids = new Set(tabs.map(t => t.id));
    tabEls.forEach((node, id) => { if (!ids.has(id)) { node.remove(); tabEls.delete(id); } });

    tabs.forEach((t, i) => {
      let node = tabEls.get(t.id);
      if (!node) { node = buildTab(t); tabEls.set(t.id, node); }
      if (el.tabs.children[i] !== node) el.tabs.insertBefore(node, el.tabs.children[i] || null);

      const isActive = t.id === activeId;
      const title = entryOf(t).q || 'New tab';
      const main = node.querySelector('.tab-main');
      const close = node.querySelector('.tab-close');
      node.classList.toggle('is-active', isActive);
      node.classList.toggle('is-loading', isActive && loading);
      main.setAttribute('aria-selected', String(isActive));
      main.tabIndex = isActive ? 0 : -1;
      close.tabIndex = isActive ? 0 : -1;
      close.setAttribute('aria-label', 'Close tab: ' + title);
      node.querySelector('.tab-title').textContent = title;
      node.title = title;
    });

    const cur = tabEls.get(activeId);
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ---- the one function that syncs the whole UI to the current state ---- */
  function commit(opts) {
    const t = activeTab();
    const q = entryOf(t).q;

    // toolbar
    el.backBtn.disabled = t.index === 0;
    el.forwardBtn.disabled = t.index >= t.entries.length - 1;
    el.omniInput.value = q;
    syncClearButtons();

    // views
    const isHome = !q;
    setView(el.viewHome, isHome);
    setView(el.viewResults, !isHome);
    document.title = isHome ? 'NASS' : q + ' – NASS';
    if (isHome) {
      searchEngine.clear();
      setLoading(false);
      el.viewResults.dataset.state = 'idle';
      el.homeInput.value = '';
      updateClock();
    }

    renderTabs();
    persist();
    syncUrl(q);
    if (opts && opts.search && q) runSearch();
  }

  function setView(node, on) {
    node.classList.toggle('is-active', on);
    node.toggleAttribute('inert', !on);
    node.setAttribute('aria-hidden', String(!on));
  }

  function setLoading(on) {
    loading = on;
    el.chrome.classList.toggle('is-loading', on);
    const node = tabEls.get(activeId);
    if (node) node.classList.toggle('is-loading', on);
  }

  function syncUrl(q) {
    try { history.replaceState(null, '', q ? '?q=' + encodeURIComponent(q) : location.pathname); } catch (_) { /* e.g. file:// */ }
  }

  function persist() {
    store.sset('nass:session', {
      seq, activeId,
      tabs: tabs.map(t => ({ id: t.id, entries: t.entries, index: t.index }))
    });
  }

  function restoreSession() {
    const s = store.sget('nass:session', null);
    if (!s || !Array.isArray(s.tabs) || !s.tabs.length) return false;
    const ok = s.tabs.filter(t => t && typeof t.id === 'string' && Array.isArray(t.entries) && t.entries.length &&
      t.entries.every(e => e && typeof e.q === 'string') && Number.isInteger(t.index) && t.index >= 0 && t.index < t.entries.length);
    if (!ok.length) return false;
    tabs = ok.slice(0, MAX_TABS);
    seq = Math.max(Number(s.seq) || 0, tabs.length);
    activeId = tabs.some(t => t.id === s.activeId) ? s.activeId : tabs[0].id;
    return true;
  }

  /* ---- results view states (called by the search provider) ---- */
  const resultsUI = {
    container: null,
    state(name, q) {
      if (!currentQuery()) return;          // ignore late callbacks after going home
      el.viewResults.dataset.state = name;
      setLoading(name === 'loading');
      if (name === 'empty') el.emptyQuery.textContent = q || currentQuery();
      if (name === 'error') announce('Something went wrong. Please try again.');
    },
    rendered(q) {
      if (!currentQuery()) return;
      el.viewResults.scrollTop = 0;
      announce('Results for ' + q);
    }
  };

  /* ---- search boxes (address bar + home box) with recent-search suggestions ---- */
  function bindSearchBox(cfg) {
    const { form, input, clearBtn, list } = cfg;
    let opts = [], idx = -1;

    const isOpen = () => !list.hidden;
    function close() {
      list.hidden = true; idx = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function highlight(i) {
      idx = i;
      list.querySelectorAll('[role="option"]').forEach((node, n) => node.setAttribute('aria-selected', String(n === i)));
      if (i >= 0) input.setAttribute('aria-activedescendant', list.id + '-o' + i); else input.removeAttribute('aria-activedescendant');
    }
    function refresh() {
      clearBtn.hidden = !input.value;
      if (!settings.saveRecents) { close(); return; }
      const v = input.value.trim().toLowerCase();
      opts = recents.filter(r => !v || (r.toLowerCase().includes(v) && r.toLowerCase() !== v)).slice(0, 6);
      if (!opts.length) { close(); return; }
      const nodes = [];
      if (!v) { const h = document.createElement('li'); h.className = 'suggest-h'; h.setAttribute('role', 'presentation'); h.textContent = 'Recent searches'; nodes.push(h); }
      opts.forEach((text, n) => {
        const li = document.createElement('li');
        li.id = list.id + '-o' + n; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
        li.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-recent"/></svg><span></span>';
        li.querySelector('span').textContent = text;
        li.addEventListener('click', () => pick(text));
        nodes.push(li);
      });
      list.replaceChildren(...nodes);
      list.hidden = false; idx = -1;
      input.setAttribute('aria-expanded', 'true');
    }
    function pick(text) { input.value = text; close(); pulse(form); navigate(text); }

    list.addEventListener('pointerdown', e => e.preventDefault());   // keep focus in the input while picking
    input.addEventListener('focus', refresh);
    input.addEventListener('blur', close);
    input.addEventListener('input', () => { refresh(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!isOpen()) refresh();
        if (!opts.length) return;
        e.preventDefault();
        const n = opts.length;
        highlight(e.key === 'ArrowDown' ? (idx + 1) % n : (idx - 1 + n) % n);
      } else if (e.key === 'Enter' && idx >= 0) {
        e.preventDefault(); pick(opts[idx]);
      } else if (e.key === 'Escape') {
        if (isOpen()) { close(); e.stopPropagation(); }
        else if (input === el.omniInput) { input.value = currentQuery(); syncClearButtons(); }
      }
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      close(); pulse(form);
      if (!input.value.trim()) { input.focus(); return; }
      navigate(input.value);
      input.blur();
    });
    clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); refresh(); });
  }

  function pulse(form) {
    form.classList.remove('is-submitting'); void form.offsetWidth;
    form.classList.add('is-submitting');
    setTimeout(() => form.classList.remove('is-submitting'), 350);
  }
  function syncClearButtons() {
    el.omniClear.hidden = !el.omniInput.value;
    el.homeClear.hidden = !el.homeInput.value;
  }

  /* ---- menu ---- */
  function menuItems() { return Array.from(el.menu.querySelectorAll('[role^="menuitem"]')); }
  function openMenu() {
    el.menu.hidden = false;
    el.menuBtn.setAttribute('aria-expanded', 'true');
    reflectTheme();
    const first = menuItems()[0]; if (first) first.focus();
  }
  function closeMenu(returnFocus) {
    if (el.menu.hidden) return;
    el.menu.hidden = true;
    el.menuBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) el.menuBtn.focus();
  }
  function reflectTheme() {
    el.menu.querySelectorAll('[data-theme-value]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeValue === settings.theme)));
  }
  function runMenuAction(action) {
    closeMenu(false);
    if (action === 'new-tab') newTab();
    else if (action === 'home') goHome();
    else if (action === 'reload') reload();
    else if (action === 'settings') openSettings();
    else if (action === 'about') openDialog(el.aboutDialog);
  }

  /* ---- dialogs ---- */
  function openDialog(d) {
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function openSettings() {
    el.setRecents.checked = settings.saveRecents;
    el.setClock.checked = settings.showClock;
    el.setClock24.checked = settings.clock24;
    el.setClock24.disabled = !settings.showClock;
    refreshRecentCount();
    openDialog(el.settingsDialog);
  }
  function refreshRecentCount() {
    const n = recents.length;
    el.recentCount.textContent = n ? n + (n === 1 ? ' saved search' : ' saved searches') : 'Nothing saved';
    el.clearRecents.disabled = !n;
  }

  /* ---- clock ---- */
  function updateClock() {
    el.clock.hidden = !settings.showClock;
    if (!settings.showClock) return;
    const now = new Date();
    el.clockTime.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !settings.clock24 });
    el.clockTime.setAttribute('datetime', now.toISOString());
    el.clockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  /* ------------------------------------------------------------------------
     6. BOOT
     ------------------------------------------------------------------------ */
  function boot() {
    ['browser', 'chrome', 'tabs', 'newTabBtn', 'backBtn', 'forwardBtn', 'reloadBtn', 'homeBtn',
      'omniForm', 'omniInput', 'omniClear', 'omniList', 'menuBtn', 'menu', 'main', 'viewHome', 'viewResults',
      'homeForm', 'homeInput', 'homeClear', 'homeList', 'clock', 'clockTime', 'clockDate',
      'emptyQuery', 'emptyHome', 'retryBtn', 'nassResults', 'settingsDialog', 'aboutDialog',
      'setRecents', 'setClock', 'setClock24', 'clearRecents', 'recentCount', 'toast', 'srStatus'
    ].forEach(id => { el[id] = $(id); });

    resultsUI.container = el.nassResults;
    searchEngine.init(resultsUI);

    /* toolbar */
    el.backBtn.addEventListener('click', goBack);
    el.forwardBtn.addEventListener('click', goForward);
    el.reloadBtn.addEventListener('click', reload);
    el.homeBtn.addEventListener('click', goHome);
    el.newTabBtn.addEventListener('click', () => newTab());
    el.emptyHome.addEventListener('click', goHome);
    el.retryBtn.addEventListener('click', runSearch);

    /* search boxes */
    bindSearchBox({ form: el.omniForm, input: el.omniInput, clearBtn: el.omniClear, list: el.omniList });
    bindSearchBox({ form: el.homeForm, input: el.homeInput, clearBtn: el.homeClear, list: el.homeList });
    el.omniInput.addEventListener('focus', () => el.omniInput.select());

    /* tabs (event delegation) */
    el.tabs.addEventListener('click', e => {
      const node = e.target.closest('.tab'); if (!node) return;
      if (e.target.closest('.tab-close')) closeTab(node.dataset.id, e.detail === 0);
      else activateTab(node.dataset.id, false);
    });
    el.tabs.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const node = e.target.closest('.tab'); if (node) { e.preventDefault(); closeTab(node.dataset.id, false); }
    });
    el.tabs.addEventListener('keydown', e => {
      const main = e.target.closest('.tab-main'); if (!main) return;
      const i = tabs.findIndex(t => t.id === main.parentElement.dataset.id);
      let n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      else if (e.key === 'Delete') { e.preventDefault(); closeTab(tabs[i].id, true); return; }
      if (n >= 0) { e.preventDefault(); activateTab(tabs[n].id, true); }
    });

    /* menu */
    el.menuBtn.addEventListener('click', () => (el.menu.hidden ? openMenu() : closeMenu(false)));
    el.menu.addEventListener('click', e => {
      const item = e.target.closest('[data-action], [data-theme-value]'); if (!item) return;
      if (item.dataset.themeValue) { settings.theme = item.dataset.themeValue; saveSettings(); applyTheme(); reflectTheme(); return; }
      runMenuAction(item.dataset.action);
    });
    el.menu.addEventListener('keydown', e => {
      const items = menuItems(); const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
      else if (e.key === 'Tab') closeMenu(false);
    });
    document.addEventListener('pointerdown', e => {
      if (!el.menu.hidden && !e.target.closest('.menu-wrap')) closeMenu(false);
    });

    /* settings + about dialogs */
    el.setRecents.addEventListener('change', () => { settings.saveRecents = el.setRecents.checked; saveSettings(); });
    el.setClock.addEventListener('change', () => { settings.showClock = el.setClock.checked; el.setClock24.disabled = !settings.showClock; saveSettings(); updateClock(); });
    el.setClock24.addEventListener('change', () => { settings.clock24 = el.setClock24.checked; saveSettings(); updateClock(); });
    el.clearRecents.addEventListener('click', () => { recents = []; store.set('nass:recents', recents); refreshRecentCount(); toast('Recent searches cleared'); });
    [el.settingsDialog, el.aboutDialog].forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

    /* keyboard: "/" or Ctrl/Cmd+K jumps to the search bar */
    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      const slash = e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
      const kbar = e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey);
      if (!slash && !kbar) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      (currentQuery() ? el.omniInput : el.homeInput).focus();
    });

    /* clock */
    setInterval(() => { if (!document.hidden && !currentQuery()) updateClock(); }, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateClock(); });

    /* start: restore this browser tab's session, or open a fresh NASS tab */
    if (!restoreSession()) { tabs = [{ id: 't' + (++seq), entries: [{ q: '' }], index: 0 }]; activeId = tabs[0].id; }
    const urlQ = normalizeQuery(new URLSearchParams(location.search).get('q'));
    if (urlQ && !toUrl(urlQ)) {
      const t = activeTab();
      if (entryOf(t).q !== urlQ) { t.entries.splice(t.index + 1); t.entries.push({ q: urlQ }); t.index = t.entries.length - 1; }
    }
    commit({ search: true });
    booted = true;

    if (!currentQuery() && window.matchMedia('(hover: hover)').matches) el.homeInput.focus({ preventScroll: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
