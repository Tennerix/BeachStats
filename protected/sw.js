// ── SERVICE WORKER BEACHSTATS ────────────────────────────────────────────
// Stratégie "réseau d'abord, cache en secours" : on essaie toujours d'avoir
// la version la plus fraîche depuis le serveur ; si le réseau est absent ou
// trop lent à répondre, on sert la dernière version connue depuis le cache.
// Ça permet de continuer à noter un match (score, stats, PDF) même sans
// réseau sur la plage, tout en évitant de rester bloqué sur une vieille
// version de l'appli quand le réseau est disponible.
//
// Pour forcer tout le monde à récupérer une nouvelle version après une mise
// à jour du site, il suffit d'incrémenter CACHE_NAME (ex: 'beachstats-v2') :
// l'ancien cache sera automatiquement supprimé à l'étape "activate".
const CACHE_NAME = 'beachstats-v1';

// Pages principales pré-chargées dès l'installation, pour qu'elles soient
// utilisables hors ligne dès la première visite (pas besoin d'attendre
// d'avoir déjà ouvert chaque page une fois).
const APP_SHELL = [
  '/',
  '/points',
  '/base',
  '/intermediaire',
  '/historique',
  '/live',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // une ressource indisponible au 1er chargement ne doit pas bloquer l'installation
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // On ne met jamais en cache : les requêtes non-GET (ex: /verify en POST),
  // et les appels API dynamiques (/api/tier, /api/live/:code) qui doivent
  // toujours refléter l'état réel du moment, pas une version figée.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match('/'))
      )
  );
});
