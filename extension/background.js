import { DEFAULTS, validateSettings, originPattern } from './shared.js';
import { Translator, CHUNK_SIZE } from './translator.js';

import { TranslationCache, translationCacheKey } from './cache.js';

const cache = new TranslationCache(chrome.storage.local);
const translator = new Translator(undefined, cache);
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const extensionOrigin = chrome.runtime.getURL('');
const isExtensionPage = sender => sender.url?.startsWith(extensionOrigin);
async function settings() {
  await storageReady;
  const stored = await chrome.storage.local.get('settings');
  const config = validateSettings({ ...DEFAULTS, ...stored.settings }, { allowEmptyEndpoint: true });
  translator.setConcurrency(Number(config.maxParallelRequests));
  return config;
}
async function translate(text, targetLang, owner, context, useCache) {
  const config = await settings();
  if (targetLang !== undefined) config.targetLang = targetLang;
  validateSettings(config);
  if (!await chrome.permissions.contains({ origins: [originPattern(config.endpoint)] })) {
    throw new Error('設定画面で API 接続先へのアクセスを許可してください。');
  }
  return translator.translate(text, config, owner, context, useCache);
}
async function handle(message, sender) {
  const trusted = isExtensionPage(sender);
  const owner = sender.tab ? `tab:${sender.tab.id}:${sender.frameId}` : `page:${sender.documentId || sender.url}`;
  switch (message?.type) {
    case 'ping': return {};
    case 'settings': {
      const config = await settings();
      return { settings: trusted ? config : { targetLang: config.targetLang, mode: config.mode } };
    }
    case 'saveSettings': {
      if (!trusted) throw new Error('設定画面から操作してください。');
      const config = validateSettings(message.settings);
      if (!await chrome.permissions.contains({ origins: [originPattern(config.endpoint)] })) throw new Error('API 接続先へのアクセスを許可してください。');
      await storageReady;
      await chrome.storage.local.set({ settings: config });
      translator.setConcurrency(Number(config.maxParallelRequests));
      return {};
    }
    case 'translate': return { text: await translate(message.text, message.targetLang, owner, message.context, !(trusted && message.bypassCache === true)) };
    case 'forgetTranslation': {
      const config = await settings();
      if (message.targetLang !== undefined) config.targetLang = message.targetLang;
      validateSettings(config);
      await cache.delete(await translationCacheKey(message.text, config, message.context));
      return {};
    }
    case 'clearCache':
      if (!trusted) throw new Error('設定画面から操作してください。');
      await storageReady;
      await cache.clear();
      return {};
    case 'cancel': translator.cancel(owner); return {};
    case 'pageAction': {
      if (!trusted || !Number.isInteger(message.tabId)) throw new Error('拡張のポップアップから操作してください。');
      if (!['start', 'restore', 'stop', 'status'].includes(message.action)) throw new Error('不正な操作です。');
      if (message.action !== 'status') {
        try { await chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ['content.js'] }); }
        catch { throw new Error('このページでは翻訳できません。通常の Web ページでお試しください。'); }
      }
      const config = await settings();
      try {
        const result = await chrome.tabs.sendMessage(message.tabId, { type: 'plamoPage', action: message.action, mode: message.mode, targetLang: message.targetLang, sourceByteLimit: CHUNK_SIZE, maxParallelRequests: Number(config.maxParallelRequests) });
        if (!result.ok) throw new Error(result.error);
        return result;
      } catch (error) {
        if (message.action === 'status') return { state: { running: false, done: 0, total: 0, errors: 0 } };
        throw error;
      }
    }
    case 'selection': {
      if (!trusted || typeof message.id !== 'string' || !/^[a-f\d-]{36}$/.test(message.id)) throw new Error('選択文を読み込めません。');
      const key = `selection:${message.id}`;
      const stored = await chrome.storage.session.get(key);
      await chrome.storage.session.remove(key);
      if (!stored[key]) throw new Error('選択文が見つかりません。もう一度右クリックから翻訳してください。');
      return { text: stored[key] };
    }
    default: throw new Error('不明な操作です。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  handle(message, sender).then(result => respond({ ...result, ok: true }), error => respond({ ok: false, error: error.message || '操作に失敗しました。' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'plamo-selection', title: 'Contexlate で選択部分を翻訳', contexts: ['selection'] });
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'plamo-selection' || !info.selectionText?.trim()) return;
  (async () => {
    const id = crypto.randomUUID();
    const key = `selection:${id}`;
    await chrome.storage.session.set({ [key]: info.selectionText });
    try {
      await chrome.windows.create({ url: chrome.runtime.getURL(`selection.html?id=${id}`), type: 'popup', width: 500, height: 650 });
    } catch (error) { await chrome.storage.session.remove(key); throw error; }
  })().catch(error => console.error('選択文翻訳を開けませんでした:', error.message));
});
chrome.tabs.onRemoved.addListener(tabId => translator.cancel(`tab:${tabId}:0`));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') translator.cancel(`tab:${tabId}:0`);
});
