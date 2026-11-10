export const DEFAULTS = Object.freeze({
  endpoint: 'https://llm.keioaic.dev/v1',
  apiKey: '',
  model: 'plamo-3-translate',
  targetLang: 'ja',
  mode: 'bilingual',
  maxParallelRequests: '8',
});
export const LANGUAGES = {
  ja: '日本語', en: '英語', 'zh-hans': '中国語（簡体字）', 'zh-hant': '中国語（繁体字）',
  ko: '韓国語', fr: 'フランス語', de: 'ドイツ語', es: 'スペイン語', it: 'イタリア語',
  ru: 'ロシア語', ar: 'アラビア語', vi: 'ベトナム語', th: 'タイ語',
  id: 'インドネシア語', nl: 'オランダ語', hi: 'ヒンディー語',
};
export function validateSettings(value) {
  const settings = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, value[key] ?? DEFAULTS[key]]));
  if (Object.values(settings).some(value => typeof value !== 'string')) throw new Error('設定の形式が正しくありません。');
  let url;
  try { url = new URL(settings.endpoint.trim()); } catch { throw new Error('API URL が正しくありません。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API URL は認証情報・クエリを含まない HTTP(S) URL を指定してください。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!url.pathname.endsWith('/v1')) throw new Error('API URL は https://llm.keioaic.dev/v1 のように /v1 まで入力してください。');
  settings.endpoint = url.href;
  settings.apiKey = settings.apiKey.trim();
  settings.model = settings.model.trim();
  if (!settings.model || settings.model.length > 200) throw new Error('モデル名を入力してください。');
  if (!LANGUAGES[settings.targetLang]) throw new Error('翻訳先言語を選んでください。');
  if (!['bilingual', 'replace'].includes(settings.mode)) throw new Error('表示方法を選んでください。');
  if (!/^\d+$/.test(settings.maxParallelRequests) || Number(settings.maxParallelRequests) < 1 || Number(settings.maxParallelRequests) > 64) throw new Error('並列アクセス数は 1〜64 の整数で指定してください。');
  return settings;
}
export function originPattern(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
}
export async function rpc(message) {
  // API calls also keep long streaming translations alive in MV3's service worker.
  const heartbeat = setInterval(() => chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {}), 20000);
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '拡張機能と通信できません。拡張を再読み込みしてください。');
    return result;
  } finally { clearInterval(heartbeat); }
}
export function fillLanguages(select) {
  for (const [value, label] of Object.entries(LANGUAGES)) select.add(new Option(label, value));
}
