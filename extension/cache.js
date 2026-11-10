const STORAGE_KEY = 'translationCacheV1';
export const CACHE_MAX_ENTRIES = 200;
export const CACHE_MAX_BYTES = 2 * 1024 * 1024;

export async function translationCacheKey(text, settings, context = '') {
  if (typeof text !== 'string' || text.length > 100000 || typeof context !== 'string' || context.length > 100000) throw new Error('翻訳のキャッシュキーが不正です。');
  const input = JSON.stringify([settings.endpoint, settings.apiKey, settings.model, settings.targetLang, text, context]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class TranslationCache {
  pending = Promise.resolve();
  generation = 0;
  constructor(storage) { this.storage = storage; }
  async entries() {
    const stored = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
    return Array.isArray(stored) ? stored.filter(entry => Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && typeof entry[1] === 'string') : [];
  }
  async get(key) {
    await this.pending;
    return (await this.entries()).find(entry => entry[0] === key)?.[1];
  }
  update(change) {
    const operation = this.pending.then(async () => {
      const entries = change(await this.entries());
      while (entries.length > CACHE_MAX_ENTRIES || new TextEncoder().encode(JSON.stringify(entries)).length > CACHE_MAX_BYTES) entries.shift();
      await this.storage.set({ [STORAGE_KEY]: entries });
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  set(key, text) {
    if (new TextEncoder().encode(JSON.stringify([[key, text]])).length > CACHE_MAX_BYTES) return Promise.resolve();
    return this.update(entries => [...entries.filter(entry => entry[0] !== key), [key, text]]);
  }
  delete(key) { return this.update(entries => entries.filter(entry => entry[0] !== key)); }
  clear() {
    this.generation++;
    return this.update(() => []);
  }
}
