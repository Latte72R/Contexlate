import test from 'node:test';
import assert from 'node:assert/strict';
import { Translator, splitText, requestBody, CHUNK_SIZE, INPUT_BYTE_LIMIT, clipUtf8 } from '../extension/translator.js';
import { DEFAULTS, validateSettings, originPattern } from '../extension/shared.js';
const config = { ...DEFAULTS, apiKey: 'test-only-key' };
const json = (text = '翻訳結果', finish_reason = 'stop') => Response.json({ choices: [{ message: { content: text }, finish_reason }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('settings validate endpoint, languages, and avoid credentials in URL', () => {
  assert.equal(validateSettings(config).model, 'plamo-3-translate');
  assert.equal(validateSettings({}).mode, 'replace');
  assert.equal(validateSettings({ mode: 'bilingual' }).mode, 'bilingual');
  for (const endpoint of ['file:///tmp/a', 'https://user:secret@example.com/v1/chat/completions', 'https://example.com/invalid', 'https://example.com/v1?key=secret']) {
    assert.throws(() => validateSettings({ ...config, endpoint }));
  }
  assert.throws(() => validateSettings({ ...config, targetLang: 'invalid' }));
  assert.equal(originPattern('http://127.0.0.1:8000/v1/chat/completions'), 'http://127.0.0.1/*');
});
test('base URL and legacy completion URL normalize to the same base, including trailing slashes', () => {
  for (const endpoint of ['https://llm.keioaic.dev/v1', 'https://llm.keioaic.dev/v1/', 'https://llm.keioaic.dev/v1/chat/completions', 'https://llm.keioaic.dev/v1/chat/completions/']) {
    assert.equal(validateSettings({ ...config, endpoint }).endpoint, 'https://llm.keioaic.dev/v1');
  }
});
test('splitting is lossless, bounded, and preserves astral Unicode', () => {
  for (const text of ['Hello. '.repeat(900), 'あ😀𠮷'.repeat(2000), '', 'a'.repeat(2500)]) {
    const chunks = splitText(text);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(new TextEncoder().encode(chunk).length <= CHUNK_SIZE);
      assert.ok(chunk.isWellFormed());
    }
  }
});
test('context uses the native PLaMo option and input stays within the byte budget', async () => {
  const context = 'LLVM Compiler Infrastructure. '.repeat(2000) + '😀';
  const text = 'あ'.repeat(1900);
  const body = requestBody(text, config, context);
  assert.deepEqual(body.messages, [{ role: 'user', content: text }]);
  assert.ok(body.chat_template_kwargs.context.startsWith('LLVM Compiler Infrastructure.'));
  assert.ok(new TextEncoder().encode(text + body.chat_template_kwargs.context).length <= INPUT_BYTE_LIMIT);
  assert.equal(clipUtf8('a😀b', 4), 'a');
  assert.equal(clipUtf8('a😀b', 5), 'a😀');
  const translator = new Translator(async (_url, init) => {
    assert.equal(JSON.parse(init.body).chat_template_kwargs.context, 'Compiler technology');
    return json();
  });
  await translator.translate('Hello', config, 'a', 'Compiler technology');
  await assert.rejects(translator.translate('Hello', config, 'a', {}), /参照文脈/);
});
test('raw HTTP uses template kwargs at top level, never instructions as source text', () => {
  const body = requestBody('Hello world', config);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello world' }]);
  assert.deepEqual(body.chat_template_kwargs, { target_lang: 'ja' });
  assert.equal(body.model, config.model);
  assert.equal(body.temperature, 0);
  assert.ok(body.max_tokens <= 16384);
});
test('JSON response fallback and request credential isolation', async () => {
  const translator = new Translator(async (url, init) => {
    assert.equal(url, `${config.endpoint}/chat/completions`);
    assert.equal(init.headers.Authorization, 'Bearer test-only-key');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return json();
  });
  assert.equal(await translator.translate('Hello', config, 'a'), '翻訳結果');
});
test('default fetch keeps its native browser receiver', async () => {
  const previous = globalThis.fetch;
  let translator;
  try {
    globalThis.fetch = function () { assert.equal(this, globalThis); return Promise.resolve(json()); };
    translator = new Translator();
  } finally { globalThis.fetch = previous; }
  assert.equal(await translator.translate('Hello', config, 'a'), '翻訳結果');
});
test('SSE parser handles split UTF-8, CRLF, comments, and finish event', async () => {
  const wire = ':ping\r\ndata: {"choices":[{"delta":{"content":"日"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"本語"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(wire);
  const translator = new Translator(async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(await translator.translate('Japanese', config, 'a'), '日本語');
});
test('errors never leak server bodies or key; truncation is rejected', async () => {
  for (const response of [new Response('test-only-key secret upstream error', { status: 401 }), json('truncated', 'length'), json(''), Response.json({ invalid: true })]) {
    const translator = new Translator(async () => response);
    await assert.rejects(translator.translate('Hi', config, 'a'), error => !error.message.includes('test-only-key'));
  }
  const translator = new Translator(async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(translator.translate('Hello', config, 'a'), /途中/);
});
test('a global eight-request limit applies across owners', async () => {
  let active = 0, maximum = 0;
  const translator = new Translator(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return json();
  });
  await Promise.all(Array.from({ length: 13 }, (_, i) => translator.translate(`Text ${i}`, config, `owner-${i}`)));
  assert.equal(maximum, 8);
  assert.equal(translator.active, 0);
  assert.equal(translator.tasks.size, 0);
});
test('cancel removes queued work, aborts active work, and frees slots', async () => {
  let fetched = 0;
  const translator = new Translator((_url, { signal }) => new Promise((_resolve, reject) => {
    fetched++;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const promises = Array.from({ length: 9 }, (_, i) => translator.translate(`Text ${i}`, config, 'a'));
  const settled = Promise.allSettled(promises);
  await tick(); translator.cancel('a');
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(fetched, 8);
  assert.equal(translator.active, 0);
  assert.equal(translator.queue.length, 0);
  translator.fetch = async () => json('works again');
  assert.equal(await translator.translate('Hello', config, 'b'), 'works again');
});
test('long translation preserves separators and requires a key', async () => {
  const translator = new Translator(async () => json('translated'));
  const result = await translator.translate('word '.repeat(3000), config, 'a');
  assert.ok(result.includes('translated translated'));
  await assert.rejects(translator.translate('Hi', DEFAULTS, 'a'), /API キー/);
});

test('parallel setting defaults for existing installs and rejects invalid limits', () => {
  assert.equal(validateSettings({}).maxParallelRequests, '8');
  for (const value of ['0', '65', '1.5', '', '-1', 'NaN']) {
    assert.throws(() => validateSettings({ ...config, maxParallelRequests: value }), /並列/);
  }
  assert.equal(validateSettings({ ...config, maxParallelRequests: '8' }).maxParallelRequests, '8');
});
test('global concurrency changes drain queued work and allow active requests to finish', async () => {
  const releases = [];
  let fetched = 0;
  const translator = new Translator(() => {
    fetched++;
    return new Promise(resolve => releases.push(() => resolve(json())));
  });
  translator.setConcurrency(2);
  const pending = Promise.all(Array.from({ length: 10 }, (_, i) => translator.translate('Text', config, String(i))));
  assert.equal(fetched, 2);
  translator.setConcurrency(6);
  await tick();
  assert.equal(fetched, 6);
  translator.setConcurrency(1);
  for (let i = 0; i < 5; i++) releases.shift()();
  await tick();
  assert.equal(fetched, 6);
  releases.shift()();
  await tick();
  assert.equal(fetched, 7);
  for (let i = 0; i < 4; i++) {
    assert.equal(translator.active, 1);
    releases.shift()();
    await tick();
  }
  await pending;
  assert.equal(translator.active, 0);
  assert.equal(translator.queue.length, 0);
});

test('429 retries automatically, honors Retry-After, and keeps the concurrency slot', async () => {
  const { retryDelay } = await import('../extension/translator.js');
  assert.equal(retryDelay('2', 0), 2000);
  assert.equal(retryDelay('Wed, 01 Jan 2025 00:00:03 GMT', 0, Date.parse('2025-01-01T00:00:00Z')), 3000);
  assert.equal(retryDelay(null, 2), 8000);
  assert.equal(retryDelay('invalid', 1), 4000);
  let calls = 0;
  const translator = new Translator(async () => {
    calls++;
    assert.equal(translator.active, 1);
    return calls < 3 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : json();
  });
  assert.equal(await translator.translate('Hello', config, 'a'), '翻訳結果');
  assert.equal(calls, 3);
  assert.equal(translator.active, 0);
});
test('429 retry budget is bounded and cooldown is shared and cancellable', async () => {
  let calls = 0;
  const translator = new Translator(async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
  });
  await assert.rejects(translator.translate('Hello', config, 'a'), /5回の自動再試行/);
  assert.equal(calls, 6);
  translator.fetch = async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  };
  const a = assert.rejects(translator.translate('Again', config, 'a'), /中止/);
  await tick();
  const before = calls;
  const b = assert.rejects(translator.translate('Other tab', config, 'b'), /中止/);
  await tick();
  assert.equal(calls, before, 'New requests must respect the shared cooldown');
  translator.cancel('a'); translator.cancel('b');
  await Promise.all([a, b]);
  assert.equal(translator.active, 0);
  assert.equal(translator.tasks.size, 0);
});
