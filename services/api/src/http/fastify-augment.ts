import type { Id } from '@ohmydate/domain';

export interface RequestAuthSession {
  readonly sessionId: string;
  readonly userId: Id;
  readonly csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authSession: RequestAuthSession | null;
  }
}
