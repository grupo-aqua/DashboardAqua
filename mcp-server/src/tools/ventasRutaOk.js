// src/tools/ventasRutaOk.js
// Ventas combinadas de las rutas "OK" (113, 131, 132) — pedido explícito de
// Alberto tras confirmar que existe una segunda instancia de Odoo
// (aqua-premium-ne.odoo.com, separada de COTTSA) donde estas rutas
// registran ventas que NO se facturan formalmente al SRI ahí (quedan como
// pos.order — notas de entrega — no como facturas electrónicas). Esas
// mismas rutas SÍ facturan formalmente en COTTSA (ya sincronizado en
// ventas_mv). El gerente quiere ver el total combinado de ambas fuentes.
//
// ============================================================
// Alcance de ESTA fase (instrucción explícita de Alberto, 2026-09-22) —
// NO tocar sin su confirmación:
// ============================================================
// - Totales "tal cual" de cada sistema, SIN filtrar ni intentar detectar
//   duplicados entre COTTSA y aqua-premium-ne todavía. Se investigó antes
//   de construir esto si existe riesgo real de doble conteo (ver TODO.md:
//   se encontró que COTTSA YA tiene facturación activa bajo seller_code
//   'RUTA 113'/'RUTA 131'/'RUTA 132'/'RUTA 132.1', con volumen comparable o
//   mayor al de aqua-premium-ne, y un caso concreto de posible duplicado —
//   mismo cliente, mismo monto casi exacto, ~1 mes de diferencia) — pero
//   Alberto decidió publicar los números crudos primero para verificarlos
//   él mismo manualmente contra lo que saca de los dos sistemas, ANTES de
//   construir cualquier lógica de deduplicación.
// - NO se investiga el rastro técnico del "liquidador" (qué proceso/usuario
//   de administración mueve una venta de aqua-premium-ne a una factura
//   COTTSA, si es que eso pasa) — eso queda para una fase de limpieza
//   posterior, solo si Alberto confirma que hace falta después de ver
//   estos números.
// - aqua-premium-ne se consulta EN VIVO (JSON-RPC, ver
//   src/integrations/aquaPremiumNe.js) en cada llamada — sin sincronización
//   propia ni tabla nueva en ventas_mv. Construir eso sería prematuro antes
//   de que Alberto valide que el enfoque combinado tiene sentido.
//
// ============================================================
// Investigación previa (resumen — ver TODO.md para el detalle completo)
// ============================================================
// - "Ruta" en aqua-premium-ne es el Punto de Venta (`pos.config.name`):
//   "RUTA 113" (config_id 23), "RUTA 131" (config_id 25), "RUTA 132.1"
//   (config_id 24 — NO existe un "RUTA 132" puro ahí, solo el ".1").
// - En COTTSA (`facturas.seller_code`) SÍ existen 'RUTA 132' Y 'RUTA 132.1'
//   como códigos separados — se combinan ambos bajo el parámetro ruta="132"
//   de esta tool.
// - Mismo esquema de numeración que COTTSA — confirmado cruzando clientes
//   reales por RUC, varios con `codigo_usuario_asignado_cliente` literal
//   "113"/"131"/"132.1" en `clientes`. No hace falta tabla de mapeo de
//   rutas.
// - HALLAZGO IMPORTANTE: la última actividad en aqua-premium-ne para las 3
//   rutas, sin excepción, es el 2026-06-09 — más de 3 meses antes de esta
//   construcción. "Mes actual"/"mes anterior" (el caso de uso principal que
//   pidió Alberto) van a dar $0 de esta fuente — no es un bug de la tool,
//   es el estado real de los datos. Se expone explícitamente vía
//   `advertencia_aqua_premium_ne` para que no se lea como "no hay ventas
//   OK", sino como "esta fuente específica no tiene datos recientes".
// ============================================================
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias } = require("../util/fechas");
const { FILTRO_CLIENTE_VALIDO } = require("../sql/clasificacion");
const { executeKw } = require("../integrations/aquaPremiumNe");

const MAX_RANGO_DIAS = 400;

// Última fecha confirmada con datos reales en aqua-premium-ne para estas 3
// rutas (2026-09-22, ver comentario de arriba) — se usa SOLO para decidir
// si mostrar la advertencia, no filtra ni cambia ningún cálculo.
const ULTIMA_ACTIVIDAD_CONOCIDA_AQUA_PREMIUM_NE = "2026-06-09";

const RUTAS_OK = {
  113: { cottsaSellerCodes: ["RUTA 113"], aquaPremiumConfigIds: [23] },
  131: { cottsaSellerCodes: ["RUTA 131"], aquaPremiumConfigIds: [25] },
  132: { cottsaSellerCodes: ["RUTA 132", "RUTA 132.1"], aquaPremiumConfigIds: [24] },
};
const RUTAS_OK_VALIDAS = Object.keys(RUTAS_OK);

const RutaSchema = z.enum(RUTAS_OK_VALIDAS);
const inputSchema = {
  ruta: z.union([RutaSchema, z.array(RutaSchema).min(1).max(RUTAS_OK_VALIDAS.length)]).default(RUTAS_OK_VALIDAS),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

// $1 = array de seller_code COTTSA, $2 = inicio (timestamp), $3 = fin
// exclusivo (timestamp). Solo `facturas` — estas rutas nunca generan
// `ordenes` propias bajo estos seller_code (confirmado con datos reales).
// status=2 = posteada/facturada (mismo criterio de "facturado" que el
// resto de la tool family).
const SQL_COTTSA = `
  SELECT
    f.customer_code,
    c.identificacion_cliente AS ruc,
    COALESCE(c.nombre_comercial_cliente, c.nombre_cliente) AS nombre,
    COUNT(DISTINCT f.code) AS num_documentos,
    SUM(CASE WHEN f.tipo_movimiento = 'out_refund' THEN -f.total ELSE f.total END) AS dolares
  FROM facturas f
  LEFT JOIN clientes c ON c.codigo_cliente = f.customer_code
  WHERE f.seller_code = ANY($1::text[])
    AND f.status = 2
    AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
    AND f.fecha_creacion >= $2
    AND f.fecha_creacion <  $3
  GROUP BY f.customer_code, c.identificacion_cliente, nombre;
`;

// Consolida filas COTTSA por RUC — mismo criterio de "duplicados de
// maestro" ya usado en el resto de la tool family (un RUC puede repetirse
// bajo más de un codigo_cliente).
function consolidarCottsaPorRuc(filas) {
  const map = new Map();
  for (const f of filas) {
    const ruc = (f.ruc || "").trim() || `SIN_RUC_${f.customer_code}`;
    const actual = map.get(ruc) || { ruc, nombre: f.nombre || null, num_documentos: 0, dolares: 0 };
    actual.num_documentos += Number(f.num_documentos) || 0;
    actual.dolares += Number(f.dolares) || 0;
    if (!actual.nombre && f.nombre) actual.nombre = f.nombre;
    map.set(ruc, actual);
  }
  return map;
}

// Consulta EN VIVO a aqua-premium-ne (ver comentario del archivo — sin
// caché ni sync propia en esta fase). Agrupa por partner_id, luego resuelve
// nombre/RUC de cada partner en un segundo llamado batch.
async function obtenerAquaPremiumNe(configIds, inicioTs, finTs) {
  const grupos = await executeKw(
    "pos.order",
    "read_group",
    [
      [
        ["config_id", "in", configIds],
        ["date_order", ">=", inicioTs],
        ["date_order", "<", finTs],
      ],
      ["amount_total:sum"],
      ["partner_id"],
    ],
    {}
  );

  const partnerIds = [...new Set(grupos.map((g) => (Array.isArray(g.partner_id) ? g.partner_id[0] : null)).filter(Boolean))];
  let partners = [];
  if (partnerIds.length > 0) {
    partners = await executeKw("res.partner", "read", [partnerIds], { fields: ["name", "vat"] });
  }
  const partnerMap = new Map(partners.map((p) => [p.id, p]));

  const map = new Map();
  for (const g of grupos) {
    const partnerId = Array.isArray(g.partner_id) ? g.partner_id[0] : null;
    const partner = partnerId ? partnerMap.get(partnerId) : null;
    const ruc = (partner?.vat || "").trim() || (partnerId ? `SIN_RUC_${partnerId}` : "SIN_CLIENTE");
    const nombre = partner?.name || (Array.isArray(g.partner_id) ? g.partner_id[1] : "Sin cliente");
    const actual = map.get(ruc) || { ruc, nombre, num_documentos: 0, dolares: 0 };
    actual.num_documentos += Number(g.partner_id_count) || 0;
    actual.dolares += Number(g.amount_total) || 0;
    map.set(ruc, actual);
  }
  return map;
}

function redondear(n) {
  return Number((n || 0).toFixed(2));
}

async function calcularRuta(rutaKey, inicioTs, finTs) {
  const config = RUTAS_OK[rutaKey];

  const [cottsaResult, aquaPremiumMap] = await Promise.all([
    pool.query(SQL_COTTSA, [config.cottsaSellerCodes, inicioTs, finTs]),
    obtenerAquaPremiumNe(config.aquaPremiumConfigIds, inicioTs, finTs),
  ]);
  const cottsaMap = consolidarCottsaPorRuc(cottsaResult.rows);

  const todosLosRuc = new Set([...cottsaMap.keys(), ...aquaPremiumMap.keys()]);
  const porCliente = [...todosLosRuc].map((ruc) => {
    const c = cottsaMap.get(ruc) || null;
    const a = aquaPremiumMap.get(ruc) || null;
    return {
      identificacion: ruc.startsWith("SIN_RUC_") || ruc === "SIN_CLIENTE" ? null : ruc,
      nombre: c?.nombre || a?.nombre || null,
      dolares_total: redondear((c?.dolares || 0) + (a?.dolares || 0)),
      num_documentos_total: (c?.num_documentos || 0) + (a?.num_documentos || 0),
      cottsa: c ? { dolares: redondear(c.dolares), num_documentos: c.num_documentos } : null,
      aqua_premium_ne: a ? { dolares: redondear(a.dolares), num_documentos: a.num_documentos } : null,
    };
  });
  porCliente.sort((x, y) => y.dolares_total - x.dolares_total);

  const totalCottsa = [...cottsaMap.values()].reduce(
    (acc, c) => ({ dolares: acc.dolares + c.dolares, num_documentos: acc.num_documentos + c.num_documentos }),
    { dolares: 0, num_documentos: 0 }
  );
  const totalAquaPremium = [...aquaPremiumMap.values()].reduce(
    (acc, a) => ({ dolares: acc.dolares + a.dolares, num_documentos: acc.num_documentos + a.num_documentos }),
    { dolares: 0, num_documentos: 0 }
  );

  return {
    ruta: rutaKey,
    total_combinado: {
      dolares: redondear(totalCottsa.dolares + totalAquaPremium.dolares),
      num_documentos: totalCottsa.num_documentos + totalAquaPremium.num_documentos,
    },
    por_fuente: {
      cottsa: { dolares: redondear(totalCottsa.dolares), num_documentos: totalCottsa.num_documentos },
      aqua_premium_ne: { dolares: redondear(totalAquaPremium.dolares), num_documentos: totalAquaPremium.num_documentos },
    },
    por_cliente: porCliente,
  };
}

async function ventasRutaOk({ ruta = RUTAS_OK_VALIDAS, fecha_inicio, fecha_fin }) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
  const rutasSolicitadas = Array.isArray(ruta) ? ruta : [ruta];

  const resultados = await Promise.all(rutasSolicitadas.map((r) => calcularRuta(r, inicioTs, finTs)));

  const advertencia_aqua_premium_ne =
    fecha_fin > ULTIMA_ACTIVIDAD_CONOCIDA_AQUA_PREMIUM_NE
      ? `aqua-premium-ne no tiene ninguna venta registrada para estas 3 rutas después del ${ULTIMA_ACTIVIDAD_CONOCIDA_AQUA_PREMIUM_NE} ` +
        `(confirmado, no es un error de esta consulta) — si el rango pedido cae después de esa fecha, "aqua_premium_ne" va a dar $0 ` +
        `aunque sí haya ventas reales de las rutas OK, porque esa fuente específica dejó de tener datos recientes.`
      : null;

  const resultadoBase = { rango: { fecha_inicio, fecha_fin }, advertencia_aqua_premium_ne };

  if (!Array.isArray(ruta)) {
    return { ...resultadoBase, ...resultados[0] };
  }

  const totalCombinado = resultados.reduce(
    (acc, r) => ({
      dolares: acc.dolares + r.total_combinado.dolares,
      num_documentos: acc.num_documentos + r.total_combinado.num_documentos,
    }),
    { dolares: 0, num_documentos: 0 }
  );

  return {
    ...resultadoBase,
    rutas: rutasSolicitadas,
    total_combinado: { dolares: redondear(totalCombinado.dolares), num_documentos: totalCombinado.num_documentos },
    por_ruta: resultados,
  };
}

module.exports = { ventasRutaOk, inputSchema, RUTAS_OK_VALIDAS };
