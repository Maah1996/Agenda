// Envío automático de actividades prioritarias por Telegram a las 05:00 hora Chile.
// Corre SOLO en GitHub Actions (nunca en el navegador) — ver
// .github/workflows/morning-notification.yml.
//
// Fix (puntos 4 y 5, 20-ago-2026): antes leía Firebase por HTTPS sin ningún
// token, lo que dejó de funcionar (401 Permission denied) cuando las reglas
// RTDB se endurecieron para exigir autenticación real en casi todo. Ahora usa
// el Admin SDK de Firebase con una cuenta de servicio (secreto de GitHub
// FIREBASE_SERVICE_ACCOUNT) — acceso legítimo de servidor a servidor que
// bypasea las reglas por diseño, sin exponer ninguna credencial en el cliente.
// El envío automático desde el navegador (setInterval en index.html) se quitó
// por completo: este script es ahora el ÚNICO lugar que envía el aviso de las
// 05:00, así que no puede duplicarse.

const https = require('https');
const admin = require('firebase-admin');

const DB_URL = 'https://gantt-maah-default-rtdb.firebaseio.com';
const TG_TOKEN = process.env.TG_TOKEN;
const TG_DEFAULT_CHAT = process.env.TG_CHAT_ID;
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!TG_TOKEN) { console.error('Falta el secreto TG_TOKEN.'); process.exit(1); }
if (!SERVICE_ACCOUNT_RAW) {
  console.error('Falta el secreto FIREBASE_SERVICE_ACCOUNT (clave de la cuenta de servicio de Firebase).');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(SERVICE_ACCOUNT_RAW);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT no es un JSON válido:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DB_URL
});
const db = admin.database();

function sendTelegram(chatId, message) {
  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, raw: data }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Calcula fecha y hora reales de Santiago (con o sin horario de verano) sin
// depender de ningún offset fijo — ver .github/workflows/morning-notification.yml,
// que dispara dos veces (08:00 y 09:00 UTC) para cubrir ambos casos.
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

  const usuariosSnap = await db.ref('maah_usuarios').once('value');
  const usuarios = usuariosSnap.val();
  if (!usuarios) { console.log('Sin usuarios'); return; }

  const dias = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
  const meses = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  const d = new Date(fecha + 'T12:00:00');

  for (const [userId, user] of Object.entries(usuarios)) {
    if (!user || !user.nombre) continue;
    const chatId = user.tgid || TG_DEFAULT_CHAT;
    if (!chatId) continue;

    const agendaSnap = await db.ref(`maah_agenda/${userId}/${fecha}`).once('value');
    const agenda = agendaSnap.val();
    if (!agenda) { console.log(`${user.nombre}: sin agenda hoy`); continue; }

    const prioriActs = Object.values(agenda).filter(a => a && a.priori);
    if (!prioriActs.length) { console.log(`${user.nombre}: sin actividades prioritarias`); continue; }

    prioriActs.sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

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

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode || 0)); // el Admin SDK deja una conexión abierta; hay que cerrar el proceso a mano
