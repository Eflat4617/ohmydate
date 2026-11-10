import net from 'node:net';

export interface BlackholeProxy {
  /** Connection string that reaches the same PostgreSQL through this proxy. */
  readonly connectionString: string;
  /**
   * Silently drop all bytes in both directions. Existing sockets stay open, so
   * the client sees neither a FIN nor an error: the model of a partition.
   */
  blackhole(): void;
  close(): Promise<void>;
}

/**
 * Minimal TCP proxy used by the reconciler liveness tests. It lets a test kill
 * the PostgreSQL backend behind a connection while the client still believes
 * the socket is alive (blackhole first, then `pg_terminate_backend`).
 */
export async function startBlackholeProxy(targetUrl: string): Promise<BlackholeProxy> {
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = target.port === '' ? 5432 : Number(target.port);
  let blackholed = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (chunk) => {
      if (!blackholed) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!blackholed) client.write(chunk);
    });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
    client.on('close', () => {
      sockets.delete(client);
      if (!blackholed) upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (!blackholed) client.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('TCP proxy did not bind a port');
  }
  const proxied = new URL(targetUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);

  return {
    connectionString: proxied.toString(),
    blackhole() {
      blackholed = true;
    },
    async close() {
      blackholed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface SilentProxy {
  /** Connection string whose host/port point at this proxy. */
  readonly connectionString: string;
  close(): Promise<void>;
}

/**
 * Accepts TCP connections and never answers (no upstream connection at all).
 * Models a startup exchange that hangs: the client sends its startup packet
 * into the void and only `connectionTimeoutMillis` can bound it.
 */
export async function startSilentProxy(targetUrl: string): Promise<SilentProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('error', () => undefined);
    client.on('close', () => sockets.delete(client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('TCP proxy did not bind a port');
  }
  const proxied = new URL(targetUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);
  return {
    connectionString: proxied.toString(),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
