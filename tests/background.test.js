import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../extension/shared.js';
const listeners = {};
const event = name => ({ addListener: fn => { listeners[name] = fn; } });
const local = {}, session = {}, windows = [], menus = [];
globalThis.chrome = {
  runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: event('message'), onInstalled: event('installed') },
  storage: {
    local: { setAccessLevel: async value => { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); }, get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, value) },
    session: { get: async key => ({ [key]: session[key] }), set: async value => Object.assign(session, value), remove: async key => { delete session[key]; } },
  },
  permissions: { contains: async () => true },
  contextMenus: { removeAll: callback => callback(), create: value => menus.push(value), onClicked: event('menu') },
  windows: { create: async value => windows.push(value) },
  tabs: { onRemoved: event('removed'), onUpdated: event('updated') },
};
await import('../extension/background.js');
const trusted = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html', documentId: 'options' };
const untrusted = { id: 'test-extension', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 };
const send = (message, sender = trusted) => new Promise(resolve => listeners.message(message, sender, resolve));

test('only extension pages may access secrets or change settings', async () => {
  const value = { ...DEFAULTS, apiKey: 'never-expose-this' };
  assert.equal((await send({ type: 'saveSettings', settings: value })).ok, true);
  const publicSettings = (await send({ type: 'settings' }, untrusted)).settings;
  assert.deepEqual(Object.keys(publicSettings).sort(), ['mode', 'targetLang']);
  assert.equal((await send({ type: 'saveSettings', settings: value }, untrusted)).ok, false);
  assert.equal((await send({ type: 'settings' })).settings.apiKey, value.apiKey);
  assert.equal((await send({ type: 'clearCache' }, untrusted)).ok, false);
});
test('context menu is selection-only and opens an extension popup with one-time text', async () => {
  listeners.installed();
  assert.deepEqual(menus[0].contexts, ['selection']);
  listeners.menu({ menuItemId: 'plamo-selection', selectionText: '<script>source text</script>' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(windows[0].type, 'popup');
  const url = new URL(windows[0].url);
  assert.equal(url.pathname, '/selection.html');
  const id = url.searchParams.get('id');
  assert.equal((await send({ type: 'selection', id }, untrusted)).ok, false);
  assert.equal((await send({ type: 'selection', id })).text, '<script>source text</script>');
  assert.equal((await send({ type: 'selection', id })).ok, false);
  assert.equal(Object.keys(session).length, 0);
});
