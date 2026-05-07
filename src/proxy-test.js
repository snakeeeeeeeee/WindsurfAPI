import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { assertPublicUrlHost } from './image.js';
import { validateHostFormat } from './net-safety.js';
import { config } from './config.js';
import { isSocks, createSocksTunnel } from './socks.js';

export function isProxyError(err) {
  const m = String(err?.message || err || '');
  return /Proxy CONNECT failed|Proxy tunnel|Proxy connection|Missing expected CR after response line|ERR_PROXY_|SOCKS5:|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ECONNREFUSED|ENOTFOUND|TLS.*timeout|TLS handshake|ERR_TLS_|ERR_CONNECTION_FAILED|ERR_TIMEOUT|407|proxy authentication/i.test(m);
}

async function validateProxyHost(host) {
  if (config.allowPrivateProxyHosts) {
    await validateHostFormat(host);
  } else {
    await assertPublicUrlHost(host);
  }
}

export function createHttpConnectTunnel(proxy, targetHost, targetPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proxyHost = String(proxy.host || '').replace(/:\d+$/, '');
    const proxyPort = Number(proxy.port || 8080);
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = net.connect(proxyPort, proxyHost, () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
      ];
      if (proxy.username) {
        const token = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      lines.push('Proxy-Connection: Keep-Alive', 'Connection: Keep-Alive', '', '');
      socket.write(lines.join('\r\n'));
    });

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      socket.setTimeout(0);
    };
    const done = (err, rest = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        socket.pause();
        if (rest?.length) socket.unshift(rest);
        resolve(socket);
      }
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const raw = buf.toString('latin1');
      let headerEnd = raw.indexOf('\r\n\r\n');
      let separatorLength = 4;
      if (headerEnd < 0) {
        headerEnd = raw.indexOf('\n\n');
        separatorLength = 2;
      }
      if (headerEnd < 0) {
        if (buf.length > 8192) done(new Error('ERR_PROXY_CONNECT_BAD_RESPONSE'));
        return;
      }
      const head = raw.slice(0, headerEnd);
      const status = Number((head.match(/^HTTP\/\S+\s+(\d+)/i) || [])[1] || 0);
      if (status !== 200) {
        const rest = buf.subarray(headerEnd + separatorLength).toString('utf8').trim();
        done(new Error(`ERR_PROXY_HTTP_ERROR:${status || 'unknown'}${rest ? `:${rest.slice(0, 240)}` : ''}`));
        return;
      }
      done(null, buf.subarray(headerEnd + separatorLength));
    };
    const onError = (err) => done(new Error(`ERR_CONNECTION_FAILED:${err.message}`));
    const onTimeout = () => done(new Error('ERR_TIMEOUT'));

    socket.on('data', onData);
    socket.on('error', onError);
    socket.setTimeout(timeoutMs, onTimeout);
  });
}

function requestViaHttpProxy(proxy, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyHost = String(proxy.host || '').replace(/:\d+$/, '');
    const proxyPort = Number(proxy.port || 8080);
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = net.connect(proxyPort, proxyHost, () => {
      const lines = [
        `GET ${targetUrl.href} HTTP/1.1`,
        `Host: ${targetUrl.host}`,
        'Connection: close',
        'Accept: application/json,text/plain;q=0.9',
        'User-Agent: WindsurfAPI/ProxyTest',
      ];
      if (proxy.username) {
        const token = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });
    const done = (err, value = '') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    socket.on('data', c => buf = Buffer.concat([buf, c]));
    socket.on('end', () => done(null, buf.toString('utf8')));
    socket.on('error', err => done(new Error(`ERR_CONNECTION_FAILED:${err.message}`)));
    socket.setTimeout(timeoutMs, () => done(new Error('ERR_TIMEOUT')));
  });
}

function parseHttpResponse(raw) {
  let split = raw.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (split < 0) {
    split = raw.indexOf('\n\n');
    separatorLength = 2;
  }
  const head = split >= 0 ? raw.slice(0, split) : '';
  const body = split >= 0 ? raw.slice(split + separatorLength) : raw;
  const status = Number((head.match(/^HTTP\/\S+\s+(\d+)/i) || [])[1] || 0);
  return { status, body: body.trim() };
}

function normalizeVerifyBody(body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  if (parsed && typeof parsed === 'object') {
    return {
      egressIp: String(parsed.ip || parsed.query || '').trim(),
      country: String(parsed.country || '').trim(),
      region: String(parsed.region || '').trim(),
      city: String(parsed.city || '').trim(),
      ispOrg: String(parsed.org || parsed.isp || parsed.as || '').trim(),
      raw: parsed,
    };
  }
  return {
    egressIp: String(body || '').trim(),
    country: '',
    region: '',
    city: '',
    ispOrg: '',
    raw: body,
  };
}

export async function testProxy(proxy = {}, opts = {}) {
  const startedAt = Date.now();
  const targetUrl = new URL(opts.verifyUrl || 'https://ipinfo.io/json');
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs || 10000) || 10000);
  const targetPort = Number(targetUrl.port || (targetUrl.protocol === 'http:' ? 80 : 443));
  const targetHost = targetUrl.hostname;
  const path = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`;
  if (!proxy?.host) throw new Error('ERR_PROXY_HOST_REQUIRED');
  await validateProxyHost(proxy.host);

  let socket;
  if (isSocks(proxy)) {
    socket = await createSocksTunnel(proxy, targetHost, targetPort, timeoutMs);
  } else if (targetUrl.protocol === 'http:') {
    socket = null;
  } else {
    socket = await createHttpConnectTunnel(proxy, targetHost, targetPort, timeoutMs);
  }

  const requestText = `GET ${path || '/'} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\nAccept: application/json,text/plain;q=0.9\r\nUser-Agent: WindsurfAPI/ProxyTest\r\n\r\n`;
  const raw = !socket
    ? await requestViaHttpProxy(proxy, targetUrl, timeoutMs)
    : await new Promise((resolve, reject) => {
    const chunks = [];
    const done = (err, value) => {
      if (err) reject(err);
      else resolve(value);
    };
    if (targetUrl.protocol === 'http:') {
      socket.write(requestText);
      socket.on('data', c => chunks.push(c));
      socket.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
      socket.on('error', err => done(new Error(`ERR_CONNECTION_FAILED:${err.message}`)));
      socket.setTimeout(timeoutMs, () => { socket.destroy(); done(new Error('ERR_TIMEOUT')); });
      socket.resume();
      return;
    }
    const tlsSock = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
      tlsSock.write(requestText);
    });
    tlsSock.on('data', c => chunks.push(c));
    tlsSock.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
    tlsSock.on('error', err => done(new Error(`ERR_TLS_FAILED:${err.message}`)));
    tlsSock.setTimeout(timeoutMs, () => { tlsSock.destroy(); done(new Error('ERR_TLS_TIMEOUT')); });
  });

  const parsed = parseHttpResponse(raw);
  if (parsed.status >= 400 || parsed.status === 0) {
    throw new Error(`ERR_VERIFY_HTTP:${parsed.status || 'unknown'}${parsed.body ? `:${parsed.body.slice(0, 240)}` : ''}`);
  }
  const info = normalizeVerifyBody(parsed.body);
  if (!info.egressIp) throw new Error('ERR_PROXY_VERIFY_NO_IP');
  return {
    ...info,
    type: proxy.type || proxy.protocol || 'http',
    latencyMs: Date.now() - startedAt,
  };
}
