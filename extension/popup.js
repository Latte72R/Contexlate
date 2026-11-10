import { rpc, fillLanguages } from './shared.js';
const $ = id => document.getElementById(id);
fillLanguages($('targetLang'));
let tabId, timer, busy = false, running = false, actionError = false;
function showStatus(state) {
  if (actionError) return;
  running = state.running;
  $('status').textContent = (state.message ? state.message + '\n' : '') + (state.total ? `${state.running ? '翻訳中' : '翻訳完了'} ${state.done} / ${state.total} 件${state.errors ? `（失敗 ${state.errors} 件）` : ''}` : '');
  $('status').classList.toggle('error', !!state.errors);
  $('translate').disabled = busy || state.running;
  $('stop').disabled = !state.running;
  $('restore').disabled = !state.total;
  $('progress').hidden = !state.total;
  $('progress').max = state.total || 1;
  $('progress').value = state.done;
}
function error(error) { actionError = true; $('status').textContent = error.message; $('status').classList.add('error'); }
async function action(action) {
  return rpc({ type: 'pageAction', tabId, action, mode: document.querySelector('[name=mode]:checked').value, targetLang: $('targetLang').value });
}
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
for (const [id, name] of [['translate', 'start'], ['stop', 'stop'], ['restore', 'restore']]) {
  $(id).addEventListener('click', async () => {
    actionError = false; busy = true; $(id).disabled = true;
    try { const result = await action(name); showStatus(result.state); }
    catch (e) { error(e); }
    finally { busy = false; $('translate').disabled = running; }
  });
}
try {
  const [{ settings }, [tab]] = await Promise.all([rpc({ type: 'settings' }), chrome.tabs.query({ active: true, currentWindow: true })]);
  tabId = tab?.id;
  $('targetLang').value = settings.targetLang;
  document.querySelector(`[name=mode][value="${settings.mode}"]`).checked = true;
  if (!settings.apiKey) throw new Error('はじめに「設定」で API キーを保存してください。');
  $('translate').disabled = false;
  showStatus((await action('status')).state);
  timer = setInterval(async () => {
    if (busy) return;
    try { showStatus((await action('status')).state); } catch { clearInterval(timer); }
  }, 750);
} catch (e) { error(e); }
window.addEventListener('pagehide', () => clearInterval(timer));
