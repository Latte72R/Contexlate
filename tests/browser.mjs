import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../extension/shared.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'test-results'), { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'plamo-test-'));
const requests = [];
let active = 0, maximum = 0, delay = 5, failure = false;
let markupMode = 'normal';
let unexpectedResources = 0;
const boltIdAsHref = JSON.parse(await readFile(join(root, 'tests/fixtures/bolt-id-as-href.json'), 'utf8'));
const bolt = JSON.parse(await readFile(join(root, 'tests/fixtures/bolt.json'), 'utf8'));
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
  if (source === bolt.source) content = markupMode === 'bolt-id-as-href' ? boltIdAsHref.translation : markupMode === 'bolt-parent'
    ? bolt.translation.replace('<b id="n0"> <a id="n1">BOLT</a></b>', '<a id="n1"><b id="n0">BOLT</b></a>')
    : bolt.translation;
  if (source.startsWith('<p>Hello <strong')) {
    if (markupMode === 'unwrapped') content = '詳細は<a id="n1">資料</a>へ。<strong id="n0">世界</strong>、こんにちは。';
    if (markupMode === 'reorder') content = '<p>詳細は<a id="n1">資料</a>へ。<strong id="n0">世界</strong>、こんにちは。</p>';
    if (markupMode === 'missing') content = '<p>リンクを失った訳文。</p>';
    if (markupMode === 'attribute') content = '<p><strong id="n0">世界</strong><a id="n1" href="javascript:alert(1)">資料</a></p>';
    if (markupMode === 'script') content = '<p><strong id="n0">世界</strong><a id="n1">資料</a><script>window.pwned=true</script></p>';
    if (markupMode === 'href-duplicate') content = '<p><strong id="n0">世界</strong><a href="n1">資料</a><a href="n1">重複</a></p>';
    if (markupMode === 'href-extra') content = '<p><strong id="n0">世界</strong><a href="n1" onclick="window.pwned=true">資料</a></p>';
    if (markupMode === 'href-url') content = '<p><strong id="n0">世界</strong><a href="https://example.com/">資料</a></p>';
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
  await options.waitForFunction(() => document.getElementById('model').value === 'plamo-3-translate');
  assert.equal(await options.locator('#targetLang option[value=en]').textContent(), '英語');
  assert.equal(await options.locator('.brand .wordmark').textContent(), 'Contexlate');
  assert.equal(await options.getByRole('heading', { level: 1 }).textContent(), '翻訳の設定');
  assert.equal(requests.length, 0);
  assert.equal(await options.locator('#endpoint').inputValue(), '');
  await options.locator('#endpoint').fill(`${endpoint}/v1/`);
  await options.locator('#apiKey').fill('test-only-key');
  assert.equal(await options.locator('#maxParallelRequests').inputValue(), '1');
  await options.locator('#maxParallelRequests').fill('6');
  await options.locator('#test').click();
  await options.waitForFunction(() => document.getElementById('status').textContent.includes('接続できました'), null, { timeout: 10000 }).catch(async error => {
    throw new Error(`${error.message}; status=${await options.locator('#status').textContent()}; pageErrors=${JSON.stringify(errors)}; requests=${requests.length}`);
  });
  const send = message => options.evaluate(message => chrome.runtime.sendMessage(message), message);
  const cacheStart = requests.length;
  await send({ type: 'translate', text: 'Cache test', targetLang: 'ja' });
  await send({ type: 'translate', text: 'Cache test', targetLang: 'ja' });
  assert.equal(requests.length, cacheStart + 1);
  await send({ type: 'translate', text: 'Cache test', targetLang: 'ja', bypassCache: true });
  assert.equal(requests.length, cacheStart + 2);
  await options.locator('#clearCache').click();
  await options.waitForFunction(() => document.getElementById('status').textContent.includes('キャッシュを削除しました'));
  await send({ type: 'translate', text: 'Cache test', targetLang: 'ja' });
  assert.equal(requests.length, cacheStart + 3);
  const page = await context.newPage();
  const domSession = await context.newCDPSession(page);
  async function panelNode(name) {
    const { root } = await domSession.send('DOM.getDocument', { depth: -1, pierce: true });
    const nodes = [root];
    while (nodes.length) {
      const node = nodes.pop();
      if (node.nodeName === name) return node;
      nodes.push(...(node.children || []), ...(node.shadowRoots || []));
    }
    throw new Error('Progress panel not found');
  }
  async function panelStatus() { return (await panelNode('P')).children?.map(child => child.nodeValue).join('') || ''; }
  async function checkProgress(state) {
    const attributes = (await panelNode('PROGRESS')).attributes;
    assert.equal(Number(attributes[attributes.indexOf('max') + 1]), state.total || 1);
    assert.equal(Number(attributes[attributes.indexOf('value') + 1]), state.done);
    assert.equal(attributes.includes('hidden'), !state.total);
    assert.ok(attributes.includes('翻訳の進捗'));
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(endpoint);
  const tabs = await options.evaluate(() => chrome.tabs.query({}));
  const tabId = tabs.find(tab => tab.url === `${endpoint}/`).id;
  const action = async (action, mode = 'bilingual') => {
    if (action === 'start') await send({ type: 'clearCache' });
    return send({ type: 'pageAction', tabId, action, mode, targetLang: 'ja' });
  };
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
  await checkProgress(state);
  assert.equal(state.errors, 0); assert.equal(state.done, state.total);
  await page.screenshot({ path: join(root, 'test-results/page-panel.png'), fullPage: true });
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
  await checkProgress((await action('status')).state);
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
  await checkProgress(state);
  assert.equal(state.running, false); assert.match(state.message, /中止/);
  await action('restore'); delay = 5;
  const selectionId = crypto.randomUUID();
  await options.evaluate(({ selectionId }) => chrome.storage.session.set({ [`selection:${selectionId}`]: 'Selected text only' }), { selectionId });
  const selection = await context.newPage();
  await selection.setViewportSize({ width: 500, height: 650 });
  await selection.goto(`chrome-extension://${id}/selection.html?id=${selectionId}`);
  await selection.waitForFunction(() => document.getElementById('status').textContent.includes('翻訳できました'));
  assert.equal(await selection.locator('#translation').textContent(), '訳：Selected text only');
  assert.equal(await selection.locator('#copy').getAttribute('class'), 'primary');
  assert.equal(await selection.locator('#copy').evaluate(node => getComputedStyle(node).color), 'rgb(255, 255, 255)');
  assert.ok(await selection.locator('#copy').isEnabled());
  assert.equal(await selection.locator('#retry').getAttribute('class'), 'secondary');
  assert.equal(await selection.locator('#targetLang option[value=fr]').textContent(), 'フランス語');
  for (const screen of [options, selection]) {
    assert.match(await screen.locator('.legal').textContent(), /© 2026 Latte72/);
    assert.equal(await screen.getByRole('link', { name: 'MITライセンスを開く' }).getAttribute('href'), 'https://github.com/Latte72R/Contexlate/blob/main/LICENSE');
    assert.ok(await screen.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Extension UI must fit its viewport');
  }
  await selection.screenshot({ path: join(root, 'test-results/selection.png') });
  await options.screenshot({ path: join(root, 'test-results/options.png'), fullPage: true });
  await options.setViewportSize({ width: 360, height: 780 });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Settings must fit narrow windows');
  await options.screenshot({ path: join(root, 'test-results/options-mobile.png'), fullPage: true });
  await options.setViewportSize({ width: 1280, height: 900 });
  await selection.close();
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('targetLang').value === 'ja');
  assert.match(await popup.locator('.legal').textContent(), /© 2026 Latte72/);
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await popup.evaluate(() => document.body.scrollHeight <= 600), 'Popup must fit Chrome popup height without scrolling in its idle state');
  await popup.locator('input[value=replace]').focus();
  assert.equal(await popup.locator('input[value=replace]').evaluate(node => getComputedStyle(node.closest('label')).outlineStyle), 'solid');
  await popup.locator('input[value=replace]').blur();
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
  for (const mode of ['missing', 'attribute', 'script', 'duplicate', 'parent', 'image', 'unwrapped', 'href-duplicate', 'href-extra', 'href-url']) {
    markupMode = mode;
    const requestStart = requests.length;
    await action('start', 'replace'); state = await complete();
    assert.equal(state.errors, 1);
    await checkProgress(state);
    const panelText = await panelStatus();
    assert.ok(panelText.includes(`翻訳完了 ${state.done} / ${state.total} 件（失敗 1 件）`), panelText);
    if (mode === 'attribute') assert.match(state.message, /余分な属性: A#n1 \(href\)/);
    if (mode === 'script') assert.match(state.message, /要素IDの欠落: SCRIPT/);
    if (mode === 'parent') {
      assert.match(state.message, /親子関係変更/);
      await options.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
      await popup.reload();
      await popup.waitForFunction(state => document.getElementById('status').textContent.includes(`翻訳完了 ${state.done} / ${state.total} 件（失敗 1 件）`), state);
    }
    if (mode === 'missing') {
      const beforeRepeat = requests.length;
      await send({ type: 'pageAction', tabId, action: 'start', mode: 'replace', targetLang: 'ja' });
      state = await complete();
      assert.equal(state.errors, 1);
      assert.equal(requests.slice(beforeRepeat).filter(body => body.messages[0].content.startsWith('<p>Hello')).length, 1, 'Invalid markup must not stay cached');
    }
    assert.equal(state.done, state.total, 'A malformed paragraph must not stop the rest of the page');
    assert.equal(await page.locator('#intro').innerHTML(), originalIntro);
    assert.equal(await page.locator('[data-plamo-ui="translation"]').count(), 0);
    assert.equal(requests.slice(requestStart).filter(body => body.messages[0].content.startsWith('<p>Hello')).length, mode === 'missing' ? 2 : 1, 'Do not retry malformed markup');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await action('restore');
  }
  await page.evaluate(source => {
    const wrapper = document.createElement('article');
    wrapper.id = 'bolt-fixture'; wrapper.innerHTML = source;
    wrapper.querySelector('a').href = '#bolt-docs';
    document.body.append(wrapper);
  }, bolt.source);
  const boltOriginal = await page.locator('#bolt-fixture').innerHTML();
  markupMode = 'normal';
  await action('start', 'replace'); state = await complete();
  assert.equal(state.errors, 0);
  assert.match(await page.locator('#bolt-fixture').textContent(), /ポストリンクオプティマイザ/);
  await action('restore');
  assert.equal(await page.locator('#bolt-fixture').innerHTML(), boltOriginal);
  markupMode = 'bolt-id-as-href';
  await action('start', 'replace'); state = await complete();
  assert.equal(state.errors, 0, state.message);
  assert.match(await page.locator('#bolt-fixture').textContent(), /リンク後オプティマイザ/);
  assert.equal(await page.locator('#bolt-fixture a').getAttribute('href'), '#bolt-docs');
  await action('restore');
  assert.equal(await page.locator('#bolt-fixture').innerHTML(), boltOriginal);
  markupMode = 'bolt-parent';
  await action('start', 'replace'); state = await complete();
  assert.equal(state.errors, 1);
  assert.match(state.message, /親子関係変更: n1/);
  assert.equal(await page.locator('#bolt-fixture').innerHTML(), boltOriginal);
  await action('restore');
  await page.locator('#bolt-fixture').evaluate(node => node.remove());
  markupMode = 'reorder';
  await action('start', 'replace'); await complete();
  await page.evaluate(() => { window.originalStrongText.data = 'Updated by application'; });
  assert.equal(await page.locator('#intro strong').textContent(), 'Updated by application');
  await action('restore');
  assert.equal(await page.locator('#intro strong').textContent(), 'Updated by application');
  markupMode = 'normal';
  await page.reload();
  await page.evaluate(() => {
    const section = document.createElement('section'); section.id = 'grouped';
    section.innerHTML = '<h2>Grouped heading</h2><div><p>Grouped context one with <a href="#one">a link</a>.</p><p>Grouped context two refers to the first.</p></div>';
    document.body.append(section);
    window.groupedLink = section.querySelector('a');
    window.groupedParagraphs = [...section.querySelectorAll('p')];
    const large = document.createElement('div'); large.id = 'large-group';
    for (const name of ['LongAlpha', 'LongBeta']) {
      const child = document.createElement('div');
      for (let i = 0; i < 2; i++) {
        const p = document.createElement('p'); p.textContent = name + ' text '.repeat(300);
        child.append(p);
      }
      large.append(child);
    }
    document.body.append(large);
  });
  const groupedOriginal = await page.locator('#grouped').innerHTML();
  const largeOriginal = await page.locator('#large-group').innerHTML();
  const beforeGrouping = requests.length;
  await action('start', 'replace'); state = await complete();
  assert.equal(state.errors, 0, state.message);
  const groupedRequests = requests.slice(beforeGrouping).filter(body => body.messages[0].content.includes('Grouped context'));
  assert.equal(groupedRequests.length, 1, 'A fitting section must be translated as one source');
  assert.ok(groupedRequests[0].messages[0].content.includes('Grouped context one') && groupedRequests[0].messages[0].content.includes('Grouped context two'));
  assert.ok(groupedRequests[0].messages[0].content.includes('<h2 id='));
  assert.ok(await page.evaluate(() => window.groupedLink === document.querySelector('#grouped a') && window.groupedParagraphs.every(p => p.isConnected)));
  const largeRequests = requests.slice(beforeGrouping).filter(body => /LongAlpha|LongBeta/.test(body.messages[0].content));
  assert.equal(largeRequests.length, 2, 'An oversized container must split into fitting child containers');
  for (const body of [...groupedRequests, ...largeRequests]) assert.ok(new TextEncoder().encode(body.messages[0].content).length <= 6000);
  await action('restore');
  assert.equal(await page.locator('#grouped').innerHTML(), groupedOriginal);
  assert.equal(await page.locator('#large-group').innerHTML(), largeOriginal);
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
    assert.ok(process.env.PLAMO_API_BASE, 'PLAMO_API_BASE is required for the live test');
    await options.locator('#endpoint').fill(process.env.PLAMO_API_BASE);
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
