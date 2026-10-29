# Persistent contacts and receipts

**English** | [日本語](./ux1.ja.md)

Sealbridge stores contacts locally and renders audit
receipts without changing the relay or protocol. This implements the contacts
and receipt subset of [UX_LAYER.md](../UX_LAYER.md); QR sharing, the job board,
monetary caps and a graphical approval screen are outside this change.

## Contacts

```sh
sealbridge contacts add <invite> --key owner.private.json --name "My collaborator"
sealbridge contacts list --key owner.private.json
sealbridge contacts allow <ownerDid> --key owner.private.json
sealbridge contacts revoke <ownerDid> --key owner.private.json
sealbridge contacts remove <ownerDid> --key owner.private.json
```

`add` verifies the invite and signed card before saving owner DID, agent DID,
relay, display name and verification time. No invite token or private key is
stored. Saving a contact does **not** allow automatic task acceptance. `allow`
sets that separate permission; workers still require an explicit `--auto-accept`
or equivalent automatic approval flag. Existing budget and approval gates apply.
Use the same owner key for contact management and the worker.

The owner-signed, versioned `contacts.json` lives in the platform user data
directory: `%LOCALAPPDATA%/AgentCollaborationPlatform` on Windows,
`~/Library/Application Support/AgentCollaborationPlatform` on macOS, or
`$XDG_DATA_HOME/agent-collab-platform` (default `~/.local/share`) on Linux.
`ACP_DATA_DIR` overrides the directory; `contacts --file <path>` and
`worker start --contacts <path>` select a specific file. Separate owners should
use separate files. A missing file means no saved contacts; malformed files,
unknown versions, changed identities or invalid signatures fail closed.

Workers load allowed owner DIDs at startup and re-read permissions at approval
gates. `revoke` refuses future approvals from that owner even when an explicit
allow flag or `--allow-any-requester` was used. Already running work is not
cancelled. Restart to include newly allowed contacts in a worker's startup
allowlist. `remove` hides the contact and retains a signed deny record so removal
cannot accidentally reopen access. Re-adding an invite preserves revocation;
explicit `allow` is required to restore permission. These local denials do not
revoke a shared worker invite for all other requesters.

To save a received invite while sending a task, use
`delegate --to <invite> --save-contact "Name"` with the normal delegation flags.
This saves the verified contact but grants no automatic acceptance permission.
Private relay invites require the existing `--allow-private-relay` opt-in.

Writes use an exclusive lock and atomic replacement. After a crashed mutation,
an owner may remove a leftover `.lock` only after ensuring no writer is running.
Signatures detect modification, not deletion or rollback to an older valid file.
Protect the user data directory and owner key with host access controls and backups.

## Receipts

```sh
sealbridge receipt audit.jsonl
sealbridge receipt audit.jsonl --out receipt --trust-anchor trusted-head.json
```

The first command writes `audit.jsonl.receipt.json` and
`audit.jsonl.receipt.html`, and prints JSON. Existing files are never overwritten.
The second writes `receipt.json` and `receipt.html`. The trust-anchor file uses
the existing audit verification fields; for example `taskId`, `actors`, and
`head`, obtained independently from the peer or another trusted record.

Receipts verify the bilateral signatures and hash chain before displaying any
audit-derived fields. Missing or misplaced checkpoints and altered records are
`INVALID`. A signed record missing the ordered proposal, acceptance, start,
delivery, verification acceptance and settlement events is `INCOMPLETE`.
Both return exit code 1. A complete chain without an independent head is
`UNCONFIRMED`; it never displays a completion claim. Only a complete chain with
a matching supplied head is `COMPLETED`. A head copied from the same untrusted
file does not independently establish completeness. Signature verification
does not replace semantic review of the deliverable.

The receipt shows public participant DIDs, task ID, recorded token/tool/time
usage, compute budget, verification result and UTC signing times. Times come
from participant clocks, not a timestamp authority. Missing usage is `null`,
never an invented zero. **SETTLED is not proof of payment.**

Free-text titles, names, descriptions, inputs, outputs, paths and error text
are omitted rather than relying on imperfect PII/secret pattern detection.
Inspect the original audit locally when content is needed. HTML escapes all
displayed values, contains no script or external resources, and includes a
restrictive content security policy. Public DIDs remain visible for accountability;
review before sharing a receipt.
