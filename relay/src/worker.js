// worker.js - the relay's front door. Static files (the phone's controller page, phonepad-host.js) are served from
// public/ before this runs; this handles the two sockets and a health check, and hands each socket to its room (Room).
//   /ws/host            a game opens a room (UC-1.1); the relay picks a free 4-letter code
//   /ws/phone/<CODE>    a phone joins that room (UC-1.2); ?token= takes back a seat it held (alternate 2c)
//   /health             { ok, version }
import * as R from './rules.js';
export { Room } from './room.js';

const VERSION = 1;
const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, version: VERSION });
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
    const origin = request.headers.get('Origin');

    if (url.pathname === '/ws/host') {
      if (!upgrade) return text(426, 'a WebSocket upgrade is required');
      if (!R.allowedHost(origin, env.HOST_ORIGINS, env.ALLOW_NO_ORIGIN_HOSTS === 'true', url.origin)) return text(403, 'this game\'s origin is not on HOST_ORIGINS: ' + origin);
      for (let tries = 0; tries < 8; tries++) {  // a code already in use answers 409; another random code is tried
        const code = R.makeCode(crypto.getRandomValues(new Uint8Array(R.CODE_LENGTH)));
        const headers = new Headers(request.headers);
        headers.set('x-role', 'host'); headers.set('x-code', code); headers.set('x-self', url.origin);
        const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }));
        if (res.status !== 409) return res;
      }
      return text(503, 'no free room code after 8 tries');
    }

    const phone = /^\/ws\/phone\/([^/]+)$/.exec(url.pathname);
    if (phone) {
      if (!upgrade) return text(426, 'a WebSocket upgrade is required');
      if (!R.allowedPhone(origin, url.origin)) return text(403, 'phones join from this relay\'s own page');
      const code = R.readCode(decodeURIComponent(phone[1]));
      if (!code) return text(400, 'not a room code');
      const headers = new Headers(request.headers);
      headers.set('x-role', 'phone'); headers.set('x-token', url.searchParams.get('token') || '');
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }));
    }
    return text(404, 'not found');
  },
};
