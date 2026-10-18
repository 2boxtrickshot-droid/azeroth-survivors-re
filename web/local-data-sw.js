// Bridge the unchanged renderer's synchronous /data reads to its independent MPQ worker.
// No asset cache, persistence, upload, or network fallback for a local-data session.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/data/')) return;
  event.respondWith((async () => {
    let mount = url.searchParams.get('localData');
    if (!mount) { const client = await self.clients.get(event.clientId); mount = client && new URL(client.url).searchParams.get('localData'); }
    if (!mount || !/^[a-f0-9-]{36}$/.test(mount)) return fetch(event.request);
    if (!['GET', 'HEAD'].includes(event.request.method)) return new Response(null, { status: 405 });
    // Missing index deliberately uses the original Chain's accurate HEAD fallback.
    if (url.pathname === '/data/__index') return new Response(null, { status: 404 });
    let name;
    try { name = decodeURIComponent(url.pathname.slice(6)).replaceAll('/', '\\'); }
    catch { return new Response(null, { status: 400 }); }
    if (!name || name.length > 1024) return new Response(null, { status: 400 });
    const channel = new BroadcastChannel(`azeroth-data-${mount}`), id = crypto.randomUUID();
    return new Promise(resolve => {
      const finish = response => { clearTimeout(timer); channel.close(); resolve(response); };
      const timer = setTimeout(() => finish(new Response('Local data reader stopped. Reselect your Data folder.', { status: 503 })), 30000);
      channel.onmessage = ({ data }) => {
        if (data.id !== id) return;
        finish(new Response(event.request.method === 'HEAD' ? null : data.bytes || data.error || null, {
          status: data.status, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
        }));
      };
      channel.postMessage({ type: 'read', id, name, head: event.request.method === 'HEAD' });
    });
  })());
});
