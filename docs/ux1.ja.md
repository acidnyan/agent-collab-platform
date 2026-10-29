# 連絡先の永続化と受領記録

[English](./ux1.md) | **日本語**

Agent Collaboration Platform (ACP) の連絡先をローカルに保存し、監査ログを
JSON と静的 HTML の受領記録に変換します。プロトコルや中継器は変更しません。
[UX_LAYER.ja.md](../UX_LAYER.ja.md) の連絡先・受領記録部分が対象です。
QR 共有、ジョブボード、金額上限、GUI 承認画面は対象外です。

## 連絡先

```sh
acp contacts add <invite> --key owner.private.json --name "協力者"
acp contacts list --key owner.private.json
acp contacts allow <ownerDid> --key owner.private.json
acp contacts revoke <ownerDid> --key owner.private.json
acp contacts remove <ownerDid> --key owner.private.json
```

招待とカードの署名を検証し、owner DID、agent DID、中継先、表示名、検証時刻を
保存します。秘密鍵・招待トークンは保存しません。保存と自動受諾許可は別です。
`allow` 後もワーカーの `--auto-accept` 等の明示的指定が必要です。
既存の予算制限・承認ゲートは維持します。連絡先とワーカーには同じ所有者鍵を使います。

所有者署名付きの `contacts.json` を Windows では
`%LOCALAPPDATA%/AgentCollaborationPlatform`、macOS では
`~/Library/Application Support/AgentCollaborationPlatform`、Linux では
`$XDG_DATA_HOME/agent-collab-platform`（既定 `~/.local/share`）に保存します。
`ACP_DATA_DIR` でディレクトリ、`contacts --file` と `worker start --contacts` で
個別ファイルを指定できます。所有者ごとに別ファイルを使ってください。
未作成なら連絡先なし、不正署名・未知バージョン・壊れたデータなら拒否します。

起動時に許可 DID を読み込み、承認時にも再確認します。`revoke` は明示的な
許可フラグや `--allow-any-requester` より優先し、将来の承認を拒否します。
実行中の処理は中止しません。新規許可を起動時許可リストへ反映するには再起動します。
`remove` は一覧から隠し、拒否記録を残します。再追加しても拒否は維持され、
復帰には明示的な `allow` が必要です。他の依頼者と共有する招待自体は失効させません。

通常の委任オプションに `delegate --to <invite> --save-contact "名前"` を加えると、
受信した招待を保存できます。自動受諾は許可されません。
プライベート中継器には既存の `--allow-private-relay` が必要です。

更新には排他ロックと原子的置換を使用します。クラッシュ後の `.lock` は、
更新処理が動いていないことを確認してから所有者が削除できます。
署名は改ざんを検出しますが、削除や過去の正当なファイルへの巻き戻しは検出しません。
ホストのアクセス制御とバックアップでデータ・鍵を保護してください。

## 受領記録

```sh
acp receipt audit.jsonl
acp receipt audit.jsonl --out receipt --trust-anchor trusted-head.json
```

既定では `audit.jsonl.receipt.json` と `audit.jsonl.receipt.html` を作成し、
JSON を標準出力へ表示します。既存ファイルは上書きしません。
`--out receipt` なら `receipt.json` と `receipt.html` になります。
信頼アンカーは既存の監査検証形式（例：`taskId`、`actors`、`head`）で、
相手方や別の信頼できる記録から独立して取得してください。

双方署名とハッシュチェーンを検証してから値を表示します。
改ざん・チェックポイント欠落は `INVALID`、必要な提案・受諾・開始・納品・
検収・完了の順序が欠けた記録は `INCOMPLETE` とし、終了コード 1 を返します。
独立した head がない完全なチェーンは `UNCONFIRMED` で、完了と表示しません。
一致する head と完全なチェーンがある場合のみ `COMPLETED` です。
同じ未信頼ファイルからコピーした head は独立した証拠になりません。
署名検証は成果物の内容の検収を代替しません。

公開 DID、タスク ID、記録されたトークン・ツール・時間使用量、計算予算、
検証結果、UTC の署名時刻を表示します。時刻は参加者の時計で、第三者時刻証明ではありません。
不明な使用量はゼロではなく `null` です。**SETTLED は支払いの証明ではありません。**

PII・秘密情報の見落としを避けるため、自由文の名前・件名・説明・入出力・パス・
エラー文は省略します。内容は元の監査ログをローカルで確認してください。
HTML は表示値をエスケープし、スクリプト・外部リソースを含まず、CSP を設定します。
説明責任のため公開 DID は表示されます。共有前に内容を確認してください。
