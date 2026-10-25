# Separate-process collaboration

After `pnpm install --frozen-lockfile && pnpm build`, run:

```sh
node examples/network-collab/run.mjs
```

This starts a local relay, generates ephemeral owner keys in a fresh `/tmp`
directory, runs Bob's command adapter in a separate CLI process, and runs Alice's
Requester in another process using Bob's printed invite. Both owners independently
sign audit records and verify their JSONL bundles as `VALID`. The result and audit
file directory are printed. No real provider credentials are required.

The example needs loopback socket binding. The conformance suite automatically
uses a fetch bridge when binding is denied with EPERM/EACCES; it can also be tested
explicitly with `ACP_TEST_FETCH_BRIDGE=1 pnpm exec vitest run
conformance/network-collab.test.ts`.

For manual three-terminal operation and real adapters, see the root README.
