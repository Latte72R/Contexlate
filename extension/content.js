(() => {
  if (globalThis.__plamoTranslator) return;
  globalThis.__plamoTranslator = true;
  const EXCLUDE = 'script,style,noscript,pre,code,kbd,samp,textarea,input,select,option,svg,math,canvas,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[translate="no"],.notranslate,[hidden],[aria-hidden="true"],[data-plamo-ui]';
  const changes = [], additions = [];
  let generation = 0, panel, ui, heartbeat;
  let state = { running: false, done: 0, total: 0, errors: 0, message: '' };
  async function rpc(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '拡張との通信が切れました。ページを再読み込みしてください。');
    return result;
  }
  function visible(element) {
    if (!element || element.closest(EXCLUDE) || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  function eligible(node) { return !!node.data && visible(node.parentElement); }
  function sourceText(node) {
    return ['normal', 'nowrap'].includes(getComputedStyle(node.parentElement).whiteSpace) ? node.data.replace(/[\t\n\f\r ]+/g, ' ') : node.data;
  }
  function blockFor(node) {
    let element = node.parentElement;
    while (element !== document.body && element.parentElement) {
      if (/^(block|flex|grid|list-item|table-cell|flow-root|inline-block|inline-flex|inline-grid)$/.test(getComputedStyle(element).display)) break;
      element = element.parentElement;
    }
    return element;
  }
  const INLINE = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'SPAN', 'SMALL', 'SUP', 'SUB', 'U', 'S', 'DEL', 'INS', 'ABBR', 'ACRONYM', 'CITE', 'Q', 'MARK', 'TIME', 'TT', 'FONT', 'BDI', 'BDO', 'BR', 'WBR', 'IMG']);
  function snapshot(parents) {
    return parents.map(node => ({ node, children: [...node.childNodes].map(child => ({ node: child, text: child.nodeType === 3 ? child.data : null })) }));
  }
  function unchanged(tree) {
    return tree.every(({ node, children }) => node.childNodes.length === children.length && children.every((child, i) => node.childNodes[i] === child.node && (child.text === null || child.node.data === child.text)));
  }
  function markupFor(unit, limit) {
    const elements = [...unit.node.querySelectorAll('*')];
    if (!elements.length || elements.some(node => !INLINE.has(node.tagName) || !visible(node))) return null;
    const texts = new Set(unit.nodes);
    const encode = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    function serialize(node) {
      if (node.nodeType === 3) {
        if (!texts.has(node) && node.data.trim()) throw new Error('Excluded text');
        return encode(sourceText(node));
      }
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase(), id = elements.indexOf(node);
      const open = `<${tag} id="n${id}">`;
      return open + (['br', 'wbr', 'img'].includes(tag) ? '' : [...node.childNodes].map(serialize).join('') + `</${tag}>`);
    }
    const tag = unit.node.tagName === 'P' ? 'p' : 'div';
    let text;
    try { text = `<${tag}>${[...unit.node.childNodes].map(serialize).join('')}</${tag}>`; }
    catch { return null; }
    if (new TextEncoder().encode(text).length > limit) return null;
    return { text, tag, elements, before: snapshot([unit.node, ...elements]) };
  }
  function collect(mode, sourceByteLimit) {
    // shortcut: snapshot the main document; add frame/Shadow DOM traversal when those pages are needed.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const groups = new Map();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!eligible(node)) continue;
      const block = blockFor(node);
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }
    const blocks = [...groups].map(([node, nodes]) => ({ node, nodes, originals: nodes.map(node => node.data), text: nodes.map(sourceText).join('').trim() })).filter(unit => /\p{L}/u.test(unit.text));
    const pageText = blocks.map(unit => unit.text).join('\n\n');
    const contexts = new Map();
    let offset = 0;
    for (const block of blocks) {
      const local = pageText.slice(Math.max(0, offset - 2000), offset + block.text.length + 5000);
      contexts.set(block.node, `${document.title}\n\n${block.text}\n\n${local}\n\n${pageText.slice(0, 4000)}`.slice(0, 30000));
      offset += block.text.length + 2;
    }
    if (mode === 'bilingual') return blocks.map(unit => ({ ...unit, context: contexts.get(unit.node) }));
    const units = [];
    for (const unit of blocks) {
      const context = contexts.get(unit.node);
      const markup = markupFor(unit, sourceByteLimit);
      if (markup) units.push({ ...unit, text: markup.text, markup, context });
      else if (!unit.node.children.length) units.push({ ...unit, context });
      else {
        // shortcut: complex widgets and oversized blocks retain per-node translation with full paragraph context.
        for (const node of unit.nodes) if (/\p{L}/u.test(node.data)) units.push({ node, original: node.data, text: node.data.trim(), context });
      }
    }
    for (const element of document.body.querySelectorAll('[title],[alt],[placeholder],[aria-label]')) {
      // Placeholder text is public UI; form values and password fields are never read.
      const allowedInput = element.matches('input:not([type="password"]):not([type="hidden"]),textarea');
      const inputVisible = allowedInput && !element.parentElement?.closest(EXCLUDE) && !element.matches('[hidden],[aria-hidden="true"],[translate="no"],.notranslate') && element.getClientRects().length && getComputedStyle(element).visibility === 'visible';
      if (!visible(element) && !inputVisible) continue;
      const context = contexts.get(blockFor({ parentElement: element })) || `${document.title}\n\n${pageText.slice(0, 10000)}`;
      for (const attribute of ['title', 'alt', 'placeholder', 'aria-label']) {
        const original = element.getAttribute(attribute);
        if (original && /\p{L}/u.test(original)) units.push({ node: element, attribute, original, text: original.trim(), context });
      }
    }
    return units;
  }
  function applyMarkup(unit, text) {
    const fail = () => { const error = new Error('訳文のリンク・装飾を安全に対応づけられないため、この段落は原文を残しました。'); error.keepGoing = true; throw error; };
    const markup = unit.markup;
    const source = text.trim().replace(/^```(?:html)?\s*\n([\s\S]*?)\n```$/i, '$1');
    // Parse in an unmounted template so even rejected image/resource URLs cannot load.
    const template = document.createElement('template');
    template.innerHTML = source;
    const fragment = template.content, root = fragment.firstElementChild;
    if (fragment.children.length !== 1 || root?.tagName.toLowerCase() !== markup.tag || root.attributes.length || [...fragment.childNodes].some(node => node.nodeType === 3 && node.data.trim())) fail();
    const seen = new Set();
    function validate(parent) {
      for (const child of parent.childNodes) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1 || child.attributes.length !== 1 || !/^n\d+$/.test(child.id)) fail();
        const index = Number(child.id.slice(1)), original = markup.elements[index];
        if (!original || seen.has(index) || original.tagName !== child.tagName) fail();
        const originalParent = original.parentElement;
        const expectedParent = child.parentElement === root ? unit.node : markup.elements[Number(child.parentElement.id.slice(1))];
        if (originalParent !== expectedParent) fail();
        seen.add(index); validate(child);
      }
    }
    validate(root);
    if (seen.size !== markup.elements.length) fail();
    if (!unchanged(markup.before)) return;
    function children(parent, liveParent) {
      const texts = [...liveParent.childNodes].filter(node => node.nodeType === 3);
      return [...parent.childNodes].map(child => {
        if (child.nodeType === 3) {
          const node = texts.shift() || document.createTextNode('');
          node.data = child.data;
          return node;
        }
        const original = markup.elements[Number(child.id.slice(1))];
        original.replaceChildren(...children(child, original));
        return original;
      });
    }
    unit.node.replaceChildren(...children(root, unit.node));
    changes.push({ markup: true, before: markup.before, after: snapshot([unit.node, ...markup.elements]) });
  }
  function ensurePanel() {
    if (panel?.isConnected) return;
    panel = document.createElement('div');
    panel.setAttribute('data-plamo-ui', '');
    panel.style.cssText = 'all:initial!important;position:fixed!important;left:20px!important;bottom:20px!important;z-index:2147483647!important;display:block!important;';
    ui = panel.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:light}section{font:14px/1.5 system-ui,sans-serif;background:#fff;color:#20302c;border:1px solid #c7d7ce;border-radius:12px;box-shadow:0 6px 25px #0002;padding:14px 16px;width:300px;max-width:calc(100vw - 72px)}strong{font-size:13px;color:#23624d}p{margin:6px 0 10px;overflow-wrap:anywhere}nav{display:flex;gap:8px}button{font:inherit;border:1px solid #c7d7ce;background:#f4f7f4;border-radius:6px;color:#20302c;padding:5px 10px;cursor:pointer}button:focus-visible{outline:3px solid #23624d}button:disabled{opacity:.5;cursor:default}';
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'PLaMo 翻訳');
    const heading = document.createElement('strong'); heading.textContent = 'PLaMo Translate';
    const status = document.createElement('p'); status.id = 'status'; status.setAttribute('role', 'status');
    const nav = document.createElement('nav');
    for (const [label, action, id] of [['中止', stop, 'stop'], ['原文に戻す', restore, 'restore'], ['閉じる', () => panel.remove(), 'close']]) {
      const button = document.createElement('button'); button.textContent = label; button.id = id;
      button.addEventListener('click', action); nav.append(button);
    }
    section.append(heading, status, nav); ui.append(style, section); document.documentElement.append(panel);
  }
  function update() {
    ensurePanel();
    ui.getElementById('status').textContent = state.message || `${state.running ? '翻訳中' : '翻訳完了'} ${state.done} / ${state.total} 件${state.errors ? `（失敗 ${state.errors} 件）` : ''}`;
    ui.getElementById('stop').disabled = !state.running;
  }
  function stop() {
    generation++;
    state.running = false;
    state.message = '中止しました。翻訳済みの部分はそのまま表示しています。';
    clearInterval(heartbeat);
    rpc({ type: 'cancel' }).catch(() => {});
    update();
  }
  function restore() {
    generation++;
    clearInterval(heartbeat);
    rpc({ type: 'cancel' }).catch(() => {});
    for (const change of changes) {
      if (change.markup) {
        if (unchanged(change.after)) for (const parent of change.before) parent.node.replaceChildren(...parent.children.map(child => {
          if (child.text !== null) child.node.data = child.text;
          return child.node;
        }));
        continue;
      }
      const current = change.attribute ? change.node.getAttribute(change.attribute) : change.node.data;
      if (current !== change.translated) continue;
      if (change.attribute) change.node.setAttribute(change.attribute, change.original);
      else change.node.data = change.original;
    }
    changes.length = 0;
    for (const node of additions) node.remove();
    additions.length = 0;
    state = { running: false, done: 0, total: 0, errors: 0, message: '原文に戻しました。' };
    update();
  }
  function apply(unit, text, mode, targetLang) {
    if (!unit.node.isConnected) return;
    if (mode === 'replace') {
      if (unit.markup) { applyMarkup(unit, text); return; }
      if (unit.nodes) {
        if (unit.nodes.some((node, i) => !node.isConnected || node.data !== unit.originals[i])) return;
        const first = unit.nodes.findIndex(node => node.data.trim());
        unit.nodes.forEach((node, i) => apply({ node, original: unit.originals[i] }, i === first ? text : '', mode, targetLang));
        return;
      }
      const current = unit.attribute ? unit.node.getAttribute(unit.attribute) : unit.node.data;
      if (current !== unit.original) return;
      const leading = unit.original.match(/^\s*/u)[0], trailing = unit.original.match(/\s*$/u)[0];
      const translated = leading + text.trim() + trailing;
      if (unit.attribute) unit.node.setAttribute(unit.attribute, translated);
      else unit.node.data = translated;
      changes.push({ ...unit, translated });
    } else {
      if (unit.nodes.some((node, i) => !node.isConnected || node.data !== unit.originals[i])) return;
      const translation = document.createElement('span');
      translation.setAttribute('data-plamo-ui', 'translation');
      translation.lang = targetLang;
      translation.dir = 'auto';
      translation.style.cssText = 'display:block!important;margin-block-start:.4em!important;font-size:.95em!important;line-height:1.65!important;font-weight:normal!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;';
      translation.textContent = text;
      unit.node.append(translation);
      additions.push(translation);
    }
  }
  async function start(mode, targetLang, sourceByteLimit, maxParallelRequests = 4) {
    if (!['bilingual', 'replace'].includes(mode) || typeof targetLang !== 'string') throw new Error('表示方法と言語を選んでください。');
    restore();
    const current = generation;
    const units = collect(mode, sourceByteLimit);
    // Finish the whole page, but let readers see the current viewport translated first.
    const ranks = new Map(units.map(unit => {
      const element = unit.node.nodeType === 3 ? unit.node.parentElement : unit.node;
      const rect = element.getBoundingClientRect();
      return [unit, rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth ? 0 : 1];
    }));
    units.sort((a, b) => ranks.get(a) - ranks.get(b));
    state = { running: true, done: 0, total: units.length, errors: 0, message: '' };
    update();
    if (!units.length) { state.running = false; state.message = '翻訳できるテキストが見つかりません。'; update(); return; }
    heartbeat = setInterval(() => rpc({ type: 'ping' }).catch(() => {}), 20000);
    let index = 0;
    const pending = new Map();
    async function worker() {
      while (current === generation && index < units.length) {
        const unit = units[index++];
        try {
          const key = unit.text + '\0' + unit.context;
          if (!pending.has(key)) pending.set(key, rpc({ type: 'translate', text: unit.text, targetLang, context: unit.context }));
          const result = await pending.get(key);
          if (current !== generation) return;
          apply(unit, result.text, mode, targetLang);
          state.done++;
        } catch (error) {
          if (current !== generation) return;
          state.errors++;
          state.done++;
          state.message = `${error.message}（${state.done} / ${state.total} 件、失敗 ${state.errors} 件）`;
          // Stop scheduling after an API failure; already completed translations remain restorable.
          if (!error.keepGoing) index = units.length;
        }
        if (current === generation) update();
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxParallelRequests, units.length) }, worker));
    if (current !== generation) return;
    clearInterval(heartbeat);
    state.running = false;
    update();
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'plamoPage') return;
    try {
      if (message.action === 'start') start(message.mode, message.targetLang, message.sourceByteLimit, message.maxParallelRequests).catch(error => { state.running = false; state.message = error.message; clearInterval(heartbeat); update(); });
      else if (message.action === 'stop') stop();
      else if (message.action === 'restore') restore();
      respond({ ok: true, state: { ...state } });
    } catch (error) { respond({ ok: false, error: error.message }); }
  });
})();
