import assert from 'node:assert/strict';
import { Translator } from '../extension/translator.js';
import { DEFAULTS } from '../extension/shared.js';

const apiKey = process.env.KEIOAIC_LLM_API_KEY;
if (!apiKey) throw new Error('KEIOAIC_LLM_API_KEY を環境変数に設定してください。');
const translator = new Translator();
for (const [targetLang, source, check] of [
  ['ja', 'This system uses a GPU for fast translation.', text => /[ぁ-んァ-ヶ一-龠]/u.test(text)],
  ['en', 'このシステムではGPUを使用して高速に翻訳しています。', text => /GPU/i.test(text) && !/[ぁ-んァ-ヶ一-龠]/u.test(text)],
]) {
  const result = await translator.translate(source, { ...DEFAULTS, apiKey, targetLang }, 'smoke');
  assert.ok(check(result), `翻訳先 ${targetLang} の確認に失敗しました。`);
  console.log(`${targetLang}: ${result}`);
}
console.log('実 API のストリーミング翻訳に成功しました。');
