import type { FetchLike } from '../../src/client.js';

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type FakeHandler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export class FakeHttp {
  readonly calls: FakeRequest[] = [];

  readonly #handler: FakeHandler;

  constructor(handler: FakeHandler) {
    this.#handler = handler;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const source = init.headers as Record<string, string>;
      for (const [key, value] of Object.entries(source)) headers[key.toLowerCase()] = value;
    }
    const rawBody = init?.body;
    const body =
      typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    const url = new URL(input);
    const request: FakeRequest = {
      method,
      path: url.pathname,
      url: input,
      body,
      headers,
    };
    this.calls.push(request);
    const response = await this.#handler(request);
    const status = response.status ?? 200;
    const payload = response.body === undefined ? '' : JSON.stringify(response.body);
    return new Response(payload, {
      status,
      headers: {
        'content-type': 'application/json',
        ...response.headers,
      },
    });
  };
}
