'use strict';

(() => {
  // ---------- Constants ----------
  const RESERVED = 'default';
  const HAS_EXT = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  const LS_KEY = 'bookmarks.v1';
  const SYNC_CHUNK = 2500;      // chars per chrome.storage.sync item (item limit is 8 KB)
  const SYNC_MAX_CHUNKS = 36;   // stay under the 100 KB sync total

  const SAMPLE = {
    personal: {
      default: true,
      'github-repos': {
        'my-repo': 'github.com/my-repo',
      },
      daily: {
        Gmail: 'mail.google.com',
        Calendar: 'calendar.google.com',
        news: {
          'Hacker News': 'news.ycombinator.com',
          'The Verge': 'theverge.com',
        },
      },
    },
    work: {
      tools: {
        GitHub: 'github.com',
        'Local app': 'localhost:3000',
      },
    },
  };

  const state = {
    data: null,
    ts: 0,
    page: null,
    query: '',
    results: [],
    syncNote: HAS_EXT ? 'Saved in browser · syncs with your account' : 'Saved in this browser',
  };

  // ---------- Small helpers ----------
  const $ = (s) => document.querySelector(s);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pageNames = () => Object.keys(state.data);
  const defaultPage = () => pageNames().find((p) => state.data[p].default === true) || pageNames()[0] || null;

  function getPref(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function setPref(k, v) { try { localStorage.setItem(k, v); } catch {} }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
    star: '<path fill="currentColor" stroke="none" d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9Z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  };

  function icon(name, cls = '') {
    const s = document.createElement('span');
    s.className = 'ico ' + cls;
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return s;
  }

  function iconBtn(name, title, onClick, cls = '') {
    return h('button', {
      type: 'button', class: 'icon-btn ' + cls, title, 'aria-label': title,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); },
    }, icon(name));
  }

  // Adds https:// to bare links like "github.com/x" and blocks javascript: URLs.
  function normUrl(u) {
    u = String(u).trim();
    if (/^javascript:/i.test(u)) return '#';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(mailto|tel|about|chrome|edge|data|file):/i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u)) return 'http://' + u;
    return 'https://' + u;
  }

  function hostOf(u) {
    try { return new URL(normUrl(u)).host.replace(/^www\./, '') || u; } catch { return u; }
  }

  // "github.com/torvalds/linux" -> "linux", "mail.google.com" -> "mail.google.com"
  function autoName(u) {
    try {
      const url = new URL(normUrl(u));
      const last = url.pathname.split('/').filter(Boolean).pop();
      return last ? decodeURIComponent(last) : url.host.replace(/^www\./, '');
    } catch { return u; }
  }

  function hue(str) {
    let x = 0;
    for (const c of str) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    return x % 360;
  }

  // Chrome's built-in favicon cache: offline and private. Letter badge as fallback.
  function faviconEl(url, name) {
    const wrap = h('span', { class: 'fav' });
    const host = hostOf(url);
    const fallback = () => {
      wrap.replaceChildren((name || host || '?').trim().charAt(0).toUpperCase() || '?');
      wrap.classList.add('letter');
      wrap.style.setProperty('--hue', hue(host));
    };
    if (HAS_EXT && chrome.runtime && chrome.runtime.getURL) {
      const src = new URL(chrome.runtime.getURL('/_favicon/'));
      src.searchParams.set('pageUrl', normUrl(url));
      src.searchParams.set('size', '32');
      const img = h('img', { alt: '', loading: 'lazy', src: src.toString() });
      img.addEventListener('error', fallback);
      wrap.append(img);
    } else {
      fallback();
    }
    return wrap;
  }

  // Rename a key while keeping its position in the object.
  function renameInPlace(obj, oldKey, newKey, newVal) {
    const entries = Object.entries(obj);
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of entries) {
      if (k === oldKey) obj[newKey] = newVal === undefined ? v : newVal;
      else obj[k] = v;
    }
  }

  function setDefault(name) {
    for (const p of pageNames()) delete state.data[p].default;
    const page = state.data[name];
    const rest = { ...page };
    for (const k of Object.keys(page)) delete page[k];
    page.default = true;
    Object.assign(page, rest);
  }

  function countLinks(obj) {
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (k === RESERVED) continue;
      if (typeof v === 'string') n++;
      else if (isObj(v)) n += countLinks(v);
    }
    return n;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- Validation ----------
  function validate(d) {
    if (!isObj(d)) return 'The top level must be an object of pages, like { "personal": { ... } }.';
    let defaults = 0;
    for (const [p, page] of Object.entries(d)) {
      if (!isObj(page)) return `Page "${p}" must be an object.`;
      for (const [c, cat] of Object.entries(page)) {
        if (c === RESERVED) {
          if (typeof cat !== 'boolean') return `"default" in page "${p}" must be true or false.`;
          if (cat) defaults++;
          continue;
        }
        if (typeof cat === 'string') continue;
        if (!isObj(cat)) return `"${p} › ${c}" must be a category object or a URL string.`;
        for (const [s, sub] of Object.entries(cat)) {
          if (typeof sub === 'string') continue;
          if (!isObj(sub)) return `"${p} › ${c} › ${s}" must be a subcategory object or a URL string.`;
          for (const [l, url] of Object.entries(sub)) {
            if (typeof url !== 'string') {
              return `"${p} › ${c} › ${s} › ${l}" must be a URL string. Max depth is page › category › subcategory › link.`;
            }
          }
        }
      }
    }
    if (defaults > 1) return 'Only one page can have "default": true.';
    return null;
  }

  // ---------- Storage ----------
  // Extension: chrome.storage.local is the main copy, chrome.storage.sync is a chunked
  // best-effort mirror so the bookmarks follow your browser account.
  // Plain file: localStorage.
  async function readSync() {
    try {
      const meta = await chrome.storage.sync.get(['bm_n', 'bm_ts']);
      if (!meta.bm_n) return null;
      const keys = Array.from({ length: meta.bm_n }, (_, i) => 'bm_' + i);
      const parts = await chrome.storage.sync.get(keys);
      const json = keys.map((k) => parts[k] || '').join('');
      return { data: JSON.parse(json), ts: meta.bm_ts || 0, json };
    } catch (e) {
      console.warn('Sync read failed', e);
      return null;
    }
  }

  async function writeSync(json, ts) {
    try {
      const chunks = [];
      for (let i = 0; i < json.length; i += SYNC_CHUNK) chunks.push(json.slice(i, i + SYNC_CHUNK));
      if (chunks.length > SYNC_MAX_CHUNKS) {
        state.syncNote = 'Too large to sync · saved on this device';
        return;
      }
      const prev = (await chrome.storage.sync.get('bm_n')).bm_n || 0;
      const obj = { bm_n: chunks.length, bm_ts: ts };
      chunks.forEach((c, i) => { obj['bm_' + i] = c; });
      await chrome.storage.sync.set(obj);
      const stale = [];
      for (let i = chunks.length; i < prev; i++) stale.push('bm_' + i);
      if (stale.length) await chrome.storage.sync.remove(stale);
      state.syncNote = 'Saved in browser · syncs with your account';
    } catch (e) {
      console.warn('Sync write failed', e);
      state.syncNote = 'Saved on this device (sync unavailable)';
    }
  }

  const Store = {
    async load() {
      if (!HAS_EXT) {
        const raw = getPref(LS_KEY);
        if (!raw) return null;
        const { ts, json } = JSON.parse(raw);
        return { data: JSON.parse(json), ts };
      }
      const local = await chrome.storage.local.get(['bookmarksJson', 'updatedAt']);
      let best = local.bookmarksJson
        ? { data: JSON.parse(local.bookmarksJson), ts: local.updatedAt || 0 }
        : null;
      const synced = await readSync();
      if (synced && (!best || synced.ts > best.ts)) {
        best = { data: synced.data, ts: synced.ts };
        await chrome.storage.local.set({ bookmarksJson: synced.json, updatedAt: synced.ts });
      }
      return best;
    },

    async save(data) {
      const ts = Date.now();
      const json = JSON.stringify(data);
      state.ts = ts;
      if (!HAS_EXT) {
        setPref(LS_KEY, JSON.stringify({ ts, json }));
        return;
      }
      await chrome.storage.local.set({ bookmarksJson: json, updatedAt: ts });
      await writeSync(json, ts);
    },

    // Re-render when another tab or another synced device changes the data.
    watch(onChange) {
      if (!HAS_EXT) {
        window.addEventListener('storage', (e) => { if (e.key === LS_KEY) onChange(); });
        return;
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.updatedAt && changes.updatedAt.newValue !== state.ts) onChange();
        if (area === 'sync' && changes.bm_ts && changes.bm_ts.newValue > state.ts) onChange();
      });
    },
  };

  async function commit(msg) {
    render();
    try {
      await Store.save(state.data);
      if (msg) toast(msg);
    } catch (e) {
      console.error(e);
      toast('Could not save: ' + e.message);
    }
    renderSidebar();
  }

  async function reloadFromStore() {
    const loaded = await Store.load().catch(() => null);
    if (!loaded || validate(loaded.data)) return;
    state.data = loaded.data;
    state.ts = loaded.ts;
    if (!state.data[state.page]) state.page = defaultPage();
    render();
  }

  // ---------- Dialogs ----------
  function openForm({ title, message, fields = [], submit = 'Save', danger = false, validate: check }) {
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: 'dlg' });
      const form = h('form', { method: 'dialog' });
      const err = h('p', { class: 'form-error', role: 'alert' });
      const inputs = {};

      const rows = fields.map((f) => {
        let input;
        if (f.type === 'select') {
          input = h('select', { name: f.name },
            f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
        } else if (f.type === 'checkbox') {
          input = h('input', { type: 'checkbox', name: f.name });
          input.checked = !!f.value;
        } else {
          input = h('input', {
            type: 'text', name: f.name, placeholder: f.placeholder || '',
            autocomplete: 'off', spellcheck: 'false',
          });
          input.value = f.value ?? '';
        }
        inputs[f.name] = input;
        const row = f.type === 'checkbox'
          ? h('label', { class: 'check' }, input, h('span', {}, f.label))
          : h('label', { class: 'field' }, h('span', {}, f.label), input);
        row.fieldDef = f;
        return row;
      });

      const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) =>
        [k, el.type === 'checkbox' ? el.checked : el.value.trim()]));
      const refresh = () => rows.forEach((r) => {
        if (r.fieldDef.showIf) r.hidden = !r.fieldDef.showIf(values());
      });

      let result = null;
      form.append(...[
        h('h2', {}, title),
        message && h('p', { class: 'msg' }, message),
        ...rows,
        err,
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn ' + (danger ? 'danger' : 'primary') }, submit)),
      ].filter(Boolean));
      form.addEventListener('input', () => { refresh(); err.textContent = ''; });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = values();
        const problem = check && check(v);
        if (problem) { err.textContent = problem; return; }
        result = v;
        dlg.close();
      });
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });

      refresh();
      dlg.append(form);
      document.body.append(dlg);
      dlg.showModal();
      const first = form.querySelector('input[type=text]');
      if (first) { first.focus(); first.select(); }
      else form.querySelector('button[type=submit]').focus();
    });
  }

  const confirmDelete = (title, message) =>
    openForm({ title, message, submit: 'Delete', danger: true }).then((v) => !!v);

  function openJsonEditor() {
    const original = JSON.stringify(state.data, null, 2);
    const dlg = h('dialog', { class: 'dlg wide' });
    const ta = h('textarea', { class: 'json', spellcheck: 'false', 'aria-label': 'Bookmarks JSON' });
    ta.value = original;
    const status = h('p', { class: 'json-status' });
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });

    const parse = () => {
      try {
        const d = JSON.parse(ta.value);
        const problem = validate(d);
        if (problem) throw new Error(problem);
        status.textContent = 'Valid JSON';
        status.className = 'json-status ok';
        return d;
      } catch (e) {
        status.textContent = e.message;
        status.className = 'json-status bad';
        return null;
      }
    };

    const save = () => {
      const d = parse();
      if (!d) return;
      state.data = d;
      if (!state.data[state.page]) state.page = defaultPage();
      dlg.close();
      commit('Bookmarks saved');
    };

    const exportFile = () => {
      const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `bookmarks-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      ta.value = await f.text();
      if (parse()) toast('File loaded. Review it, then Save.');
      fileInput.value = '';
    });

    ta.addEventListener('input', parse);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });

    dlg.addEventListener('cancel', (e) => {
      if (ta.value !== original && !window.confirm('Discard your JSON changes?')) e.preventDefault();
    });
    dlg.addEventListener('close', () => dlg.remove());

    dlg.append(
      h('div', { class: 'json-head' },
        h('h2', {}, 'Edit bookmarks JSON'),
        h('p', { class: 'msg' }, 'Pages › categories › subcategories › links. Mark one page with "default": true.')),
      ta,
      status,
      h('div', { class: 'dlg-actions split' },
        h('div', { class: 'left' },
          h('button', { type: 'button', class: 'btn', onclick: () => { const d = parse(); if (d) ta.value = JSON.stringify(d, null, 2); } }, 'Format'),
          h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, 'Import file'),
          h('button', { type: 'button', class: 'btn', onclick: exportFile }, 'Export file'),
          fileInput),
        h('div', { class: 'right' },
          h('button', { type: 'button', class: 'btn', onclick: () => { if (dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close(); } }, 'Cancel'),
          h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save'))),
    );
    document.body.append(dlg);
    dlg.showModal();
    parse();
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }

  // ---------- Actions ----------
  const nameRule = (v, parent, current, kind) => {
    if (!v.name) return `Give the ${kind} a name.`;
    if (v.name === RESERVED && kind !== 'link') return `"${RESERVED}" is reserved. Pick another name.`;
    if (v.name !== current && Object.prototype.hasOwnProperty.call(parent, v.name)) {
      return `Something named "${v.name}" already exists here.`;
    }
    return null;
  };

  async function addPage() {
    const v = await openForm({
      title: 'New page',
      fields: [
        { name: 'name', label: 'Page name', placeholder: 'e.g. work' },
        { name: 'def', label: 'Open this page by default', type: 'checkbox', value: !pageNames().length },
      ],
      submit: 'Create',
      validate: (v) => nameRule(v, state.data, null, 'page'),
    });
    if (!v) return;
    state.data[v.name] = {};
    if (v.def || pageNames().length === 1) setDefault(v.name);
    state.page = v.name;
    state.query = '';
    $('#filter').value = '';
    syncHash();
    commit('Page created');
  }

  async function editPage(name) {
    const wasDef = state.data[name].default === true;
    const v = await openForm({
      title: 'Edit page',
      fields: [
        { name: 'name', label: 'Page name', value: name },
        { name: 'def', label: 'Open this page by default', type: 'checkbox', value: wasDef },
      ],
      validate: (v) => nameRule(v, state.data, name, 'page'),
    });
    if (!v) return;
    if (v.name !== name) renameInPlace(state.data, name, v.name);
    if (v.def && !wasDef) setDefault(v.name);
    if (!v.def && wasDef) delete state.data[v.name].default;
    if (state.page === name) { state.page = v.name; syncHash(); }
    commit('Page updated');
  }

  async function deletePage(name) {
    const n = countLinks(state.data[name]);
    const ok = await confirmDelete('Delete page?', `"${name}" and its ${n} link${n === 1 ? '' : 's'} will be removed.`);
    if (!ok) return;
    const wasDef = state.data[name].default === true;
    delete state.data[name];
    if (wasDef && pageNames().length) setDefault(pageNames()[0]);
    if (state.page === name) { state.page = defaultPage(); syncHash(); }
    commit('Page deleted');
  }

  async function addCategory(pageName) {
    const page = state.data[pageName];
    const v = await openForm({
      title: `New category in ${pageName}`,
      fields: [{ name: 'name', label: 'Category name', placeholder: 'e.g. github-repos' }],
      submit: 'Create',
      validate: (v) => nameRule(v, page, null, 'category'),
    });
    if (!v) return;
    page[v.name] = {};
    commit('Category created');
  }

  async function renameGroup(parent, key, kind) {
    const v = await openForm({
      title: `Rename ${kind}`,
      fields: [{ name: 'name', label: 'Name', value: key }],
      validate: (v) => nameRule(v, parent, key, kind),
    });
    if (!v || v.name === key) return;
    renameInPlace(parent, key, v.name);
    commit('Renamed');
  }

  async function deleteKey(parent, key, label) {
    const val = parent[key];
    const n = isObj(val) ? countLinks(val) : 0;
    const extra = isObj(val) && n ? ` It holds ${n} link${n === 1 ? '' : 's'}.` : '';
    const ok = await confirmDelete('Delete?', `Remove ${label}?${extra}`);
    if (!ok) return;
    delete parent[key];
    commit('Deleted');
  }

  const linkFields = (name = '', url = '') => [
    { name: 'url', label: 'URL', value: url, placeholder: 'github.com/my-repo', showIf: (v) => v.type !== 'sub' },
    { name: 'name', label: 'Name', value: name, placeholder: 'Leave empty to use the site name' },
  ];

  function linkRule(v, parent, current) {
    if (v.type === 'sub') return nameRule(v, parent, current, 'subcategory');
    if (!v.url) return 'Enter a URL.';
    if (!v.name) v.name = autoName(v.url);
    return nameRule(v, parent, current, 'link');
  }

  async function addToCategory(cat, catName) {
    const v = await openForm({
      title: `Add to ${catName}`,
      fields: [
        { name: 'type', label: 'Type', type: 'select', value: 'link', options: [
          { value: 'link', label: 'Link' },
          { value: 'sub', label: 'Subcategory' },
        ] },
        ...linkFields(),
      ],
      submit: 'Add',
      validate: (v) => linkRule(v, cat, null),
    });
    if (!v) return;
    cat[v.name] = v.type === 'sub' ? {} : v.url;
    commit(v.type === 'sub' ? 'Subcategory created' : 'Link added');
  }

  async function addLink(parent, label) {
    const v = await openForm({
      title: `Add link to ${label}`,
      fields: linkFields(),
      submit: 'Add',
      validate: (v) => linkRule(v, parent, null),
    });
    if (!v) return;
    parent[v.name] = v.url;
    commit('Link added');
  }

  async function editLink(parent, key) {
    const v = await openForm({
      title: 'Edit link',
      fields: linkFields(key, parent[key]),
      validate: (v) => linkRule(v, parent, key),
    });
    if (!v) return;
    if (v.name !== key) renameInPlace(parent, key, v.name, v.url);
    else parent[key] = v.url;
    commit('Link updated');
  }

  // ---------- Rendering ----------
  function syncHash() {
    const want = state.page ? '#' + encodeURIComponent(state.page) : '';
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
  }

  function goPage(name) {
    state.page = name;
    state.query = '';
    $('#filter').value = '';
    syncHash();
    render();
  }

  function renderSidebar() {
    const list = $('#pages');
    list.replaceChildren(...pageNames().map((name) => {
      const isDef = state.data[name].default === true;
      const active = name === state.page && !state.query;
      return h('div', {
        class: 'page-item' + (active ? ' active' : ''),
        role: 'button', tabindex: '0', 'aria-current': active ? 'page' : null,
        onclick: () => goPage(name),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goPage(name); } },
      },
      icon(isDef ? 'star' : 'folder', isDef ? 'is-default' : ''),
      h('span', { class: 'page-name', title: isDef ? `${name} (default)` : name }, name),
      h('span', { class: 'page-count' }, countLinks(state.data[name])),
      h('span', { class: 'item-actions' },
        iconBtn('pencil', 'Edit page', () => editPage(name)),
        iconBtn('trash', 'Delete page', () => deletePage(name), 'danger')));
    }));
    $('#syncNote').textContent = state.syncNote;
  }

  function linkRow(parent, key, url, path) {
    return h('li', { class: 'link' },
      h('a', { href: normUrl(url), title: url },
        faviconEl(url, key),
        h('span', { class: 'link-text' },
          h('span', { class: 'link-name' }, key),
          h('span', { class: 'link-sub' }, path || hostOf(url)))),
      h('span', { class: 'actions' },
        iconBtn('pencil', 'Edit link', () => editLink(parent, key)),
        iconBtn('trash', 'Delete link', () => deleteKey(parent, key, `link "${key}"`), 'danger')));
  }

  function linkList(parent) {
    const items = Object.entries(parent).filter(([k, v]) => k !== RESERVED && typeof v === 'string');
    if (!items.length) return null;
    return h('ul', { class: 'links' }, items.map(([k, v]) => linkRow(parent, k, v)));
  }

  function categoryCard(page, name, cat) {
    const subs = Object.entries(cat).filter(([, v]) => isObj(v));
    const links = linkList(cat);
    return h('section', { class: 'card' },
      h('header', { class: 'card-head' },
        h('h2', {}, name),
        h('span', { class: 'count' }, countLinks(cat)),
        h('span', { class: 'actions' },
          iconBtn('plus', 'Add link or subcategory', () => addToCategory(cat, name)),
          iconBtn('pencil', 'Rename category', () => renameGroup(page, name, 'category')),
          iconBtn('trash', 'Delete category', () => deleteKey(page, name, `category "${name}"`), 'danger'))),
      links,
      !links && !subs.length && h('p', { class: 'empty' }, 'No links yet. Press + to add one.'),
      subs.map(([s, sub]) => h('div', { class: 'sub' },
        h('div', { class: 'sub-head' },
          h('h3', {}, s),
          h('span', { class: 'actions' },
            iconBtn('plus', 'Add link', () => addLink(sub, s)),
            iconBtn('pencil', 'Rename subcategory', () => renameGroup(cat, s, 'subcategory')),
            iconBtn('trash', 'Delete subcategory', () => deleteKey(cat, s, `subcategory "${s}"`), 'danger'))),
        linkList(sub) || h('p', { class: 'empty' }, 'Empty'))));
  }

  function renderPage() {
    const content = $('#content');
    const name = state.page;
    const page = state.data[name];

    if (!page) {
      content.replaceChildren(h('div', { class: 'blank' },
        h('h1', {}, 'No pages yet'),
        h('p', {}, 'Create a page to start adding bookmarks.'),
        h('button', { type: 'button', class: 'btn primary', onclick: addPage }, icon('plus'), 'New page')));
      return;
    }

    const isDef = page.default === true;
    const cats = Object.entries(page).filter(([k, v]) => k !== RESERVED && isObj(v));
    const loose = Object.entries(page).some(([k, v]) => k !== RESERVED && typeof v === 'string');

    content.replaceChildren(
      h('div', { class: 'page-head' },
        h('h1', {}, name),
        isDef && h('span', { class: 'badge' }, 'default'),
        h('span', { class: 'actions' },
          iconBtn('pencil', 'Edit page', () => editPage(name)),
          iconBtn('trash', 'Delete page', () => deletePage(name), 'danger')),
        h('button', { type: 'button', class: 'btn primary add-cat', onclick: () => addCategory(name) }, icon('plus'), 'Category')),
      cats.length || loose
        ? h('div', { class: 'grid' },
          loose && h('section', { class: 'card' },
            h('header', { class: 'card-head' }, h('h2', {}, 'Links'),
              h('span', { class: 'actions' }, iconBtn('plus', 'Add link', () => addLink(page, name)))),
            linkList(page)),
          cats.map(([c, cat]) => categoryCard(page, c, cat)))
        : h('div', { class: 'blank' },
          h('p', {}, 'This page is empty.'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => addCategory(name) }, icon('plus'), 'Add a category')),
    );
  }

  function collectLinks() {
    const out = [];
    for (const [p, page] of Object.entries(state.data)) {
      for (const [c, cat] of Object.entries(page)) {
        if (c === RESERVED) continue;
        if (typeof cat === 'string') { out.push({ parent: page, key: c, url: cat, path: [p] }); continue; }
        if (!isObj(cat)) continue;
        for (const [s, v] of Object.entries(cat)) {
          if (typeof v === 'string') out.push({ parent: cat, key: s, url: v, path: [p, c] });
          else if (isObj(v)) {
            for (const [l, u] of Object.entries(v)) {
              if (typeof u === 'string') out.push({ parent: v, key: l, url: u, path: [p, c, s] });
            }
          }
        }
      }
    }
    return out;
  }

  function renderResults() {
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    state.results = collectLinks().filter((r) => {
      const hay = [r.key, r.url, ...r.path].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const n = state.results.length;
    $('#content').replaceChildren(
      h('div', { class: 'page-head' },
        h('h1', {}, 'Results'),
        h('span', { class: 'badge' }, `${n} match${n === 1 ? '' : 'es'}`),
        n > 0 && h('span', { class: 'hint' }, 'Enter opens the first one')),
      n
        ? h('section', { class: 'card results' },
          h('ul', { class: 'links' }, state.results.map((r) =>
            linkRow(r.parent, r.key, r.url, r.path.join(' › ') + ' · ' + hostOf(r.url)))))
        : h('div', { class: 'blank' }, h('p', {}, `Nothing matches “${state.query}”.`)),
    );
  }

  function render() {
    renderSidebar();
    if (state.query) renderResults();
    else renderPage();
  }

  // ---------- Clock & theme ----------
  function tick() {
    const d = new Date();
    const hour12 = getPref('clock24') !== '1';
    const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', hour12 }).formatToParts(d);
    $('#time').textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
    $('#period').textContent = (parts.find((p) => p.type === 'dayPeriod') || {}).value || '';
    $('#date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const hr = d.getHours();
    $('#greet').textContent =
      hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : hr < 22 ? 'Good evening' : 'Good night';
  }

  const THEMES = ['system', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const btn = $('#themeBtn');
    btn.replaceChildren(icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor'));
    btn.title = `Theme: ${t} (click to change)`;
    btn.setAttribute('aria-label', btn.title);
    if (typeof Bg !== 'undefined') Bg.applyDim();
  }

  // ---------- Background photos ----------
  // Free Unsplash photos via Lorem Picsum (no API key). The current and the next photo
  // are kept in Cache Storage, so switching is instant and the last photo works offline.
  const Bg = (() => {
    const SETTINGS_KEY = 'bg.settings';
    const STATE_KEY = 'bg.state';
    const LIST_KEY = 'bg.list';
    const CACHE = 'bg-photos-v1';
    const EVERY = { tab: 0, '30m': 30 * 60e3, '1h': 60 * 60e3, '1d': 24 * 60 * 60e3, never: Infinity };
    const EVERY_LABELS = { tab: 'Every new tab', '30m': 'Every 30 minutes', '1h': 'Every hour', '1d': 'Every day', never: 'Never (only with the button)' };
    const hasCache = typeof caches !== 'undefined';

    const readJson = (k, fallback) => { try { return JSON.parse(getPref(k)) ?? fallback; } catch { return fallback; } };
    const settings = { mode: 'photo', every: '1h', dim: 25, ...readJson(SETTINGS_KEY, {}) };
    const st = readJson(STATE_KEY, {}); // { current, next }
    let lum = 0.5;
    let layer = 0;
    let busy = false;
    const shownUrls = [];

    const saveSettings = () => setPref(SETTINGS_KEY, JSON.stringify(settings));
    const saveState = () => setPref(STATE_KEY, JSON.stringify(st));

    function photoSize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.min(2560, Math.round(screen.width * dpr));
      return [w, Math.round((w * screen.height) / screen.width)];
    }

    // Landscape photo list, refreshed once a day and merged so variety grows over time.
    async function getList() {
      const cached = readJson(LIST_KEY, null);
      if (cached && Date.now() - cached.at < 24 * 60 * 60e3 && cached.items.length) return cached.items;
      try {
        const page = 1 + Math.floor(Math.random() * 10);
        const r = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=100`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const fresh = (await r.json())
          .filter((p) => p.width / p.height >= 1.3)
          .map((p) => ({ id: p.id, author: p.author, link: p.url }));
        const merged = [...new Map([...((cached && cached.items) || []), ...fresh].map((p) => [p.id, p])).values()].slice(-400);
        setPref(LIST_KEY, JSON.stringify({ at: Date.now(), items: merged }));
        return merged;
      } catch (e) {
        console.warn('Photo list fetch failed', e);
        return (cached && cached.items) || [];
      }
    }

    async function fetchPhoto() {
      const list = await getList();
      const pool = list.filter((p) => p.id !== (st.current && st.current.id) && p.id !== (st.next && st.next.id));
      if (!pool.length) return null;
      const p = pool[Math.floor(Math.random() * pool.length)];
      const [w, h] = photoSize();
      const url = `https://picsum.photos/id/${p.id}/${w}/${h}`;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (hasCache) await (await caches.open(CACHE)).put(url, r);
        else await r.blob();
        return { ...p, url };
      } catch (e) {
        console.warn('Photo fetch failed', e);
        return null;
      }
    }

    async function srcFor(meta) {
      if (!hasCache) return meta.url;
      const c = await caches.open(CACHE);
      let r = await c.match(meta.url);
      if (!r) {
        try {
          r = await fetch(meta.url);
          if (!r.ok) return null;
          await c.put(meta.url, r.clone());
        } catch { return null; }
      }
      return URL.createObjectURL(await r.blob());
    }

    async function prune() {
      if (!hasCache) return;
      const keep = new Set([st.current && st.current.url, st.next && st.next.url]);
      const c = await caches.open(CACHE);
      for (const req of await c.keys()) if (!keep.has(req.url)) await c.delete(req);
    }

    // Average brightness 0..1, used to add extra dimming when the photo fights the theme.
    function brightness(img) {
      try {
        const c = document.createElement('canvas');
        c.width = 48; c.height = 27;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 48, 27);
        const d = x.getImageData(0, 0, 48, 27).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return s / (d.length / 4) / 255;
      } catch { return 0.5; }
    }

    function isDark() {
      const t = document.documentElement.dataset.theme;
      return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function applyDim() {
      const fights = isDark() ? lum > 0.5 : lum < 0.42;
      const v = Math.min(0.9, settings.dim / 100 + (fights ? 0.22 : 0));
      document.documentElement.style.setProperty('--dim', v.toFixed(2));
    }

    function setCredit(meta) {
      const a = $('#credit');
      if (!meta || settings.mode !== 'photo') { a.hidden = true; return; }
      a.href = meta.link || 'https://picsum.photos';
      a.textContent = `Photo · ${meta.author} · Unsplash`;
      a.hidden = false;
    }

    async function show(meta) {
      if (!meta) return false;
      const src = await srcFor(meta);
      if (!src) return false;
      const img = new Image();
      if (!src.startsWith('blob:')) img.crossOrigin = 'anonymous';
      const loaded = new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        setTimeout(() => reject(new Error('Photo load timed out')), 15000);
      });
      img.src = src;
      try { await loaded; } catch { return false; }
      if (settings.mode !== 'photo') return false;
      lum = brightness(img);
      applyDim();
      layer = 1 - layer;
      const on = $(layer ? '#bgB' : '#bgA');
      const off = $(layer ? '#bgA' : '#bgB');
      on.style.backgroundImage = `url("${src}")`;
      on.classList.add('on');
      off.classList.remove('on');
      document.documentElement.classList.add('has-photo');
      setCredit(meta);
      shownUrls.push(src);
      while (shownUrls.length > 2) {
        const old = shownUrls.shift();
        if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1500);
      }
      return true;
    }

    // Show the prefetched photo (or fetch one), then prefetch the following one.
    async function advance() {
      if (busy) return false;
      busy = true;
      $('#nextBg').classList.add('busy');
      try {
        let meta = st.next;
        st.next = null;
        let ok = await show(meta);
        if (!ok) { meta = await fetchPhoto(); ok = await show(meta); }
        if (ok) st.current = { ...meta, shownAt: Date.now() };
        // Offline with nothing new: keep the last saved photo instead of the plain gradient.
        else if (st.current && !document.documentElement.classList.contains('has-photo')) await show(st.current);
        saveState();
        st.next = await fetchPhoto();
        saveState();
        prune();
        return ok;
      } finally {
        busy = false;
        $('#nextBg').classList.remove('busy');
      }
    }

    const expired = () => !st.current || Date.now() - st.current.shownAt >= EVERY[settings.every];

    function applyMode() {
      if (settings.mode === 'photo') return;
      document.documentElement.classList.remove('has-photo');
      $('#bgA').classList.remove('on');
      $('#bgB').classList.remove('on');
      setCredit(null);
    }

    async function start() {
      applyMode();
      if (settings.mode !== 'photo') return;
      if (!expired() && await show(st.current)) {
        if (!st.next) { st.next = await fetchPhoto(); saveState(); }
      } else {
        await advance();
      }
    }

    async function next() {
      if (settings.mode !== 'photo') { settings.mode = 'photo'; saveSettings(); }
      const ok = await advance();
      if (!ok) toast("Couldn't load a new photo. Are you offline?");
    }

    function closePanel() {
      const p = document.querySelector('.bg-panel');
      if (p) p.remove();
      $('#bgBtn').setAttribute('aria-expanded', 'false');
    }

    function openPanel() {
      if (document.querySelector('.bg-panel')) { closePanel(); return; }
      const anchor = $('#bgBtn');
      const panel = h('div', { class: 'bg-panel', role: 'dialog', 'aria-label': 'Background settings' });

      const draw = () => {
        const modeBtn = (mode, label) => h('button', {
          type: 'button', 'aria-pressed': settings.mode === mode ? 'true' : 'false',
          onclick: () => {
            settings.mode = mode;
            saveSettings();
            start();
            draw();
          },
        }, label);
        const every = h('select', {
          onchange: (e) => { settings.every = e.target.value; saveSettings(); },
        }, Object.entries(EVERY_LABELS).map(([v, l]) => h('option', { value: v, selected: settings.every === v }, l)));
        const dimOut = h('span', { class: 'dim-val' }, settings.dim + '%');
        const dim = h('input', {
          type: 'range', min: '0', max: '70', step: '5', value: String(settings.dim),
          oninput: (e) => { settings.dim = Number(e.target.value); dimOut.textContent = settings.dim + '%'; applyDim(); },
          onchange: saveSettings,
        });
        const photo = settings.mode === 'photo';
        panel.replaceChildren(
          h('h3', {}, 'Background'),
          h('div', { class: 'seg' }, modeBtn('photo', 'Photos'), modeBtn('plain', 'Plain')),
          photo && h('label', { class: 'field' }, h('span', {}, 'Change photo'), every),
          photo && h('label', { class: 'field' }, h('span', {}, 'Dim photo ', dimOut), dim),
          photo && h('button', { type: 'button', class: 'btn primary', onclick: next }, icon('refresh'), 'Next photo'),
          photo && h('p', { class: 'note' }, 'Free photos from Unsplash via Lorem Picsum. Dimming is raised automatically when a photo is too bright or dark for the theme.'),
        );
      };

      draw();
      $('.tools').append(panel);
      anchor.setAttribute('aria-expanded', 'true');
      const outside = (e) => {
        if (!document.body.contains(panel)) { document.removeEventListener('pointerdown', outside); return; }
        if (!panel.contains(e.target) && !anchor.contains(e.target)) {
          closePanel();
          document.removeEventListener('pointerdown', outside);
        }
      };
      setTimeout(() => document.addEventListener('pointerdown', outside));
    }

    function init() {
      $('#nextBg').append(icon('refresh'));
      $('#bgBtn').append(icon('image'));
      $('#nextBg').addEventListener('click', next);
      $('#bgBtn').addEventListener('click', openPanel);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyDim);
      // Rotate while a tab stays open.
      setInterval(() => {
        if (settings.mode === 'photo' && settings.every !== 'tab' && document.visibilityState === 'visible' && expired()) advance();
      }, 60e3);
      start();
    }

    return { init, applyDim };
  })();

  // ---------- Init ----------
  function bindUi() {
    $('#filterIcon').replaceWith(icon('search', 'filter-ico'));
    $('#jsonBtn').append(icon('braces'));
    $('#addPage').prepend(icon('plus'));

    $('#addPage').addEventListener('click', addPage);
    $('#jsonBtn').addEventListener('click', openJsonEditor);
    $('#themeBtn').addEventListener('click', () => {
      const cur = getPref('theme') || 'system';
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      setPref('theme', next);
      applyTheme(next);
    });
    $('#clock').addEventListener('click', () => {
      setPref('clock24', getPref('clock24') === '1' ? '0' : '1');
      tick();
    });

    const filter = $('#filter');
    filter.addEventListener('input', () => {
      state.query = filter.value.trim();
      render();
    });
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.query && state.results[0]) {
        const url = normUrl(state.results[0].url);
        if (e.metaKey || e.ctrlKey) window.open(url, '_blank');
        else location.href = url;
      }
      if (e.key === 'Escape') {
        filter.value = '';
        state.query = '';
        filter.blur();
        render();
      }
    });
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.querySelector('dialog[open]');
      if (typing) return;
      if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        filter.focus();
      }
    });
  }

  async function init() {
    applyTheme(getPref('theme') || 'system');
    tick();
    setInterval(tick, 1000);
    bindUi();
    Bg.init();

    let loaded = null;
    try { loaded = await Store.load(); } catch (e) { console.warn('Load failed', e); }
    if (loaded && !validate(loaded.data)) {
      state.data = loaded.data;
      state.ts = loaded.ts;
    } else {
      state.data = structuredClone(SAMPLE);
      await Store.save(state.data);
    }

    let fromHash = '';
    try { fromHash = decodeURIComponent(location.hash.slice(1)); } catch {}
    state.page = state.data[fromHash] ? fromHash : defaultPage();
    render();
    Store.watch(reloadFromStore);
  }

  init();
})();
