import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { config } from '../src/config.js';
import { createHttpConnectTunnel, isProxyError, testProxy } from '../src/proxy-test.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('HTTP CONNECT proxy tunnel', () => {
  it('accepts LF-only CONNECT responses from permissive proxy providers', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        assert.match(chunk.toString('latin1'), /^CONNECT example\.com:443 HTTP\/1\.1\r?\n/);
        socket.write('HTTP/1.1 200 Connection Established\n\nhello');
      });
    });
    const port = await listen(server);
    try {
      const tunnel = await createHttpConnectTunnel({ host: '127.0.0.1', port }, 'example.com', 443, 1000);
      const data = await new Promise((resolve, reject) => {
        tunnel.once('data', (chunk) => resolve(chunk.toString('utf8')));
        tunnel.once('error', reject);
        tunnel.setTimeout(1000, () => reject(new Error('timeout waiting for unshifted tunnel bytes')));
        tunnel.resume();
      });
      assert.equal(data, 'hello');
      tunnel.destroy();
    } finally {
      await close(server);
    }
  });

  it('rejects non-200 CONNECT responses as proxy errors', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 407 Proxy Authentication Required\n\nbad credentials'));
    });
    const port = await listen(server);
    try {
      await assert.rejects(
        createHttpConnectTunnel({ host: '127.0.0.1', port }, 'example.com', 443, 1000),
        /ERR_PROXY_HTTP_ERROR:407:bad credentials/
      );
      assert.equal(isProxyError(new Error('ERR_PROXY_HTTP_ERROR:407')), true);
    } finally {
      await close(server);
    }
  });

  it('uses ordinary proxy GET for HTTP verification URLs', async () => {
    const originalAllowPrivate = config.allowPrivateProxyHosts;
    config.allowPrivateProxyHosts = true;
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        const raw = chunk.toString('latin1');
        assert.match(raw, /^GET http:\/\/ipinfo\.test\/json HTTP\/1\.1\r?\n/);
        socket.end([
          'HTTP/1.1 200 OK',
          'Content-Type: application/json',
          '',
          '{"ip":"203.0.113.9","country":"US","region":"New Jersey","city":"Colonia","org":"AS7922"}',
        ].join('\r\n'));
      });
    });
    const port = await listen(server);
    try {
      const result = await testProxy(
        { host: '127.0.0.1', port, username: 'user', password: 'pass' },
        { verifyUrl: 'http://ipinfo.test/json', timeoutMs: 1000 }
      );
      assert.equal(result.egressIp, '203.0.113.9');
      assert.equal(result.region, 'New Jersey');
    } finally {
      config.allowPrivateProxyHosts = originalAllowPrivate;
      await close(server);
    }
  });

  it('finishes HTTP verification when Content-Length is complete even if proxy keeps connection open', async () => {
    const originalAllowPrivate = config.allowPrivateProxyHosts;
    config.allowPrivateProxyHosts = true;
    const body = '{"ip":"198.51.100.22","country":"US","region":"Texas","city":"Decatur","org":"AS35986"}';
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write([
          'HTTP/1.1 200 OK',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          '',
          body,
        ].join('\r\n'));
      });
    });
    const port = await listen(server);
    try {
      const result = await testProxy(
        { host: '127.0.0.1', port, username: 'user', password: 'pass' },
        { verifyUrl: 'http://ipinfo.test/json', timeoutMs: 1000 }
      );
      assert.equal(result.egressIp, '198.51.100.22');
      assert.equal(result.city, 'Decatur');
    } finally {
      config.allowPrivateProxyHosts = originalAllowPrivate;
      await close(server);
    }
  });

  it('includes HTTP verification response body in error messages', async () => {
    const originalAllowPrivate = config.allowPrivateProxyHosts;
    config.allowPrivateProxyHosts = true;
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.end([
          'HTTP/1.1 403 Forbidden',
          'Content-Type: text/plain',
          '',
          'msg: forbidden ip=171.88.62.76 not supported',
        ].join('\r\n'));
      });
    });
    const port = await listen(server);
    try {
      await assert.rejects(
        testProxy({ host: '127.0.0.1', port }, { verifyUrl: 'http://ipinfo.test/json', timeoutMs: 1000 }),
        /ERR_VERIFY_HTTP:403:msg: forbidden ip=171\.88\.62\.76 not supported/
      );
    } finally {
      config.allowPrivateProxyHosts = originalAllowPrivate;
      await close(server);
    }
  });
});
