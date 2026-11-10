export const CHUNK_SIZE = 6000;
export const INPUT_BYTE_LIMIT = 14000;
export function clipUtf8(text, limit) {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, Math.max(0, limit)), { stream: true });
}
export function splitText(text, limit = CHUNK_SIZE) {
  const chunks = [];
  const chars = Array.from(text);
  const encoder = new TextEncoder();
  let start = 0;
  while (start < chars.length) {
    let end = start, bytes = 0;
    while (end < chars.length) {
      const size = encoder.encode(chars[end]).length;
      if (bytes + size > limit) break;
      bytes += size; end++;
    }
    if (end === start) throw new Error('分割サイズが小さすぎます。');
    for (let i = end - 1; end < chars.length && i >= start + Math.floor((end - start) / 2); i--) {
      if (/[\s。！？.!?]/u.test(chars[i])) { end = i + 1; break; }
    }
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

export function requestBody(text, settings, context = '') {
  const reference = clipUtf8(context, INPUT_BYTE_LIMIT - new TextEncoder().encode(text).length);
  return {
    model: settings.model,
    messages: [{ role: 'user', content: text }],
    temperature: 0,
    max_tokens: 8192,
    stream: true,
    // extra_body in the OpenAI SDK is merged into the top level of the HTTP body.
    chat_template_kwargs: { target_lang: settings.targetLang, ...(reference ? { context: reference } : {}) },
  };
}

async function readTranslation(response) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json();
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('訳文が出力上限に達しました。短い範囲を選んで再試行してください。');
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('API が空、または不正な訳文を返しました。');
    return choice.message.content;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', output = '', finished = false;
  function line(value) {
    if (!value.startsWith('data:')) return;
    const payload = value.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { finished = true; return; }
    const data = JSON.parse(payload);
    if (data.error) throw new Error('API がストリーム中にエラーを返しました。');
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('訳文が出力上限に達しました。短い範囲を選んで再試行してください。');
    if (choice?.finish_reason === 'stop') finished = true;
    const content = choice?.delta?.content;
    if (typeof content === 'string') output += content;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const value of lines) line(value);
      if (done) { line(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!finished || !output.trim()) throw new Error('訳文の受信が途中で終了しました。再試行してください。');
  return output;
}

export class Translator {
  active = 0;
  concurrency = 4;
  queue = [];
  tasks = new Set();
  constructor(fetchImpl = fetch.bind(globalThis)) { this.fetch = fetchImpl; }
  setConcurrency(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('並列アクセス数は 1〜64 の整数で指定してください。');
    this.concurrency = limit;
    this.drain();
  }
  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      this.active++;
      this.queue.shift()();
    }
  }
  cancel(owner) {
    for (const task of this.tasks) if (task.owner === owner) task.controller.abort();
  }
  async translate(text, settings, owner, context = '') {
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('翻訳する文字数は 1〜100,000 文字にしてください。');
    if (typeof context !== 'string' || context.length > 100000) throw new Error('翻訳の参照文脈が不正です。');
    if (!settings.apiKey) throw new Error('設定画面で API キーを保存してください。');
    const task = { owner, controller: new AbortController() };
    this.tasks.add(task);
    let result = '';
    try {
      for (const chunk of splitText(text)) {
        task.controller.signal.throwIfAborted();
        const translated = await this.run(chunk, settings, task.controller.signal, context || (chunk !== text ? text : ''));
        const leading = chunk.match(/^\s*/u)[0], trailing = chunk.match(/\s*$/u)[0];
        if (result && !/\s$/u.test(result) && !leading) result += '\n';
        result += leading + translated.trim() + trailing;
      }
      return result;
    } catch (error) {
      if (task.controller.signal.aborted) throw new Error('翻訳を中止しました。');
      throw error;
    } finally { this.tasks.delete(task); }
  }
  async run(text, settings, signal, context) {
    if (this.active >= this.concurrency) {
      await new Promise((resolve, reject) => {
        const entry = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.queue.splice(this.queue.indexOf(entry), 1); reject(new Error('翻訳を中止しました。')); };
        this.queue.push(entry);
        signal.addEventListener('abort', abort, { once: true });
      });
    } else { this.active++; }
    let headerTimer, timeout;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      headerTimer = setTimeout(abort, 25000);
      timeout = setTimeout(abort, 120000);
      const response = await this.fetch(`${settings.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(text, settings, context)),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
      clearTimeout(headerTimer);
      if (!response.ok) {
        const hint = { 401: 'API キーを確認してください。', 403: 'API のアクセス権を確認してください。', 429: '混雑しています。しばらく待って再試行してください。', 503: 'モデルが起動中、または利用できません。' }[response.status] || '接続先とモデル名を確認してください。';
        await response.body?.cancel();
        throw new Error(`API エラー (${response.status})。${hint}`);
      }
      return await readTranslation(response);
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new Error('API の応答がタイムアウトしました。モデルの起動後に再試行してください。');
      if (error instanceof TypeError) throw new Error('API に接続できません。URL・ネットワーク・接続権限を確認してください。');
      throw error;
    } finally {
      clearTimeout(headerTimer); clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      this.active--;
      this.drain();
    }
  }
}
