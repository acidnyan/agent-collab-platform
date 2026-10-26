# Security Proof / Red-Team Adversarial Suite

**English** | [日本語](#日本語)

Skeptical engineers can rerun every proof below with:

```sh
pnpm test:security-proof
```

That command is `vitest run conformance/security-proofs.test.ts`. CI runs the same step, **Run Security Proof Suite (Red-Team Adversarial Tests)**, after the main test suite. A passing run is the check: each case drives the production function, asserts the attack is rejected, and fails if a secret, injected command, cross-session read, or forged signature is accepted.

懐疑的な検証者は、上記の1コマンドで本番コードに対する敵対的テストを再実行できます。CI の同名ステップも同じコマンドです。秘密情報の漏えい、注入コマンドの実行、他セッションの読取り、偽造署名の受理が1件でも起きると失敗します。

## How to read a row / 行の読み方

| Column                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| Threat class          | The attack the proof simulates                                       |
| Architectural control | The code that is supposed to stop it                                 |
| Adversarial test      | The `describe` / `it` title in `conformance/security-proofs.test.ts` |

## Proof 1 — Memory and environment secret exfiltration

Threat class: a compromised worker task dumps `process.env`, inspects the credential broker, or redeems an expired, forged, or other-task handle, trying to recover host secrets such as `OPENAI_API_KEY` or `GITHUB_TOKEN`. This is the post-PHP2Shell memory-disclosure class named alongside `CVE-2026-109618` / `CVE-2026-109619`: raw provider material must stay in the host process.

| Threat class                            | Architectural control                                                                                                                                                                                                         | Adversarial test                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Host env dumped by a command worker     | `sanitizedEnvironment` in `packages/sandbox/src/index.ts` builds a fresh allowlist. `CommandAgentAdapter.executeCommand` in `packages/adapters/src/command.ts` passes only that allowlist plus `PATH` and `TASK_INPUT_FILE`.  | `Proof 1: memory and environment secret exfiltration` → command worker env |
| Guest JavaScript reads `process`        | `runSandbox` in `packages/sandbox/src/index.ts` evaluates task code in a null-prototype `vm` context. The wrapper process holds Node APIs; the guest does not.                                                                | same proof → sandbox guest cannot see `process`                            |
| Real provider key vs task-scoped handle | `startCredentialProxy` in `packages/adapters/src/credential-proxy.ts` mints a random loopback token. `ClaudeCodeAdapter.executeTask` puts that token in the child env and attaches the real key only inside the host `fetch`. | same proof → credential proxy and Claude adapter                           |
| Forged, other-task, or closed handle    | The proxy compares `Authorization` / `x-api-key` to that task's token and listens only until `close()`.                                                                                                                       | same proof → forged, other-task, and closed handles                        |

## Proof 2 — Command injection and path traversal

Threat class: task input or adapter arguments contain `$(touch …)`, `` `id` ``, `; rm -rf /`, `| cat /etc/passwd`, `../../etc/passwd`, or `__proto__`.

| Threat class                      | Architectural control                                                                                                                                                                                                                     | Adversarial test                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Shell metacharacters in argv      | `runCommand` in `packages/adapters/src/command.ts` calls `spawn` without `shell: true`. Array commands are the child-process executor. `resolveCommand` rejects relative paths (`COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH`) and unknown names. | `Proof 2: command injection and path traversal` → `runCommand` and `resolveCommand` |
| Task input spliced into the shell | `CommandAgentAdapter` writes input to `workspaceDir/input.json` and the child stdin. It does not concatenate input into `argv`. A string `command` is an owner-authored `/bin/sh -c` script and still receives input only on stdin.       | same proof → adapter argv and workspace listing                                     |
| Schema and prototype pollution    | `validateOutput` in `packages/core/src/schema.ts` and `JSON.parse` as used by `parseJsonDeliverable`.                                                                                                                                     | same proof → schema and `__proto__`                                                 |

## Proof 3 — Cross-session bleed and isolation downgrade

Threat class: concurrent principals read each other's relay inbox, a finished task leaves readable state, or a worker claims `oci_container` / `container` while the run was a subprocess (and the reverse direction of an under-reported required level). Mapped to `CVE-2026-109619` and `CVE-2026-115419`.

| Threat class                            | Architectural control                                                                                                                                                                                                                                                                           | Adversarial test                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Wrong-key inbox poll                    | `InMemoryRelay.authenticate` / `openInbox` in `packages/relay/src/fetch.ts` require a recipient-signed `RelayAuth` token from `packages/core/src/relay-auth.ts`.                                                                                                                                | `Proof 3: cross-session state bleed and isolation downgrade` → concurrent inboxes |
| Stale queue and envelope replay         | `receive` dequeues once. `send` rejects a repeated `envelopeId` with `REPLAYED_ENVELOPE`.                                                                                                                                                                                                       | same proof → stale queue                                                          |
| Task code picks its own isolation label | `runContainerOrSubprocessSandbox` and `SandboxAgentAdapter` in `packages/sandbox/src/container.ts` and `packages/adapters/src/sandbox.ts` set `effectiveIsolationLevel` from the runtime path. `runtime: null` falls back to `subprocess_restricted` and reports that string.                   | same proof → runner label                                                         |
| Attestation below the contract          | `VerificationEngine.verify` in `packages/runtime/src/verifier.ts` rejects an `oci_container` contract whose signed attestation is not `oci_container`, unless `sandboxPolicy.allowSubprocessFallback` is true (`ISOLATION_LEVEL_MISMATCH`). A one-byte signature flip cannot upgrade the claim. | same proof → verifier                                                             |

The requester trusts the worker's signature over the host-reported level. Untrusted task output is not that level. `packages/runtime/src/session.ts` copies `reportIsolation` into the signed attestation.

## Proof 4 — Resource exhaustion and SSRF

Threat class: oversized relay bodies, queue floods, nonce replay, and relay URLs aimed at instance metadata, loopback, or `file:`. Mapped to the exhaustion side of `CVE-2026-109618`.

| Threat class                                                              | Architectural control                                                                                                                                                                                                                                                                                                                                         | Adversarial test                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Payload over 1 MiB, 1001st queued envelope, too many recipients           | `InMemoryRelay.send` in `packages/relay/src/fetch.ts` rejects with `RELAY_CAPACITY` when the JSON byte length exceeds `1048576`, the recipient queue length reaches `1000`, or `maxQueues` is exhausted.                                                                                                                                                      | `Proof 4: resource exhaustion and SSRF` → capacity |
| Nonce replay inside the retention window                                  | `authenticate` stores `recipientDid:nonce` and rejects a second use. `maxAuthSeenEntries` caps the FIFO window so the set cannot grow without bound. A nonce that is still inside the window stays rejected.                                                                                                                                                  | same proof → nonce replay                          |
| `http://169.254.169.254`, strict `http://127.0.0.1`, `file:///etc/passwd` | `validateRelayEndpointUrl` and `parseAndVerifyInviteToken` in `packages/core/src/discovery.ts`. Link-local and metadata hosts always throw `SSRF_BLOCKED_RELAY_URL`. Loopback throws when `allowPrivateRelay: false`. `file:` is not an allowed protocol. `RequesterClient.delegate` calls the same check before dialing (`packages/runtime/src/session.ts`). | same proof → SSRF                                  |
| Provider URL `file:///etc/passwd`                                         | `startCredentialProxy` rejects non-HTTP(S) base URLs with `INVALID_PROVIDER_URL`.                                                                                                                                                                                                                                                                             | same proof → provider URL                          |

Public `http:` and `ws:` relay endpoints stay allowed. `conformance/security-hardening.test.ts` (`accepts public http: endpoints`) locks that policy. This proof does not claim cleartext public HTTP is blocked.

## Proof 5 — Envelope and artifact tampering

Threat class: one-byte or one-field edits to a signed `TaskContract` budget or scope, an artifact hash / `UsageReceipt`, or a `RelayAuth` timestamp or signature. Canonicalization is RFC 8785 JCS and the signature algorithm is Ed25519 (`packages/core/src/crypto.ts`).

| Threat class                                            | Architectural control                                                                                                                                                                                           | Adversarial test                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Budget or scope edited after signing                    | `verifyContract` in `packages/core/src/contract.ts` requires `digest(manifest) === digest(proposal.payload)` and a valid Ed25519 signature over the JCS payload.                                                | `Proof 5: cryptographic envelope and artifact tampering` → contract |
| Artifact bytes or `digest` edited; usage receipt edited | `VerificationEngine.verify` requires `verifySigned` on the artifact, attestation, and usage receipt, and `digest(data) === artifact.payload.digest`. The signed artifact is the task receipt this suite checks. | same proof → artifact and usage                                     |
| Stale or flipped `RelayAuth`                            | `verifyRelayAuthToken` rejects timestamps outside five minutes of skew and any signature byte that no longer verifies.                                                                                          | same proof → RelayAuth                                              |

An unmodified contract, delivery, and fresh token are accepted first. A verifier that rejected everything would fail those controls.

## Local verification / ローカルでの確認

From a built checkout (Node.js 22, pnpm 10):

```sh
pnpm test:security-proof
```

Expect every test in `conformance/security-proofs.test.ts` to pass. The full regression suite remains `pnpm test`.

## 日本語

[English](#security-proof--red-team-adversarial-suite) | **日本語**

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
