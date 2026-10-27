// SPDX-License-Identifier: Apache-2.0

/**
 * CLI spelling of Node's permission model.
 * `--permission` is the stable flag on Node.js >= 22.13 and on Node.js 23+.
 * Earlier Node.js 20 and 22 releases accept `--experimental-permission`.
 * `--allow-fs-read` / `--allow-fs-write` are valid only together with one of these.
 */
export const NODE_PERMISSION_FLAGS = ['--permission', '--experimental-permission'] as const;
export type NodePermissionFlag = (typeof NODE_PERMISSION_FLAGS)[number];

/**
 * What a sandbox run can honestly claim about Node's permission model.
 * `kernelNetworkIsolated` is true only for `oci_container` (`--network none`).
 * The permission model does not deny `fetch`, `node:net`, `node:http`,
 * `node:https`, `node:dns`, or `node:dgram`.
 * `permissionModelActive` means a permission flag was passed. It is false for
 * `oci_container`, which uses the container runtime instead of that flag.
 */
export interface SandboxBoundaryMetadata {
  nodePermissionFlag: NodePermissionFlag | null;
  permissionModelActive: boolean;
  kernelNetworkIsolated: boolean;
}

export interface NodePermissionProbe {
  /** Flags the binary advertises. Defaults to `process.allowedNodeEnvironmentFlags`. */
  flags?: Iterable<string>;
  /** `process.versions.node`, with or without a leading `v`. */
  nodeVersion?: string;
}

export interface ResolvedNodePermission {
  flag: NodePermissionFlag | null;
  /** Empty when neither permission flag is supported. Never contains `--allow-fs-*` alone. */
  args: string[];
  boundary: SandboxBoundaryMetadata;
}

/** Boundary recorded for Podman/Docker `--network none` runs. */
export const OCI_CONTAINER_BOUNDARY: SandboxBoundaryMetadata = {
  nodePermissionFlag: null,
  permissionModelActive: false,
  kernelNetworkIsolated: true,
};

export function parseNodeVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
  };
}

/** True when the documented stable spelling is `--permission` (Node.js >= 22.13, or >= 23). */
export function prefersStableNodePermissionFlag(nodeVersion: string): boolean {
  const { major, minor } = parseNodeVersion(nodeVersion);
  return major > 22 || (major === 22 && minor >= 13);
}

function advertisedFlags(probe?: NodePermissionProbe): Set<string> {
  return new Set(probe?.flags ?? process.allowedNodeEnvironmentFlags);
}

/**
 * Chooses `--permission` or `--experimental-permission` for `process.execPath`.
 * Returns null when `allowedNodeEnvironmentFlags` lists neither, so callers can
 * start the child without `--allow-fs-*` and record `permissionModelActive: false`.
 * Version selects the spelling when both flags are advertised. A binary that
 * lists only one spelling uses that spelling.
 */
export function detectNodePermissionFlag(probe?: NodePermissionProbe): NodePermissionFlag | null {
  const flags = advertisedFlags(probe);
  const version = probe?.nodeVersion ?? process.versions.node;
  const hasStable = flags.has('--permission');
  const hasExperimental = flags.has('--experimental-permission');
  if (prefersStableNodePermissionFlag(version) && hasStable) return '--permission';
  if (hasExperimental) return '--experimental-permission';
  if (hasStable) return '--permission';
  return null;
}

/** Subprocess claim. `kernelNetworkIsolated` stays false even when the flag is active. */
export function subprocessSandboxBoundary(probe?: NodePermissionProbe): SandboxBoundaryMetadata {
  const flag = detectNodePermissionFlag(probe);
  return {
    nodePermissionFlag: flag,
    permissionModelActive: flag !== null,
    kernelNetworkIsolated: false,
  };
}

function assertScratchDirectory(directory: string): void {
  // A comma is a permission-model path separator, so it would widen the allowlist.
  if (
    directory.length === 0 ||
    directory === '/' ||
    directory.includes(',') ||
    directory.includes('\0')
  )
    throw new Error('INVALID_SANDBOX_DIRECTORY');
}

/**
 * Permission-model argv for one scratch directory.
 * `--allow-fs-read` and `--allow-fs-write` are omitted when no permission flag exists,
 * because Node rejects them unless `--permission` or `--experimental-permission` is active.
 */
export function resolveNodePermissionArgs(
  directory: string,
  probe?: NodePermissionProbe,
): ResolvedNodePermission {
  const boundary = subprocessSandboxBoundary(probe);
  if (!boundary.nodePermissionFlag) return { flag: null, args: [], boundary };
  assertScratchDirectory(directory);
  return {
    flag: boundary.nodePermissionFlag,
    args: [
      boundary.nodePermissionFlag,
      '--allow-fs-read=' + directory,
      '--allow-fs-write=' + directory,
    ],
    boundary,
  };
}
