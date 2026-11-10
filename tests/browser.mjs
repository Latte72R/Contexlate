import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../extension/shared.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'plamo-test-'));
const requests = [];
let active = 0, maximum = 0, delay = 5, failure = false;
let markupMode = 'normal';
let unexpectedResources = 0;
const fixture = await readFile(join(root, 'tests/fixtures/page.html'));
const server = createServer(async (req, res) => {
  if (req.url === '/beacon') unexpectedResources++;
  if (req.method !== 'POST') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  active++; maximum = Math.max(maximum, active);
  let counted = true;
  res.on('close', () => { if (counted) { active--; counted = false; } });
  if (failure) { res.writeHead(401); res.end('secret upstream error must not be displayed'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.flushHeaders();
  await new Promise(resolve => setTimeout(resolve, delay));
  if (res.destroyed) return;
  const source = body.messages[0].content;
  let content = source === 'Untrusted content' ? '<img src=x onerror="window.pwned=true">' : source.startsWith('<') ? source.replace(/>([^<]+)</g, (_match, text) => `>訳：${text}<`) : `訳：${source}`;
  if (source.startsWith('<p>Hello <strong')) {
    if (markupMode === 'unwrapped') content = '詳細は<a id="n1">資料</a>へ。<strong id="n0">世界</strong>、こんにちは。';
    if (markupMode === 'reorder') content = '<p>詳細は<a id="n1">資料</a>へ。<strong id="n0">世界</strong>、こんにちは。</p>';
    if (markupMode === 'missing') content = '<p>リンクを失った訳文。</p>';
    if (markupMode === 'attribute') content = '<p><strong id="n0">世界</strong><a id="n1" href="javascript:alert(1)">資料</a></p>';
    if (markupMode === 'script') content = '<p><strong id="n0">世界</strong><a id="n1">資料</a><script>window.pwned=true</script></p>';
    if (markupMode === 'duplicate') content = '<p><strong id="n0">世界</strong><strong id="n0">世界</strong></p>';
    if (markupMode === 'parent') content = '<p><strong id="n0">世界<a id="n1">資料</a></strong></p>';
    if (markupMode === 'image') content = `<p><strong id="n0">世界</strong><a id="n1">資料</a><img src="http://${req.headers.host}/beacon"></p>`;
  }
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
let context;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const extensionPath = join(temp, 'extension');
  await cp(join(root, 'extension'), extensionPath, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  // Test copy only: permission for the local fixture and mock API, no production changes.
  manifest.host_permissions.push('http://127.0.0.1/*');
  if (process.env.PLAMO_LLVM_TEST === '1') manifest.host_permissions.push('https://llvm.org/*');
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
  });
  context.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') console.error('Request failed:', request.url(), request.failure()?.errorText); });
  context.on('console', message => { if (message.type() === 'error') console.error('Browser error:', message.text()); });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  const errors = [];
  options.on('pageerror', error => errors.push(error.message));
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.getElementById('model').value === 'plamo-3-translate-8b');
  assert.equal(await options.locator('#targetLang option[value=en]').textContent(), '英語');
  assert.equal(requests.length, 0);
  await options.locator('#endpoint').fill(`${endpoint}/v1/`);
  await options.locator('#apiKey').fill('test-only-key');
  assert.equal(await options.locator('#maxParallelRequests').inputValue(), '4');
  await options.locator('#maxParallelRequests').fill('6');
  await options.locator('#test').click();
  await options.waitForFunction(() => document.getElementById('status').textContent.includes('接続できました'), null, { timeout: 10000 }).catch(async error => {
    throw new Error(`${error.message}; status=${await options.locator('#status').textContent()}; pageErrors=${JSON.stringify(errors)}; requests=${requests.length}`);
  });
  const send = message => options.evaluate(message => chrome.runtime.sendMessage(message), message);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(endpoint);
  const tabs = await options.evaluate(() => chrome.tabs.query({}));
  const tabId = tabs.find(tab => tab.url === `${endpoint}/`).id;
  const action = (action, mode = 'bilingual') => send({ type: 'pageAction', tabId, action, mode, targetLang: 'ja' });
  const complete = async () => {
    for (let i = 0; i < 3000; i++) {
      const result = await action('status');
      if (!result.state.running) return result.state;
      if (process.env.PLAMO_LLVM_TEST === '1' && i > 0 && i % 100 === 0) console.log('Page progress:', JSON.stringify(result.state));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Translation did not finish');
  };
  const firstPageRequest = requests.length;
  assert.equal((await action('start')).ok, true);
  let state = await complete();
  assert.equal(state.errors, 0); assert.equal(state.done, state.total);
  assert.ok(await page.locator('[data-plamo-ui=translation]').count() > 5);
  assert.equal(await page.locator('#intro strong').textContent(), 'world');
  const pageRequests = requests.slice(firstPageRequest).map(request => request.messages[0].content);
  assert.ok(pageRequests.indexOf('Below viewport context.') > pageRequests.findIndex(text => text.startsWith('Hello world.')));
  assert.ok(await page.locator('#below > [data-plamo-ui=translation]').count(), 'Offscreen text must still finish translating');
  assert.match(await page.locator('#intro > [data-plamo-ui=translation]').textContent(), /Hello world\. Visit the documentation for details\./);
  await page.locator('#button').click();
  assert.equal(await page.evaluate(() => window.clickCount), 1);
  assert.equal(await page.locator('#unsafe img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await action('restore');
  assert.equal(await page.locator('[data-plamo-ui=translation]').count(), 0);
  await page.evaluate(() => { window.savedStrong = document.querySelector('#intro strong'); window.savedButton = document.querySelector('#button'); });
  await action('start', 'replace'); state = await complete();
  assert.equal(state.errors, 0);
  assert.equal(await page.locator('#intro strong').textContent(), '訳：world');
  assert.equal(await page.locator('#button').getAttribute('title'), '訳：Click this button');
  assert.equal(await page.locator('#input').getAttribute('placeholder'), '訳：Search the page');
  assert.equal(await page.locator('#input').inputValue(), 'PRIVATE FORM VALUE');
  assert.ok(await page.evaluate(() => window.savedStrong === document.querySelector('#intro strong') && window.savedButton === document.querySelector('#button')));
  await page.locator('#button').click(); assert.equal(await page.evaluate(() => window.clickCount), 2);
  assert.equal(await page.locator('#unsafe img').count(), 0);
  await page.locator('#second').evaluate(element => { element.textContent = 'New application content'; });
  await action('restore');
  assert.equal(await page.locator('#intro strong').textContent(), 'world');
  assert.equal(await page.locator('#second').textContent(), 'New application content');
  assert.equal(await page.locator('#input').getAttribute('placeholder'), 'Search the page');
  const sources = requests.map(request => request.messages[0].content + '\n' + (request.chat_template_kwargs.context || '')).join('\n');
  for (const excluded of ['PRIVATE FORM VALUE', 'PRIVATE PASSWORD', 'PRIVATE DRAFT', 'DO NOT SEND CODE', 'DO NOT SEND HIDDEN', 'DO NOT SEND INVISIBLE', 'DO NOT TRANSLATE', 'PRIVATE EDITOR', 'Secret placeholder']) assert.ok(!sources.includes(excluded), excluded);
  assert.ok(requests.every(request => request.chat_template_kwargs.target_lang === 'ja'));
  assert.ok(requests.some(request => request.messages[0].content.startsWith('<p>') && request.chat_template_kwargs.context.includes('This system uses a GPU')));
  const llvmRequest = requests.find(request => request.messages[0].content.startsWith('<p>LLVM began as a '));
  assert.ok(llvmRequest, 'LLVM-style inline links must be translated as a complete paragraph');
  assert.ok(llvmRequest.messages[0].content.includes('research project</a>'));
  assert.ok(!llvmRequest.messages[0].content.includes('\n'), 'HTML source indentation must not split Japanese words');
  assert.equal(maximum, 6);
  failure = true;
  await action('start', 'replace'); state = await complete();
  assert.ok(state.errors > 0); assert.match(state.message, /401/); assert.ok(!state.message.includes('secret upstream'));
  failure = false; delay = 300;
  await action('start', 'replace');
  await new Promise(resolve => setTimeout(resolve, 50));
  await action('stop'); state = await complete();
  assert.equal(state.running, false); assert.match(state.message, /中止/);
  await action('restore'); delay = 5;
  const selectionId = crypto.randomUUID();
  await options.evaluate(({ selectionId }) => chrome.storage.session.set({ [`selection:${selectionId}`]: 'Selected text only' }), { selectionId });
  const selection = await context.newPage();
  await selection.setViewportSize({ width: 500, height: 650 });
  await selection.goto(`chrome-extension://${id}/selection.html?id=${selectionId}`);
  await selection.waitForFunction(() => document.getElementById('status').textContent.includes('翻訳できました'));
  assert.equal(await selection.locator('#translation').textContent(), '訳：Selected text only');
  assert.equal(await selection.locator('#targetLang option[value=fr]').textContent(), 'フランス語');
  await mkdir(join(root, 'test-results'), { recursive: true });
  await selection.screenshot({ path: join(root, 'test-results/selection.png') });
  await options.screenshot({ path: join(root, 'test-results/options.png'), fullPage: true });
  await selection.close();
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 350, height: 620 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('targetLang').value === 'ja');
  await popup.screenshot({ path: join(root, 'test-results/popup.png') });
  await page.reload();
  const originalIntro = await page.locator('#intro').innerHTML();
  await page.evaluate(() => { window.originalLink = document.querySelector('#link'); window.originalStrongText = document.querySelector('#intro strong').firstChild; });
  markupMode = 'reorder';
  await action('start', 'replace'); state = await complete();
  assert.equal(state.errors, 0, state.message);
  assert.ok(await page.evaluate(() => document.querySelector('#intro').firstElementChild === window.originalLink));
  assert.ok(await page.evaluate(() => window.originalStrongText === document.querySelector('#intro strong').firstChild), 'Framework references to text nodes must remain live');
  assert.match(await page.locator('#intro').textContent(), /^詳細は資料へ。世界、こんにちは。$/);
  await action('restore');
  assert.equal(await page.locator('#intro').innerHTML(), originalIntro);
  for (const mode of ['missing', 'attribute', 'script', 'duplicate', 'parent', 'image', 'unwrapped']) {
    markupMode = mode;
    const requestStart = requests.length;
    await action('start', 'replace'); state = await complete();
    assert.equal(state.errors, 1);
    assert.equal(state.done, state.total, 'A malformed paragraph must not stop the rest of the page');
    assert.equal(await page.locator('#intro').innerHTML(), originalIntro);
    assert.equal(await page.locator('[data-plamo-ui="translation"]').count(), 0);
    assert.equal(requests.slice(requestStart).filter(body => body.messages[0].content.startsWith('<p>Hello')).length, 1, 'Do not retry malformed markup');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await action('restore');
  }
  markupMode = 'reorder';
  await action('start', 'replace'); await complete();
  await page.evaluate(() => { window.originalStrongText.data = 'Updated by application'; });
  assert.equal(await page.locator('#intro strong').textContent(), 'Updated by application');
  await action('restore');
  assert.equal(await page.locator('#intro strong').textContent(), 'Updated by application');
  markupMode = 'normal';
  await page.reload();
  assert.equal(unexpectedResources, 0, 'Rejected markup must not fetch resources during parsing');
  if (process.env.PLAMO_LLVM_TEST === '1') {
    await page.goto('https://llvm.org/', { waitUntil: 'networkidle' });
    const original = await page.locator('body').innerHTML();
    await action('start', 'replace'); state = await complete();
    assert.equal(state.errors, 0, state.message);
    await action('restore');
    await writeFile(join(root, 'test-results/llvm-mock-original.html'), original);
    await writeFile(join(root, 'test-results/llvm-mock-restored.html'), await page.locator('body').innerHTML());
    assert.equal(await page.locator('body').innerHTML(), original, 'Mock LLVM DOM must restore exactly');
    await page.goto(endpoint);
  }
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: settings, bilingual/replace, native context, inline reordering, DOM identity, restore, exclusions, cancellation, malformed markup rejection, selection popup, global concurrency.');
  if (process.env.PLAMO_LIVE_TEST === '1') {
    assert.ok(process.env.KEIOAIC_LLM_API_KEY, 'KEIOAIC_LLM_API_KEY is required for the live test');
    await options.locator('#maxParallelRequests').fill('4');
    await options.locator('#endpoint').fill(DEFAULTS.endpoint);
    await options.locator('#apiKey').fill(process.env.KEIOAIC_LLM_API_KEY);
    await options.locator('#test').click();
    await options.waitForFunction(() => document.getElementById('status').textContent.includes('接続できました'), null, { timeout: 120000 });
    console.log('Live extension connection test:', await options.locator('#status').textContent());
    await action('start', 'bilingual'); state = await complete();
    assert.equal(state.errors, 0, state.message);
    assert.match(await page.locator('#intro > [data-plamo-ui=translation]').textContent(), /[ぁ-んァ-ヶ一-龠]/u);
    await page.screenshot({ path: join(root, 'test-results/live-bilingual.png'), fullPage: true });
    await action('start', 'replace'); state = await complete();
    assert.equal(state.errors, 0, state.message);
    assert.match(await page.locator('#intro').textContent(), /[ぁ-んァ-ヶ一-龠]/u);
    assert.equal(await page.locator('#input').inputValue(), 'PRIVATE FORM VALUE');
    await page.screenshot({ path: join(root, 'test-results/live-replace.png'), fullPage: true });
    await action('restore');
    assert.equal(await page.locator('#intro strong').textContent(), 'world');
    const liveId = crypto.randomUUID();
    await options.evaluate(liveId => chrome.storage.session.set({ [`selection:${liveId}`]: 'This system uses a GPU for fast translation.' }), liveId);
    const liveSelection = await context.newPage();
    await liveSelection.setViewportSize({ width: 500, height: 650 });
    await liveSelection.goto(`chrome-extension://${id}/selection.html?id=${liveId}`);
    await liveSelection.waitForFunction(() => document.getElementById('status').textContent.includes('翻訳できました'), null, { timeout: 120000 });
    assert.match(await liveSelection.locator('#translation').textContent(), /[ぁ-んァ-ヶ一-龠]/u);
    await liveSelection.screenshot({ path: join(root, 'test-results/live-selection.png') });
    console.log('Live extension checks passed: bilingual page, replacement page, restoration, selection translation.');
    if (process.env.PLAMO_LLVM_TEST === '1') {
      await page.goto('https://llvm.org/', { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        window.llvmOriginalHTML = document.body.innerHTML;
        window.llvmAnchors = [...document.querySelectorAll('a')].map(node => [node, node.getAttribute('href')]);
        window.llvmResearchLink = document.querySelector('a[href="pubs/2004-01-30-CGO-LLVM.html"]');
      });
      await page.screenshot({ path: join(root, 'test-results/llvm-before.png'), fullPage: true, caret: 'initial' });
      await action('start', 'replace'); state = await complete();
      await page.screenshot({ path: join(root, 'test-results/llvm-after.png'), fullPage: true, caret: 'initial' });
      await page.pdf({ path: join(root, 'test-results/llvm-after.pdf'), format: 'A4', printBackground: true });
      await writeFile(join(root, 'test-results/llvm-after.txt'), await page.locator('body').innerText());
      console.log('LLVM translation state:', JSON.stringify(state));
      const paragraph = await page.locator('a[href="pubs/2004-01-30-CGO-LLVM.html"]').evaluate(node => node.closest('p').textContent);
      console.log('LLVM research paragraph:', paragraph);
      assert.equal(state.errors, 0, state.message);
      assert.match(paragraph, /イリノイ大学/);
      assert.match(paragraph, /研究\s*プロジェクト/);
      assert.ok(!paragraph.includes('～'), 'Sentence fragments must not produce placeholder gaps');
      assert.ok(await page.evaluate(() => window.llvmAnchors.every(([node, href]) => node.isConnected && node.getAttribute('href') === href)));
      await action('restore');
      await writeFile(join(root, 'test-results/llvm-original.html'), await page.evaluate(() => window.llvmOriginalHTML));
      await writeFile(join(root, 'test-results/llvm-restored.html'), await page.locator('body').innerHTML());
      assert.ok(await page.evaluate(() => document.body.innerHTML === window.llvmOriginalHTML), 'LLVM DOM must restore exactly');
      console.log('LLVM regression passed: natural paragraph, all original links retained, original DOM restored exactly.');
    }
  }
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
