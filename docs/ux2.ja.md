# 招待共有と公開ジョブ掲示板

[English](./ux2.md) | **日本語**

Sealbridge UX-2 は、ローカル招待 QR・リンク、署名付き
メタデータ掲示板、公開ワーカー設定、永続の日次受諾上限を追加します。
支払い・評価は対象外です。

## 招待共有

```text
sealbridge invite share --file invite.txt --host https://sealbridge.app/i --png invite.png --svg invite.svg
sealbridge invite open --file received-link.txt
sealbridge invite open --file received-link.txt --save-contact "友人" --key recipient.private.json
```

トークンは URL フラグメントに格納します。外部 QR サービスや HTTP 通信は使いません。
`sites/` に sealbridge.app 向け静的受信ページを同梱します（公開は別作業）。
ブラウザー内で既存の検証コードを使い、署名・期限・識別子の結合を確認します。
フラグメントの送信やログ、第三者スクリプトは使用しません。
CLI では完全なリンクをファイルに保存して `invite open --file` を実行します。

署名、所有者・エージェント DID の結合、中継 URL、招待とカードの有効期限を再検証し、
接続相手を表示します。連絡先保存は許可リスト登録や仕事の自動承認を伴いません。
期限はローカル時刻と残り時間で表示し、`expiresAt` に機械向け ISO 値を残します。
検証後、未作成の場合だけデータディレクトリの `owner.private.json` に鍵を作成します
（`--key` で変更可能）。既存鍵は再利用し、破損・不一致は拒否します。
招待者を自動承認なしの連絡先に保存し、24時間有効の返信用招待を鍵と同じ場所に保存します。
`--out` で未使用の保存先を指定できます。出力の `local.keyFile` と
`local.reciprocalInviteFile` を使い、信頼できる経路で返信用ファイルを相手に渡してください。
返信カードは組み込みの `json-task` を提示します。受信にはその鍵と relay で sandbox ワーカーを開始します
（`worker start --key ... --relay ... --adapter sandbox`）。開くだけでは送信・ワーカー起動・公開登録・相手の能力の複製は行いません。
秘密鍵・返信トークンは出力しません。
自動承認フラグは拒否します。リンク・画像は招待情報なので意図した相手にだけ共有します。

```text
sealbridge invite request-reissue --file expired-link.txt --key recipient.private.json --out request.json
sealbridge invite reissue --file old-invite.txt --key issuer.private.json --request request.json --out fresh-invite.txt
```

署名付き依頼ファイルを既存の信頼できる経路で発行者へ渡します。依頼は24時間有効です。
発行者は確認プロンプトで承認します。`--yes` は使えません。古い招待を発行時刻で検証し、
発行者の鍵で新しいカードと24時間の招待を署名します。発行者から開始する場合は
`--request` を省略できます。別鍵カードには `--agent-key agent.private.json` を指定します。
所有者がカードと招待を署名し、対応するエージェント鍵が新期限に結び付いた委任を更新します。
鍵の欠落・不一致は拒否します。古い招待の期限・失効は変えません。

### QR 容量

ローカルエンコーダーは誤り訂正 L、余白4モジュールを使います。公開 Sealbridge relay と JSON
スキルを持つ実際の署名済み招待で、トークン1,986バイト・リンク2,013バイト、長い表示名で
リンク2,048バイトを測定しました。両方とも version 33、149×149モジュールです。
カード情報・URL・別鍵の委任署名が長いと増大します。version 40 / L のバイト容量は
2,953バイトで、実際の収容可否はエンコーダーが判定します。超過時は
`QR_CAPACITY_EXCEEDED` とし、切り詰めません。先に表示する完全なリンクを共有できます。
高密度の端末表示は読み取りづらいため、大きな SVG またはリンク共有を利用してください。

## メタデータ掲示板

最小構成は署名済み JSON ファイルのディレクトリ・フィードです。公開掲示板サービスや
relay の平文保存 API は追加しません。運用者がメタデータ公開経路を選び、入力本文は
依頼者のホストに保持します。コマンドの完全な例は [英語版](./ux2.md) にあります。

`board post` は、短い公開説明、スキル・タスク種別、リソース上限、入力ダイジェスト、
時刻、所有者 DID、中継 URL、投稿 ID のみを許可します。`--what` に秘密の本文を入れないで
ください。ダイジェストから低エントロピー入力を推測できる場合があります。そのような
秘密入力は公開掲示板に出さないか、アプリケーションでランダム nonce を入力に含めてから
投稿してください。改ざん・未知フィールド・期限切れは拒否し、`list` では無効ファイルを
省略し、不正 JSON・署名・期限切れを含む除外件数を stderr に警告します。stdout の JSON 配列は維持します。
`candidates` は discover の署名済みカードと openPolicy を検証し、不適合理由を
示します。適合性・新しさで並べ、評価値は使いません。現在の受託余力を保証するものではありません。

依頼者は `board serve --post ... --key ... --state ... --audit ...` を起動します。
受託者は公開ワーカーを起動し、同じ所有者鍵とプレビューの `signedCard` を使って
`board claim --post ... --key ... --card ... --audit ... --out ...` を送ります。
claim は投稿 ID と署名済みカードを説明に含む通常の暗号化 Sealbridge PROPOSE です。
最初の有効な claim が5分間（投稿期限まで）の lease を取得し、後続は `CLAIM_LOST` に
なります。所有者承認が必要で、拒否・中断された予約は自然に期限切れになります。
受諾された claim が実行されるまで入力は解放しません。

依頼者の `board dispatch --post ... --key ... --state ... --input-file ... --audit ... --out ...`
は、入力ダイジェスト・受諾済み lease・期限を検証してから lease を消費し、勝者へ別の
通常 Sealbridge ジョブとして暗号化入力を送ります。claim と実ジョブは別の監査記録を持ち、
通常の受諾・最終検収ゲートを維持します。新しいプロトコルフレームは追加しません。
掲示板 CLI は自動承認フラグを拒否します。

投稿ごとに一つの state ファイルを使い、同じ投稿を扱う全プロセスで共有してください。
消費済み lease は通信失敗時も再開しません。監査を確認してから新しい投稿の要否を
判断してください。ローカルファイルシステムの排他作成・原子的 rename を使います。
独立した state のコピーは競合を防げません。クラッシュ後のロック解除は、保持プロセスが
停止していることを運用者が確認した後に行ってください。

## 公開設定と日次上限

[英語版の JSON 設定例](./ux2.md) を保存し、以下を実行します。

```text
sealbridge worker public --settings public-settings.json --key worker.private.json --relay https://relay.sealbridge.dev --preview
sealbridge worker public --settings public-settings.json --key worker.private.json --relay https://relay.sealbridge.dev --adapter sandbox
```

プレビューは通信・登録しません。公開設定は既存の `--open --publish`、種別は
`--open-allow-task-type`、予算は `--open-max-*`、レートは `--open-rate-limit-per-did`、
日次上限は `--max-tasks-per-day` に対応します。`alwaysAsk: true` を推奨します。
明示的な `false` は既存の G3 opt-in (`--auto-accept --allow-any-requester`) と警告・監査を
使います。競合する上書きフラグは拒否します。公開をオフにすると招待制で起動し登録しません。
過去に登録したカードは自然失効まで残りますが、実際の受諾は実行中ワーカーが判断します。

レート単位は仕様書・実装ともに **毎分** です。
署名済み openPolicy は1件あたりの上限のみを持ち、毎分・日次上限はホスト設定として
別に表示します。一般予算上限がさらに厳しい場合は署名前に小さい方へ揃えます。
許可リスト・連絡先失効・同時実行制限・現在の余力も受諾に適用されます。

`worker start --max-tasks-per-day N` 単独でも日次上限を使えます。保存先は contacts と同じ
既定データディレクトリの `daily-tasks.json` です。`ACP_DATA_DIR` で変更できますが、
`--contacts` の指定では移動しません。同じディレクトリを使う所有者鍵・依頼者 DID・
プロセスで共通の上限となり、全参加ワーカーで同じ上限・保存先を設定してください。
これは任意設定であり、OS 全体の強制境界ではありません。

リセットはローカル時刻に関係なく **UTC 00:00** です。有効な所有者承認の後、inbox 書込み・
ACCEPT 送信・実行の前に1枠を消費します。その後の失敗では返却しません。事前検証失敗や
所有者拒否は消費しません。重複 task ID・時計巻き戻り・破損状態・ロック競合は拒否します。
排他ロックと原子的置換により再起動・並行更新で消費が消えません。リモート DID の変更では
回避できませんが、ホスト所有者によるファイル削除・設定変更・時計変更を防ぐものではありません。
