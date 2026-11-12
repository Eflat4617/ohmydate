import type { Id } from '@ohmydate/domain';

export interface RequestAuthSession {
  readonly sessionId: string;
  readonly userId: Id;
  /** Hex SHA-256 of the session's CSRF token (FU-92); never the raw token. */
  readonly csrfTokenHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authSession: RequestAuthSession | null;
  }
}
