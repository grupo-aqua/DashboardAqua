// services/vigiloServicio/sincronizacionVigiloService.js
// Sincroniza tramos de ruta/parada de la flota (Vigilo) a Postgres — mismo
// patrón que MobilVendor/Odoo (sync programado, nunca consulta en vivo
// desde la tool MCP). Corre por cron a las 23:00 America/Guayaquil (ver
// cron/tareasCron.js), ventana rodante de 3 días (hoy + 2 atrás) para
// cubrir correcciones tardías de datos del lado de Vigilo, igual que el
// cron de MobilVendor resincroniza los últimos DIAS_RETRO días.
//
// Investigado en vivo antes de construir (ver TODO.md para el detalle
// completo de las 5 preguntas técnicas resueltas):
// - El "tag" de Vigilo (ej. 'T5') coincide DIRECTO con el seller_code que
//   ya usa Grupo Aqua — sin tabla de mapeo.
// - EXCEPCIONES conocidas, confirmadas con datos reales de la flota
//   (TrackONLINE, 2026-09-30): 'C8'/'C9' (grupo Vigilo "COMODINES" —
//   vehículos de respaldo, sin ruta asignada) y 'GOH0723' (grupo "Todos",
//   tag = placa — parece un tracker admin/de prueba, no un vehículo de
//   ruta real). Se excluyen explícitamente, no hay heurística automática
//   confiable para detectarlos (son solo 3, confirmados a mano).
// - DOMICILIO, COTTSA (rutas 113/131/132) y TELEVENTA no tienen ningún
//   vehículo en la flota de Vigilo — cobertura parcial, esperado.
const { Op } = require("sequelize");
const { VigiloVehiculo, VigiloTramoRuta } = require("../../models");
const { trackOnline, targetRouteQry } = require("./vigiloConexion");

const TAGS_EXCLUIDOS = new Set(["C8", "C9", "GOH0723"]);
const DIAS_VENTANA = 3; // hoy + 2 atrás

function fechaStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
}

// Refresca el roster completo de la flota desde TrackONLINE — inserta
// vehículos nuevos, actualiza tag/grupo/placa de los existentes, y marca
// `activo=false` los que ya no aparecen (vehículo dado de baja en Vigilo).
async function sincronizarRosterVehiculos() {
  const data = await trackOnline();
  const trackTargets = data?.TrackTargets || [];

  const vistos = new Set();
  for (const t of trackTargets) {
    const target = t.Target;
    if (!target?.TargetId) continue;
    const tag = (target.Tag || "").trim();
    vistos.add(target.TargetId);
    await VigiloVehiculo.upsert({
      target_id: target.TargetId,
      tag,
      grupo_vigilo: target.TargetGroup?.Name || null,
      placa: (target.Plate || "").trim() || null,
      activo: true,
      actualizado_en: new Date(),
    });
  }

  if (vistos.size > 0) {
    await VigiloVehiculo.update(
      { activo: false, actualizado_en: new Date() },
      { where: { target_id: { [Op.notIn]: [...vistos] } } }
    );
  }

  return [...vistos].length;
}

// Deriva tipo_tramo/duración de una actividad de Vigilo. Una actividad
// siempre trae OnRouteTime>0 XOR OnStopTime>0 en la práctica (confirmado
// con datos reales) — si algún día llegara un tramo con ambos en 0 (ej.
// posición repetida sin movimiento medible), se descarta silenciosamente,
// no hay nada útil que guardar.
function clasificarTramo(actividad) {
  if (actividad.OnStopTime > 0) return { tipo: "PARADA", duracion: actividad.OnStopTime };
  if (actividad.OnRouteTime > 0) return { tipo: "RUTA", duracion: actividad.OnRouteTime };
  return null;
}

async function sincronizarTramosVehiculo(targetId, fromDate, toDate) {
  const resp = await targetRouteQry(targetId, fromDate, toDate);
  if (resp?.Error) {
    throw new Error(resp.ErrorDescription || resp.ErrorCode || "Error desconocido de Vigilo");
  }
  const actividades = resp?.Data?.TrackActivities || [];

  let insertados = 0;
  for (const a of actividades) {
    const clasif = clasificarTramo(a);
    if (!clasif) continue;
    if (!a.FromTrackerDate || !a.ToTrackerDate) continue;

    const desde = new Date(a.FromTrackerDate);
    const hasta = new Date(a.ToTrackerDate);
    // Comparación de fecha calendario en hora local del tracker (el string
    // que da Vigilo no trae offset — se compara tal cual, sin conversión de
    // zona, que es exactamente cómo se validó "cruza medianoche" durante la
    // investigación de umbrales).
    const cruzaMedianoche = a.FromTrackerDate.slice(0, 10) !== a.ToTrackerDate.slice(0, 10);

    await VigiloTramoRuta.upsert({
      trace_id: a.TraceId,
      target_id: targetId,
      tipo_tramo: clasif.tipo,
      desde_fecha: desde,
      hasta_fecha: hasta,
      duracion_segundos: clasif.duracion,
      desde_lat: a.FromLat ?? null,
      desde_lon: a.FromLong ?? null,
      hasta_lat: a.ToLat ?? null,
      hasta_lon: a.ToLong ?? null,
      desde_direccion: a.FromAddress || null,
      hasta_direccion: a.ToAddress || null,
      cruza_medianoche: cruzaMedianoche,
      odometro_distancia: a.OdometerGPSDistance ?? null,
      sincronizado_en: new Date(),
    });
    insertados++;
  }
  return insertados;
}

async function sincronizarParadasFlota() {
  const fromDate = fechaStr(-(DIAS_VENTANA - 1));
  const toDate = fechaStr(0);

  const totalRoster = await sincronizarRosterVehiculos();

  const vehiculos = await VigiloVehiculo.findAll({
    where: { activo: true },
    raw: true,
  });
  const vehiculosASincronizar = vehiculos.filter((v) => !TAGS_EXCLUIDOS.has(v.tag));

  const resultados = { roster: totalRoster, vehiculosSincronizados: 0, tramosGuardados: 0, errores: [] };

  for (const v of vehiculosASincronizar) {
    try {
      const n = await sincronizarTramosVehiculo(v.target_id, fromDate, toDate);
      resultados.vehiculosSincronizados++;
      resultados.tramosGuardados += n;
    } catch (err) {
      resultados.errores.push({ tag: v.tag, error: err.message });
    }
  }

  return resultados;
}

module.exports = { sincronizarParadasFlota, sincronizarRosterVehiculos, TAGS_EXCLUIDOS, DIAS_VENTANA };
