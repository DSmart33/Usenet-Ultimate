/**
 * NNTP Connection Management
 *
 * Handles NNTP authentication, TLS/plain connections, timeout handling,
 * and connection pooling for reusing authenticated sockets within a batch.
 */

import * as net from 'net';
import * as tls from 'tls';

/**
 * Connect to Usenet and authenticate
 */
export async function connectToUsenet(provider: { host: string; port: number; useTLS: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved && socket) {
        resolved = true;
        socket.destroy();
        reject(new Error('Connection timeout'));
      }
    }, 10000);

    let buffer = '';

    const socket = provider.useTLS
      ? tls.connect({ host: provider.host, port: provider.port, rejectUnauthorized: false })
      : net.connect({ host: provider.host, port: provider.port });
    socket.setNoDelay(true);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('data', dataHandler);
      socket.removeListener('error', errorHandler);
      socket.removeListener('close', closeHandler);
      socket.removeListener('end', endHandler);
    };

    const dataHandler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // Server greeting
        if (line.startsWith('200') || line.startsWith('201')) {
          if (provider.username && provider.password) {
            socket.write(`AUTHINFO USER ${provider.username}\r\n`);
          } else {
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve(socket);
            }
          }
        }
        // Username accepted
        else if (line.startsWith('381')) {
          socket.write(`AUTHINFO PASS ${provider.password}\r\n`);
        }
        // Authentication successful
        else if (line.startsWith('281')) {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(socket);
          }
        }
        // Authentication failed
        else if (line.startsWith('481') || line.startsWith('482')) {
          if (!resolved) {
            resolved = true;
            cleanup();
            socket.destroy();
            reject(new Error('Authentication failed'));
          }
        }
      }
    };

    const errorHandler = (error: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(error);
      }
    };

    const closeHandler = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error('Connection closed by server'));
      }
    };

    const endHandler = () => {
      closeHandler();
    };

    socket.on('data', dataHandler);
    socket.on('error', errorHandler);
    socket.on('close', closeHandler);
    socket.on('end', endHandler);
  });
}

/**
 * NNTP Connection Pool — reuses authenticated sockets within a batch
 * to avoid repeated TLS handshakes across multiple NZB health checks.
 */
export class NntpConnectionPool {
  private pools = new Map<string, (net.Socket | tls.TLSSocket)[]>();

  private key(provider: { host: string; port: number; username: string }): string {
    return `${provider.host}:${provider.port}:${provider.username}`;
  }

  async acquire(provider: { host: string; port: number; useTLS: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {
    const k = this.key(provider);
    const stack = this.pools.get(k);
    if (stack && stack.length > 0) {
      const socket = stack.pop()!;
      // Verify the socket is still alive
      if (!socket.destroyed && socket.writable) {
        return socket;
      }
      // Socket is dead, fall through to create new
      try { socket.destroy(); } catch {}
    }
    return connectToUsenet(provider);
  }

  release(provider: { host: string; port: number; username: string }, socket: net.Socket | tls.TLSSocket): void {
    if (socket.destroyed || !socket.writable) {
      try { socket.destroy(); } catch {}
      return;
    }
    const k = this.key(provider);
    let stack = this.pools.get(k);
    if (!stack) {
      stack = [];
      this.pools.set(k, stack);
    }
    stack.push(socket);
  }

  destroyAll(): void {
    for (const [, stack] of this.pools) {
      for (const socket of stack) {
        try { socket.destroy(); } catch {}
      }
    }
    this.pools.clear();
  }
}
