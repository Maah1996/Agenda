const https = require('https');

const DB_URL = 'https://gantt-maah-default-rtdb.firebaseio.com';
const TG_TOKEN = process.env.TG_TOKEN;
const TG_DEFAULT_CHAT = process.env.TG_CHAT_ID;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
      res.on('error', reject);
    });
  });
}

function sendTelegram(chatId, message) {
  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Fix (punto 6): antes restaba 3h fijas asumiendo siempre UTC-3. Chile alterna
// UTC-3 (verano) / UTC-4 (invierno), así que ese offset fijo quedaba mal la
// mitad del año. Ahora se calcula con la zona horaria real de Santiago, y el
// workflow dispara dos veces (08:00 y 09:00 UTC) para cubrir ambos casos —
// esta función decide cuál de las dos ejecuciones es la correcta y descarta
// la otra, para no enviar el mensaje duplicado.
function horaYFechaChile(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  });
  const partes = {};
  fmt.formatToParts(now).forEach(p => { if (p.type !== 'literal') partes[p.type] = p.value; });
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: partes.hour };
}

async function main() {
  const now = new Date();
  const { fecha, hora } = horaYFechaChile(now);
  console.log(`Fecha Chile: ${fecha} — hora Chile: ${hora}h`);
  if (hora !== '05') {
    console.log(`No son las 05:00 en Chile (son las ${hora}h) — esta ejecución no envía nada.`);
    return;
  }

  const usuarios = await fetchJSON(`${DB_URL}/maah_usuarios.json`);
  if (!usuarios) { console.log('Sin usuarios'); return; }

  for (const [userId, user] of Object.entries(usuarios)) {
    if (!user || !user.nombre) continue;
    const chatId = user.tgid || TG_DEFAULT_CHAT;
    if (!chatId) continue;

    const agenda = await fetchJSON(`${DB_URL}/maah_agenda/${userId}/${fecha}.json`);
    if (!agenda) { console.log(`${user.nombre}: sin agenda hoy`); continue; }

    const prioriActs = Object.values(agenda).filter(a => a && a.priori);
    if (!prioriActs.length) { console.log(`${user.nombre}: sin actividades prioritarias`); continue; }

    prioriActs.sort((a, b) => a.hora.localeCompare(b.hora));

    const dias = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const meses = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
    const d = new Date(fecha + 'T12:00:00');

    let msg = `🚨 <b>ACTIVIDADES PRIORITARIAS HOY:\n${dias[d.getDay()]} ${d.getDate()} DE ${meses[d.getMonth()]} DEL ${d.getFullYear()}</b>\n\n`;
    prioriActs.forEach(a => {
      msg += `⭐ <b>${a.hora}</b> — ${a.act}`;
      if (a.obs) msg += ` <i>(${a.obs})</i>`;
      msg += '\n';
    });

    console.log(`Enviando a ${user.nombre}: ${prioriActs.length} actividad(es) prioritaria(s)`);
    const result = await sendTelegram(chatId, msg);
    console.log('Telegram:', result.ok ? 'OK' : JSON.stringify(result));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
