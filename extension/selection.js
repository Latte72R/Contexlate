import { rpc, fillLanguages } from './shared.js';
const $ = id => document.getElementById(id);
fillLanguages($('targetLang'));
let text = '', generation = 0;
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function translate() {
  const current = ++generation;
  $('retry').disabled = $('targetLang').disabled = true;
  $('stop').disabled = false; $('copy').disabled = true;
  $('retry').className = 'primary'; $('copy').className = 'secondary';
  $('translation').textContent = '';
  status('翻訳中…');
  try {
    const result = await rpc({ type: 'translate', text, targetLang: $('targetLang').value });
    if (current !== generation) return;
    $('translation').textContent = result.text;
    $('copy').disabled = false;
    $('copy').className = 'primary'; $('retry').className = 'secondary';
    status('翻訳できました。');
  } catch (error) { if (current === generation) status(error.message, true); }
  finally {
    if (current === generation) { $('retry').disabled = $('targetLang').disabled = false; $('stop').disabled = true; }
  }
}
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('retry').addEventListener('click', translate);
$('targetLang').addEventListener('change', translate);
$('stop').addEventListener('click', async () => {
  generation++;
  $('retry').disabled = $('targetLang').disabled = false; $('stop').disabled = true;
  status('翻訳を中止しました。');
  await rpc({ type: 'cancel' }).catch(error => status(error.message, true));
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('translation').textContent); status('訳文をコピーしました。'); }
  catch { status('コピーできませんでした。訳文を選択してコピーしてください。', true); }
});
window.addEventListener('pagehide', () => { chrome.runtime.sendMessage({ type: 'cancel' }).catch(() => {}); });
try {
  const [{ settings }, selection] = await Promise.all([rpc({ type: 'settings' }), rpc({ type: 'selection', id: new URL(location.href).searchParams.get('id') })]);
  text = selection.text;
  $('original').textContent = text;
  $('targetLang').value = settings.targetLang;
  await translate();
} catch (error) { status(error.message, true); }
