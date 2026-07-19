// 등불 서비스 워커 — 오프라인/재방문 시 빠른 로딩을 위한 앱 셸 캐싱
// 버전을 올리면 이전 캐시는 자동으로 정리됩니다.
const CACHE_VERSION = 'deungbul-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/bible_kr.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Claude API 호출은 절대 캐시하지 않음 (매번 새 조언이어야 함)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 페이지 자체는 네트워크 우선 (최신 버전 유지), 실패하면 캐시로 폴백 (오프라인 지원)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 그 외 정적 자산(성경 데이터, 아이콘 등)은 캐시 우선
  if (CORE_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  }
});
