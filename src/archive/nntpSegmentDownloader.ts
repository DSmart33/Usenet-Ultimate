/**
 * NNTP Segment Downloader
 *
 * Downloads archive segments from Usenet via NNTP protocol.
 * Handles yEnc decoding of binary article bodies.
 */

import * as net from 'net';
import * as tls from 'tls';
import { connectToUsenet } from '../health/nntpConnection.js';
import type { UsenetConfig } from './types.js';

/**
 * Download first segments of a file from Usenet to read archive header
 * Most archive formats store headers at the beginning (first 32-64KB)
 */
export async function downloadArchiveHeader(
  messageIds: string[],
  config: UsenetConfig,
  maxBytes: number = 65536, // 64KB should be enough for most headers
  existingSocket?: net.Socket | tls.TLSSocket
): Promise<Buffer> {
  const socket = existingSocket || await connectToUsenet(config);
  const ownsSocket = !existingSocket;

  try {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    // Download first few segments until we have enough bytes for header
    for (const messageId of messageIds) {
      if (totalBytes >= maxBytes) break;

      const segmentData = await downloadSegment(socket, messageId);
      chunks.push(segmentData);
      totalBytes += segmentData.length;

      // Stop after first 2-3 segments (usually enough for headers)
      if (chunks.length >= 3) break;
    }

    return Buffer.concat(chunks).slice(0, maxBytes);
  } finally {
    if (ownsSocket) socket.destroy();
  }
}

/**
 * Decode yEnc-encoded binary data from raw body lines.
 * yEnc encoding: each byte = (original + 42) mod 256
 * Escape sequences: =char means ((char - 64 - 42) mod 256)
 * Lines starting with =y are yEnc control lines (=ybegin, =ypart, =yend)
 */
function decodeYenc(lines: string[]): Buffer {
  const decoded: number[] = [];
  let inYencData = false;

  for (const line of lines) {
    if (line.startsWith('=ybegin ')) {
      inYencData = true;
      continue;
    }
    if (line.startsWith('=yend ')) {
      break;
    }
    if (line.startsWith('=ypart ')) {
      continue;
    }
    if (!inYencData) continue;

    let i = 0;
    while (i < line.length) {
      let byte: number;
      if (line[i] === '=' && i + 1 < line.length) {
        // Escape sequence
        byte = (line.charCodeAt(i + 1) - 64 - 42 + 256) % 256;
        i += 2;
      } else {
        byte = (line.charCodeAt(i) - 42 + 256) % 256;
        i++;
      }
      decoded.push(byte);
    }
  }

  // If no =ybegin found, treat as raw binary (non-yEnc article)
  if (!inYencData) {
    return Buffer.concat(lines.map(l => Buffer.from(l, 'binary')));
  }

  return Buffer.from(decoded);
}

/**
 * Download a single segment using BODY command
 */
export async function downloadSegment(
  socket: net.Socket | tls.TLSSocket,
  messageId: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let bodyBuffer = '';
    let bodyLines: string[] = [];
    let inBody = false;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('Segment download timeout'));
      }
    }, 30000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('data', dataHandler);
      socket.removeListener('error', errorHandler);
      socket.removeListener('close', closeHandler);
      socket.removeListener('end', endHandler);
    };

    const dataHandler = (data: Buffer) => {
      if (inBody) {
        // Buffer body data and split into lines, keeping partial last line
        bodyBuffer += data.toString('latin1');
        const lines = bodyBuffer.split('\r\n');
        bodyBuffer = lines.pop() || ''; // Keep incomplete last line

        for (const line of lines) {
          if (line === '.') {
            // End of body — decode yEnc and resolve
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve(decodeYenc(bodyLines));
            }
            return;
          }
          // NNTP dot-stuffing: lines starting with ".." have the first dot removed
          bodyLines.push(line.startsWith('..') ? line.slice(1) : line);
        }
      } else {
        // Parse NNTP response headers using latin1 to preserve byte values
        // (the same chunk may contain start of yEnc body after 222 response)
        buffer += data.toString('latin1');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() || '';

        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          if (line.startsWith('222')) {
            // Body follows — remaining lines in this chunk are body data
            inBody = true;
            // Any remaining complete lines after 222 go to bodyLines
            for (let bi = li + 1; bi < lines.length; bi++) {
              const bodyLine = lines[bi];
              if (bodyLine === '.') {
                if (!resolved) {
                  resolved = true;
                  cleanup();
                  resolve(decodeYenc(bodyLines));
                }
                return;
              }
              bodyLines.push(bodyLine.startsWith('..') ? bodyLine.slice(1) : bodyLine);
            }
            // Any partial trailing data becomes bodyBuffer
            if (buffer) {
              bodyBuffer = buffer;
              buffer = '';
            }
            return; // Stop processing header lines
          } else if (line.startsWith('430') || line.startsWith('4') || line.startsWith('5')) {
            // Article not found or error
            if (!resolved) {
              resolved = true;
              cleanup();
              reject(new Error(`Article not found: ${line}`));
            }
            return;
          }
        }
      }
    };

    const errorHandler = (error: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(error);
      }
    };

    const closeHandler = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('Connection closed during segment download'));
      }
    };

    const endHandler = () => {
      closeHandler();
    };

    socket.on('data', dataHandler);
    socket.on('error', errorHandler);
    socket.on('close', closeHandler);
    socket.on('end', endHandler);

    // Request article body
    socket.write(`BODY <${messageId}>\r\n`);
  });
}
