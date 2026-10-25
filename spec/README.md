# ACP Protocol Specification (`spec/`)

**結論**: 本ディレクトリはプログラミング言語に依存しないプロトコル仕様と JSON Schema (Draft 2020-12) の正本（Single Source of Truth）を定義する。すべてのプロトコルオブジェクトは **RFC 8785 (JCS: JSON Canonicalization Scheme)** で正規化されたバイト列に対して **SHA-256 ダイジェスト** と **Ed25519 署名** を計算する。

---

## 1. 共通暗号・シリアライズ規則

1. **エンコーディング**: UTF-8 JSON（I-JSON サブセット準拠、浮動小数点の誤差を避けるため金額・トークン数・秒数はすべて整数 `integer` で表現する）。
2. **正規化（Canonicalization）**: 署名およびハッシュ計算の対象となるJSONオブジェクトは、[RFC 8785 (JCS)](https://www.rfc-editor.org/info/rfc8785/) に従ってキーを辞書順ソートし空白を除去した決定論的バイト列に変換する。
3. **識別子（Principal ID）**: オーナーおよびエージェントの識別子は W3C `did:key` 形式（Ed25519公開鍵のMultibase base58btcエンコード、例: `did:key:z6Mk...`）を使用する。
4. **ダイジェスト表記**: `"sha256:<64文字の16進小文字>"`（例: `"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"`）。
5. **署名表記**: `"ed25519:<base64urlまたは128文字の16進小文字>"`。署名計算時は対象オブジェクトから `signature` / `signatures` フィールドを除いた状態でJCS正規化を行う。

---

## 2. コアスキーマ一覧

| ファイル名 | ステータス | 役割 |
| :--- | :--- | :--- |
| [`task-manifest.schema.json`](./task-manifest.schema.json) | **Draft v0.1 (検証済)** | 依頼側（Requester）が提示するタスク仕様・入出力JSON Schema・受入基準・検証方法・予算上限・付与Capability・隔離要件の定義 |
| `capability-token.schema.json` | Planned (M0) | UCAN/Biscuit風の減衰可能スコープトークン定義（`issuer`, `audience`, `taskId`, `resources`, `allowedTools`, `argConstraints`, `maxInvocations`, `maxDelegationDepth`, `proofs`） |
| `envelope.schema.json` | Planned (M0) | Relay通過用の署名付きメッセージエンベロープ（`envelopeId`, `taskId`, `seq`, `eventType`, `senderDid`, `recipientDid`, `payload`, `signature`）および受領確認 `AckReceipt` |
| `audit-entry.schema.json` | Planned (M0) | 双方向署名ハッシュチェーン台帳エントリおよび `UsageReceipt` / `ApprovalReceipt` |

---

## 3. スキーマ検証コマンド

```bash
npx --yes -p ajv-cli@5 -p ajv-formats@3 ajv validate \
  --spec=draft2020 \
  -c ajv-formats \
  -s spec/task-manifest.schema.json \
  -d spec/examples/sample-task-manifest.json
```

## M0–M1 executable wire profile

The new `capability-token`, `usage-receipt`, `approval-receipt`, `ack-receipt`,
`envelope` and `audit-entry` schemas are implemented. Run `pnpm validate:schemas`
to compile all schemas and validate every example using Ajv Draft 2020-12.
The original TaskManifest schema and example remain unchanged.

Signed protocol objects use `{ "payload": <object>, "signature": <block> }`.
Let `D = "sha256:" + hex(SHA256(UTF8(JCS(payload))))`. The block contains
`signerDid`, `canonicalization: "RFC8785-JCS"`, `payloadDigest: D`, `signedAt`, and
`signature: "ed25519:" + base64url(64-byte-signature)` without padding.
The exact Ed25519 signature preimage is:

```text
UTF8(JCS({payload, signerDid, canonicalization, payloadDigest, signedAt}))
```

This covers the payload and signature metadata, and does not sign the signature
bytes themselves. It refines the draft's general rule above. JCS inputs must be
finite JSON data with valid Unicode; undefined, cycles, sparse arrays, nonfinite
numbers, custom object instances and lone surrogates are rejected. Content
addresses for JSON artifacts use `SHA256(UTF8(JCS(data)))`; `digestBytes` is
available for exact binary content. did:key encodes the Ed25519 public key with
multicodec bytes `ed 01` and base58btc multibase `z`.

Capability proofs are an ordered root-to-leaf array of signed tokens. Each child
binds `parentHash` to the SHA-256 digest of its complete signed parent, changes
issuer to the parent's audience, retains task binding, narrows the resource,
tools and argument schemas, never raises maxCalls or expiry, never backdates
notBefore, and decreases maxDepth by at least one. A zero depth forbids another
child. Wire token `maxCalls`/`maxDepth` correspond to manifest grant
`maxInvocations`/`maxDelegationDepth`. Argument schemas are indexed by tool name.
Only identical schemas or direct `allOf` inheritance are accepted. See the
security model for supported scope and schema syntax.

Approval receipt gate names map to the manifest's names:

| Receipt gate | Manifest gate |
| --- | --- |
| contract_acceptance | GATE_CONTRACT_ACCEPT |
| external_side_effect | GATE_EXTERNAL_SIDE_EFFECT |
| budget_increase | GATE_BUDGET_OVERRUN |
| redelegation | GATE_SUB_DELEGATION |
| final_verification | GATE_DELIVERY_ACCEPT |

Owner-signed approval receipts bind the task, gate, exact target digest and
APPROVED/REJECTED decision. Gate instances reject receipt replay. Signed
transitions bind contract digest, task, prior state and zero-based sequence. The
M1 transition profile uses PROPOSED, ACCEPTED, IN_PROGRESS, DELIVERED,
VERIFY_ACCEPT, VERIFY_REJECT, SETTLED, CANCELLED and DISPUTED; the exhaustive table
is in `conformance/state-transitions.json`. PROPOSE establishes PROPOSED. Negotiation,
retry and timeout-specific states in the architecture remain later extensions.

Audit body fields are `taskId`, zero-based `seq`, `prevEntryHash` (null at genesis),
`actorDid`, `receiverDid`, `eventType`, `payload`. `entryHash = digest(body)`;
`actorSignature` signs the body and `counterSignature` is a signed AckReceipt
binding that hash, task and both parties. The final signed checkpoint fixes the
count, head and actors and is signed again by the other party. JSONL contains
`{"entry": ...}` records followed by one `{"checkpoint": ...}` record. Bundles
contain `{entries, checkpoint}`. The checkpoint is required for offline verification.
An independent latest head is required to detect rollback to an older valid bundle.

A2A AgentCard, Task, Message and Artifact retain SDK wire shapes, carried inside
signed ACP envelopes. The bridge uses the installed A2A SDK 0.3 wire profile;
ACP contract/receipt objects are overlay payloads rather than changes to A2A.
MCP `tools/call` requests and results use the official SDK and are physically
proxied outside the sandbox. Unknown tools and metadata-free bypasses are denied.

## M2/M3 additive discovery and session profile

The M0/M1 JSON schemas and examples remain unchanged. Signed AgentCards and
invites use the same `Signed<T>` preimage. `AgentCard` contains ownerDid,
agentDid, relayEndpoint, skills (including optional JSON input/output schemas),
costModes, name, description and version. The owner signs the card.
`AgentInvite` binds the complete signed card to the same ownerDid/agentDid and
relayUrl, plus issuedAt/expiresAt. Parsers reject invalid signatures, mismatched
identities/routes, future issuance and expiry. URI encoding is either
`acp-invite:<base64url(JSON(Signed<AgentInvite>))>` or
`acp://invite?token=<same-base64url>`.

Session envelopes have monotonic sequence numbers per sender. Each application
event is followed by an `AUDIT_ENTRY` envelope carrying a signed audit body;
the receiver returns `AUDIT_ACK` carrying its signed AckReceipt. Both sides
append the identical AuditEntry. `CHECKPOINT` and `CHECKPOINT_ACK` exchange the
final signed checkpoint and countersignature. DELIVER includes artifact, usage,
attestation and its signed transition. Attestations may add
`effectiveIsolationLevel`; original M1 attestations remain valid.
