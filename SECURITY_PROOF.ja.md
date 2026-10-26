# セキュリティ証明 / レッドチーム敵対スイート

[English (SECURITY_PROOF.md)](./SECURITY_PROOF.md) | **日本語**

懐疑的な検証者は、本番関数を直接叩く敵対的テストを次の1コマンドで再実行できます。

```sh
pnpm test:security-proof
```

中身は `vitest run conformance/security-proofs.test.ts` です。CI のステップ **Run Security Proof Suite (Red-Team Adversarial Tests)** も同じコマンドを、通常の `pnpm test` のあとに実行します。合格が確認そのものです。秘密情報の漏えい、注入コマンドの実行、他セッションの読取り、偽造署名の受理が1件でも起きると失敗します。全体の回帰は `pnpm test` のままです。

行の読み方: 「脅威」は再現する攻撃、「制御」は止めるコード、「テスト」は `conformance/security-proofs.test.ts` の `describe` / `it` 名です。テスト名は英語のまま検索してください。

### 証明 1 — メモリと環境変数からの秘密情報持ち出し

侵害されたワーカー作業が `process.env` をダンプしたり、資格情報ブローカーを覗いたり、期限切れ・偽造・別タスクのハンドルを引き換えたりして、`OPENAI_API_KEY` や `GITHUB_TOKEN` などのホスト秘密を回収しようとする攻撃です。PHP2Shell 以後のメモリ開示、および `CVE-2026-109618` / `CVE-2026-109619` と同じ類の脅威です。生のプロバイダー鍵はホストプロセスに残します。

| 脅威                                         | 制御                                                                                                                                                                                                                              | テスト                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| コマンドワーカーがホスト環境をダンプする     | `packages/sandbox/src/index.ts` の `sanitizedEnvironment` が許可リストを新規に作る。`packages/adapters/src/command.ts` の `CommandAgentAdapter.executeCommand` は、そのリストに `PATH` と `TASK_INPUT_FILE` だけを足して渡す。    | `Proof 1: memory and environment secret exfiltration` の command worker env |
| ゲスト JavaScript が `process` を読む        | `runSandbox` はタスクコードをプロトタイプ無しの `vm` で評価する。Node API はラッパープロセス側だけが持つ。                                                                                                                        | 同じ証明の sandbox guest                                                    |
| 本物のプロバイダー鍵と、タスク単位のハンドル | `packages/adapters/src/credential-proxy.ts` の `startCredentialProxy` がランダムなループバックトークンを発行する。`ClaudeCodeAdapter.executeTask` は子プロセスへそのトークンだけを置き、本物の鍵はホストの `fetch` にだけ付ける。 | 同じ証明の credential proxy と Claude adapter                               |
| 偽造・別タスク・クローズ済みハンドル         | プロキシは `Authorization` / `x-api-key` をそのタスクのトークンと比較し、`close()` までしか待たない。                                                                                                                             | 同じ証明の forged, other-task, and closed handles                           |

### 証明 2 — コマンド注入とパストラバーサル

タスク入力やアダプタ引数に `$(touch …)`、`` `id` ``、`; rm -rf /`、`| cat /etc/passwd`、`../../etc/passwd`、`__proto__` を入れる攻撃です。

| 脅威                         | 制御                                                                                                                                                                                                      | テスト                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| argv のシェルメタ文字        | `runCommand` は `shell: true` なしで `spawn` する。配列形式のコマンドが子プロセス実行器である。`resolveCommand` は相対パスを `COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH` で拒否し、未知の名前も拒否する。       | `Proof 2: command injection and path traversal` の `runCommand` と `resolveCommand` |
| タスク入力をシェルへ継ぎ足す | `CommandAgentAdapter` は入力を `workspaceDir/input.json` と子プロセスの標準入力へ書く。`argv` へは連結しない。文字列の `command` はオーナーが書いた `/bin/sh -c` であり、入力はやはり標準入力だけに届く。 | 同じ証明の adapter argv と workspace listing                                        |
| スキーマとプロトタイプ汚染   | `packages/core/src/schema.ts` の `validateOutput` と、`parseJsonDeliverable` が使う `JSON.parse`。                                                                                                        | 同じ証明の schema と `__proto__`                                                    |

### 証明 3 — セッション間の漏えいと隔離レベルの格下げ

並行する主体が互いの受信箱を読んだり、終わったタスクの状態が残ったり、実行は子プロセスなのに `oci_container` や `container` だと主張したりする攻撃です。`CVE-2026-109619` と `CVE-2026-115419` に対応づけています。

| 脅威                                   | 制御                                                                                                                                                                                                                                                                           | テスト                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 別の鍵による受信箱のポーリング         | `packages/relay/src/fetch.ts` の `InMemoryRelay.authenticate` / `openInbox` は、`packages/core/src/relay-auth.ts` の受信者署名 `RelayAuth` を要求する。                                                                                                                        | `Proof 3: cross-session state bleed and isolation downgrade` の concurrent inboxes |
| 古いキューとエンベロープの再生         | `receive` は一度だけ取り出す。`send` は同じ `envelopeId` を `REPLAYED_ENVELOPE` で拒否する。                                                                                                                                                                                   | 同じ証明の stale queue                                                             |
| タスクコードが隔離レベルを自分で名乗る | `packages/sandbox/src/container.ts` と `packages/adapters/src/sandbox.ts` の `runContainerOrSubprocessSandbox` / `SandboxAgentAdapter` は、実行経路から `effectiveIsolationLevel` を決める。`runtime: null` は `subprocess_restricted` に落ち、その文字列を報告する。          | 同じ証明の runner label                                                            |
| 契約より低い隔離の証明                 | `packages/runtime/src/verifier.ts` の `VerificationEngine.verify` は、`oci_container` 契約の署名付き証明が `oci_container` でなければ拒否する。例外は `sandboxPolicy.allowSubprocessFallback: true`（`ISOLATION_LEVEL_MISMATCH`）。署名の1バイト改ざんでは主張を上げられない。 | 同じ証明の verifier                                                                |

依頼側が信頼するのは、ホストが報告したレベルに対するワーカーの署名です。信頼できないタスク出力そのものはレベルではありません。`packages/runtime/src/session.ts` は `reportIsolation` を署名付き証明へコピーします。

### 証明 4 — リソース枯渇と SSRF

1MiB を超えるリレー本体、キューの洪水、ノンス再生、インスタンスメタデータ・ループバック・`file:` を狙ったリレー URL です。`CVE-2026-109618` の枯渇側に対応づけています。

| 脅威                                                                            | 制御                                                                                                                                                                                                                                                                                                                                               | テスト                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1MiB 超、1001件目のキュー、受信者数の上限                                       | `packages/relay/src/fetch.ts` の `InMemoryRelay.send` は、JSON バイト長が `1048576` を超える、受信者キューが `1000` に達する、`maxQueues` を使い切ると `RELAY_CAPACITY` で拒否する。                                                                                                                                                               | `Proof 4: resource exhaustion and SSRF` の capacity |
| 保持窓の内側でのノンス再生                                                      | `authenticate` は `recipientDid:nonce` を保存し、二度目を拒否する。`maxAuthSeenEntries` が FIFO 窓を上限にし、集合は際限なく増えない。窓の中にあるノンスは拒否されたままになる。                                                                                                                                                                   | 同じ証明の nonce replay                             |
| `http://169.254.169.254`、厳格モードの `http://127.0.0.1`、`file:///etc/passwd` | `packages/core/src/discovery.ts` の `validateRelayEndpointUrl` と `parseAndVerifyInviteToken`。リンクローカルとメタデータホストは常に `SSRF_BLOCKED_RELAY_URL`。ループバックは `allowPrivateRelay: false` のとき拒否。`file:` は許可プロトコルではない。`packages/runtime/src/session.ts` の `RequesterClient.delegate` は接続前に同じ検査をする。 | 同じ証明の SSRF                                     |
| プロバイダー URL `file:///etc/passwd`                                           | `startCredentialProxy` は HTTP(S) 以外のベース URL を `INVALID_PROVIDER_URL` で拒否する。                                                                                                                                                                                                                                                          | 同じ証明の provider URL                             |

公開の `http:` と `ws:` のリレー端点は、いまも許可されています。`conformance/security-hardening.test.ts` の `accepts public http: endpoints` がその方針を固定しています。この証明は、平文の公開 HTTP を拒否するとは主張しません。

### 証明 5 — エンベロープと成果物の改ざん

署名済み `TaskContract` の予算やスコープ、成果物ハッシュ / `UsageReceipt`、`RelayAuth` の時刻や署名を、1バイトまたは1フィールドだけ書き換える攻撃です。正規化は RFC 8785 JCS、署名アルゴリズムは Ed25519 です（`packages/core/src/crypto.ts`）。

| 脅威                                            | 制御                                                                                                                                                                                                        | テスト                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 署名後の予算またはスコープの改変                | `packages/core/src/contract.ts` の `verifyContract` は `digest(manifest) === digest(proposal.payload)` と、JCS ペイロードに対する有効な Ed25519 署名を要求する。                                            | `Proof 5: cryptographic envelope and artifact tampering` の contract |
| 成果物バイトまたは `digest`、利用レシートの改変 | `VerificationEngine.verify` は成果物・実行証明・利用レシートの `verifySigned` と、`digest(data) === artifact.payload.digest` を要求する。このスイートが検査するタスクレシートは、その署名付き成果物である。 | 同じ証明の artifact and usage                                        |
| 古い、または1バイト改ざんした `RelayAuth`       | `verifyRelayAuthToken` は、ずれが5分を超える時刻と、検証に通らない署名バイトを拒否する。                                                                                                                    | 同じ証明の RelayAuth                                                 |

改ざん前の契約、配送、新しいトークンは、先に受理されることを確認します。何でも拒否する検証器は、この対照で失敗します。

ビルド済みのチェックアウト（Node.js 22、pnpm 10）で、リポジトリ直下から次を実行してください。

```sh
pnpm test:security-proof
```

`conformance/security-proofs.test.ts` のすべてのテストが通ることを確認します。
