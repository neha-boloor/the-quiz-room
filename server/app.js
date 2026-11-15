import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { FileBucket } from './file-bucket.js';
import { initializeHost, verifyAccessCode, hostSession } from './auth.js';
import worker from '../dist/server/index.js';

/** Startable in tests, with no implicit bind or state created at import time. */
export async function createLocalApp({
  dataDirectory,
  password,
  advertisedOrigin,
  ownerEmail = 'owner@quiz.local',
  buzzerReleaseDelayMs,
}) {
  const { record, accessCode } = await initializeHost(dataDirectory, { password });
  const bucket = new FileBucket(dataDirectory + '/objects');
  const env = {
    BUCKET: bucket,
    OWNER_EMAIL: ownerEmail,
    LOCAL_MODE: true,
    BUZZER_RELEASE_DELAY_MS: buzzerReleaseDelayMs,
  };
  const sessions = new Map();
  const loginAttempts = new Map();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  for (const list of Object.values(safeInterfaces()))
    for (const address of list || []) allowedHosts.add(address.address);
  if (advertisedOrigin) allowedHosts.add(new URL(advertisedOrigin).hostname);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  let port;
  const originFor = (request) => {
    const origin = new URL('http://' + request.headers.host);
    if (!allowedHosts.has(origin.hostname.replace(/^\[|\]$/g, '')))
      throw Object.assign(Error('Unrecognized host'), { status: 403 });
    return origin.origin;
  };
  const privateHeaders = (request) => {
    const headers = new Headers(request.headers);
    // Never trust identity headers supplied by a phone or another LAN client.
    for (const key of [...headers.keys()]) if (key.startsWith('oai-')) headers.delete(key);
    if (hostSession(request, sessions)) headers.set('oai-authenticated-user-email', ownerEmail);
    return headers;
  };
  const safeRoomRequest = (request, roomId, token, guest) => {
    const headers = privateHeaders(request);
    if (token) headers.set('authorization', 'Bearer ' + token);
    if (guest) headers.set('x-guest-view', '1');
    return new Request(originFor(request) + '/api/room/' + roomId, { headers });
  };
  async function notify(roomId) {
    await Promise.all(
      [...sockets.clients].map(async (socket) => {
        if (socket.roomId !== roomId || socket.readyState !== WebSocket.OPEN) return;
        const response = await worker.fetch(
          safeRoomRequest(socket.request, roomId, socket.token, socket.guest),
          env,
        );
        if (response.ok) socket.send(JSON.stringify({ type: 'refresh' }));
        else {
          socket.send(JSON.stringify({ type: 'expired' }));
          socket.close(1008, 'Session unavailable');
        }
      }),
    );
  }
  const server = http.createServer(async (request, response) => {
    try {
      const origin = originFor(request);
      const url = new URL(request.url, origin);
      if (request.headers.origin && request.headers.origin !== origin)
        throw Object.assign(Error('Cross-origin request denied'), { status: 403 });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024)
          throw Object.assign(Error('Request too large'), { status: 413 });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (url.pathname === '/api/local/login') {
        if (
          request.method !== 'POST' ||
          !request.headers['content-type']?.includes('application/json')
        )
          throw Object.assign(Error('JSON POST required'), { status: 405 });
        const ip = request.socket.remoteAddress;
        const attempt = loginAttempts.get(ip) || { count: 0, until: Date.now() + 60000 };
        if (attempt.until < Date.now()) {
          attempt.count = 0;
          attempt.until = Date.now() + 60000;
        }
        if (++attempt.count > 10)
          throw Object.assign(Error('Too many attempts. Try again in a minute.'), { status: 429 });
        loginAttempts.set(ip, attempt);
        let submitted;
        try {
          submitted = JSON.parse(body.toString());
        } catch {
          throw Object.assign(Error('Invalid JSON'), { status: 400 });
        }
        if (!verifyAccessCode(record, submitted.accessCode))
          throw Object.assign(Error('Incorrect host access code'), { status: 403 });
        const session = randomBytes(32).toString('base64url');
        sessions.set(session, Date.now() + 8 * 3600000);
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': `quiz_host=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        });
        response.end('{}');
        return;
      }
      if (url.pathname === '/api/local/logout') {
        if (request.method !== 'POST') throw Object.assign(Error('POST required'), { status: 405 });
        const cookie = request.headers.cookie
          ?.split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith('quiz_host='))
          ?.slice(10);
        sessions.delete(cookie);
        response.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'quiz_host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        });
        response.end('{}');
        return;
      }
      const headers = privateHeaders(request);
      const result = await worker.fetch(
        new Request(url, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
        }),
        env,
      );
      // A localhost QR would point each phone at itself. Advertise the host LAN origin.
      if (url.pathname === '/api/me' && result.ok) {
        const data = await result.json();
        data.partyOrigin = advertisedOrigin || lanOrigin(port);
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(data));
        return;
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      const match = url.pathname.match(/^\/api\/room\/([\w-]+)\/\w+$/);
      if (request.method === 'POST' && result.ok && match) await notify(match[1]);
    } catch (error) {
      if (response.headersSent) return;
      response.writeHead(error.status || 500, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ error: error.status ? error.message : 'Local server error' }));
    }
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      const origin = originFor(request);
      if (request.url !== '/live' || request.headers.origin !== origin) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (connection) => {
        connection.request = request;
        const deadline = setTimeout(() => connection.close(1008, 'Authenticate first'), 5000);
        connection.on('error', () => {});
        connection.once('message', async (bytes) => {
          try {
            const message = JSON.parse(bytes.toString());
            if (
              !/^[\w-]{10,100}$/.test(message.roomId) ||
              typeof (message.token || '') !== 'string'
            )
              throw Error('Invalid connection');
            const check = await worker.fetch(
              safeRoomRequest(request, message.roomId, message.token, !!message.guest),
              env,
            );
            if (!check.ok) throw Error('Access denied');
            connection.roomId = message.roomId;
            connection.token = message.token;
            connection.guest = !!message.guest;
            clearTimeout(deadline);
            connection.send(JSON.stringify({ type: 'ready' }));
          } catch {
            clearTimeout(deadline);
            connection.close(1008, 'Access denied');
          }
        });
      });
    } catch {
      socket.destroy();
    }
  });
  return {
    server,
    accessCode,
    async listen(listenPort = 3000, bind = '0.0.0.0') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, bind, resolve);
      });
      port = server.address().port;
      return port;
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
export function lanOrigin(port) {
  for (const list of Object.values(safeInterfaces()))
    for (const address of list || [])
      if (address.family === 'IPv4' && !address.internal)
        return `http://${address.address}:${port}`;
  return `http://localhost:${port}`;
}

function safeInterfaces() {
  try {
    return networkInterfaces();
  } catch {
    return {};
  }
}
