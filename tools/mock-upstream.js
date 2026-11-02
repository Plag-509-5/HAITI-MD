#!/usr/bin/env node
'use strict';

/**
 * Faux serveur PLAG AI pour développer l'interface hors ligne.
 *
 *   node tools/mock-upstream.js            # écoute sur 127.0.0.1:8765
 *   PLAG_API_KEY=dev node tools/mock-upstream.js
 *
 * Puis :  PLAG_API_URL=http://127.0.0.1:8765/v1/chat PLAG_API_KEY=dev npm start
 */

const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 8765);
const HOST = process.env.MOCK_HOST || '127.0.0.1';
const KEY = process.env.MOCK_KEY || '';

function answerFor(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = (last && last.content) || '';
  return `**Mock PLAG AI** — réponse simulée pour ton prompt :

> ${prompt.replace(/\n/g, ' ').slice(0, 160)}

Voici un aperçu du rendu :

1. Listes numérotées et **gras**, *italique*, \`code inline\`.
2. Un bloc de code :

\`\`\`js
const res = await fetch('http://127.0.0.1:8765/v1/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.PLAG_API_KEY },
  body: JSON.stringify({ messages, think: false, stream: false }),
});
const data = await res.json();
console.log(data);
\`\`\`

| Élément | État |
| --- | --- |
| Streaming | OK |
| Markdown | OK |

*Fin de la réponse simulée.*`;
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/v1/chat') || req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }
  if (KEY && req.headers['x-api-key'] !== KEY) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid API key' }));
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    const text = answerFor(body.messages || []);

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        })
      );
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (body.think) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Je réfléchis à la réponse… ' } }] })}\n\n`);
    }

    const chunks = text.match(/[\s\S]{1,18}/g) || [text];
    let i = 0;
    const tick = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(tick);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
    }, 25);

    res.on('close', () => clearInterval(tick));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock PLAG AI → http://${HOST}:${PORT}/v1/chat${KEY ? ' (clé: ' + KEY + ')' : ''}`);
});
