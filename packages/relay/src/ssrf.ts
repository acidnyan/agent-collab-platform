// SPDX-License-Identifier: Apache-2.0
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { validateIpAddress, validateRelayEndpointUrl } from '@acp/core';
import type { RelayEndpointPolicy } from '@acp/core';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver. Tests pass a mock; production uses dns.lookup. */
export interface RelayLookup {
  (
    hostname: string,
    options?: { all?: boolean; family?: number; verbatim?: boolean },
  ): Promise<ResolvedAddress[]>;
}

export interface RelayClientSecurityOptions extends RelayEndpointPolicy {
  lookup?: RelayLookup;
}

export interface ResolvedRelayEndpoint {
  url: URL;
  addresses: ResolvedAddress[];
  /** Returns only the addresses accepted before the socket is opened. */
  lookup: LookupFunction;
}

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((item) => ({
    address: item.address,
    family: item.family === 6 ? 6 : 4,
  }));
}

function pinnedNodeLookup(addresses: ResolvedAddress[]): LookupFunction {
  const listed = addresses.map((item) => ({ address: item.address, family: item.family }));
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const family = options.family;
    const selected =
      family === 4 || family === 6 ? listed.filter((item) => item.family === family) : listed;
    const chosen = selected.length > 0 ? selected : listed;
    if (chosen.length === 0) {
      callback(Object.assign(new Error('SSRF_BLOCKED_RELAY_URL'), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (options.all) {
      callback(null, chosen);
      return;
    }
    callback(null, chosen[0].address, chosen[0].family);
  };
  return lookup;
}

function literalAddress(hostname: string): ResolvedAddress | undefined {
  if (hostname.includes(':')) return { address: hostname, family: 6 };
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(hostname))
    return { address: hostname, family: 4 };
  return undefined;
}

/**
 * Resolve every A/AAAA answer and reject the endpoint when any address is disallowed.
 * Literal IP hosts skip DNS. The returned lookup never resolves again.
 */
export async function resolveAndValidateRelayEndpoint(
  value: string,
  options: RelayClientSecurityOptions = {},
): Promise<ResolvedRelayEndpoint> {
  validateRelayEndpointUrl(value, { allowPrivateRelay: options.allowPrivateRelay });
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  const literal = literalAddress(hostname);
  let addresses: ResolvedAddress[];
  if (literal) {
    validateIpAddress(literal.address, { allowPrivateRelay: options.allowPrivateRelay });
    addresses = [literal];
  } else {
    let found: ResolvedAddress[];
    try {
      found = await (options.lookup ?? systemLookup)(hostname, { all: true, verbatim: true });
    } catch (error) {
      if (error instanceof Error && error.message === 'SSRF_BLOCKED_RELAY_URL') throw error;
      throw new Error('SSRF_BLOCKED_RELAY_URL');
    }
    if (!Array.isArray(found) || found.length === 0) throw new Error('SSRF_BLOCKED_RELAY_URL');
    addresses = found.map((item) => ({
      address: item.address,
      family: item.family === 6 ? 6 : 4,
    }));
    for (const item of addresses)
      validateIpAddress(item.address, { allowPrivateRelay: options.allowPrivateRelay });
  }
  return { url, addresses, lookup: pinnedNodeLookup(addresses) };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key === 'host') return;
    out[key] = value;
  });
  return out;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('ABORT'), { name: 'AbortError' });
}

function sameOrigin(target: URL, endpoint: URL): boolean {
  return (
    target.protocol === endpoint.protocol &&
    target.hostname === endpoint.hostname &&
    target.port === endpoint.port
  );
}

async function pinnedRequest(
  pin: ResolvedRelayEndpoint,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const target = requestUrl(input);
  if (!sameOrigin(target, pin.url)) throw new Error('SSRF_BLOCKED_RELAY_URL');
  const secure = target.protocol === 'https:';
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new Error('SSRF_BLOCKED_RELAY_URL');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const lib = secure ? https : http;
  const signal = init?.signal ?? undefined;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname,
        port: target.port === '' ? undefined : Number(target.port),
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        path: target.pathname + target.search,
        headers: headerRecord(init?.headers),
        lookup: pin.lookup,
        ...(secure ? { servername: hostname } : {}),
      },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (key === 'transfer-encoding' || key === 'content-length') continue;
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else headers.set(key, value);
        }
        const status = incoming.statusCode ?? 0;
        // 204/205/304 cannot carry a body. A stream argument makes Response throw.
        const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
        if (nullBody) incoming.resume();
        const body = nullBody
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        try {
          resolve(
            new Response(body, {
              status,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
    const fail = (error: Error) => {
      if (signal?.aborted) reject(abortError(signal));
      else reject(error);
    };
    req.on('error', fail);
    if (signal) {
      const onAbort = () => req.destroy();
      if (signal.aborted) {
        req.destroy();
        reject(abortError(signal));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    const body = init?.body ?? null;
    if (body == null) req.end();
    else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
    else if (body instanceof URLSearchParams) req.end(body.toString());
    else req.destroy(new Error('UNSUPPORTED_BODY'));
  });
}

/** Fetch that dials only the addresses accepted by resolveAndValidateRelayEndpoint. */
export function createPinnedRelayFetch(
  endpoint: string | ResolvedRelayEndpoint,
  options: RelayClientSecurityOptions = {},
): typeof fetch {
  let pending: Promise<ResolvedRelayEndpoint> | undefined;
  const resolve = () => {
    if (typeof endpoint !== 'string') return Promise.resolve(endpoint);
    pending ??= resolveAndValidateRelayEndpoint(endpoint, options);
    return pending;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    pinnedRequest(await resolve(), input, init)) as typeof fetch;
}
