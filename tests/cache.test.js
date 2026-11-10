import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslationCache, translationCacheKey, CACHE_MAX_ENTRIES, CACHE_MAX_BYTES } from '../extension/cache.js';
import { Translator } from '../extension/translator.js';
import { DEFAULTS } from '../extension/shared.js';
const config = { ...DEFAULTS, apiKey: 'cache-test-key' };
function storage() {
  const data = {};
  return { data, get: async key => structuredClone({ [key]: data[key] }), set: async value => Object.assign(data, structuredClone(value)) };
}
const response = () => Response.json({ choices: [{ message: { content: '訳文' }, finish_reason: 'stop' }] });
test('cache keys isolate inputs, context, model, target, endpoint and credentials', async () => {
  const key = await translationCacheKey('Source', config, 'Context');
  for (const [text, settings, context] of [
    ['Other', config, 'Context'], ['Source', config, 'Other'],
    ...['model', 'targetLang', 'endpoint', 'apiKey'].map(field => ['Source', { ...config, [field]: 'different' }, 'Context']),
  ]) assert.notEqual(await translationCacheKey(text, settings, context), key);
  assert.equal(await translationCacheKey('Source', { ...config, maxParallelRequests: '1', mode: 'replace' }, 'Context'), key);
});
test('cache survives recreation, serializes concurrent writes, bounds size, and clears', async () => {
  const store = storage(), cache = new TranslationCache(store);
  const key = i => i.toString(16).padStart(64, '0');
  await Promise.all(Array.from({ length: CACHE_MAX_ENTRIES + 1 }, (_, i) => cache.set(key(i), '訳文')));
  assert.equal(await cache.get(key(0)), undefined);
  assert.equal(await new TranslationCache(store).get(key(200)), '訳文');
  await cache.delete(key(200));
  assert.equal(await cache.get(key(200)), undefined);
  await cache.set(key(300), 'a'.repeat(CACHE_MAX_BYTES));
  assert.ok(new TextEncoder().encode(JSON.stringify(store.data)).length < CACHE_MAX_BYTES);
  assert.equal(await cache.get(key(199)), '訳文', 'Oversized entries must not evict useful cached results');
  await cache.clear();
  await cache.set(key(400), 'a'.repeat(CACHE_MAX_BYTES / 2));
  await cache.set(key(401), 'b'.repeat(CACHE_MAX_BYTES / 2));
  assert.equal(await cache.get(key(400)), undefined);
  assert.equal((await cache.get(key(401))).length, CACHE_MAX_BYTES / 2);
  await cache.set(key(301), 'new');
  await cache.clear();
  assert.equal(await new TranslationCache(store).get(key(301)), undefined);
});
test('only completed translations are cached; bypass, failures, clear during flight and storage errors work', async () => {
  const store = storage(), cache = new TranslationCache(store);
  let calls = 0;
  const fetch = async () => { calls++; return response(); };
  const translator = new Translator(fetch, cache);
  await translator.translate('Source', config, 'a');
  await new Translator(fetch, new TranslationCache(store)).translate('Source', config, 'b');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(store.data).includes(config.apiKey));
  assert.ok(!JSON.stringify(store.data).includes('Source'));
  await translator.translate('Source', config, 'a', '', false);
  assert.equal(calls, 2);
  translator.fetch = async () => { calls++; return Response.json({}, { status: 503 }); };
  for (let i = 0; i < 2; i++) await assert.rejects(translator.translate('Failure', config, 'a'));
  assert.equal(calls, 4);
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  translator.fetch = () => new Promise(resolve => { finish = () => resolve(response()); started(); });
  const pending = translator.translate('Pending', config, 'a');
  await ready;
  await cache.clear();
  finish(); await pending;
  assert.equal(await cache.get(await translationCacheKey('Pending', config)), undefined);
  let abortStarted;
  const abortReady = new Promise(resolve => { abortStarted = resolve; });
  translator.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    abortStarted();
  });
  const cancelled = assert.rejects(translator.translate('Cancelled', config, 'cancel-owner'), /中止/);
  await abortReady;
  translator.cancel('cancel-owner');
  await cancelled;
  assert.equal(await cache.get(await translationCacheKey('Cancelled', config)), undefined);
  const broken = new TranslationCache({ get: async () => { throw Error('storage unavailable'); } });
  assert.equal(await new Translator(fetch, broken).translate('Source', config, 'a'), '訳文');
});
