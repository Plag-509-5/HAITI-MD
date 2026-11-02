/* =========================================================
   PLAG AI · Studio — logique de l'interface
   ========================================================= */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const md = window.PlagMarkdown;
  const STORAGE_KEY = 'plagai.studio.v2';
  const MAX_CONVERSATIONS = 60;

  const LOGO_SVG =
    '<svg viewBox="0 0 32 32" fill="none"><path d="M9 23V9.5A2.5 2.5 0 0 1 11.5 7H18a6.5 6.5 0 0 1 0 13h-4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="22.5" cy="23" r="2.5" fill="currentColor"/></svg>';

  const SUGGESTIONS = [
    { icon: '✦', title: 'Qui es-tu ?', desc: 'Découvre PLAG AI et ce que je peux faire pour toi.', prompt: 'Présente-toi : qui es-tu, qui t’a créée et quelles sont tes capacités ?' },
    { icon: '{ }', title: 'Code', desc: 'Un composant React animé, prêt à copier.', prompt: 'Écris-moi un composant React moderne pour une carte produit animée, avec Tailwind.' },
    { icon: '✍', title: 'Rédaction', desc: 'Un message pro en kreyòl, français ou anglais.', prompt: 'Rédige un e-mail professionnel pour demander un devis à un fournisseur, en français.' },
    { icon: '☀', title: 'Explique simplement', desc: 'Un concept complexe, en 5 phrases claires.', prompt: 'Explique-moi simplement comment fonctionne un modèle de langage, en 5 phrases.' },
  ];

  /* ---------------------- État ---------------------- */

  const state = {
    conversations: [],
    activeId: null,
    settings: { theme: 'dark', think: false },
    api: { mode: 'checking', reachable: null, hasKey: null, keySource: null, upstream: '' },
    streaming: null,
    healthTimer: null,
  };

  const els = {
    thread: $('#thread'),
    threadInner: $('#threadInner'),
    history: $('#history'),
    input: $('#input'),
    composer: $('#composer'),
    sendBtn: $('#sendBtn'),
    stopBtn: $('#stopBtn'),
    thinkChip: $('#thinkChip'),
    micBtn: $('#micBtn'),
    modeInfo: $('#modeInfo'),
    statusPill: $('#statusPill'),
    liveBadge: $('#liveBadge'),
    chatTitle: $('#chatTitle'),
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    toast: $('#toast'),
    regenBtn: $('#regenBtn'),
    shortcutsModal: $('#shortcutsModal'),
    demoNotice: $('#demoNotice'),
    demoNoticeTitle: $('#demoNoticeTitle'),
    demoNoticeText: $('#demoNoticeText'),
  };

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------------- Persistance ---------------------- */

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      state.conversations = Array.isArray(raw.conversations) ? raw.conversations : [];
      state.activeId = raw.activeId || null;
      if (raw.settings) Object.assign(state.settings, raw.settings);
    } catch {
      state.conversations = [];
    }
    if (!state.conversations.length) {
      const conv = blankConversation();
      state.conversations.push(conv);
      state.activeId = conv.id;
    }
    if (!state.conversations.some((c) => c.id === state.activeId)) {
      state.activeId = state.conversations[0].id;
    }
  }

  function save() {
    try {
      const trimmed = state.conversations.slice(0, MAX_CONVERSATIONS).map((c) => ({
        ...c,
        messages: c.messages.map(({ pending, ...m }) => m),
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversations: trimmed, activeId: state.activeId, settings: state.settings }));
    } catch {
      /* quota dépassé : on ignore */
    }
  }

  function blankConversation() {
    return { id: uid(), title: 'Nouvelle discussion', messages: [], createdAt: Date.now() };
  }

  const activeConvo = () => state.conversations.find((c) => c.id === state.activeId);

  /* ---------------------- Utilitaires UI ---------------------- */

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  const clockTime = (ts) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const nearBottom = () => {
    const t = els.thread;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 140;
  };

  function scrollToBottom(force) {
    if (!force && !nearBottom()) return;
    els.thread.scrollTop = els.thread.scrollHeight;
  }

  /* ---------------------- Historique ---------------------- */

  function renderHistory() {
    els.history.innerHTML = '';
    const items = [...state.conversations].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    if (!items.length) {
      els.history.innerHTML = '<div class="history-empty">Aucune discussion pour le moment. Lance-toi !</div>';
      return;
    }
    for (const conv of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-item' + (conv.id === state.activeId ? ' active' : '');
      btn.innerHTML = `<span class="h-title">${esc(conv.title || 'Sans titre')}</span>
        <span class="h-del" role="button" tabindex="0" aria-label="Supprimer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
        </span>`;
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.h-del')) {
          e.stopPropagation();
          deleteConversation(conv.id);
          return;
        }
        selectConversation(conv.id);
      });
      els.history.appendChild(btn);
    }
  }

  function selectConversation(id) {
    if (state.streaming) abortStreaming();
    state.activeId = id;
    save();
    renderHistory();
    renderThread();
    updateHeader();
    closeSidebar();
  }

  function deleteConversation(id) {
    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (!state.conversations.length) state.conversations.push(blankConversation());
    if (state.activeId === id) state.activeId = state.conversations[0].id;
    save();
    renderHistory();
    renderThread();
    updateHeader();
  }

  function newConversation() {
    if (state.streaming) abortStreaming();
    const conv = blankConversation();
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    save();
    renderHistory();
    renderThread();
    updateHeader();
    closeSidebar();
    els.input.focus();
  }

  function updateHeader() {
    const conv = activeConvo();
    els.chatTitle.textContent = conv ? conv.title || 'Nouvelle discussion' : 'Nouvelle discussion';
    els.regenBtn.disabled = !conv || !conv.messages.some((m) => m.role === 'assistant');
  }

  /* ---------------------- Rendu du fil ---------------------- */

  function renderThread() {
    const conv = activeConvo();
    els.threadInner.innerHTML = '';
    if (!conv || conv.messages.length === 0) {
      els.threadInner.appendChild(heroEl());
      return;
    }
    for (const msg of conv.messages) {
      els.threadInner.appendChild(messageEl(msg));
    }
    requestAnimationFrame(() => {
      els.thread.scrollTop = els.thread.scrollHeight;
    });
  }

  function heroEl() {
    const wrap = document.createElement('div');
    wrap.className = 'hero';
    wrap.innerHTML = `
      <span class="hero-eyebrow"><span class="grad-dot"></span> PLAG AI · par PLAG-TECH</span>
      <h2>Salut, je suis <span class="grad">PLAG AI</span>.<br>Sur quoi on travaille ?</h2>
      <p>Une intelligence conçue par PLAG-TECH pour t'aider à écrire, coder, expliquer, traduire et créer — en français, en kreyòl ou en anglais.</p>
      <div class="suggestions"></div>`;
    const grid = $('.suggestions', wrap);
    for (const s of SUGGESTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'suggestion';
      b.innerHTML = `<span class="s-icon">${esc(s.icon)}</span><strong>${esc(s.title)}</strong><span class="s-desc">${esc(s.desc)}</span>`;
      b.addEventListener('click', () => {
        els.input.value = s.prompt;
        autoGrow();
        els.input.focus();
        sendMessage();
      });
      grid.appendChild(b);
    }
    return wrap;
  }

  function messageEl(msg) {
    const row = document.createElement('div');
    row.className = `msg ${msg.role}`;
    row.dataset.id = msg.id;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (msg.role === 'assistant') avatar.innerHTML = LOGO_SVG;
    else avatar.textContent = 'Toi';
    row.appendChild(avatar);

    const wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    const refs = {};

    if (msg.role === 'assistant') {
      const details = document.createElement('details');
      details.className = 'thinking';
      details.hidden = !msg.thinking;
      details.innerHTML = '<summary>Raisonnement</summary><div class="thinking-body"></div>';
      wrap.appendChild(details);
      refs.thinking = details;
      refs.thinkingBody = $('.thinking-body', details);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    refs.bubble = bubble;

    if (msg.role === 'user') {
      bubble.textContent = msg.content;
    } else if (msg.error) {
      bubble.appendChild(errorCard(msg.error));
    } else if (!msg.content && !msg.thinking) {
      bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    } else {
      paintAssistant(refs, msg);
    }

    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const metaBits = [];
    if (msg.demo) metaBits.push('<span class="demo-tag">démo</span>');
    if (msg.ms) metaBits.push(`${(msg.ms / 1000).toFixed(1)} s`);
    if (msg.ts) metaBits.push(clockTime(msg.ts));
    tools.innerHTML =
      `<button class="tool-btn" data-act="copy" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14"/></svg>
        Copier
      </button>` +
      (msg.role === 'assistant'
        ? `<button class="tool-btn" data-act="regen" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 4.5V11h-6"/></svg>
            Régénérer
          </button>`
        : '') +
      (metaBits.length ? `<span class="msg-meta">${metaBits.join('<span>·</span>')}</span>` : '');
    wrap.appendChild(tools);

    tools.addEventListener('click', (e) => {
      const btn = e.target.closest('.tool-btn');
      if (!btn) return;
      if (btn.dataset.act === 'copy') {
        copyText(msg.content || '').then((ok) => toast(ok ? 'Message copié' : 'Copie impossible'));
      }
      if (btn.dataset.act === 'regen') regenerate(msg.id);
    });

    row.appendChild(wrap);
    row._refs = refs;
    return row;
  }

  function paintAssistant(refs, msg, streaming) {
    const html = md.render(msg.content || '');
    if (streaming) {
      refs.bubble.innerHTML = html + (msg.content ? '<span class="caret"></span>' : '<span class="typing"><i></i><i></i><i></i></span>');
    } else {
      refs.bubble.innerHTML = html;
    }
    if (refs.thinking) {
      const hasThinking = Boolean(msg.thinking);
      refs.thinking.hidden = !hasThinking;
      if (hasThinking) refs.thinkingBody.textContent = msg.thinking;
    }
  }

  function errorCard(error) {
    const card = document.createElement('div');
    card.className = 'error-card';
    const detail = error.detail ? `<br><code>${esc(String(error.detail).slice(0, 240))}</code>` : '';
    card.innerHTML = `<span class="e-icon">!</span><div><strong>${esc(error.title || 'Erreur')}</strong>${esc(error.message || '')}${detail}
      ${error.retry ? '<br><button type="button">Réessayer</button>' : ''}</div>`;
    const btn = $('button', card);
    if (btn) btn.addEventListener('click', () => regenerate(null));
    return card;
  }

  /* ---------------------- Envoi / streaming ---------------------- */

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
  }

  function setBusy(busy) {
    els.sendBtn.disabled = busy;
    els.stopBtn.hidden = !busy;
    els.sendBtn.hidden = busy;
  }

  function payloadMessages(conv) {
    return conv.messages
      .filter((m) => !m.error && typeof m.content === 'string' && m.content.trim())
      .slice(-24)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  function sendMessage() {
    const text = els.input.value.trim();
    if (!text || state.streaming) return;
    const conv = activeConvo();
    els.input.value = '';
    autoGrow();

    const userMsg = { id: uid(), role: 'user', content: text, ts: Date.now() };
    conv.messages.push(userMsg);
    if (conv.messages.filter((m) => m.role === 'user').length === 1) {
      conv.title = text.length > 48 ? text.slice(0, 48).trimEnd() + '…' : text;
    }
    conv.updatedAt = Date.now();

    const assistant = { id: uid(), role: 'assistant', content: '', thinking: '', ts: Date.now(), pending: true };
    conv.messages.push(assistant);

    save();
    renderHistory();
    updateHeader();
    renderThread();

    const row = els.threadInner.querySelector(`[data-id="${assistant.id}"]`);
    runAssistant(conv, assistant, row, false);
  }

  function regenerate(messageId) {
    if (state.streaming) return;
    const conv = activeConvo();
    if (!conv) return;
    let index = -1;
    if (messageId) index = conv.messages.findIndex((m) => m.id === messageId);
    else {
      for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
        if (conv.messages[i].role === 'assistant') {
          index = i;
          break;
        }
      }
    }
    if (index < 0 || conv.messages[index].role !== 'assistant') return;
    if (!conv.messages.slice(0, index).some((m) => m.role === 'user')) return;

    const assistant = { id: uid(), role: 'assistant', content: '', thinking: '', ts: Date.now(), pending: true };
    conv.messages.splice(index, 1, assistant);
    save();
    renderThread();
    const row = els.threadInner.querySelector(`[data-id="${assistant.id}"]`);
    runAssistant(conv, assistant, row, true);
  }

  async function runAssistant(conv, assistant, row, isRetry) {
    const controller = new AbortController();
    state.streaming = { controller, assistant };
    setBusy(true);

    const refs = row ? row._refs : null;
    let firstToken = true;
    let renderQueued = false;

    const queuePaint = () => {
      if (renderQueued || !refs) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        paintAssistant(refs, assistant, true);
      });
    };

    const onEvent = (evt) => {
      if (evt.type === 'thinking') {
        assistant.thinking += evt.text;
        queuePaint();
      } else if (evt.type === 'delta') {
        if (firstToken) {
          firstToken = false;
          if (refs && refs.thinking) refs.thinking.open = false;
        }
        assistant.content += evt.text;
        queuePaint();
      } else if (evt.type === 'done') {
        assistant.ms = evt.ms;
      } else if (evt.type === 'error') {
        throw Object.assign(new Error(evt.message || 'Erreur inconnue'), { code: evt.code });
      }
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: payloadMessages(conv), think: state.settings.think, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || `L'API a répondu ${res.status}`);
        err.code = data.code;
        err.detail = data.detail;
        throw err;
      }

      await consumeStream(res.body, onEvent, controller.signal);
    } catch (err) {
      const aborted = err.name === 'AbortError' || controller.signal.aborted;
      if (aborted) {
        if (!assistant.content) {
          assistant.error = { title: 'Génération interrompue', message: 'La réponse a été arrêtée avant de commencer.', retry: true };
        }
      } else if (shouldFallbackToDemo(err)) {
        await demoReply(assistant, conv, refs, controller.signal, queuePaint);
      } else {
        assistant.error = {
          title: err.code === 'UPSTREAM_ERROR' ? "L'API a renvoyé une erreur" : 'Connexion impossible',
          message: err.message || 'Une erreur est survenue.',
          detail: err.detail,
          retry: true,
        };
      }
    } finally {
      assistant.pending = false;
      if (state.streaming && state.streaming.assistant === assistant) state.streaming = null;
      setBusy(false);
      save();
      renderThread();
      updateHeader();
      scrollToBottom();
      if (isRetry) els.input.focus();
    }
  }

  function shouldFallbackToDemo(err) {
    const code = err && err.code;
    return (
      code === 'UPSTREAM_UNREACHABLE' ||
      code === 'NO_KEY' ||
      code === 'PARSE_ERROR' ||
      err instanceof TypeError || // fetch a échoué (réseau)
      state.api.mode === 'demo'
    );
  }

  async function consumeStream(body, onEvent, signal) {
    if (!body) throw new Error('Flux de réponse indisponible.');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let failure = null;

    while (true) {
      if (signal && signal.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new DOMException('Aborted', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let evt;
          try {
            evt = JSON.parse(raw);
          } catch {
            continue; // événement illisible : ignoré
          }
          if (evt.type === 'error') failure = evt;
          else onEvent(evt);
        }
      }
    }

    if (failure) {
      throw Object.assign(new Error(failure.message || 'Erreur API'), { code: failure.code });
    }
  }

  function abortStreaming() {
    if (!state.streaming) return;
    state.streaming.controller.abort();
    state.streaming = null;
    setBusy(false);
  }

  /* ---------------------- Mode démo ---------------------- */

  const DEMO_REPLIES = [
    {
      match: /(qui es|présente|presente|ton nom|tu es qui|c'est quoi plag)/i,
      build: () => `Je suis **PLAG AI**, une intelligence artificielle créée par **PLAG-TECH** — pensée pour répondre vite, en français comme en kreyòl. 👋

### Ce que je sais faire
- ✍️ **Écrire** : e-mails, articles, posts réseaux sociaux, traductions.
- 💻 **Coder** : je génère, explique et corrige du code (JS, Python, SQL…).
- 🧠 **Expliquer** : concepts complexes simplifiés, résumés, plans d'action.
- 🎨 **Créer** : idées, noms, scripts, slogans.

> ⚠️ Tu vois actuellement le **mode démo** de l'interface : l'API locale \`127.0.0.1:8765\` n'était pas joignable depuis ce navigateur. Lance le site sur la machine où tourne PLAG AI pour des réponses réelles.

Voici la requête exacte qu'utilise l'interface :

\`\`\`bash
curl -X POST http://127.0.0.1:8765/v1/chat \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: $(cat /etc/plag-ai/api.key)" \\
  -d '{
    "messages": [{"role": "user", "content": "Bonjour !"}],
    "think": false,
    "stream": false
  }'
\`\`\`

Une question ? J'écoute.`,
    },
    {
      match: /(code|react|python|js|javascript|fonction|algo|bug)/i,
      build: () => `Bonne idée — voici une base propre et animée.

\`\`\`jsx
import { useState } from 'react';
import { motion } from 'framer-motion';

export default function ProductCard({ product }) {
  const [liked, setLiked] = useState(false);

  return (
    <motion.article
      whileHover={{ y: -6 }}
      className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur"
    >
      <h3 className="text-lg font-semibold">{product.name}</h3>
      <p className="mt-1 text-sm text-white/60">{product.price} HTG</p>
      <button
        onClick={() => setLiked(!liked)}
        className="mt-4 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 text-sm font-semibold text-black"
      >
        {liked ? '♥ Ajouté' : '♡ J’aime'}
      </button>
    </motion.article>
  );
}
\`\`\`

**Ce que ça fait :**
1. Animation d'élévation au survol (\`whileHover\`).
2. État local pour le bouton « j'aime ».
3. Styles Tailwind : verre dépoli + dégradé.

> Mode démo actif — je simule ici la réponse de PLAG AI.`,
    },
    {
      match: /(kreyòl|creole|créole|ayisyen)/i,
      build: () => `Bonjou! 👋 Mwen se **PLAG AI**, yon entèlijans atifisyèl ki fèt pa **PLAG-TECH**.

Men sa mwen ka fè pou ou:
| Domèn | Egzanp |
| --- | --- |
| Redaksyon | Imèl, atik, pòs rezo sosyal |
| Kòd | JavaScript, Python, SQL |
| Eksplikasyon | Konsèp difisil, pi senp |
| Tradiksyon | Franse ↔ Kreyòl ↔ Anglè |

*(Mode démo : l'API PLAG AI locale n'est pas joignable depuis ce navigateur.)*`,
    },
  ];

  function demoText(prompt) {
    const found = DEMO_REPLIES.find((r) => r.match.test(prompt || ''));
    return found
      ? found.build()
      : `Merci pour ton message ! Petite précision d'abord : **l'API PLAG AI n'est pas joignable depuis ce navigateur**, je réponds donc en *mode démo* 🤖.

Pour obtenir de vraies réponses :

1. Lance le service PLAG AI sur \`127.0.0.1:8765\`.
2. Démarre ce site sur la même machine : \`npm start\`.
3. Ouvre \`http://localhost:3000\` — le voyant passe au **vert**.

\`\`\`bash
# terminal 1 — ton API doit déjà tourner
# terminal 2
cd HAITI-MD && npm start
\`\`\`

Dès que l'API répond, cet écran devient un vrai chat : réponses en streaming, raisonnement optionnel, historique sauvegardé.`;
  }

  async function demoReply(assistant, conv, refs, signal, queuePaint) {
    assistant.demo = true;
    if (state.api.mode !== 'demo') setApiState('demo');
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    const full = demoText(lastUser ? lastUser.content : '');
    const startedAt = Date.now();
    const tokens = full.match(/\S+\s*/g) || [full];

    for (const token of tokens) {
      if (signal && signal.aborted) break;
      assistant.content += token;
      queuePaint && queuePaint();
      await new Promise((r) => setTimeout(r, 14 + Math.random() * 22));
    }
    assistant.ms = Date.now() - startedAt;
  }

  /* ---------------------- Santé de l'API ---------------------- */

  function setApiState(mode, info) {
    state.api.mode = mode;
    if (info) Object.assign(state.api, info);
    updateDemoNotice(mode);

    const pill = els.statusPill;
    const badge = els.liveBadge;
    const label = $('.status-text', pill);
    const badgeText = $('.badge-text', badge);

    pill.dataset.state = mode === 'live' ? 'live' : mode === 'demo' ? 'demo' : mode === 'checking' ? 'checking' : 'error';
    badge.dataset.state = pill.dataset.state;

    if (mode === 'live') {
      label.textContent = 'API connectée · en ligne';
      badgeText.textContent = 'PLAG AI · en ligne';
      els.modeInfo.hidden = true;
    } else if (mode === 'demo') {
      const reason = state.api.hasKey === false ? 'clé API absente' : 'API hors ligne';
      label.textContent = `Mode démo · ${reason}`;
      badgeText.textContent = 'démo';
      els.modeInfo.hidden = false;
      els.modeInfo.textContent = 'démo';
      els.modeInfo.title = state.api.hasKey === false ? "Clé API introuvable (PLAG_API_KEY ou /etc/plag-ai/api.key)" : `API ${state.api.upstream || ''} injoignable`;
    } else if (mode === 'checking') {
      label.textContent = "Vérification de l'API…";
      badgeText.textContent = 'PLAG AI';
    } else {
      label.textContent = 'API injoignable';
      badgeText.textContent = 'hors ligne';
    }
  }

  function updateDemoNotice(mode) {
    const notice = els.demoNotice;
    if (!notice) return;
    const dismissed = sessionStorage.getItem('plagai.notice.dismissed') === '1';
    if (mode !== 'demo' || dismissed) {
      notice.hidden = true;
      return;
    }
    if (state.api.hasKey === false) {
      els.demoNoticeTitle.textContent = 'Clé API absente';
      els.demoNoticeText.textContent =
        "Renseigne PLAG_API_KEY dans .env (ou dépose la clé dans /etc/plag-ai/api.key), puis redémarre le serveur. En attendant, les réponses sont simulées.";
    } else {
      els.demoNoticeTitle.textContent = 'API PLAG AI injoignable';
      els.demoNoticeText.textContent =
        "Démarre ce site sur la machine où tourne l'API (127.0.0.1:8765), puis recharge la page. En attendant, les réponses sont simulées.";
    }
    notice.hidden = false;
  }

  async function checkHealth() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('health');
      const data = await res.json();
      setApiState(data.mode === 'live' ? 'live' : 'demo', {
        reachable: data.reachable,
        hasKey: data.hasKey,
        keySource: data.keySource,
        upstream: data.upstream,
      });
    } catch {
      setApiState('demo', { reachable: false, hasKey: false });
    }
  }

  /* ---------------------- Thème ---------------------- */

  function applyTheme(theme) {
    state.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    save();
  }

  /* ---------------------- Barre latérale mobile ---------------------- */

  function openSidebar() {
    els.sidebar.classList.add('open');
    els.scrim.hidden = false;
  }
  function closeSidebar() {
    els.sidebar.classList.remove('open');
    els.scrim.hidden = true;
  }

  /* ---------------------- Export ---------------------- */

  function exportMarkdown() {
    const conv = activeConvo();
    if (!conv || !conv.messages.length) {
      toast('Rien à exporter pour le moment');
      return;
    }
    const lines = [`# ${conv.title}`, '', `_Exporté depuis PLAG AI · Studio — ${new Date().toLocaleString('fr-FR')}_`, ''];
    for (const m of conv.messages) {
      lines.push(`## ${m.role === 'user' ? '🧑 Toi' : '🤖 PLAG AI'}`, '');
      if (m.thinking) lines.push('<details><summary>Raisonnement</summary>', '', m.thinking, '', '</details>', '');
      lines.push(m.content || '_(vide)_', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(conv.title || 'plag-ai').replace(/[^\w\s-]/g, '').trim().slice(0, 40) || 'plag-ai'}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Conversation exportée');
  }

  /* ---------------------- Dictée vocale ---------------------- */

  let recognition = null;
  function setupSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      els.micBtn.hidden = true;
      return;
    }
    recognition = new SR();
    recognition.lang = 'fr-FR';
    recognition.interimResults = true;
    recognition.continuous = false;

    let base = '';
    recognition.onstart = () => {
      base = els.input.value ? els.input.value + ' ' : '';
      els.micBtn.classList.add('live');
      els.micBtn.setAttribute('aria-pressed', 'true');
    };
    recognition.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
      }
      els.input.value = base + text;
      autoGrow();
    };
    recognition.onerror = () => toast('Dictée indisponible sur ce navigateur');
    recognition.onend = () => {
      els.micBtn.classList.remove('live');
      els.micBtn.setAttribute('aria-pressed', 'false');
      els.input.focus();
    };

    els.micBtn.addEventListener('click', () => {
      try {
        recognition.start();
      } catch {
        recognition.stop();
      }
    });
  }

  /* ---------------------- Événements ---------------------- */

  function bind() {
    els.composer.addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.streaming) return;
      sendMessage();
    });

    els.input.addEventListener('input', autoGrow);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!state.streaming) sendMessage();
      }
    });

    els.stopBtn.addEventListener('click', () => {
      abortStreaming();
      toast('Génération arrêtée');
    });

    els.thinkChip.addEventListener('click', () => {
      state.settings.think = !state.settings.think;
      els.thinkChip.setAttribute('aria-pressed', String(state.settings.think));
      save();
      toast(state.settings.think ? 'Réflexion activée — PLAG AI raisonnera avant de répondre' : 'Réflexion désactivée');
    });

    els.regenBtn.addEventListener('click', () => regenerate(null));

    $('#newChatBtn').addEventListener('click', newConversation);
    $('#clearAllBtn').addEventListener('click', () => {
      if (!state.conversations.some((c) => c.messages.length)) {
        toast('Historique déjà vide');
        return;
      }
      if (confirm('Effacer toutes les discussions ?')) {
        state.conversations = [blankConversation()];
        state.activeId = state.conversations[0].id;
        save();
        renderHistory();
        renderThread();
        updateHeader();
        toast('Historique effacé');
      }
    });

    $('#themeBtn').addEventListener('click', () => applyTheme(state.settings.theme === 'dark' ? 'light' : 'dark'));
    $('#exportBtn').addEventListener('click', exportMarkdown);

    $('#menuBtn').addEventListener('click', openSidebar);
    $('#sidebarClose').addEventListener('click', closeSidebar);
    els.scrim.addEventListener('click', closeSidebar);

    $('#shortcutsBtn').addEventListener('click', () => els.shortcutsModal.showModal());

    $('#demoNoticeClose').addEventListener('click', () => {
      els.demoNotice.hidden = true;
      try {
        sessionStorage.setItem('plagai.notice.dismissed', '1');
      } catch {
        /* stockage indisponible */
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newConversation();
      }
      if (e.key === 'Escape' && state.streaming) {
        abortStreaming();
        toast('Génération arrêtée');
      }
    });

    // Copie des blocs de code (délégation)
    els.threadInner.addEventListener('click', (e) => {
      const btn = e.target.closest('.copy-code');
      if (!btn) return;
      const code = btn.closest('.code')?.querySelector('code');
      if (!code) return;
      copyText(code.textContent).then((ok) => {
        if (!ok) return toast('Copie impossible');
        btn.textContent = 'Copié ✓';
        setTimeout(() => {
          btn.textContent = 'Copier';
        }, 1600);
      });
    });

    // Re-vérifie l'API quand on revient sur l'onglet
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkHealth();
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) closeSidebar();
    });
  }

  /* ---------------------- Démarrage ---------------------- */

  function init() {
    load();
    applyTheme(state.settings.theme || 'dark');
    els.thinkChip.setAttribute('aria-pressed', String(state.settings.think));
    bind();
    setupSpeech();
    renderHistory();
    renderThread();
    updateHeader();
    autoGrow();
    setApiState('checking');
    checkHealth();
    clearInterval(state.healthTimer);
    state.healthTimer = setInterval(checkHealth, 30000);
    els.input.focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
