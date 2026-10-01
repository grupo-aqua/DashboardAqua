// cron/tareasCron.js
// Sincronización automática: 12:00 AM y 12:00 PM (America/Guayaquil)
// Cubre: MobilVendor, Odoo, Rutas y Historial de Visitas

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');

const { sincronizarVentasRango, sincronizarPromociones } = require('../services/sincronizacionService');
const { sincronizarOdooCompletoRango } = require('../services/odooServicio/sincronizacionOdooService');
const { sincronizarRutasYDetalles }    = require('../services/syncRouteDetailsService');
const { obtenerHistorialDeUsuarios }   = require('../services/syncHistorialVisitasService');
const { sincronizarParadasFlota }      = require('../services/vigiloServicio/sincronizacionVigiloService');
const { marcarFacturasDuplicadas }     = require('../services/reconciliacionFacturasService');

// ================================================================
// LOGGING
// ================================================================
const LOG_DIR = path.join(__dirname, 'cronLog');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getLogFile() {
  // Un archivo por día en zona horaria Ecuador
  const fecha = new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }); // "YYYY-MM-DD"
  return path.join(LOG_DIR, `${fecha}.log`);
}

function log(msg, nivel = 'INFO') {
  const ts   = new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });
  const linea = `[${ts}] [${nivel.padEnd(5)}] ${msg}\n`;
  process.stdout.write(linea);
  try { fs.appendFileSync(getLogFile(), linea); } catch (_) { /* no bloquear si hay error de I/O */ }
}

// ================================================================
// LOCK — evita ejecuciones concurrentes
// ================================================================
let isRunning = false;

// ================================================================
// HELPERS DE FECHA  (yyyy-mm-dd, hora Ecuador)
// ================================================================
function fechaStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
}

// ================================================================
// NÚCLEO DE SINCRONIZACIÓN
// label     → texto identificador en logs
// startDate → fecha inicio yyyy-mm-dd
// endDate   → fecha fin   yyyy-mm-dd
// ================================================================
async function ejecutarSincronizacion(label, startDate, endDate) {
  if (isRunning) {
    log(`[${label}] Otra sincronización en curso — ejecución omitida`, 'WARN');
    return;
  }

  isRunning = true;
  const inicio = Date.now();

  log('='.repeat(65));
  log(`[${label}] Rango: ${startDate} → ${endDate}`);
  log('='.repeat(65));

  const resultados = {
    mobilvendor : null,
    odoo        : null,
    rutas       : null,
    visitas     : null,
    promos      : null,
    duplicados  : null,
  };

  // ── 1. MobilVendor + Odoo en paralelo ───────────────────────
  log('[MV + Odoo] Iniciando sincronización paralela...');

  const [resMV, resOdoo] = await Promise.allSettled([
    sincronizarVentasRango(startDate, endDate),
    sincronizarOdooCompletoRango(startDate, endDate),
  ]);

  if (resMV.status === 'fulfilled') {
    const errDoc = resMV.value?.erroresPorDocumento?.length ?? 0;
    resultados.mobilvendor = `OK${errDoc > 0 ? ` (${errDoc} errores de documento)` : ''}`;
    log(`[MobilVendor] ${resultados.mobilvendor}`);
  } else {
    resultados.mobilvendor = `ERROR: ${resMV.reason?.message ?? 'desconocido'}`;
    log(`[MobilVendor] ${resultados.mobilvendor}`, 'ERROR');
  }

  if (resOdoo.status === 'fulfilled') {
    resultados.odoo = 'OK';
    log('[Odoo]        OK');
  } else {
    resultados.odoo = `ERROR: ${resOdoo.reason?.message ?? 'desconocido'}`;
    log(`[Odoo]        ${resultados.odoo}`, 'ERROR');
  }

  // ── 2. Rutas ─────────────────────────────────────────────────
  log('[Rutas] Iniciando sincronización...');
  try {
    await sincronizarRutasYDetalles();
    resultados.rutas = 'OK';
    log('[Rutas]       OK');
  } catch (e) {
    resultados.rutas = `ERROR: ${e.message ?? 'desconocido'}`;
    log(`[Rutas]       ${resultados.rutas}`, 'ERROR');
  }

  // ── 3. Historial de visitas ──────────────────────────────────
  log('[Visitas] Iniciando sincronización...');
  try {
    await obtenerHistorialDeUsuarios(startDate, endDate);
    resultados.visitas = 'OK';
    log('[Visitas]     OK');
  } catch (e) {
    resultados.visitas = `ERROR: ${e.message ?? 'desconocido'}`;
    log(`[Visitas]     ${resultados.visitas}`, 'ERROR');
  }

  // ── 4. Promociones (maestro MobilVendor) ─────────────────────
  log('[Promos] Iniciando sincronización...');
  try {
    await sincronizarPromociones();
    resultados.promos = 'OK';
    log('[Promos]      OK');
  } catch (e) {
    resultados.promos = `ERROR: ${e.message ?? 'desconocido'}`;
    log(`[Promos]      ${resultados.promos}`, 'ERROR');
  }

  // ── 5. Reconciliación de facturas duplicadas MobilVendor↔Odoo (Tier 2,
  //       ver TODO.md: "Propuesta de diseño COMPLETA — reconciliación de
  //       facturas") — corre DESPUÉS de MobilVendor+Odoo (necesita que
  //       ambos ya hayan escrito su versión del documento). Idempotente
  //       (solo toca filas con duplicado_de todavía NULL), así que corre en
  //       los 2 ciclos diarios (00:00 y 12:00) sin problema — eso además
  //       reduce a ~12h el tiempo máximo que un duplicado nuevo queda sin
  //       marcar, en vez de esperar 24h.
  log('[Duplicados] Iniciando reconciliación de facturas...');
  try {
    const r = await marcarFacturasDuplicadas();
    resultados.duplicados = `OK (${r.marcados} marcados, ${r.promosReapuntadas} promos reapuntadas, ${r.aRevisionManual} a revisión manual)`;
    log(`[Duplicados]  ${resultados.duplicados}`);
  } catch (e) {
    resultados.duplicados = `ERROR: ${e.message ?? 'desconocido'}`;
    log(`[Duplicados]  ${resultados.duplicados}`, 'ERROR');
  }

  // ── Resumen final ────────────────────────────────────────────
  const duracion   = ((Date.now() - inicio) / 1000).toFixed(1);
  const hayErrores = Object.values(resultados).some(v => v && v.startsWith('ERROR'));

  log('-'.repeat(65));
  log(`[${label}] Finalizado en ${duracion}s — ${hayErrores ? 'CON ERRORES' : 'TODO OK'}`);
  log(`  MobilVendor : ${resultados.mobilvendor}`);
  log(`  Odoo        : ${resultados.odoo}`);
  log(`  Rutas       : ${resultados.rutas}`);
  log(`  Visitas     : ${resultados.visitas}`);
  log(`  Promos      : ${resultados.promos}`);
  log(`  Duplicados  : ${resultados.duplicados}`);
  log('='.repeat(65) + '\n');

  isRunning = false;
}

// ================================================================
// VENTANA RETROACTIVA
// MobilVendor entrega los documentos por FECHA DE CREACIÓN. Una orden creada
// hace varios días pero ENTREGADA recién (la entrega ocurre días después del
// pedido) NO se vuelve a pedir si la ventana es solo "ayer + hoy" → su
// fecha_entrega queda congelada en el día de creación y, si eso cruza el borde
// de mes, "falta" en el ranking (que filtra por fecha_entrega).
// Mirando atrás N días re-traemos esas órdenes y su fecha_entrega real se
// actualiza. Es idempotente: lo ya correcto se reescribe igual.
// ================================================================
const DIAS_RETRO = 10;

// ================================================================
// CRON 1 — 12:00 AM (medianoche)
// Sincroniza los últimos DIAS_RETRO días + hoy.
// ================================================================
cron.schedule('0 0 * * *', async () => {
  await ejecutarSincronizacion('CRON 12:00 AM', fechaStr(-DIAS_RETRO), fechaStr(0));
}, { timezone: 'America/Guayaquil' });

// ================================================================
// CRON 2 — 12:00 PM (mediodía)
// Sincroniza los últimos DIAS_RETRO días + hoy: actualización intradiaria
// que además refresca la fecha_entrega de pedidos entregados hoy.
// ================================================================
cron.schedule('0 12 * * *', async () => {
  await ejecutarSincronizacion('CRON 12:00 PM', fechaStr(-DIAS_RETRO), fechaStr(0));
}, { timezone: 'America/Guayaquil' });

// ================================================================
// CRON 3 — 23:00 (flota Vigilo)
// Corre APARTE de MobilVendor/Odoo/Rutas/Visitas — no comparte `isRunning`
// con esos: son sistemas completamente distintos (Vigilo, no MobilVendor/
// Odoo) y esta corrida es lenta por el rate limit propio de la API de
// Vigilo (1 llamada/15s, ~34 vehículos → ~9 minutos), no tiene sentido que
// bloquee ni se bloquee con la sincronización de ventas. Horario elegido
// para correr después de que terminan las rutas del día (ver TODO.md,
// investigación de umbrales: actividad real de la flota cae a night-time
// para casi todos los vehículos bastante antes de esa hora).
let isRunningVigilo = false;

cron.schedule('0 23 * * *', async () => {
  if (isRunningVigilo) {
    log('[Vigilo] Sincronización anterior aún en curso — ejecución omitida', 'WARN');
    return;
  }
  isRunningVigilo = true;
  const inicio = Date.now();
  log('[Vigilo] Iniciando sync de paradas de flota (ventana 3 días)...');
  try {
    const resultado = await sincronizarParadasFlota();
    const duracion = ((Date.now() - inicio) / 1000).toFixed(1);
    log(
      `[Vigilo] OK en ${duracion}s — roster=${resultado.roster} vehiculos, ` +
      `sincronizados=${resultado.vehiculosSincronizados}, tramos=${resultado.tramosGuardados}, ` +
      `errores=${resultado.errores.length}`
    );
    for (const e of resultado.errores) {
      log(`[Vigilo]   error en ${e.tag}: ${e.error}`, 'WARN');
    }
  } catch (e) {
    log(`[Vigilo] ERROR: ${e.message ?? 'desconocido'}`, 'ERROR');
  } finally {
    isRunningVigilo = false;
  }
}, { timezone: 'America/Guayaquil' });

log('CRON inicializado — ejecuciones diarias: 12:00 AM, 12:00 PM (ventas) y 23:00 (flota Vigilo), America/Guayaquil');
