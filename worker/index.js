/* Lumiose Planner · Worker de Cloudflare
   - Sirve la web (los archivos estáticos los entrega Cloudflare solo; este código solo atiende /api/*).
   - Cada minuto captura los datos en vivo y los guarda tal cual en R2 (capa bronze), para ir acumulando el histórico:
       Bicing cada minuto · tráfico cada 5 min · tiempo cada 15 min · iBus de TMB cada 2 min (25 paradas de control por turno).
   - /api/ibus devuelve las previsiones de iBus de los últimos 20 minutos; el visor calcula con ellas el retraso de cada
     línea frente al horario. Las claves de TMB son secretos del Worker: nunca salen de aquí ni se guardan en R2.
   El plan gratuito da 10 ms de procesador por ejecución: aquí solo se descarga y se guarda; lo pesado (compactar por días)
   lo hace cada noche GitHub Actions. */
import CONTROL from './control.json';

const BICING_GBFS = 'https://api.citybik.es/gbfs/2/bicing/gbfs.json';
const TRAFICO = 'https://opendata-ajuntament.barcelona.cat/data/dataset/8319c2b1-4c21-4962-9acd-6db4c5ff1148/resource/2d456eb5-4ea6-4f68-9794-2f3f1a58a933/download';
const TIEMPO = 'https://api.open-meteo.com/v1/forecast?latitude=41.3874&longitude=2.1686&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day&timezone=Europe%2FMadrid';
const IBUS = 'https://api.tmb.cat/v1/itransit/bus/parades/';
const POR_CICLO = 25, VENTANA_S = 20 * 60;

// Fecha y hora de Barcelona (las particiones van por día local, como en pipeline/vivo.py)
function partes(d) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value;
  return o;
}
async function gzip(txt) { return new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); }
async function guardar(env, fuente, d, txt) {
  const p = partes(d);
  await env.DATOS.put(`bronze/${fuente}/fecha=${p.year}-${p.month}-${p.day}/${p.hour}${p.minute}${p.second}.json.gz`, await gzip(txt),
    { httpMetadata: { contentType: 'application/json' }, customMetadata: { ts: d.toISOString() } });
}
// Los errores nunca llevan la dirección completa: la de iBus contiene las claves
async function pedir(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'lumiose-planner (portfolio, victorquero.dev)' } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} respondió ${r.status}`);
  return r.text();
}

let feeds = null;                                                    // URLs de Bicing (se descubren una vez por instancia)
async function bicing(env, d, min) {
  if (!feeds) feeds = Object.fromEntries(Object.values(JSON.parse(await pedir(BICING_GBFS)).data)[0].feeds.map(f => [f.name, f.url]));
  await guardar(env, 'bicing', d, await pedir(feeds.station_status));
  if (min % 360 === 0) await guardar(env, 'bicing_info', d, await pedir(feeds.station_information));   // datos fijos, cada 6 h
}
async function trafico(env, d) { await guardar(env, 'trafico', d, await pedir(TRAFICO)); }
async function tiempo(env, d) { await guardar(env, 'tiempo', d, await pedir(TIEMPO)); }

// iBus: próximas llegadas en 25 paradas de control, por turnos (el turno sale del minuto: no hace falta guardar estado)
function llegadas(j, out) {
  if (Array.isArray(j)) { for (const v of j) llegadas(v, out); return out; }
  if (j && typeof j === 'object') {
    if (Array.isArray(j.propers_busos)) for (const b of j.propers_busos)
      out.push([j.nom_linia ?? null, j.codi_linia ?? null, j.id_sentit ?? null, b.temps_arribada]);
    for (const v of Object.values(j)) if (v && typeof v === 'object') llegadas(v, out);
  }
  return out;
}
async function ibus(env, d, min) {
  const n = CONTROL.length, desde = (Math.floor(min / 2) * POR_CICLO) % n;
  const lote = Array.from({ length: Math.min(POR_CICLO, n) }, (_, i) => CONTROL[(desde + i) % n]);
  const crudo = {}, ahora = d.getTime() / 1000, nuevas = [];
  let fallos = 0;
  await Promise.all(lote.map(async codi => {
    const r = await fetch(`${IBUS}${codi}?app_id=${env.TMB_APP_ID}&app_key=${env.TMB_APP_KEY}`);
    if (r.status === 401 || r.status === 403 || r.status === 429) throw new Error(`TMB respondió ${r.status} (claves no válidas o cupo agotado)`);
    if (!r.ok) { fallos++; return; }
    const txt = await r.text(); crudo[codi] = txt;                    // por código de parada: la dirección lleva las claves
    const vistos = new Set();
    for (const [nom, cod, sentido, t] of llegadas(JSON.parse(txt), [])) {
      if (!t) continue;
      const lleg = Number(t) / (Number(t) > 1e11 ? 1000 : 1);
      if (lleg < ahora - 60 || lleg > ahora + 30 * 60) continue;
      const k = `${nom}|${cod}|${sentido}`; if (vistos.has(k)) continue;     // solo el próximo bus de cada línea y sentido
      vistos.add(k); nuevas.push([Math.round(ahora), codi, nom, cod, sentido, Math.round(lleg)]);
    }
  }));
  if (!Object.keys(crudo).length) throw new Error(`ninguna parada respondió (${fallos} fallos)`);
  await guardar(env, 'bus', d, JSON.stringify(crudo));
  const prev = await env.DATOS.get('vivo/ibus.json');
  const viejas = prev ? (await prev.json()).obs.filter(o => ahora - o[0] < VENTANA_S) : [];
  await env.DATOS.put('vivo/ibus.json', JSON.stringify({ ts: d.toISOString(), campos: ['ts', 'parada', 'nom_linia', 'codi_linia', 'sentido', 'llegada'],
    paradas_control: n, por_ciclo: POR_CICLO, obs: viejas.concat(nuevas) }), { httpMetadata: { contentType: 'application/json' } });
}

const JSON_H = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

export default {
  async scheduled(event, env, ctx) {
    const d = new Date(event.scheduledTime), min = Math.floor(event.scheduledTime / 60000);
    const tareas = { bicing: () => bicing(env, d, min) };
    if (min % 5 === 0) tareas.trafico = () => trafico(env, d);
    if (min % 15 === 0) tareas.tiempo = () => tiempo(env, d);
    if (min % 2 === 0 && env.TMB_APP_ID && env.TMB_APP_KEY) tareas.bus = () => ibus(env, d, min);
    const nombres = Object.keys(tareas), res = await Promise.allSettled(nombres.map(k => tareas[k]()));
    // Estado de cada fuente (lo enseña /api/estado): última captura buena y último error
    const prev = await env.DATOS.get('estado.json'), estado = prev ? await prev.json() : {};
    nombres.forEach((k, i) => {
      const e = estado[k] || (estado[k] = {});
      if (res[i].status === 'fulfilled') { e.ok = d.toISOString(); e.capturas = (e.capturas || 0) + 1; }
      else { e.error = String(res[i].reason && res[i].reason.message || res[i].reason).slice(0, 200); e.error_ts = d.toISOString(); }
    });
    await env.DATOS.put('estado.json', JSON.stringify(estado), { httpMetadata: { contentType: 'application/json' } });
  },

  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/ibus' || pathname === '/api/estado') {
      const o = await env.DATOS.get(pathname === '/api/ibus' ? 'vivo/ibus.json' : 'estado.json');
      return new Response(o ? o.body : (pathname === '/api/ibus' ? '{"obs":[]}' : '{}'), { headers: { ...JSON_H, 'cache-control': 'public, max-age=60' } });
    }
    if (pathname.startsWith('/api/')) return new Response('{"error":"no existe"}', { status: 404, headers: JSON_H });
    return env.ASSETS.fetch(req);
  },
};
