/* Uscita di esempio: dati simulati per provare l'app senza file veri.
   Crea un CSV nel formato Vakaros (10 Hz) e uno nel formato Cyclops / Smart Fittings Manager (1 Hz). */
'use strict';
async function createDemoSession() {
  const date = '2026-11-01';
  const t0 = new Date(date + 'T11:00:00').getTime();
  const N = 45 * 60 * 10; // 45 minuti a 10 Hz
  const TWD = 300, R = 6371008.8, rad = Math.PI / 180;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Programma: bolina con virate, poppa con strambate
  const legs = [];
  let tt = 0;
  const plan = [['up', 6], ['down', 5], ['up', 7], ['down', 5]];
  for (const [kind, n] of plan) for (let i = 0; i < n; i++) { const d = 70 + rnd() * 80; legs.push({ kind, side: i % 2, a: tt, b: tt + d }); tt += d; }
  const legAt = s => legs.find(l => s >= l.a && s < l.b) || legs[legs.length - 1];
  let lat = 39.1900, lon = 9.1700, hdg = TWD - 45, sog = 12;
  const vk = ['timestamp,latitude,longitude,sog_kts,cog,hdg_true,roll,pitch'];
  const cy = ['Timestamp, Latitude, Longitude, Heading,1555,1556', 'yyyy-MM-dd HH:mm:ss.SSS, °, °, °,kg,kg'];
  const p2_ = n => String(n).padStart(2, '0');
  const loc = d => `${d.getFullYear()}-${p2_(d.getMonth() + 1)}-${p2_(d.getDate())} ${p2_(d.getHours())}:${p2_(d.getMinutes())}:${p2_(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  let gust = 0;
  for (let k = 0; k < N; k++) {
    const s = k / 10, L = legAt(s), since = s - L.a;
    const up = L.kind === 'up';
    const target = up ? (L.side ? TWD + 44 : TWD - 44) : (L.side ? TWD + 180 - 38 : TWD + 180 + 38);
    // virata/strambata: la prua ruota in ~5 s, la velocità cala e risale
    const turnT = 5;
    const prevTarget = up ? (L.side ? TWD - 44 : TWD + 44) : (L.side ? TWD + 180 + 38 : TWD + 180 - 38);
    const a = clamp(since / turnT, 0, 1);
    const want = since < turnT && L !== legs[0] ? prevTarget + angDiff(target, prevTarget) * (a * a * (3 - 2 * a)) : target;
    hdg = (want + (rnd() - .5) * 3 + 360) % 360;
    gust += (rnd() - .5) * 0.08; gust *= 0.995;
    const base = up ? 12.5 : 19 + gust * 6;
    const drop = since < 18 && L !== legs[0] ? (up ? 7 : 6) * Math.exp(-Math.pow((since - 4) / 4, 2)) : 0;
    sog += ((base + gust * 2 - drop) - sog) * 0.08 + (rnd() - .5) * .05;
    const ms = sog / KN;
    lat += ms * 0.1 * Math.cos(hdg * rad) / R / rad;
    lon += ms * 0.1 * Math.sin(hdg * rad) / (R * Math.cos(lat * rad)) / rad;
    const heelSide = up ? (L.side ? 1 : -1) : (L.side ? -1 : 1);
    const roll = heelSide * (up ? 4 : 2.5) * (1 - (drop > 2 ? .8 : 0)) + Math.sin(s / 2.3) * 1.5 + (rnd() - .5);
    const pitch = (up ? 1.2 : -0.6) + Math.sin(s / 1.7) * .9 + drop * .3 + (rnd() - .5) * .4;
    const d = new Date(t0 + k * 100);
    vk.push(`${d.toISOString()},${lat.toFixed(7)},${lon.toFixed(7)},${sog.toFixed(2)},${hdg.toFixed(1)},${((hdg + (rnd() - .5) * 4 + 360) % 360).toFixed(1)},${roll.toFixed(2)},${pitch.toFixed(2)}`);
    if (k % 10 === 3) {
      // orologio del telefono del Cyclops 4 s indietro: si corregge con "Allinea con il GPS"
      const dc = new Date(t0 + k * 100 - 4000);
      const strallo = (up ? 420 : 300) + sog * 9 + (rnd() - .5) * 40 - drop * 25;
      const scotta = (up ? 380 : 210) + sog * (up ? 12 : 6) + (rnd() - .5) * 35 - drop * 30;
      cy.push(`${loc(dc)}, ${lat.toFixed(8)}, ${lon.toFixed(8)},${hdg.toFixed(1).padStart(5)},${strallo.toFixed(1).padStart(6)},${scotta.toFixed(1).padStart(6)},`);
    }
  }
  const meta = newSessionMeta({
    title: 'Esempio · Golfo di Cagliari', date, place: 'Cagliari, Poetto', boat: 'Nacra 17', helm: 'Timoniere', crew: 'Prodiere',
    windMin: 12, windMax: 16, twd: TWD, sea: 'Onda corta', goals: 'Virate in bolina: uscita veloce. Strambate senza toccare.', notes: 'Uscita generata dall\'app con dati simulati, per provare le funzioni.'
  });
  const folder = await Store.createSession(meta);
  await Store.writeText(`${folder}/dati/vakaros_esempio.csv`, vk.join('\n'));
  await Store.writeText(`${folder}/dati/cyclops_esempio.csv`, cy.join('\n'));
  for (const [file, name] of [['dati/vakaros_esempio.csv', 'Vakaros Atlas 2'], ['dati/cyclops_esempio.csv', 'Cyclops']]) {
    const text = await Store.readText(`${folder}/${file}`);
    const tab = parseTable(text), cols = analyzeCols(tab);
    const cfg = guessSourceConfig(tab, cols);
    if (cfg.kind === 'Cyclops') { cfg.columns.forEach(c => { if (c.col === '1555') c.name = 'Strallo'; if (c.col === '1556') c.name = 'Scotta randa'; }); cfg.offset = 4; }
    meta.sources.push(Object.assign({ id: uid('s'), file, name }, cfg));
  }
  meta.events.push({ id: uid('e'), t: t0 + 30000, type: 'partenza', note: 'Inizio lavoro di bolina' });
  meta.events.push({ id: uid('e'), t: t0 + Math.round(legs[2].a * 1000), type: 'nota', note: 'Raffica da sinistra, scotta lasca troppo tardi' });
  await Store.saveSession(folder, meta);
  return folder;
}
