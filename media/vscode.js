'use strict';
// Jembatan antara dashboard Tessly dan VS Code. Dashboard memanggil window.api seperti di aplikasi Electron;
// di sini panggilan itu diteruskan ke extension lewat postMessage.
(() => {
  const vscode = acquireVsCodeApi();
  const boot = JSON.parse(document.getElementById('tessly-boot').textContent);

  // Pilihan dashboard (tema, bahasa, jenis token) disimpan oleh extension, bukan localStorage webview,
  // supaya tetap ada setelah VS Code ditutup.
  const store = { ...boot.prefs };
  if (!store['tessly.lang']) store['tessly.lang'] = boot.lang;
  if (!store['tessly.theme']) store['tessly.theme'] = boot.theme;
  const fakeStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
      vscode.postMessage({ type: 'set-pref', key: k, value: String(v) });
    },
    removeItem: (k) => {
      delete store[k];
      vscode.postMessage({ type: 'set-pref', key: k, value: null });
    },
  };
  Object.defineProperty(window, 'localStorage', { value: fakeStorage, configurable: true });

  let seq = 0;
  const waiting = new Map();
  const dataListeners = [];
  const ask = (type) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    vscode.postMessage({ type, id });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'reply' && waiting.has(m.id)) {
      waiting.get(m.id)(m.data);
      waiting.delete(m.id);
    } else if (m.type === 'data') {
      dataListeners.forEach((cb) => cb(m.data));
    }
  });

  // Update di VS Code diurus Marketplace, jadi bagian update di dashboard selalu "tidak ada".
  const noUpdate = { status: 'idle', current: boot.version };
  window.api = {
    getData: () => ask('get-data'),
    onData: (cb) => dataListeners.push(cb),
    getSettings: () => ask('get-settings'),
    saveSettings: () => Promise.resolve(true),
    setLang: () => Promise.resolve(),
    update: {
      get: () => Promise.resolve(noUpdate),
      check: () => Promise.resolve(noUpdate),
      download: () => Promise.resolve(),
      install: () => Promise.resolve(),
      onState: () => {},
    },
  };
  document.documentElement.classList.add('in-vscode');
})();
