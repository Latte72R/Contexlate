# ページ翻訳の実装比較と採用した方式

2026-11-11 に公式ドキュメントと公開コードを確認しました。コードの転載やライブラリ追加はせず、既存の拡張に必要な方式を実装しています。

| 参照した実装 | 確認した方式 | この拡張での採用 |
| --- | --- | --- |
| [Immersive Translate の公式プロンプト仕様](https://immersivetranslate.com/en/docs/prompts/) | 段落単位の入力、タイトル・ページ文脈の付与、インライン HTML の維持 | 段落を分割せず渡し、PLaMo の正式な `context` オプションでタイトル・周辺本文を付与 |
| [Firefox のページ翻訳](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/content/translations-document.sys.mjs#L6280) | 要素 ID による対応付け、元の要素・テキストノードの再利用、訳文の順序に沿う再配置 | 元のリンク・装飾とテキストノードを再利用し、同じ親の中で自然な語順へ並べ替える。属性・リンク先・イベント処理を保持 |
| [TWP のページ翻訳](https://github.com/FilipePS/Traduzir-paginas-web/blob/master/src/contentScript/pageTranslator.js#L386) | インライン要素をまたぐ文・段落のグループ化 | 段落内のリンク・太字で翻訳を分断しない |
| [Firefox の画面内優先処理](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/translations/content/translations-document.sys.mjs#L950)、[TWP の表示領域判定](https://github.com/FilipePS/Traduzir-paginas-web/blob/master/src/contentScript/pageTranslator.js#L967) | 表示領域にある内容を優先する | 実行時に画面内の段落を先に処理し、その後も画面外の翻訳を継続 |

## PLaMo に合わせた点

[PLaMo の公式仕様](https://huggingface.co/pfnet/plamo-3-translate-8b#translation-options)では、参照文脈は翻訳本文や一般的な system 指示に混ぜず、`chat_template_kwargs.context` で渡せます。実 API に「かみを切りました。」を送ると、折り紙の文脈では paper、美容院の文脈では haircut と訳し分けることを確認しました。

元の「LLVM began as a」のような文の断片には文脈を足しても不足語の穴が残りました。段落をまとめることと、文脈を十分に渡すことの両方が必要でした。

## DOM への反映

段落の HTML はタグと一時的な要素 ID に絞り、リンク先・クラス・スタイルは HTML から除きます。フォームの入力値もモデルへ渡しません。応答は表示しない template 内で解析し、要素 ID・タグ・親子関係・重複・欠落・追加属性を検証します。検証後もモデルの要素を直接挿入せず、元の要素とテキストノードへ反映します。対応付けを検証できない段落は原文を残します。

復元時は、サイト側が内容を変更していないことを確認して、元のノード・文字列・順序に戻します。画面内優先は最初の処理順にだけ適用し、翻訳対象全体の文脈と完了範囲は保持します。

## 検証

- `tmp.pdf` の崩れと llvm.org の原文を比較。
- 実 API で llvm.org の 93 件を翻訳し、翻訳エラー 0 件を確認。
- 実 API の応答を再現して、全リンクの維持と元の HTML への完全復元を確認。
- モック API で、元のテキストノードを保持するアプリの更新、画面内の優先、画面外も含む完了、リンクの語順変更、危険・欠落・重複・親子関係変更を含む応答の拒否を検証。

複数段落を独自の区切り記号でまとめるバッチ方式は、区切りの保持が PLaMo で未検証のため導入していません。段落単位と設定された同時実行数（既定4件）を維持しています。
