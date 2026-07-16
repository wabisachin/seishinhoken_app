# 精神保健福祉士 試験対策アプリ

教科書PDF・過去問PDF・出題基準PDFから知識ベースを作り、それを根拠にLLMが国家試験レベルの
問題を生成する演習アプリ。個人利用（開発者＋友人1名）を前提としている。

## 全体像

```
[PDF] text_pdf/ (教科書24冊) ─┐
[PDF] exam_pdf/past_exam/     ├→ scripts/extract_*.py → data/*.json, data/textbooks/*.jsonl
[PDF] exam_pdf/reference/    ─┘         │
                                          ▼
                          scripts/chunk_and_embed.py
                     （チャンク分割 → Voyage埋め込み → Supabase投入）
                                          │
                                          ▼
                              Supabase (Postgres + pgvector)
                     documents / chunks / taxonomy / past_questions
                     questions / attempts / app_settings / error_logs
                                          │
                                          ▼
                            web/ (Next.js App Router)
                  分野別演習・全分野ミニ模試・復習モード・成績・管理者ページ
```

## ディレクトリ構成

- `text_pdf/`, `exam_pdf/` — PDF原本（gitignore対象、サイズが大きいため）
- `data/` — 抽出済みの中間データ（gitignore対象。スクリプトで再生成できる）
- `scripts/` — 前処理パイプライン（Python）
- `web/` — アプリ本体（Next.js 15 / App Router / Tailwind v4）

## セットアップ

1. ルートの `.env.example` を `.env` にコピーし、各キーを設定
   （Supabaseプロジェクト作成・埋め込み・LLM用。詳しくはコメント参照）
2. Python依存関係: `pip install -r scripts/requirements.txt`
3. 前処理を順に実行:
   ```
   python scripts/extract_textbooks.py   # text_pdf/ → data/textbooks/*.jsonl
   python scripts/extract_pastexams.py   # exam_pdf/past_exam/ → data/past_questions.json
   python scripts/extract_kijun.py       # 出題基準PDF(vision) → data/taxonomy.json
   python scripts/chunk_and_embed.py     # チャンク化・埋め込み・Supabase投入
   ```
4. `web/.env.example` を `web/.env` にコピーし、Supabase接続情報とLLMキー、
   `ADMIN_PASSWORD`（後述）を設定
5. `cd web && npm install && npm run dev`

Supabaseのテーブルは `web/supabase/migrations/*.sql` を番号順に適用する
（Supabase Management API 経由、または `supabase db push` 等で）。

## 問題生成の設計（最重要）

### なぜバックグラウンドの生成ループを持たないか

以前はサーバーの常駐プロセス内で「目標数に達するまで生成し続けるループ」を回す設計だったが、
Vercelのようなサーバーレス環境ではレスポンス返却後にそのループが継続する保証が無く、
かつプロセス再起動のたびに試行回数のカウンタがリセットされ得るため、コストが際限なく
増大しうる脆弱性があった。

現在は **`web/app/api/quiz/next` への1リクエストにつき、生成は高々1回だけ** という
完全にリクエスト駆動の設計（`web/lib/questionSupply.ts`）になっている。生成が必要な間、
フロントエンド（`web/app/(main)/quiz/page.tsx`）がこのエンドポイントを繰り返し呼ぶことで
結果的に「生成されるまで待つ」体験になるが、サーバー側に「呼ばれていないのに動き続ける」
処理は存在しない。これによりVercelのサーバーレス関数でもそのまま安全に動く。

### コスト上限（科目ごと）

`questions`テーブルの行数を**そのつど直接数える**ことで上限を判定する。専用のカウンタ
状態を一切持たないため、プロセス再起動やリトライで上限がリセットされたり回避されたり
することが無い（`web/lib/questionSupply.ts`の`countBySubject`）。

- アクティブ問題が **50問未満**: 出題のたびに必ず新規生成
- **50〜200問**: 新規生成の確率を徐々に下げ、既存プールからの再出題を増やす
  （`(200 - activeCount) / (200 - 50)`）
- アクティブ問題が **200問に到達**: 新規生成を完全に停止、以降は再出題のみ
- **却下(rejected)も分母に含めた総数が250に到達**: 却下ばかりでアクティブが増えない
  科目でも必ずここで生成が止まる安全弁

この閾値は科目単位（18科目 × 200問 = 最大3,600問）。出題基準の細目単位ではない
（406細目 × 200問だと最大81,200問になり非現実的なコストになるため）。

### 生成品質・多様性

- `explanations`（各選択肢の吟味）→`correct`（正答決定）の順にスキーマを設計している。
  逆順だと正答を先に決め打ちしてから理由を後付けすることになり、両者が矛盾して
  自己検証で弾かれる（rejected）ケースが多発したため（`web/lib/generation.ts`）。
- 出題対象の出題基準項目は、既存問題数が最も少ないものを優先して選ぶ
  （`pickTaxonomyItem`）。200問に到達するまでの間、特定の項目に偏らないようにする。
- 同じ項目で既に出題済みの問題文・使用済み根拠抜粋をプロンプトに「重複を避ける対象」
  として渡している（`existingCoverage`）。

### 生成後の自己検証

`generateOneQuestion`は生成→形式チェック→根拠テキストとの照合（LLMによる校閲）を行い、
矛盾があれば1回だけ修正指示付きで再生成する。それでも通らなければ`status="rejected"`
として保存し、出題プールには含めない（データとしては残る＝後から分析できる）。

## LLMモデルの決定（管理者専用）

問題生成に使うLLM（プロバイダ・モデル）は `app_settings` テーブルの1行だけが正であり、
**クライアントから指定させる経路は存在しない**（`web/lib/appSettings.ts`）。
`/admin`ページ（後述）からのみ変更できる。

## 管理者ページ（/admin）

- メインナビゲーションには一切リンクを置いていない（URLを直接知っている人だけが辿り着く）
- `ADMIN_PASSWORD`環境変数によるパスワード認証。ログイン成功時にHMAC署名付きのCookieを
  発行する（`web/lib/adminAuth.ts`）。パスワード自体はCookieに載らず、ステートレスに
  検証できるため複数のサーバーレスインスタンス間でも追加のストレージ無しに機能する
- できること:
  - 問題生成に使うLLMの変更
  - 生成済み問題・解答履歴の全削除（検証データを消して本番運用を始める用。
    教科書データ・出題基準・過去問は消えない）
  - 直近のエラーログの閲覧・クリア

## エラーログ

LLM課金上限・レート制限など外部サービス連携で起きたエラーは、サーバーログに出す
だけでなく `error_logs` テーブルにも保存し、`/admin`ページから確認できる
（`web/lib/errorLog.ts`）。エラーの発生源(`source`)・メッセージ・スタックトレース・
関連コンテキスト（科目名など）を記録する。

## 出題モードごとのUI設計

- **分野別演習**（`mode=subject`）: 1問ずつ出題・即時に解説を表示。解いている間に
  裏で次の1問を先読み（同じオンデマンド生成エンドポイントを叩くだけなので、
  既にプールが足りていれば単なる高速な既存問題取得になる）。リロード・離脱時は
  `localStorage`に進行状況を保存し、次回アクセス時に再開バナーを出す。
- **全分野ミニ模試**（`mode=mock`）: 3問ずつまとめて表示し、即時フィードバックは
  出さない。全問解答後に分野別の得点率を含む結果レポートを表示する
  （`web/app/(main)/quiz/MockQuiz.tsx`）。こちらも`localStorage`で再開に対応。
- **復習モード**（`mode=review`）: 直近の解答が誤答だった問題を優先的に再出題。

## 既知の制約・データ品質メモ

- 一部の教科書PDF（古い版・独自フォントエンコーディング）は、丸数字（①②③等）が
  正しく展開されずテキスト抽出が乱れることがある。意味は文脈から復元可能なため
  実害は小さいが、引用抜粋の見た目が読みにくいことがある。
- 出題基準PDFはGPT-4o visionでページ画像から構造化抽出しており、科目名の表記ゆれ
  （全角/半角かっこ、送り仮名の違い等）が起きることがある。`extract_kijun.py`実行後は
  `past_questions.json`の科目名一覧と突き合わせて正規化することを推奨する。

## デプロイ（Vercel）

現在の生成方式（リクエスト駆動・行数ベースの上限判定）はサーバーレス環境でもそのまま
安全に動作する設計になっている。追加の対応は基本的に不要だが、生成1回あたり
20〜40秒程度かかることがあるため、`/api/quiz/next`の`maxDuration`はVercelの
プラン上限に収まる値に調整すること。
