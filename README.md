# PLaMo Translate — Chrome 拡張

PLaMo 3 Translate 8B と OpenAI 互換 API を使う Manifest V3 拡張です。拡張本体は依存ライブラリ・ビルド不要です。

- **原文の下に併記**：段落や見出しごとに訳文を追加します。
- **ページ全体を翻訳**：元の DOM を残し、文字と画像の代替テキスト・ツールチップなどを置き換えます。
- **選択文翻訳**：文字を選択 → 右クリック →「PLaMo で選択部分を翻訳」。独立した小さなウィンドウで表示します。
- 翻訳先の表示名はすべて日本語です。中止・原文への復元・設定・接続テストを備えています。

## Windows の Chrome に入れる

1. `dist/plamo-translate.zip` を Windows 側の任意のフォルダーに展開します。ZIP は `npm run pack` でも作れます。
2. Chrome で `chrome://extensions` を開き、「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で、展開した **manifest.json のあるフォルダー** を選びます。
4. 拡張の「設定」を開き、API キーを入力して「保存して接続テスト」を押します。
5. Web ページを開き、拡張アイコンから言語・表示方法を選んで「このページを翻訳」を押します。

WSL 内の `dist` をエクスプローラーで開くには、通常の WSL ターミナルで次を実行できます。

```bash
cd /home/latte/translator
explorer.exe "$(wslpath -w "$PWD/dist")"
```

WSL の `extension` フォルダーを Windows から開いて読み込むこともできます。ZIP を Windows に展開した場合、更新時は再展開して拡張画面の「再読み込み」を押してください。

### 既定の接続先

| 設定 | 値 |
| --- | --- |
| API URL | `https://llm.keioaic.dev/v1` |
| モデル | `plamo-3-translate-8b` |
| 翻訳先 | 日本語 |
| 表示 | 原文の下に併記 |
| API キー | 設定画面から入力 |

API URL は `/v1` まで入力すると、拡張が `/chat/completions` を付けて通信します。従来の `/v1/chat/completions` までの入力も受け付け、保存済みの設定もそのまま使えます。

Chrome はシェルの環境変数を読みません。`KEIOAIC_LLM_API_KEY` の**値**を設定画面に貼り付けてください。テスト用キーも配布物には含めていません。

## 翻訳の仕組み

API 通信はバックグラウンドの service worker が担当します。同時リクエストは複数タブ・選択文翻訳を含めて合計で設定した並列アクセス数まで（既定 **4 件**、設定可能範囲 **1〜64 件**）。設定を下げた場合、進行中の通信は完了させ、新しい通信から制限します。翻訳対象は最大 6,000 UTF-8 バイトごとのまとまりにし、`temperature: 0`、`max_tokens: 8192` で送ります。出力上限や途中切断はエラーにし、不完全な訳文を適用しません。

各リクエストには PLaMo 固有の `chat_template_kwargs.context` で、ページのタイトル、対象段落、周囲の本文、ページ冒頭を参照文脈として渡します。入力本文と文脈の合計を最大 14,000 UTF-8 バイトに収め、入力上限 16,384 トークンとテンプレート分の余裕を確保します。出力は最大 8,192 トークンで、合計 32,768 トークンの範囲に収めます。参照文脈にも、フォーム入力や非表示要素を含めません。

`stream: true` で受信し、応答ヘッダーは 25 秒、1 リクエスト全体は 120 秒でタイムアウトします。長い翻訳中は通信を継続して MV3 の idle 終了を防ぎます。実行時に画面内の段落を優先し、画面外も含めて翻訳が完了した単位から順にページへ反映します。

翻訳先は HTTP ボディ直下の `chat_template_kwargs.target_lang` で指定します。2026-11-11 に実 API で、直下の指定と、提示された curl の `extra_body.chat_template_kwargs` の両方がフランス語出力になることを確認しました。

### 段落を分断せず、リンク・装飾を保つ

[PLaMo の公式仕様](https://huggingface.co/pfnet/plamo-3-translate-8b#translation-options)に従って、参照文脈は `context` 引数で渡し、翻訳する本文と分けます。

置き換えモードは、リンクや太字を含む段落をまとめて、最小限の HTML と要素 ID で翻訳します。翻訳後の要素 ID・タグ・親子関係が元と一致することを検証し、**元のリンク・装飾要素とテキストノードを再利用**して訳文を反映します。日本語の自然な語順に合わせて同じ親の中で要素を並べ替えますが、リンク先・CSS クラス・イベントリスナーなどの元の属性と動作は維持します。原文に戻すと、元のテキストノードと要素順も復元します。

モデルから返された HTML をそのまま挿入しません。元にないタグ・属性、リンクの欠落・重複、親子関係の変更があれば、その段落は原文のまま残してエラーを表示し、他の段落の翻訳を続けます。併記モードはまとまった段落をプレーンテキストとして翻訳します。

入力欄などを含む複雑なブロックや、6,000 バイトを超える装飾付きのブロックは、元の DOM を保持するためテキストノードごとに翻訳します。この場合も段落全体と前後の本文を参照文脈として渡します。

類似拡張の調査と採用理由は [実装比較](docs/translation-design.md) にまとめています。

### 対象と制限

- 対象は実行時点で表示されているメイン文書のテキストです。後から追加・変更された内容は再度「翻訳」を押すと取り込みます。
- 入力値、パスワード、編集領域、コードブロック、非表示要素、`translate="no"` は対象外です。入力欄の公開プレースホルダーは置き換えモードの対象です。
- iframe、Shadow DOM、画像に描かれた文字、Canvas、PDF ビューアーのページ全体翻訳には対応しません。Chrome の内部ページ・Chrome ウェブストアなど、スクリプトを挿入できないページも対象外です。
- ページの HTML/CSS は保持しますが、訳文の文字数による折り返し・高さ・レイアウトの変化はあります。
- 原文に戻す操作は、この拡張が書いた値と一致する部分だけを戻します。サイト側が更新した新しい内容を上書きしません。
- ページ翻訳は入力欄を除外しますが、本文自体に機密情報があれば送信対象です。選択文翻訳は選択した文字だけを送ります。

### 権限と保存

`activeTab` でユーザーが操作したタブにのみアクセスします。既定 API のドメインへの接続権限を持ち、別の API に変えたときは Chrome がそのホストへの許可を求めます。

API キーは `chrome.storage.local` に保存し、`TRUSTED_CONTEXTS` に制限して content script から読み出せないようにしています。Chrome 同期は使用しません。暗号化された秘密情報保管庫ではありません。

翻訳文はページまたは選択文ウィンドウのメモリーだけに置き、履歴は保存しません。選択文はウィンドウへ渡す間だけ `storage.session` を使い、読み取り時に削除します。API 通信は Cookie を送らず、リダイレクトも追いません。

関連する Chrome 公式資料： [API への通信](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[storage](https://developer.chrome.com/docs/extensions/reference/api/storage)、[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[service worker の寿命](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。

## 開発・検証

Node.js 22 以降と Python 3 があれば、ユニットテストと ZIP 作成を実行できます。

```bash
npm test
npm run pack
# 実 API。環境変数のキーは出力しません。
node scripts/smoke-api.mjs
```

ブラウザテストはローカルのモック API と Chromium を使います。本番のキーや API は使いません。テスト用コピーにだけ localhost の権限を追加します。

```bash
npm install
npx playwright install chromium
npm run test:browser
# 実 API も拡張から呼ぶ場合（テスト用の一時プロファイルは終了時に削除）
PLAMO_LIVE_TEST=1 npm run test:browser
# llvm.org を実 API で翻訳し、修正後 PDF・画像とリンク維持・完全復元を確認
PLAMO_LIVE_TEST=1 PLAMO_LLVM_TEST=1 npm run test:browser
```

設定保存、接続テスト、日本語の言語名、併記、置き換え、DOM とイベントの維持、復元、フォームなどの除外、中止、API エラー、選択文ウィンドウ、同時実行数を確認します。右クリックのネイティブメニューはユニットテストで登録・クリック後の処理を確認します。

拡張の配布物には `extension/` の内容だけを含めます。モデル本体は含みません。

2026-11-11 の検証では、14 件のユニットテスト、Chromium のモック API テスト、および拡張から実 API を使った接続・併記・置き換え・復元・選択文翻訳が通っています。Windows 版 Chrome の手動操作は未確認です。
