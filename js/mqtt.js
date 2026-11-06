/* Client MQTT 3.1.1 minimo su WebSocket: quanto serve per ricevere i dati live dal telefono.
   (Niente librerie esterne: CONNECT, SUBSCRIBE, PUBLISH QoS 0, PING, riconnessione automatica.) */
'use strict';
(function (root) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const str = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
  const varLen = n => { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0); return out; };
  const packet = (type, body) => new Uint8Array([type, ...varLen(body.length), ...body]);

  class MqttClient {
    constructor({ url, clientId, username, password, keepalive = 20 }) {
      this.url = url; this.clientId = clientId || 'n17dv-' + Math.random().toString(36).slice(2, 10);
      this.username = username || ''; this.password = password || ''; this.keepalive = keepalive;
      this.subs = new Map(); this.buf = new Uint8Array(0); this.pid = 1; this.closed = false; this.retry = 0;
      this.onmessage = null; this.onstate = null; this.state = 'idle';
    }
    setState(s, detail) { this.state = s; this.onstate && this.onstate(s, detail); }
    connect() {
      this.closed = false;
      this.setState('connecting');
      let ws;
      try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { this.setState('error', e.message); return this.schedule(); }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        let flags = 0x02; // clean session
        const pay = [...str(this.clientId)];
        if (this.username) { flags |= 0x80; pay.push(...str(this.username)); }
        if (this.password) { flags |= 0x40; pay.push(...str(this.password)); }
        ws.send(packet(0x10, [...str('MQTT'), 4, flags, this.keepalive >> 8, this.keepalive & 255, ...pay]));
      };
      ws.onmessage = e => this.feed(new Uint8Array(e.data));
      ws.onerror = () => {};
      ws.onclose = () => { clearInterval(this.ping); if (!this.closed) { this.setState('reconnecting'); this.schedule(); } else this.setState('closed'); };
    }
    schedule() { if (this.closed) return; const d = Math.min(10000, 500 * Math.pow(2, this.retry++)); setTimeout(() => this.connect(), d); }
    close() { this.closed = true; clearInterval(this.ping); try { this.ws && this.ws.send(new Uint8Array([0xE0, 0])); this.ws && this.ws.close(); } catch (e) { /* già chiuso */ } }
    subscribe(topic, cb) { this.subs.set(topic, cb); if (this.state === 'connected') this.sendSub(topic); }
    sendSub(topic) { const id = this.pid++ & 0xffff; this.ws.send(packet(0x82, [id >> 8, id & 255, ...str(topic), 0])); }
    publish(topic, payload, retain = false) {
      if (this.state !== 'connected') return false;
      const p = typeof payload === 'string' ? enc.encode(payload) : payload;
      this.ws.send(packet(0x30 | (retain ? 1 : 0), [...str(topic), ...p]));
      return true;
    }
    // i pacchetti MQTT possono arrivare spezzati o in gruppo dentro i messaggi WebSocket
    feed(chunk) {
      const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length);
      let p = 0;
      while (p + 2 <= b.length) {
        let len = 0, mul = 1, q = p + 1, ok = false;
        for (let i = 0; i < 4 && q < b.length; i++, q++) { len += (b[q] & 127) * mul; mul *= 128; if (!(b[q] & 128)) { ok = true; q++; break; } }
        if (!ok || q + len > b.length) break;
        this.handle(b[p], b.subarray(q, q + len));
        p = q + len;
      }
      this.buf = b.slice(p);
    }
    handle(h, body) {
      const type = h >> 4;
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { this.setState('error', 'Il server ha rifiutato il collegamento (codice ' + body[1] + ').'); this.closed = true; this.ws.close(); return; }
        this.retry = 0; this.setState('connected');
        for (const t of this.subs.keys()) this.sendSub(t);
        clearInterval(this.ping);
        this.ping = setInterval(() => { try { this.ws.send(new Uint8Array([0xC0, 0])); } catch (e) { /* in chiusura */ } }, this.keepalive * 1000 * 0.75);
      } else if (type === 3) { // PUBLISH
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tl));
        let off = 2 + tl;
        if ((h >> 1) & 3) off += 2; // QoS > 0: c'è l'identificativo del pacchetto
        const payload = body.subarray(off);
        for (const [f, cb] of this.subs) if (topicMatch(f, topic)) cb(topic, payload);
        this.onmessage && this.onmessage(topic, payload);
      }
    }
  }
  function topicMatch(filter, topic) {
    const f = filter.split('/'), t = topic.split('/');
    for (let i = 0; i < f.length; i++) { if (f[i] === '#') return true; if (f[i] !== '+' && f[i] !== t[i]) return false; }
    return f.length === t.length;
  }
  root.MqttClient = MqttClient;
  if (typeof module !== 'undefined') module.exports = { MqttClient };
})(typeof window !== 'undefined' ? window : globalThis);
