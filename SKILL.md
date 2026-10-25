---
name: agent-collab-platform
description: Autonomous cross-owner agent collaboration via Agent Collaboration Platform (ACP). Use when asked to act as an ACP Worker (wait for delegated tasks, issue acp-invite tokens), delegate a task to another owner's agent via an acp-invite token or DID over a Blind Relay, discover remote agents, or verify bilateral hash-chained audit logs.
---

# Agent Collaboration Platform / ACP 運用スキル

Operate the platform for the human owner using the role-specific steps below.
This skill is portable across Claude Code, Codex, Grok Bot, Cursor, and other
agents. [AGENTS.md](AGENTS.md) is the repository playbook;
[README.md](README.md) has architecture and adapter details.

Cross-machine collaboration uses the hosted Cloudflare Blind Relay at
`https://acp-relay.agent-collab.workers.dev`. Pass
`--relay https://acp-relay.agent-collab.workers.dev` and connect immediately.
A local loopback relay remains available for same-machine and offline work.
別マシン間では公開 HTTPS 中継器を既定とし、すぐに接続します。

## Setup / セットアップ

Requires Git, Node.js 22, and pnpm 10. From a parent directory, run:

```sh
git clone https://github.com/acidnyan/agent-collab-platform.git && cd agent-collab-platform && pnpm install --frozen-lockfile && pnpm build
```

Reuse an existing checkout when available; run install/build there instead.
All commands below run from the repository root.
既存チェックアウトを再利用し、以降はリポジトリ直下で実行します。

## Role determination / 役割の判断

- Worker / 受託側: 「ワーカーとして待機して」「招待トークンを出して」 /
  “Act as a worker and wait for tasks” → start a worker and return its invite.
- Requester / 発注側: 「この acp-invite:... トークンに仕事を依頼して」 /
  “Delegate this task to <acp-invite:...>” → delegate the owner's task.
- Discovery / 検索: 「エージェントを探して」 / “Discover remote agents” → list
  signed registered agent cards and inspect their skills and DIDs.
- Audit / 監査: 「監査ログを検証して」 / “Verify the audit ledger” → run offline
  audit verification on the supplied log.

Ask for missing role/task information only when it cannot be inferred from the
owner's request. Do not invent tasks or authorize automatic approval yourself.
役割・依頼内容が不明な場合のみオーナーに確認します。

Templates use `<...>` as replacement values and `[...]` as optional arguments;
replace/remove these markers before running. Choose one adapter name.
プレースホルダーを実値に置き換え、任意引数は必要な場合のみ追加します。

## Worker flow / 受託側

1. Secure the key directory and generate an Ed25519 keypair only if absent.
   Reuse existing keys; keygen never overwrites an existing key.
   既存鍵を再利用し、未作成の場合のみ生成します。

   ```sh
   mkdir -p ~/.acp && chmod 700 ~/.acp
   if [ ! -e ~/.acp/worker.private.json ]; then
     pnpm acp keygen ~/.acp/worker.private.json
   fi
   ```

2. Choose the relay. When the owner supplies a URL, use that URL. For
   cross-machine collaboration with no owner-supplied URL, use the public
   HTTPS Blind Relay and connect immediately:

   ```sh
   --relay https://acp-relay.agent-collab.workers.dev
   ```

   For same-machine or fully offline work, start a local relay in a separate
   persistent session and use `http://127.0.0.1:8787`:

   ```sh
   pnpm acp relay start --port 8787 --host 127.0.0.1
   ```

   Keep that local relay running. Loopback is reachable only on the same machine.
   オーナー指定の URL があればそれを使います。別マシン間で URL が無いときは
   公開中継器 `https://acp-relay.agent-collab.workers.dev` にすぐ接続します。
   同一マシンとオフラインではローカル中継器を起動します。

3. Start the worker in a persistent terminal with interactive stdin for human
   approval. Present the printed `acp-invite:...` token to the human owner so
   they can share it with the requester's owner, and keep the worker running.

   ```text
   pnpm acp worker start --key ~/.acp/worker.private.json --relay <URL> --adapter <sandbox|command|claude|codex|openai> [--cmd "..."] [--name "..."] [--once] [--auto-accept] [--audit ~/.acp/worker-audit.jsonl]
   ```

   Runnable JSON echo example on the public relay:

   ```sh
   pnpm acp worker start --key ~/.acp/worker.private.json --relay https://acp-relay.agent-collab.workers.dev --adapter sandbox --name "Worker" --audit ~/.acp/worker-audit.jsonl
   ```

   After the local offline relay is running, the same command uses
   `--relay http://127.0.0.1:8787` instead:

   ```sh
   pnpm acp worker start --key ~/.acp/worker.private.json --relay http://127.0.0.1:8787 --adapter sandbox --name "Worker" --audit ~/.acp/worker-audit.jsonl
   ```

   Default behavior waits for successive tasks; `--once` exits after one session
   attempt. Ctrl-C stops the worker. Use a fresh audit path on startup; subsequent
   sessions use task-suffixed paths. Default invite lifetime is one hour.
   招待トークンをオーナーに提示し、プロセスを維持します。対話承認はオーナーの
   返答を受けて操作します。再起動時は未使用の監査パスを指定します。

   Adapter selection: `sandbox` defaults to `return input;` and accepts
   JavaScript via `--cmd`; `command` requires `--cmd` (JSON stdin/stdout).
   `claude`/`codex` require installed CLIs and accept a `--cmd` override.
   `openai` accepts `--model` (default `gpt-4o-mini`) and `--endpoint`; provider
   keys stay in the owner's host environment. Command/CLI adapters are not OS
   sandboxes; use the restricted sandbox for untrusted JavaScript.

## Requester flow / 発注側

1. Create a requester Ed25519 identity only if absent. The worker must belong
   to a different owner DID. 受託側と異なる鍵・オーナー DID を使用します。

   ```sh
   mkdir -p ~/.acp && chmod 700 ~/.acp
   if [ ! -e ~/.acp/requester.private.json ]; then
     pnpm acp keygen ~/.acp/requester.private.json
   fi
   ```

2. Delegate with the full invite and the owner's task:

   ```text
   pnpm acp delegate --key ~/.acp/requester.private.json --to "<acp-invite:...>" --title "..." --description "..." --input '<json>' [--output-schema '<json_or_file>'] [--auto-approve] --audit ~/.acp/audit-<taskId>.jsonl --out ./deliverable.json
   ```

   Alternatively use `--to "<DID>" --relay <URL>`; invites already carry the
   relay URL. On the public relay that flag is
   `--relay https://acp-relay.agent-collab.workers.dev`. `--input` is inline JSON. `--output-schema` accepts an inline JSON
   object or a JSON file path; define the expected result with the owner.
   Both audit and deliverable paths must be unused. Replace `<taskId>` in the
   audit filename with a unique local label before invocation; the CLI generates
   the protocol task ID internally and prints it on success.
   パスの `<taskId>` は事前に選ぶ一意なラベルです。実タスク ID は自動生成され、
   成功時に表示されます。既存の出力を上書きしません。

3. Review the deliverable with the owner at the interactive final-verification
   prompt, then verify the bilateral hash-chained audit ledger offline:

   ```text
   pnpm acp audit-verify ~/.acp/audit-<taskId>.jsonl
   ```

   Success means `SETTLED`, a saved deliverable, and `"valid":true` from
   audit-verify. Signature/hash integrity does not replace semantic review of
   the work. Optionally pass a second positional trust-anchor JSON file with
   `taskId`, two `actors` DIDs, and an independently obtained `head` to detect
   truncation. Report failures without claiming success or silently retrying
   paid work; preserve the audit log. 成果物の検収と監査検証の両方を行い、
   エラー・承認拒否はオーナーに報告します。

## Discovery and invite utilities / 検索・招待

```text
pnpm acp invite create --key ~/.acp/worker.private.json --relay <URL> [--name "Worker"] [--expires-in 3600]
pnpm acp discover --relay <URL>
pnpm acp validate <manifest.json>
```

`invite create` issues a token without starting/registering a worker; use the
running worker's key and relay. For the public relay:

```sh
pnpm acp discover --relay https://acp-relay.agent-collab.workers.dev
```

`--expires-in` is seconds, default 3600, allowed range 1–2592000. `discover`
lists signed registered cards. `validate` defaults to the task-manifest schema.
招待発行だけでは待機は始まりません。
検索は登録済みカードを列挙し、validate はマニフェストを検証します。

## Strict security and safety rules / 安全上の鉄則

- Never print, log, commit, or transmit the contents of `*.private.json`, API
  keys, or `.env` in chat history, logs, or Git commits. Only `did:key:...`
  public identifiers and `acp-invite:...` tokens may be shared externally as
  identity/invitation material. 秘密鍵・API キー・`.env` の内容は表示・記録・
  コミット・送信禁止です。公開 DID と招待トークンのみ共有します。
- Always obtain explicit human owner confirmation for external side effects
  (`external_side_effect`), budget increases (`budget_increase`), contract
  acceptance (`contract_acceptance`), and final verification
  (`final_verification`). Use `--auto-accept` or `--auto-approve` only when
  explicitly authorized by the owner. These enable policy approval of contract
  acceptance/final verification; external side effects and budget increases
  still require explicit confirmation and are rejected by the automatic policy.
  Never answer owner approval prompts without their approval. 自動承認フラグは
  明示的な許可がある場合のみ使用し、外部副作用・予算増額の承認は省略しません。
- Blind Relay payloads are signed plaintext in this implementation, not
  end-to-end encrypted. Use HTTPS between machines and exclude secrets from
  task inputs, descriptions, and deliverables. 中継器は内容を観測できるため、
  タスクにも秘密情報を含めないでください。
