import { DEFAULTS, validateSettings, originPattern, rpc, fillLanguages } from './shared.js';
const $ = id => document.getElementById(id);
fillLanguages($('targetLang'));
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function save(test) {
  try {
    const settings = validateSettings(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, $(key).value])));
    if (!settings.apiKey) throw new Error('API キーを入力してください。');
    // Request permission directly from this click/submit gesture, before other asynchronous work.
    const granted = await chrome.permissions.request({ origins: [originPattern(settings.endpoint)] });
    if (!granted) throw new Error('API 接続先へのアクセスが許可されませんでした。');
    $('save').disabled = $('test').disabled = true;
    await rpc({ type: 'saveSettings', settings });
    if (!test) { status('設定を保存しました。'); return; }
    status('接続テスト中…');
    const result = await rpc({ type: 'translate', bypassCache: true, text: 'This system uses a GPU for fast translation.', targetLang: settings.targetLang });
    status(`接続できました。\n${result.text}`);
  } catch (error) { status(error.message, true); }
  finally { $('save').disabled = $('test').disabled = false; }
}
$('form').addEventListener('submit', event => { event.preventDefault(); save(false); });
$('test').addEventListener('click', () => { if ($('form').reportValidity()) save(true); });
$('clearCache').addEventListener('click', async () => {
  $('clearCache').disabled = true;
  try { await rpc({ type: 'clearCache' }); status('翻訳キャッシュを削除しました。'); }
  catch (error) { status(error.message, true); }
  finally { $('clearCache').disabled = false; }
});
try {
  const { settings } = await rpc({ type: 'settings' });
  for (const key of Object.keys(DEFAULTS)) $(key).value = settings[key];
} catch (error) { status(error.message, true); }
