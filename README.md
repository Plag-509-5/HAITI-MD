# PLAG AI · Studio

Une interface de chat nouvelle génération pour **PLAG AI**, l'IA créée par **PLAG-TECH**.
Design sombre « aurora », streaming en temps réel, raisonnement repliable, Markdown + code, historique local, thème clair, dictée vocale — **zéro dépendance npm**.

```
ta machine
┌──────────────────────────────────────────────┐
│  navigateur  →  http://localhost:3000        │
│        │                                     │
│        ▼                                     │
│  server.js (proxy + clé API)                 │
│        │  POST /v1/chat  (X-API-Key: …)      │
│        ▼                                     │
│  PLAG AI  127.0.0.1:8765                     │
└──────────────────────────────────────────────┘
```

Le navigateur ne voit jamais la clé API : c'est **server.js** qui lit
`/etc/plag-ai/api.key` (ou `PLAG_API_KEY`) et signe les requêtes.

---

## Démarrage rapide

Prérequis : Node.js ≥ 18 et le service PLAG AI qui tourne sur `127.0.0.1:8765`.

```bash
cd HAITI-MD
npm start          # ou : node server.js
```

Puis ouvre **http://localhost:3000**.

Si le service PLAG AI écoute ailleurs :

```bash
PLAG_API_URL=http://192.168.1.20:8765/v1/chat PLAG_API_KEY=ma-cle npm start
```

> ⚠️ Le site doit tourner **sur la machine (ou le réseau) où l'API est joignable**.
> Ouvert depuis un autre ordinateur, `127.0.0.1` désignerait ce navigateur, pas ton serveur.

### Configuration

Copie `.env.example` en `.env` :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port de l'interface |
| `HOST` | `0.0.0.0` | Interface d'écoute |
| `PLAG_API_URL` | `http://127.0.0.1:8765/v1/chat` | Endpoint de chat (prioritaire) |
| `PLAG_API_URL_FALLBACK` | — | Endpoint(s) de repli, séparés par des virgules |
| `PLAG_API_KEY` | — | Clé API (prioritaire) |
| `PLAG_API_KEY_FILE` | `/etc/plag-ai/api.key` | Fichier de clé si `PLAG_API_KEY` est vide |
| `PLAG_TIMEOUT_MS` | `300000` | Délai maximum d'une réponse |

La clé est aussi cherchée dans `.plag-ai-key` à la racine du projet.

**Deux endpoints à la fois.** Le serveur sonde les URLs dans l'ordre (sonde HTTP, mise en cache 8 s)
et utilise la première qui répond. Exemple typique :

```bash
PLAG_API_URL=http://127.0.0.1:8765/v1/chat            # sur la machine de l'API → rapide
PLAG_API_URL_FALLBACK=http://203.0.113.42:8765/v1/chat # depuis ailleurs → IP publique
```

Le même `.env` fonctionne donc en local **et** à distance, sans rien changer.

---

## Ce que fait l'interface

- **Streaming mot à mot** avec curseur animé, bouton **Stop** et latence affichée.
- **Réflexion optionnelle** (chip « Réflexion » → `think: true`), raisonnement repliable.
- **Markdown complet** : titres, listes, citations, tableaux, liens, code inline.
- **Blocs de code** avec langue détectée et bouton *Copier*.
- **Historique** des discussions sauvegardé en local (`localStorage`), suppression, titre automatique.
- **Export** de la conversation en Markdown.
- **Thème clair / sombre**, responsive mobile (menu latéral coulissant).
- **Dictée vocale** (Web Speech API, `fr-FR`) si le navigateur la supporte.
- **Mode démo** automatique : si l'API est injoignable, l'interface reste utilisable et annonce clairement le mode démo.
- **Test de connexion** intégré : bouton « Tester la connexion » (ou clic sur la pastille d'état) → latence, code HTTP, message d'erreur exact de l'API.
- Raccourcis : `Entrée` envoyer · `Maj+Entrée` nouvelle ligne · `⌘/Ctrl+K` nouvelle discussion · `Échap` stop.

---

## Comment la réponse est normalisée

`server.js` accepte plusieurs formats de sortie et les convertit en un flux unique pour le navigateur
(`data: {"type":"delta","text":"…"}`) :

- OpenAI-like : `choices[0].delta.content`, `choices[0].message.content`
- Ollama : `message.content`, `response`
- Champs simples : `text`, `content`, `answer`, `output`, `result`, `reply`
- Raisonnement : `reasoning_content`, `reasoning`, `thinking`
- Flux SSE (`text/event-stream`), ndjson, ou JSON complet (repli automatique)

Aucune modification n'est donc nécessaire si l'API PLAG AI évolue légèrement.

### Endpoints internes

| Route | Description |
| --- | --- |
| `POST /api/chat` | Proxy vers PLAG AI (`{ messages, think, stream }`) |
| `GET /api/health` | État : `{ reachable, hasKey, mode: "live" \| "demo", upstream }` |
| `POST /api/ping` | **Test réel** : envoie une mini-requête signée et renvoie latence, statut HTTP et début de réponse |

---

## Développer sans l'API

Un faux serveur imite PLAG AI (réponses en streaming, Markdown, tableaux) :

```bash
# terminal 1
MOCK_KEY=dev node tools/mock-upstream.js     # 127.0.0.1:8765

# terminal 2
PLAG_API_URL=http://127.0.0.1:8765/v1/chat PLAG_API_KEY=dev npm start
```

---

## Structure

```
.
├── server.js              # proxy + fichiers statiques (aucune dépendance)
├── public/
│   ├── index.html         # structure de l'interface
│   ├── styles.css         # design « aurora », thèmes clair/sombre, responsive
│   ├── app.js             # chat, streaming, historique, thème, dictée
│   ├── markdown.js        # moteur Markdown maison
│   └── favicon.svg
├── tools/mock-upstream.js # faux serveur PLAG AI pour le dev
├── .env.example
└── package.json
```

## Sécurité

- La clé API reste **côté serveur** : le navigateur ne reçoit jamais `X-API-Key`, aucun secret n'est écrit dans le HTML ou le JS.
- `.env` est ignoré par Git. Ne committe jamais ta clé ; en cas de fuite, **régénère-la**.
- Exposer l'API sur une **IP publique** en HTTP simple fait circuler la clé **en clair** : place de préférence un reverse-proxy **HTTPS** (Caddy, Nginx, Cloudflare Tunnel), restreins les IP autorisées par pare-feu, et n'ouvre le port que si nécessaire.
- L'interface n'a pas d'authentification : si tu la publies, protège-la (mot de passe, VPN, Cloudflare Access…).

## Dépannage

| Symptôme | Cause probable |
| --- | --- |
| Pastille « Mode démo · API hors ligne » | Le service PLAG AI n'écoute pas sur l'URL configurée (`curl` l'endpoint pour vérifier). |
| « Mode démo · clé API absente » | Ni `PLAG_API_KEY`, ni `/etc/plag-ai/api.key`, ni `.plag-ai-key`. |
| Erreur 401/403 | Clé refusée par l'API — teste avec le bouton **Tester la connexion**. |
| « Impossible de joindre … depuis ce serveur » | L'API n'est pas accessible depuis la machine qui fait tourner `server.js` (pare-feu, port fermé, IP changée). |
| Rien ne s'affiche après envoi | Vérifie la console du navigateur et les logs de `server.js`. |

---

Fait avec soin pour **PLAG-TECH** · PLAG AI peut se tromper : vérifie les informations importantes.
