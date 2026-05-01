/**
 * URL helper utilities
 *
 * Shared logic for resolving the request's absolute base URL in a way that
 * survives reverse proxies on non-standard ports.
 */

import type { Request } from 'express';

/**
 * Resolve the request's absolute base URL, honoring X-Forwarded-Port for
 * reverse proxies on non-standard ports. `trust proxy` must be enabled
 * (set in server.ts) for req.protocol to reflect X-Forwarded-Proto.
 *
 * Uses req.get('host') (raw Host header) rather than req.hostname so behavior
 * stays consistent with existing call sites. Setups where the proxy rewrites
 * Host without preserving the original should set BASE_URL instead.
 */
export function resolveBaseUrl(req: Request): string {
  if (process.env.BASE_URL) {
    const v = process.env.BASE_URL;
    return v.endsWith('/') ? v.slice(0, -1) : v;
  }

  const proto = req.protocol;
  const hostHeader = (req.get('host') || 'localhost').split(',')[0].trim();

  // Bare IPv6 (e.g., "[::1]") has brackets but no port; bracketed-with-port is "[::1]:8080".
  const hostHasPort = hostHeader.startsWith('[')
    ? hostHeader.includes(']:')
    : hostHeader.includes(':');
  if (hostHasPort) return `${proto}://${hostHeader}`;

  const fwdRaw = (req.get('x-forwarded-port') || '').split(',')[0].trim();
  const fwdPort = Number(fwdRaw);
  const isDefault = (proto === 'https' && fwdPort === 443) || (proto === 'http' && fwdPort === 80);
  if (Number.isFinite(fwdPort) && fwdPort > 0 && fwdPort < 65536 && !isDefault) {
    return `${proto}://${hostHeader}:${fwdPort}`;
  }

  return `${proto}://${hostHeader}`;
}
