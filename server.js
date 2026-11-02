#!/usr/bin/env node
'use strict';

/**
 * PLAG AI — Studio
 * Petit serveur Node.js sans dépendance qui :
 *   1. sert l'interface (dossier ./public)
 *   2. proxifie /api/chat vers l'API PLAG AI (http://127.0.0.1:8765/v1/chat)
 *      en injectant la clé X-API-Key (lue depuis PLAG_API_KEY ou /etc/plag-ai/api.key)
 *   3. normalise la réponse (JSON ou SSE) en un flux d'événements simple pour le navigateur
 *
 * Démarrage :  node server.js  (ou npm start)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadDotEnv();

const CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  upstream: process.env.PLAG_API_URL || 'http://127.0.0.1:8765/v1/chat',
  keyFile: process.env.PLAG_API_KEY_FILE || '/etc/plag-ai/api.key',
  timeout: Number(process.env.PLAG_TIMEOUT_MS || 300000),
};

function readKey() {
  if (process.env.PLAG_API_KEY && process.env.PLAG_API_KEY.trim()) {
    return { key: process.env.PLAG_API_KEY.trim(), source: 'env' };
  }
  const candidates = [CONFIG.keyFile, path.join(ROOT, '.plag-ai-key')];
  for (const file of candidates) {
    try {
      const key = fs.readFileSync(file, 'utf8').trim();
      if (key) return { key, source: file };
    } catch {
      /* fichier absent : on continue */
    }
  }
  return { key: '', source: null };
}

/* ------------------------------------------------------------------ */
/* Utilitaires HTTP                                                    */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload trop volumineux'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Extraction de texte : tolère plusieurs formats de réponse           */
/* ------------------------------------------------------------------ */

function asText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    return asText(value.text ?? value.content ?? '');
  }
  return '';
}

/** Renvoie { text, thinking } contenu dans un objet de réponse (chunk ou complet). */
function extract(obj) {
  if (obj == null) return { text: '', thinking: '' };
  if (typeof obj === 'string') return { text: obj, thinking: '' };
  if (typeof obj !== 'object') return { text: '', thinking: '' };

  let text = '';
  let thinking = '';

  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (choice && typeof choice === 'object') {
    const d = choice.delta || choice.message || {};
    text += asText(d.content) || asText(d.text);
    thinking += asText(d.reasoning_content) + asText(d.reasoning) + asText(d.thinking);
    if (!text && typeof choice.text === 'string') text = choice.text;
  }

  if (obj.message && typeof obj.message === 'object') {
    text += asText(obj.message.content);
    thinking += asText(obj.message.reasoning_content) + asText(obj.message.reasoning) + asText(obj.message.thinking);
  }

  if (!text) {
    for (const key of ['response', 'content', 'text', 'answer', 'output', 'result', 'reply', 'completion', 'generated_text']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        text = obj[key];
        break;
      }
    }
  }
  if (!text && typeof obj.data === 'string') text = obj.data;
  if (!thinking) thinking = asText(obj.reasoning_content) + asText(obj.reasoning) + asText(obj.thinking);

  return { text, thinking };
}

function extractFromJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw.trim(), thinking: '' };
  }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || JSON.stringify(parsed.error);
    throw Object.assign(new Error(message), { status: 502 });
  }
  return extract(parsed);
}

/* ------------------------------------------------------------------ */
/* Proxy de chat                                                       */
/* ------------------------------------------------------------------ */

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return sendJson(res, err.status || 400, { error: 'Corps de requête JSON invalide.' });
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return sendJson(res, 400, { error: 'Le champ "messages" est requis.' });
  }

  const cleanMessages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({ role: m.role, content: String(m.content ?? '') }))
    .filter((m) => m.content.trim().length > 0);

  const wantStream = body.stream !== false;
  const { key, source } = readKey();
  if (!key) {
    return sendJson(res, 503, {
      error:
        "Clé API introuvable. Renseigne PLAG_API_KEY dans .env ou place la clé dans /etc/plag-ai/api.key.",
      code: 'NO_KEY',
      keySource: null,
    });
  }

  const payload = {
    messages: cleanMessages,
    think: Boolean(body.think),
    stream: wantStream,
  };
  if (body.system) payload.system = String(body.system);
  if (Number.isFinite(body.temperature)) payload.temperature = body.temperature;
  if (Number.isFinite(body.max_tokens)) payload.max_tokens = body.max_tokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  const startedAt = Date.now();

  const onClientClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClientClose);

  let upstreamRes;
  try {
    upstreamRes = await fetch(CONFIG.upstream, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: wantStream ? 'text/event-stream, application/json' : 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    res.off('close', onClientClose);
    const offline = err.name === 'AbortError' ? 'Délai dépassé' : 'API PLAG AI injoignable';
    return sendJson(res, 502, {
      error: `${offline} (${CONFIG.upstream}). Vérifie que le service tourne sur ${new URL(CONFIG.upstream).host}.`,
      code: 'UPSTREAM_UNREACHABLE',
      keySource: source,
      detail: String(err.message || err),
    });
  }

  if (!upstreamRes.ok) {
    const detail = (await upstreamRes.text().catch(() => '')).slice(0, 800);
    clearTimeout(timer);
    res.off('close', onClientClose);
    return sendJson(res, upstreamRes.status === 401 || upstreamRes.status === 403 ? 401 : 502, {
      error:
        upstreamRes.status === 401 || upstreamRes.status === 403
          ? "L'API a refusé la clé fournie (401/403). Vérifie /etc/plag-ai/api.key."
          : `L'API a répondu ${upstreamRes.status}.`,
      code: 'UPSTREAM_ERROR',
      status: upstreamRes.status,
      detail,
      keySource: source,
    });
  }

  /* ---- Mode non-streaming : on attend le JSON complet ---- */
  if (!wantStream) {
    try {
      const raw = await upstreamRes.text();
      const { text, thinking } = extractFromJson(raw);
      clearTimeout(timer);
      res.off('close', onClientClose);
      return sendJson(res, 200, { text, thinking, ms: Date.now() - startedAt });
    } catch (err) {
      clearTimeout(timer);
      res.off('close', onClientClose);
      return sendJson(res, err.status || 502, { error: String(err.message || err), code: 'PARSE_ERROR' });
    }
  }

  /* ---- Mode streaming ---- */
  const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
  const isEventStream = contentType.includes('event-stream') || contentType.includes('ndjson');

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let text = '';
  let thinking = '';
  let finished = false;

  const emit = (payloadObj) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payloadObj)}\n\n`);
  };
  const pushDelta = (chunk) => {
    if (chunk.thinking) {
      thinking += chunk.thinking;
      emit({ type: 'thinking', text: chunk.thinking });
    }
    if (chunk.text) {
      text += chunk.text;
      emit({ type: 'delta', text: chunk.text });
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    emit({ type: 'done', ms: Date.now() - startedAt, chars: text.length, thinkingChars: thinking.length });
    if (!res.writableEnded) res.end();
    res.off('close', onClientClose);
  };
  const fail = (message, code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    emit({ type: 'error', message, code: code || 'UPSTREAM_ERROR' });
    if (!res.writableEnded) res.end();
    res.off('close', onClientClose);
  };

  try {
    if (!isEventStream) {
      const raw = await upstreamRes.text();
      pushDelta(extractFromJson(raw));
      return finish();
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleBlock = (block) => {
      const lines = block.split('\n');
      let dataLines = [];
      let sawPrefix = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith(':')) continue; // commentaire keep-alive
        if (trimmed.startsWith('data:')) {
          sawPrefix = true;
          dataLines.push(trimmed.slice(5).trim());
        } else if (trimmed.startsWith('event:') || trimmed.startsWith('id:') || trimmed.startsWith('retry:')) {
          continue;
        } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          dataLines.push(trimmed); // serveur qui envoie du JSON brut ligne par ligne
        }
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.error) {
          const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'Erreur API';
          return fail(msg);
        }
        pushDelta(extract(parsed));
      } catch {
        if (!sawPrefix) return;
        // texte brut renvoyé dans un événement SSE
        pushDelta({ text: data, thinking: '' });
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleBlock(block);
      }
    }
    if (buffer.trim()) handleBlock(buffer.replace(/\r\n/g, '\n'));
    finish();
  } catch (err) {
    if (err.name === 'AbortError') {
      // Le client a coupé : on clôt proprement sans bruit.
      if (!res.writableEnded) res.end();
      clearTimeout(timer);
      res.off('close', onClientClose);
      return;
    }
    fail(String(err.message || err));
  }
}

/* ------------------------------------------------------------------ */
/* Santé de l'API                                                      */
/* ------------------------------------------------------------------ */

function probeTcp(url, timeout = 600) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve(false);
    }
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const socket = net.connect({ host: target.hostname, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function handleHealth(req, res) {
  const { key, source } = readKey();
  const reachable = await probeTcp(CONFIG.upstream).catch(() => false);
  sendJson(res, 200, {
    ok: reachable && Boolean(key),
    reachable,
    hasKey: Boolean(key),
    keySource: source,
    upstream: CONFIG.upstream,
    mode: reachable && key ? 'live' : 'demo',
  });
}

/* ------------------------------------------------------------------ */
/* Fichiers statiques                                                  */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);

  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'Accès refusé.' });
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback
      if (!path.extname(relative)) {
        const fallback = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(fallback, (e2, data) => {
          if (e2) return sendJson(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(data);
        });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(target).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': cache,
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Routeur                                                             */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health' && req.method === 'GET') return await handleHealth(req, res);
    if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Endpoint inconnu.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Méthode non autorisée.' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[erreur]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erreur interne du serveur.' });
    else res.end();
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  const { key, source } = readKey();
  console.log('');
  console.log('  ╭───────────────────────────────────────────────╮');
  console.log('  │   PLAG AI · Studio                            │');
  console.log('  ╰───────────────────────────────────────────────╯');
  console.log(`  Interface   →  http://localhost:${CONFIG.port}`);
  console.log(`  API PLAG AI →  ${CONFIG.upstream}`);
  console.log(`  Clé API     →  ${key ? `chargée (${source})` : 'ABSENTE — définis PLAG_API_KEY'}`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nArrêt du serveur. À bientôt !');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
