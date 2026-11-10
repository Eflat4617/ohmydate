import { IfMatchPattern } from '@ohmydate/contracts';
import type { FastifyRequest } from 'fastify';
import { sha256Hex, canonicalJson } from '../application/canonical.js';
import { ProblemError } from './problem.js';

const IF_MATCH = new RegExp(IfMatchPattern);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * 08 §1: existing-resource mutations require If-Match: W/"<version>".
 * Missing -> 428 (precondition required); malformed -> 400 format error.
 */
export function requireIfMatch(request: FastifyRequest): number {
  const value = headerValue(request, 'if-match');
  if (value === undefined || value.trim() === '') {
    throw new ProblemError({
      status: 428,
      code: 'version_conflict',
      title: 'If-Match header required',
      detail: 'existing-resource mutations must send If-Match: W/"<version>"',
    });
  }
  if (!IF_MATCH.test(value.trim())) {
    throw new ProblemError({
      status: 400,
      code: 'validation_failed',
      title: 'Malformed request',
      detail: 'If-Match must be a weak positive version tag, e.g. W/"1"',
    });
  }
  return Number.parseInt(value.trim().slice(3, -1), 10);
}

/**
 * 08 §1 requires Idempotency-Key on every mutation except login/logout.
 * Routes that do not declare a 428 response (creation POSTs) use 400.
 */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const value = headerValue(request, 'idempotency-key');
  if (value === undefined || value.trim() === '') {
    throw new ProblemError({
      status: 400,
      code: 'validation_failed',
      title: 'Malformed request',
      detail: 'Idempotency-Key header is required for this mutation',
    });
  }
  if (!UUID.test(value.trim())) {
    throw new ProblemError({
      status: 400,
      code: 'validation_failed',
      title: 'Malformed request',
      detail: 'Idempotency-Key must be a UUID',
    });
  }
  return value.trim();
}

export function etagForVersion(version: number): string {
  return `W/"${version}"`;
}

export function etagForBody(body: unknown): string {
  return `W/"${sha256Hex(canonicalJson(body)).slice(0, 16)}"`;
}

export function ifNoneMatch(request: FastifyRequest, etag: string): boolean {
  const value = headerValue(request, 'if-none-match');
  if (value === undefined) return false;
  const candidates = value.split(',').map((entry) => entry.trim());
  return candidates.some(
    (candidate) => candidate === '*' || candidate === etag || candidate === etag.replace(/^W\//, ''),
  );
}

/**
 * 08 §1 pinned rule: hash = method + path (no query string) + normalized body.
 * If-Match and other headers are deliberately excluded.
 */
export function requestHash(request: FastifyRequest, body: unknown): string {
  const path = request.url.split('?', 1)[0] ?? request.url;
  return sha256Hex(
    canonicalJson({
      method: request.method,
      path,
      body: body ?? null,
    }),
  );
}
