// room.js - Room: one game's room, a Durable Object holding the game's socket and one socket per phone (UC-1.1-1.6).
// It uses the hibernation API (ctx.acceptWebSocket), so a quiet room costs nothing; what must outlive hibernation (the room's
// set-up, the seats held for phones that dropped) is in storage, and each socket carries its role and seat as an attachment.
// The relay forwards and checks; it keeps no input and nothing about anyone once the room closes.
import { DurableObject } from 'cloudflare:workers';
import * as R from './rules.js';

const send = (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch { /* the socket is closing; its close handler cleans up */ } };
const shut = (ws, code, why) => { try { ws.close(code, why); } catch { /* already closed */ } };

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rates = new WeakMap();                  // per phone socket, one second at a time; lost on hibernation, which is fine
  }

  async fetch(request) {
    const role = request.headers.get('x-role');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (role === 'host') {
      if (this.ctx.getWebSockets('host').length) return new Response('room in use', { status: 409 });
      await this.ctx.storage.deleteAll();        // a fresh room: nothing from an earlier game under this code
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ role: 'host', code: request.headers.get('x-code'), self: request.headers.get('x-self') });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (role === 'phone') {
      const room = await this.ctx.storage.get('room');
      if (!room || !this.ctx.getWebSockets('host').length) return this.refuse(server, client, 4004, 'no_room');
      const held = (await this.ctx.storage.get('held')) || {};
      const taken = new Set(this.ctx.getWebSockets('phone').map((w) => w.deserializeAttachment().seat));
      const pick = R.pickSeat({ seats: room.seats, taken, held, token: request.headers.get('x-token'), now: Date.now() });
      if (!pick.ok) return this.refuse(server, client, 4009, 'full');
      const token = pick.rejoin ? held[pick.seat].token : crypto.randomUUID();
      delete held[pick.seat];
      await this.ctx.storage.put('held', held);
      this.ctx.acceptWebSocket(server, ['phone', 'seat:' + pick.seat]);
      server.serializeAttachment({ role: 'phone', seat: pick.seat, token });
      send(server, { t: 'seat', seat: pick.seat, token, layout: room.layout, labels: room.labels, seats: room.seats, code: room.code });
      for (const h of this.ctx.getWebSockets('host')) send(h, { t: 'join', seat: pick.seat, rejoin: pick.rejoin });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('no role', { status: 400 });
  }

  refuse(server, client, code, why) {            // a browser cannot read an HTTP error on a socket, so say it on the socket
    server.accept();
    send(server, { t: 'error', why });
    shut(server, code, why);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const who = ws.deserializeAttachment();
    if (who.role === 'host') return this.fromHost(ws, who, raw);
    let counter = this.rates.get(ws);
    if (!counter) this.rates.set(ws, (counter = { start: Date.now(), n: 0 }));
    if (!R.rateOk(counter, Date.now(), R.LIMITS.phoneMsgsPerSecond)) return shut(ws, 4029, 'too many messages');
    const r = R.readPhone(raw);
    if (!r.ok) { send(ws, { t: 'error', why: r.why }); return shut(ws, 4400, r.why.slice(0, 120)); }
    for (const h of this.ctx.getWebSockets('host')) send(h, { ...r.msg, seat: who.seat });
  }

  async fromHost(ws, who, raw) {
    const room = await this.ctx.storage.get('room');
    if (!room) {                                 // UC-1.1: the first message opens the room
      const h = R.readHello(raw);
      if (!h.ok) { send(ws, { t: 'error', why: h.why }); return shut(ws, 4400, h.why.slice(0, 120)); }
      const join = R.joinUrl(who.self, who.code);
      const open = { ...h.hello, code: who.code, join };
      await this.ctx.storage.put('room', open);
      return send(ws, { t: 'room', code: who.code, join, qr: R.qrBits(join), layout: open.layout, seats: open.seats });
    }
    const r = R.readHost(raw, room.seats);
    if (!r.ok) return send(ws, { t: 'error', why: r.why });   // a host's bad message is reported, the room stays open
    const m = r.msg;
    if (m.t === 'layout') {
      await this.ctx.storage.put('room', { ...room, layout: m.layout, labels: m.labels });
      for (const p of this.ctx.getWebSockets('phone')) send(p, m);
      return;
    }
    const phones = this.ctx.getWebSockets('seat:' + m.seat);
    if (!phones.length) return send(ws, { t: 'error', why: 'no phone in seat ' + m.seat });
    const out = m.t === 'rumble' ? { t: 'rumble', ms: m.ms } : m.t === 'ping' ? { t: 'ping', id: m.id } : { t: 'sig', d: m.d };
    for (const p of phones) send(p, out);
  }

  async webSocketClose(ws, code, reason) {
    const who = ws.deserializeAttachment();
    shut(ws, 1000, 'closed');
    if (!who) return;
    if (who.role === 'host') {                   // UC-1 alternate 6a: the game closed, so the room does
      for (const p of this.ctx.getWebSockets('phone')) { send(p, { t: 'host_gone' }); shut(p, 4001, 'host_gone'); }
      await this.ctx.storage.deleteAll();
      return;
    }
    if (who.role === 'phone' && typeof who.seat === 'number') {   // UC-1.6 and 2c: the seat is held for a rejoin
      const room = await this.ctx.storage.get('room');
      if (!room) return;
      const held = (await this.ctx.storage.get('held')) || {};
      held[who.seat] = { token: who.token, leftAt: Date.now() };
      await this.ctx.storage.put('held', held);
      for (const h of this.ctx.getWebSockets('host')) send(h, { t: 'leave', seat: who.seat });
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, 'error');
  }
}
