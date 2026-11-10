import net from 'node:net';

export interface DropProxy {
  /** Connection string that reaches the same PostgreSQL through this proxy. */
  readonly connectionString: string;
  /** Stop forwarding bytes while leaving existing sockets open. */
  pause(): void;
  /** Resume forwarding for new and still-open connections. */
  resume(): void;
  /**
   * Destroy every proxied socket in both directions. No PostgreSQL FATAL or
   * FIN is sent, so the client sees the same unexpected loss as a failover or
   * a frozen network path that later closes.
   */
  dropConnections(): void;
  close(): Promise<void>;
}

export async function startDropProxy(targetUrl: string): Promise<DropProxy> {
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = target.port === '' ? 5432 : Number(target.port);
  let paused = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (chunk) => {
      if (!paused) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!paused) client.write(chunk);
    });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
    client.on('close', () => {
      sockets.delete(client);
      if (!paused) upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (!paused) client.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('TCP drop proxy did not bind a port');
  }
  const proxied = new URL(targetUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);

  return {
    connectionString: proxied.toString(),
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    dropConnections() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async close() {
      paused = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
