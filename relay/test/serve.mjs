// A static server for test/host_page.html on http://127.0.0.1:8833 (one of the relay's HOST_ORIGINS), so a real browser can
// play the game's side against a real relay. Run: node test/serve.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = 8833;
const here = new URL('.', import.meta.url);
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path !== '/' && path !== '/host_page.html') { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(await readFile(new URL('host_page.html', here)));
}).listen(PORT, '127.0.0.1', () => console.log('host test page on http://127.0.0.1:' + PORT + '/'));
