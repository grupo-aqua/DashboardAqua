// controllers/controllerConsolidado/consolidadoController.js
// Dashboard Consolidado General — Grupo AQUA S.A.
// Agrega 5 canales: PREVENTA, BOTELLONES, HIELO, COTTSA, DESCARTABLE ODOO

const Sequelize = require('sequelize');
const { sequelize, CottsaExtraMes } = require('../../models');
const { getDiasHabiles } = require('../../utils/diasFestivos');
const {
  obtenerVentasCOTTSAPorRuta,
  obtenerVentasPOSCOTTSA,
  obtenerResumenReembolsosCOTTSA,
} = require('../controllerCotxa/cotsaController');

// ================================================================
// CONSTANTES DE CANALES
// ================================================================
const COTTSA_COMPANY_ID = 3;

const RUTAS_PREVENTA = [
  'PV1','PV2','PV3','PV4','PV5','PV6','PV7',
  'PV8','PV9','PV10','PV11','PV12','PV13','PV14',
  'PREVENTA VIP 1','TELEVENTA 1','TELEVENTA 4',
];

const RUTAS_ODOO = [
  'Carmen Garcia','Estefania Flores','Tamara Villacres',
  'RUTA E1','RUTA E2','RUTA E3','RUTA E4','RUTA E5',
  'RUTA E6','RUTA E7','RUTA E8','RUTA E9','RUTA E10',
  'RUTA EA1','RUTA U2','Distribucion OK/E','Domicilio',
];

const NOMBRES_MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

// ================================================================
// HELPERS DE FECHA
// ================================================================
function getFechaInicioMes(a, m) {
  return `${a}-${String(m).padStart(2,'0')}-01 00:00:00`;
}
function getFechaFinMes(a, m) {
  let mf = m + 1, af = a;
  if (mf === 13) { mf = 1; af++; }
  return `${af}-${String(mf).padStart(2,'0')}-01 00:00:00`;
}
function getMesPrevio(anio, mes) {
  let m = mes - 1, a = anio;
  if (m === 0) { m = 12; a--; }
  return { anio: a, mes: m };
}
function get6Meses(anio, mes) {
  const result = [];
  for (let i = 5; i >= 0; i--) {
    let m = mes - i, a = anio;
    while (m <= 0) { m += 12; a--; }
    result.push({
      anio: a, mes: m,
      label: `${NOMBRES_MESES[m-1]} ${a}`,
      inicio: getFechaInicioMes(a, m),
      fin:    getFechaFinMes(a, m),
    });
  }
  return result;
}


async function getFechaFinDinamica(anio, mes) {
  const hoy = new Date();
  if (anio === hoy.getFullYear() && mes === hoy.getMonth() + 1) {
    const [r] = await sequelize.query(
      `SELECT hasta_date FROM sincronizaciones_ventas ORDER BY fecha_sync DESC LIMIT 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const [yyyy, mm, dd] = String(r?.hasta_date).substring(0,10).split('-').map(Number);
    const sig = new Date(yyyy, mm - 1, dd + 1);
    return `${sig.getFullYear()}-${String(sig.getMonth()+1).padStart(2,'0')}-${String(sig.getDate()).padStart(2,'0')} 00:00:00`;
  }
  return getFechaFinMes(anio, mes);
}

// ================================================================
// HELPER PARA PLACEHOLDERS SEQUELIZE
// ================================================================
function makeBindings(arr, prefix = 'r') {
  const pl  = arr.map((_, i) => `:${prefix}${i}`).join(', ');
  const rep = {};
  arr.forEach((v, i) => { rep[`${prefix}${i}`] = v; });
  return { pl, rep };
}

// ================================================================
// QUERIES POR CANAL — devuelven { dolares, unidades, docs, clientes }
// ================================================================

// 1. PREVENTA — ordenes, route_code IN PV routes
function qPreventa(inicio, fin) {
  const { pl, rep } = makeBindings(RUTAS_PREVENTA, 'pv');
  return sequelize.query(`
    SELECT
      COALESCE(SUM(dd.total),    0) AS dolares,
      COALESCE(SUM(dd.cantidad), 0) AS unidades,
      COUNT(DISTINCT o.code)              AS docs,
      COUNT(DISTINCT o.customer_code)     AS clientes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.route_code IN (${pl})
      AND o.status IN (2,4,5)
      AND o.fecha_creacion >= :inicio
      AND o.fecha_creacion <  :fin
  `, { replacements: { ...rep, inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// 2. BOTELLONES — ordenes (autoventa sellers)
// CORRECCIÓN 2026-09-29: `seller_code ILIKE 'R%'` (pensado para rutas
// rurales genuinas) también matchea 'RUTA 113'/'RUTA 131'/'RUTA 132'/
// 'RUTA 132.1' — esas rutas ya se cuentan aparte en la card "COTTSA"
// (calcularCOTTSAMes, sección 5 más abajo). Sin esta exclusión, si algún
// día `ordenes` llega a tener filas con esos seller_code (hoy no las
// tiene, confirmado con datos reales — ver TODO.md), se duplicarían
// contra la card COTTSA. Defensivo, mismo criterio que
// mcp-server/src/sql/clasificacion.js.
function qBotellonesOrdenes(inicio, fin) {
  return sequelize.query(`
    SELECT
      COALESCE(SUM(dd.total),    0) AS dolares,
      COALESCE(SUM(dd.cantidad), 0) AS unidades,
      COUNT(DISTINCT o.code)              AS docs,
      COUNT(DISTINCT o.customer_code)     AS clientes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE dd.descripcion_categoria = 'BOTELLÓN'
      AND o.status IN (2,4,5)
      AND o.seller_code NOT IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1')
      AND (
        o.seller_code ILIKE 'M%'
        OR o.seller_code ILIKE 'TV%'
        OR (o.seller_code ILIKE 'T%' AND o.seller_code NOT ILIKE 'TV%')
        OR o.seller_code ILIKE 'R%'
        OR o.seller_code = '148399'
      )
      AND o.fecha_creacion >= :inicio
      AND o.fecha_creacion <  :fin
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// 3. BOTELLONES — facturas (DSD / entrega directa)
// Usa dd.total + dd.impuesto_linea para obtener el total con IVA por línea BOTELLÓN
function qBotellonesFacturas(inicio, fin) {
  return sequelize.query(`
    SELECT
      COALESCE(SUM(dd.total + COALESCE(dd.impuesto_linea, 0)), 0) AS dolares,
      COALESCE(SUM(dd.cantidad), 0) AS unidades,
      COUNT(DISTINCT f.code)              AS docs,
      COUNT(DISTINCT f.customer_code)     AS clientes
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE dd.descripcion_categoria = 'BOTELLÓN'
      AND f.status IN (0,2,3,4,5)
      AND (
        f.seller_code ILIKE 'A%'
        OR f.seller_code ILIKE 'E%'
        OR (f.seller_code ILIKE 'V%' AND f.seller_code NOT ILIKE 'TV%')
        OR f.seller_code IN ('10','18','27')
        OR f.seller_code = 'U1'
      )
      AND COALESCE(f.fecha_entrega, f.fecha_creacion) >= :inicio
      AND COALESCE(f.fecha_entrega, f.fecha_creacion) <  :fin
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// 4. HIELO — facturas, seller_code H%
// Usa f.total directamente para incluir IVA correcto
function qHielo(inicio, fin) {
  return sequelize.query(`
    SELECT
      COALESCE(SUM(f.total), 0) AS dolares,
      COALESCE(SUM(dd_agg.cantidad_total), 0) AS unidades,
      COUNT(DISTINCT f.code)              AS docs,
      COUNT(DISTINCT f.customer_code)     AS clientes
    FROM facturas f
    LEFT JOIN (
      SELECT documento_code, SUM(cantidad) AS cantidad_total
      FROM detalle_documento GROUP BY documento_code
    ) dd_agg ON dd_agg.documento_code = f.code
    WHERE (f.seller_code ILIKE 'H%' OR f.seller_code IN ('10','h3'))
      AND f.status IN (0,2,3,4,5)
      AND f.fecha_creacion >= :inicio
      AND f.fecha_creacion <  :fin
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// 5. COTTSA — Misma lógica que el dashboard descartable
// (obtenerDashboardCOTTSA del cotsaController):
//   ranking preventa (Facts seller_code IN ['RUTA 113','RUTA 131','RUTA 132'])
// + POS Kenny Navas    (Facts seller_code IN ['POS RUTA 113','POS RUTA 131','RUTA 132.1'])
// − Reembolsos Odoo    (TODOS los pos.order amount_total<0 del mes,
//                       incluyendo huérfanos sin facturar)
// Esto garantiza que el card "COTTSA S.A." del consolidado cuadre con
// el total "COTTSA — AGUA OK" mostrado en el descartable.
async function calcularCOTTSAMes(anioNum, mesNum) {
  const [ventasRuta, ventasPOS, reembolsos] = await Promise.all([
    obtenerVentasCOTTSAPorRuta(anioNum, mesNum),
    obtenerVentasPOSCOTTSA(anioNum, mesNum),
    obtenerResumenReembolsosCOTTSA(anioNum, mesNum),
  ]);

  const dolaresPreventa  = ventasRuta.reduce((a, r) => a + (Number(r.dolares)       || 0), 0);
  const unidadesPreventa = ventasRuta.reduce((a, r) => a + (Number(r.unidades)      || 0), 0);
  const facturasPreventa = ventasRuta.reduce((a, r) => a + (Number(r.cant_facturas) || 0), 0);
  const clientesPreventa = ventasRuta.reduce((a, r) => a + (Number(r.cant_clientes) || 0), 0);

  const reembolsosTotal    = Number(reembolsos?.total)    || 0;
  const reembolsosCantidad = Number(reembolsos?.cantidad) || 0;

  const dolaresPOS  = (Number(ventasPOS?.dolares)       || 0) - reembolsosTotal;
  const unidadesPOS = Number(ventasPOS?.unidades)       || 0;
  const facturasPOS = (Number(ventasPOS?.cant_facturas) || 0) + reembolsosCantidad;
  const clientesPOS = Number(ventasPOS?.cant_clientes)  || 0;

  return {
    dolares:  dolaresPreventa  + dolaresPOS,
    unidades: unidadesPreventa + unidadesPOS,
    docs:     facturasPreventa + facturasPOS,
    clientes: clientesPreventa + clientesPOS,
  };
}

// 6. DESCARTABLE ODOO — ordenes, seller_nombre IN RUTAS_ODOO, categoria 7
function qOdoo(inicio, fin) {
  const { pl, rep } = makeBindings(RUTAS_ODOO, 'od');
  return sequelize.query(`
    SELECT
      COALESCE(SUM(dd.total),    0) AS dolares,
      COALESCE(SUM(dd.cantidad), 0) AS unidades,
      COUNT(DISTINCT o.code)              AS docs,
      COUNT(DISTINCT o.customer_code)     AS clientes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.type = 2
      AND o.status IN (2,4,5)
      AND dd.codigo_categoria = '7'
      AND o.seller_nombre IN (${pl})
      AND o.fecha_creacion >= :inicio
      AND o.fecha_creacion <  :fin
  `, { replacements: { ...rep, inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// ================================================================
// TOTAL EMPRESA — todas las ordenes sin filtro de canal
// ================================================================
function qTotalOrdenes(inicio, fin) {
  return sequelize.query(`
    SELECT
      COALESCE(SUM(dd.total),    0) AS dolares,
      COALESCE(SUM(dd.cantidad), 0) AS unidades,
      COUNT(DISTINCT o.code)              AS docs,
      COUNT(DISTINCT o.customer_code)     AS clientes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status IN (2,4,5)
      AND o.origen_sistema = 'MOBILVENDOR'
      AND o.fecha_creacion >= :inicio
      AND o.fecha_creacion <  :fin
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// ================================================================
// TOTAL EMPRESA — todas las facturas sin filtro de canal
// Usa f.total para incluir IVA (coincide con Odoo)
// ================================================================
function qTotalFacturas(inicio, fin) {
  return sequelize.query(`
    SELECT
      COALESCE(SUM(f.total), 0) AS dolares,
      COALESCE(SUM(dd_agg.cantidad_total), 0) AS unidades,
      COUNT(DISTINCT f.code)              AS docs,
      COUNT(DISTINCT f.customer_code)     AS clientes
    FROM facturas f
    LEFT JOIN (
      SELECT documento_code, SUM(cantidad) AS cantidad_total
      FROM detalle_documento GROUP BY documento_code
    ) dd_agg ON dd_agg.documento_code = f.code
    WHERE f.status IN (0,2,3,4,5)
      AND f.fecha_creacion >= :inicio
      AND f.fecha_creacion <  :fin
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// ================================================================
// TENDENCIA 6 MESES POR EMPRESA (5 empresas dinámicamente)
// Facturas → company_id  |  Ordenes → descripcion_company (CASE)
// ================================================================
const COMPANIES = [
  { id: 1, nombre: 'GRUPOAQUA S.A.',    color: '#34d399' },
  { id: 2, nombre: 'AQUASUPPLY S.A.',   color: '#60a5fa' },
  { id: 3, nombre: 'COTTSA S.A.',       color: '#fbbf24' },
  { id: 4, nombre: 'IIBC S.A.',        color: '#a78bfa' },
  { id: 5, nombre: 'DISTRINTER S.A.',   color: '#f87171' },
];

function qPorEmpresa(inicio6m, fin) {
  return sequelize.query(`
    SELECT
      f.company_id::INT AS empresa_id,
      DATE_TRUNC('month', f.fecha_creacion) AS mes_truncado,
      SUM(f.total) AS total
    FROM facturas f
    WHERE f.status IN (0,2,3,4,5)
      AND f.company_id IS NOT NULL
      AND f.fecha_creacion >= :inicio6m
      AND f.fecha_creacion <  :fin
    GROUP BY f.company_id, DATE_TRUNC('month', f.fecha_creacion)
    ORDER BY f.company_id, DATE_TRUNC('month', f.fecha_creacion)
  `, { replacements: { inicio6m, fin }, type: Sequelize.QueryTypes.SELECT });
}

// ================================================================
// TENDENCIA 6 MESES — total empresa (todas las ordenes + facturas)
// ================================================================
function qTendencia(inicio6m, fin6m) {
  return sequelize.query(`
    SELECT mes_truncado, SUM(dolares) AS total
    FROM (
      -- Solo ordenes MobilVendor (Odoo vende mediante facturas, no ordenes)
      SELECT DATE_TRUNC('month', o.fecha_creacion) AS mes_truncado, SUM(dd.total) AS dolares
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.status IN (2,4,5)
        AND o.origen_sistema = 'MOBILVENDOR'
        AND o.fecha_creacion >= :inicio6m AND o.fecha_creacion < :fin6m
      GROUP BY DATE_TRUNC('month', o.fecha_creacion)

      UNION ALL

      -- Todas las facturas Odoo — usa f.total para incluir IVA (coincide con Odoo)
      SELECT DATE_TRUNC('month', f.fecha_creacion) AS mes_truncado, SUM(f.total) AS dolares
      FROM facturas f
      WHERE f.status IN (0,2,3,4,5)
        AND f.fecha_creacion >= :inicio6m AND f.fecha_creacion < :fin6m
      GROUP BY DATE_TRUNC('month', f.fecha_creacion)
    ) t
    GROUP BY mes_truncado
    ORDER BY mes_truncado
  `, {
    replacements: { inicio6m, fin6m },
    type: Sequelize.QueryTypes.SELECT,
  });
}

// ================================================================
// TOP 10 PRODUCTOS — todas las ordenes + facturas (sin filtro canal)
// ================================================================
function qTopProductos(inicio, fin) {
  return sequelize.query(`
    SELECT descripcion AS nombre, SUM(cantidad) AS unidades, SUM(dolares) AS dolares
    FROM (
      -- Solo ordenes MobilVendor
      SELECT dd.descripcion, dd.cantidad, dd.total AS dolares
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.status IN (2,4,5)
        AND o.origen_sistema = 'MOBILVENDOR'
        AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin

      UNION ALL

      -- Facturas Odoo
      SELECT dd.descripcion, dd.cantidad, dd.total AS dolares
      FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.status IN (0,2,3,4,5)
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
    ) t
    WHERE descripcion IS NOT NULL AND descripcion != ''
    GROUP BY descripcion
    ORDER BY dolares DESC
    LIMIT 10
  `, {
    replacements: { inicio, fin },
    type: Sequelize.QueryTypes.SELECT,
  });
}

// ================================================================
// CLIENTES ACTIVOS — deduplicados entre ordenes y facturas
// Usa UNION (sin ALL) para eliminar clientes que aparecen en ambas tablas
// ================================================================
function qClientesActivos(inicio, fin) {
  return sequelize.query(`
    SELECT COUNT(DISTINCT customer_code) AS clientes
    FROM (
      SELECT customer_code FROM ordenes
      WHERE status IN (2,4,5)
        AND fecha_creacion >= :inicio
        AND fecha_creacion <  :fin
        AND customer_code IS NOT NULL
      UNION
      SELECT customer_code FROM facturas
      WHERE status IN (0,2,3,4,5)
        AND fecha_creacion >= :inicio
        AND fecha_creacion <  :fin
        AND customer_code IS NOT NULL
    ) t
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });
}

// ================================================================
// TOP 10 CLIENTES — todas las ordenes + facturas (sin filtro canal)
// ================================================================
function qTopClientes(inicio, fin) {
  return sequelize.query(`
    SELECT customer_code AS codigo, MAX(nombre) AS nombre, SUM(dolares) AS dolares
    FROM (
      -- Solo ordenes MobilVendor
      SELECT o.customer_code, COALESCE(c.nombre_cliente, o.customer_code) AS nombre, SUM(dd.total) AS dolares
      FROM ordenes o
      JOIN detalle_documento dd ON dd.documento_code = o.code
      LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
      WHERE o.status IN (2,4,5)
        AND o.origen_sistema = 'MOBILVENDOR'
        AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
      GROUP BY o.customer_code, c.nombre_cliente

      UNION ALL

      -- Facturas Odoo
      SELECT f.customer_code, COALESCE(c.nombre_cliente, f.customer_code) AS nombre, SUM(dd.total) AS dolares
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      LEFT JOIN clientes c ON c.codigo_cliente = f.customer_code
      WHERE f.status IN (0,2,3,4,5)
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
      GROUP BY f.customer_code, c.nombre_cliente
    ) t
    GROUP BY customer_code
    ORDER BY dolares DESC
    LIMIT 10
  `, {
    replacements: { inicio, fin },
    type: Sequelize.QueryTypes.SELECT,
  });
}

// ================================================================
// BUILDER CANAL — aplica proyección y calcula variaciones
// ================================================================
function buildCanal(nombre, act, ant, diasT, diasL, esMes) {
  const dolares  = Number(act?.dolares  || 0);
  const unidades = Number(act?.unidades || 0);
  const dolAnt   = Number(ant?.dolares  || 0);
  const proyeccion = esMes && diasT > 0 ? (dolares / diasT) * diasL : dolares;
  const varAbs  = dolares - dolAnt;
  const varPorc = dolAnt > 0 ? (varAbs / dolAnt) * 100 : dolares > 0 ? 100 : 0;
  return {
    canal:        nombre,
    dolares:      Number(dolares.toFixed(2)),
    proyeccion:   Number(proyeccion.toFixed(2)),
    unidades:     Math.round(unidades),
    mesAnterior:  Number(dolAnt.toFixed(2)),
    variacionAbs: Number(varAbs.toFixed(2)),
    variacionPorc:Number(varPorc.toFixed(2)),
    docs:         Number(act?.docs     || 0),
    clientes:     Number(act?.clientes || 0),
  };
}

// ================================================================
// ENDPOINT PRINCIPAL
// GET /api/consolidado/dashboard?anio=YYYY&mes=MM
// ================================================================
const obtenerDashboardConsolidado = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    if (!anio || !mes)
      return res.status(400).json({ error: 'Debe enviar ?anio=YYYY&mes=MM' });

    const anioNum = parseInt(anio, 10);
    const mesNum  = parseInt(mes,  10);
    if (isNaN(anioNum) || isNaN(mesNum) || mesNum < 1 || mesNum > 12)
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const hoy         = new Date();
    const esMesActual = anioNum === hoy.getFullYear() && mesNum === hoy.getMonth() + 1;

    const inicio = getFechaInicioMes(anioNum, mesNum);
    const fin    = await getFechaFinDinamica(anioNum, mesNum);

    const { anio: anioPrev, mes: mesPrev } = getMesPrevio(anioNum, mesNum);
    const antInicio = getFechaInicioMes(anioPrev, mesPrev);
    const antFin    = getFechaFinMes(anioPrev, mesPrev);

    const diasT = getDiasHabiles(anioNum, mesNum, true);
    const diasL = getDiasHabiles(anioNum, mesNum, false);

    const meses6   = get6Meses(anioNum, mesNum);
    const inicio6m = meses6[0].inicio;
    const fin6m    = fin;

    // ── Ejecutar todas las queries en paralelo ────────────────
    const [
      [prevAct],  [prevAnt],
      [botOAct],  [botOAnt],
      [botFAct],  [botFAnt],
      [hieloAct], [hieloAnt],
      [odooAct],  [odooAnt],
      [totOrdAct],  [totOrdAnt],
      [totFactAct], [totFactAnt],
      [clientesActRow],
      tendenciaRaw,
      topProdRaw,
      topClientesRaw,
      porEmpresaRaw,
      // Tendencia COTTSA 6 meses con la misma lógica que el dashboard
      // descartable (ranking preventa + POS Kenny Navas − reembolsos Odoo).
      // El mes actual y el anterior se reusan de este mismo array para
      // evitar repetir las llamadas a Odoo.
      cottsaPorMesArr,
      cottsaExtrasRaw,
    ] = await Promise.all([
      qPreventa(inicio, fin),           qPreventa(antInicio, antFin),
      qBotellonesOrdenes(inicio, fin),  qBotellonesOrdenes(antInicio, antFin),
      qBotellonesFacturas(inicio, fin), qBotellonesFacturas(antInicio, antFin),
      qHielo(inicio, fin),              qHielo(antInicio, antFin),
      qOdoo(inicio, fin),               qOdoo(antInicio, antFin),
      qTotalOrdenes(inicio, fin),       qTotalOrdenes(antInicio, antFin),
      qTotalFacturas(inicio, fin),      qTotalFacturas(antInicio, antFin),
      qClientesActivos(inicio, fin),
      qTendencia(inicio6m, fin6m),
      qTopProductos(inicio, fin),
      qTopClientes(inicio, fin),
      qPorEmpresa(inicio6m, fin),
      Promise.all(meses6.map(m => calcularCOTTSAMes(m.anio, m.mes))),
      CottsaExtraMes.findAll({
        where: {
          [Sequelize.Op.or]: meses6.map(m => ({ anio: m.anio, mes: m.mes })),
        },
        raw: true,
      }),
    ]);

    // ── COTTSA actual y anterior se sacan del array de 6 meses (siempre
    // incluyen mes actual y mes anterior, ver get6Meses).
    const idxAct = meses6.findIndex(m => m.anio === anioNum  && m.mes === mesNum);
    const idxAnt = meses6.findIndex(m => m.anio === anioPrev && m.mes === mesPrev);
    const COTTSAAct = cottsaPorMesArr[idxAct] || { dolares: 0, unidades: 0, docs: 0, clientes: 0 };
    const COTTSAAnt = idxAnt >= 0
      ? cottsaPorMesArr[idxAnt]
      : { dolares: 0, unidades: 0, docs: 0, clientes: 0 };

    // ── Unir botellones (ordenes + facturas) ──────────────────
    const botAct = {
      dolares:  Number(botOAct?.dolares||0)  + Number(botFAct?.dolares||0),
      unidades: Number(botOAct?.unidades||0) + Number(botFAct?.unidades||0),
      docs:     Number(botOAct?.docs||0)     + Number(botFAct?.docs||0),
      clientes: Number(botOAct?.clientes||0) + Number(botFAct?.clientes||0),
    };
    const botAnt = {
      dolares: Number(botOAnt?.dolares||0) + Number(botFAnt?.dolares||0),
    };

    // ── Extras COTTSA por mes (igual que la tabla COTTSA del dashboard preventa) ──
    const cottsaExtrasMap = new Map();
    for (const r of cottsaExtrasRaw) {
      const k = `${r.anio}-${String(r.mes).padStart(2,'0')}`;
      cottsaExtrasMap.set(k, {
        dolares:  Number(r.dolares)  || 0,
        unidades: Number(r.unidades) || 0,
        facturas: Number(r.facturas) || 0,
      });
    }
    const mesActKey = `${anioNum}-${String(mesNum).padStart(2, '0')}`;
    const mesAntKey = `${anioPrev}-${String(mesPrev).padStart(2, '0')}`;
    const extraActCOTTSA = cottsaExtrasMap.get(mesActKey) || { dolares: 0, unidades: 0, facturas: 0 };
    const extraAntCOTTSA = cottsaExtrasMap.get(mesAntKey) || { dolares: 0, unidades: 0, facturas: 0 };

    const COTTSAActFinal = {
      dolares:  Number(COTTSAAct?.dolares  || 0) + extraActCOTTSA.dolares,
      unidades: Number(COTTSAAct?.unidades || 0) + extraActCOTTSA.unidades,
      docs:     Number(COTTSAAct?.docs     || 0) + extraActCOTTSA.facturas,
      clientes: Number(COTTSAAct?.clientes || 0),
    };
    const COTTSAAntFinal = {
      dolares:  Number(COTTSAAnt?.dolares  || 0) + extraAntCOTTSA.dolares,
      unidades: Number(COTTSAAnt?.unidades || 0) + extraAntCOTTSA.unidades,
      docs:     Number(COTTSAAnt?.docs     || 0) + extraAntCOTTSA.facturas,
      clientes: Number(COTTSAAnt?.clientes || 0),
    };

    // ── Construir canales (para desglose) ─────────────────────
    const canales = [
      buildCanal('PREVENTA',      prevAct,  prevAnt,  diasT, diasL, esMesActual),
      buildCanal('BOTELLONES',    botAct,   botAnt,   diasT, diasL, esMesActual),
      buildCanal('HIELO',         hieloAct, hieloAnt, diasT, diasL, esMesActual),
      buildCanal('COTTSA',        COTTSAActFinal, COTTSAAntFinal, diasT, diasL, esMesActual),
      buildCanal('DESC. ODOO',    odooAct,  odooAnt,  diasT, diasL, esMesActual),
    ];

    // ── KPIs totales — todas las ordenes MobilVendor + todas las facturas Odoo ──
    // Las órdenes MobilVendor y las facturas Odoo son sistemas separados (distintos
    // vendedores, distintas tablas), por lo que sumarlos no produce doble conteo.
    // Los clientes se deduplicacan con UNION entre ambas tablas.
    const totalVentas      = Number((Number(totOrdAct?.dolares || 0) + Number(totFactAct?.dolares || 0)).toFixed(2));
    const totalUnidades    = Math.round(Number(totOrdAct?.unidades || 0) + Number(totFactAct?.unidades || 0));
    const totalDocs        = Number(totOrdAct?.docs || 0) + Number(totFactAct?.docs || 0);
    const totalMesAnterior = Number((Number(totOrdAnt?.dolares || 0) + Number(totFactAnt?.dolares || 0)).toFixed(2));
    const totalClientes    = Number(clientesActRow?.clientes || 0);
    const totalProyeccion  = esMesActual && diasT > 0
      ? Number(((totalVentas / diasT) * diasL).toFixed(2))
      : totalVentas;

    const varAbs  = totalVentas - totalMesAnterior;
    const varPorc = totalMesAnterior > 0 ? (varAbs / totalMesAnterior) * 100 : 0;

    // ── Tendencia: mapear a estructura de 6 meses ─────────────
    const tendenciaMap = new Map(
      tendenciaRaw.map(r => {
        const dt = new Date(r.mes_truncado);
        const k = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
        return [k, Number(r.total || 0)];
      })
    );
    const tendencia = meses6.map(m => ({
      label: m.label,
      total: Number((tendenciaMap.get(`${m.anio}-${String(m.mes).padStart(2,'0')}`) || 0).toFixed(2)),
    }));

    // ── Top productos ─────────────────────────────────────────
    const topProductos = topProdRaw.map(p => ({
      nombre:   String(p.nombre || 'S/N').substring(0, 40),
      unidades: Math.round(Number(p.unidades || 0)),
      dolares:  Number(Number(p.dolares || 0).toFixed(2)),
    }));

    // ── Top clientes ──────────────────────────────────────────
    const topClientes = topClientesRaw.map(c => ({
      codigo:  c.codigo,
      nombre:  String(c.nombre || 'SIN NOMBRE').substring(0, 35),
      dolares: Number(Number(c.dolares || 0).toFixed(2)),
    }));

    // ── Por empresa — 5 empresas dinámicas ────────────────────
    // Agrupar porEmpresaRaw por empresa_id en un Map de Map<mesKey, total>
    console.log('porEmpresaRaw count:', porEmpresaRaw.length, 'sample:', JSON.stringify(porEmpresaRaw.slice(0, 3)));
    const empresaTendMaps = new Map();
    for (const row of porEmpresaRaw) {
      const empId = Number(row.empresa_id);
      // mes_truncado puede venir como Date (pg) o como string ISO
      const dt = new Date(row.mes_truncado);
      const mesKey = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
      if (!empresaTendMaps.has(empId)) empresaTendMaps.set(empId, new Map());
      empresaTendMaps.get(empId).set(mesKey, Number(row.total || 0));
    }

    // Sobrescribir COTTSA con la misma lógica que el dashboard descartable
    // (ranking preventa + POS Kenny Navas − reembolsos Odoo + extras manuales).
    // cottsaPorMesArr es paralelo a meses6.
    const cottsaMesMap = new Map();
    meses6.forEach((m, i) => {
      const mesKey = `${m.anio}-${String(m.mes).padStart(2, '0')}`;
      cottsaMesMap.set(mesKey, Number(cottsaPorMesArr[i]?.dolares || 0));
    });
    for (const [mesKey, extra] of cottsaExtrasMap.entries()) {
      cottsaMesMap.set(mesKey, (cottsaMesMap.get(mesKey) || 0) + extra.dolares);
    }
    empresaTendMaps.set(COTTSA_COMPANY_ID, cottsaMesMap);

    const porEmpresa = COMPANIES.map(emp => {
      const tendMap  = empresaTendMaps.get(emp.id) || new Map();
      const actual   = tendMap.get(mesActKey)  || 0;
      const anterior = tendMap.get(mesAntKey)  || 0;
      const varAbs   = actual - anterior;
      const varPorc  = anterior > 0 ? (varAbs / anterior) * 100 : (actual > 0 ? 100 : 0);
      return {
        empresa:       emp.nombre,
        color:         emp.color,
        actual:        Number(actual.toFixed(2)),
        anterior:      Number(anterior.toFixed(2)),
        variacionAbs:  Number(varAbs.toFixed(2)),
        variacionPorc: Number(varPorc.toFixed(2)),
        tendencia: meses6.map(m => ({
          label: m.label,
          total: Number((tendMap.get(`${m.anio}-${String(m.mes).padStart(2,'0')}`) || 0).toFixed(2)),
        })),
      };
    });

    return res.json({
      periodo: {
        anio: anioNum, mes: mesNum, esMesActual,
        label: `${NOMBRES_MESES[mesNum-1]} ${anioNum}`,
      },
      kpis: {
        totalVentas:      Number(totalVentas.toFixed(2)),
        totalProyeccion:  Number(totalProyeccion.toFixed(2)),
        totalUnidades,
        totalMesAnterior: Number(totalMesAnterior.toFixed(2)),
        variacionAbs:     Number(varAbs.toFixed(2)),
        variacionPorc:    Number(varPorc.toFixed(2)),
        ticketPromedio:   totalDocs > 0 ? Number((totalVentas / totalDocs).toFixed(2)) : 0,
        totalDocumentos:  totalDocs,
        totalClientes,
      },
      canales,
      tendencia,
      topProductos,
      topClientes,
      porEmpresa,
    });

  } catch (error) {
    console.error('❌ ERROR CONSOLIDADO:', error);
    return res.status(500).json({ message: 'Error al obtener datos consolidados', detail: error.message });
  }
};

module.exports = { obtenerDashboardConsolidado };
