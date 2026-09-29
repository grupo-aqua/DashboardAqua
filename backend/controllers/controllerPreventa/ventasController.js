// controllers/ventasController.js
const {
  Orden,
  DetalleDocumento,
  MetaPreventa,
} = require("../../models");

const Sequelize = require("sequelize");
const Op = Sequelize.Op;
const { sequelize } = require('../../models');
const { getDiasHabilesTranscurridos, getDiasLaborablesMes } = require('../../utils/diasFestivos');
const { filtroVisibilidad, permisosModulo } = require('../../utils/visibilidadRutas');
const { dedupeProductosVendidos } = require('../../utils/dedupeProductos');

// ==========================================
//  SOLO RUTAS DE PREVENTA PERMITIDAS
// ==========================================
const RUTAS_PREVENTA_VALIDAS = [
  "PV1", "PV2", "PV3", "PV4", "PV5", "PV6", "PV7", "PV8", "PV9",
  "PV10", "PV11", "PV12", "PV13", "PV14",
  "PREVENTA VIP 1", "TELEVENTA 1", "TELEVENTA 4",
];

const META_MENSUAL_UNIDADES_PREVENTA = 70000;
const META_MENSUAL_USD_PREVENTA = 200000;

// =============================================================
// 🧩 FUNCIÓN SEGURA PARA FECHAS PG
// =============================================================
function getRangoFechas(anio, mes) {
  const inicio = new Date(Date.UTC(anio, mes - 1, 1));
  const fin = new Date(Date.UTC(anio, mes, 1));
  return {
    fInicio: inicio.toISOString().replace("T", " ").substring(0, 19),
    fFin: fin.toISOString().replace("T", " ").substring(0, 19),
  };
}

// ================================================================
// HELPERS DE FECHA — centralizados
// ================================================================

/** Primer día del mes: "YYYY-MM-01 00:00:00" */
function getFechaInicioMes(anioNum, mesNum) {
  return `${anioNum}-${String(mesNum).padStart(2, '0')}-01 00:00:00`;
}

/** Primer día del mes siguiente (= fin de mes completo): "YYYY-MM-01 00:00:00" */
function getFechaFinMes(anioNum, mesNum) {
  let mesFin = mesNum + 1, anioFin = anioNum;
  if (mesFin === 13) { mesFin = 1; anioFin++; }
  return `${anioFin}-${String(mesFin).padStart(2, "0")}-01 00:00:00`;
}

// ================================================================
// FECHA DE ÚLTIMA SINCRONIZACIÓN
// ================================================================
/**
 * getFechaFinQuery(anioNum, mesNum)
 * Siempre retorna el primer día del mes siguiente (fin de mes completo).
 * El filtro no depende de la fecha de sincronización.
 */
const getFechaFinQuery = (anioNum, mesNum) => getFechaFinMes(anioNum, mesNum);


// =====================================
// 🔧 META HISTÓRICA POR PREVENTA (USD)
// =====================================
// Las metas históricas por preventa quedaron deshabilitadas (la meta real viene de
// objetivosGerencia / metas_preventas). Se devuelve un mapa vacío sin consultar la BD.
const obtenerMetasHistoricasPreventas = async () => {
  return {};
};

const obtenerMetaHistoricaGlobal = async () => {
  // CORRECCIÓN 2026-09-29: `seller_code ILIKE 'R%'` también matchea
  // 'RUTA 113'/'RUTA 131'/'RUTA 132'/'RUTA 132.1' (rutas OK, manejadas
  // aparte en mcp-server/ventasRutaOk.js) — se excluyen explícitamente.
  // Defensivo: `ordenes` no tiene hoy filas reales con esos seller_code
  // (confirmado con datos reales), así que no cambia el resultado actual.
  const sql = `
    SELECT MAX(total_mes) AS meta_global FROM (
      SELECT DATE_TRUNC('month', o.fecha_entrega) as mes, SUM(dd.total) AS total_mes
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE dd.codigo_categoria = '7' AND o.status IN (2,4,5)
        AND o.seller_code NOT ILIKE 'RUTA %'
        AND (o.seller_code ILIKE 'PV%' OR o.seller_code ILIKE 'PREVENTA%'
          OR o.seller_code ILIKE 'TELEVENTA%' OR o.seller_code ILIKE 'R%')
      GROUP BY DATE_TRUNC('month', o.fecha_entrega)
    ) AS sub;
  `;
  const [row] = await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
  return row?.meta_global ? Number(row.meta_global) : 0;
};

// ══════════════════════════════════════════════════════════════════
// OBJETIVO GERENCIA desde tabla meta_preventas
// ══════════════════════════════════════════════════════════════════
const obtenerObjetivosGerencia = async (anioNum, mesNum) => {
  try {
    const registros = await MetaPreventa.findAll({
      where: { mes: mesNum, anio: anioNum },
      attributes: ["codigo_ruta", "meta_dolares", "meta_unidades"],
      raw: true,
    });
    const mapa = {};
    registros.forEach(m => {
      mapa[m.codigo_ruta.toUpperCase()] = {
        meta_dolares: Number(m.meta_dolares) || 0,
        meta_unidades: Number(m.meta_unidades) || 0,
      };
    });
    console.log(`🎯 Objetivos gerencia ${mesNum}/${anioNum}:`, mapa);
    return mapa;
  } catch (err) {
    console.error("❌ Error cargando objetivos gerencia:", err.message);
    return {};
  }
};

// ======================================================
//  TOP 20 CLIENTES
// ======================================================
const obtenerTop20Clientes = async (anioNum, mesNum) => {
  // Top clientes siempre usa mes completo (no depende de sync)
  const fechaInicioStr = getFechaInicioMes(anioNum, mesNum);
  const fechaFinStr    = getFechaFinMes(anioNum, mesNum);

  const sql = `
    SELECT f.customer_code AS codigo_cliente, c.nombre_cliente AS cliente,
           f.seller_code AS preventa, f.route_code AS ruta,
           SUM(dd.cantidad) AS unidades_consumidas, SUM(dd.total) AS monto_consumido
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    LEFT JOIN clientes c ON c.codigo_cliente = f.customer_code
    WHERE f.type = 1 AND f.status = 2
      AND f.fecha_entrega >= '${fechaInicioStr}' AND f.fecha_entrega < '${fechaFinStr}'
      AND (f.seller_code ILIKE 'PV%' OR f.route_code ILIKE 'PV%'
        OR f.route_code ILIKE 'TELEVENTA%' OR f.route_code ILIKE 'RURAL%')
    GROUP BY f.customer_code, c.nombre_cliente, f.seller_code, f.route_code
    ORDER BY monto_consumido DESC LIMIT 20;
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

const obtenerDetalleRuta = async (req, res) => {
  try {
    const { vendedor, anio, mes } = req.query;
    if (!vendedor || !anio || !mes)
      return res.status(400).json({ error: "Debe enviar vendedor, anio y mes" });
    const detalle = await obtenerDetallePorVendedor(vendedor, parseInt(anio), parseInt(mes));
    res.status(200).json(detalle);
  } catch (error) {
    console.error("❌ Error en obtenerDetalleRuta:", error);
    res.status(500).json({ message: "Error interno" });
  }
};

const obtenerDetallePorVendedor = async (codigoVendedor, anioNum, mesNum) => {
  const { fInicio, fFin } = getRangoFechas(anioNum, mesNum);
  const sql = `
    SELECT dd.codigo_producto, dd.descripcion,
           SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.seller_code = '${codigoVendedor}' AND dd.codigo_categoria = '7'
      AND o.status IN ('2','4','5')
      AND o.fecha_creacion >= '${fInicio}' AND o.fecha_creacion < '${fFin}'
    GROUP BY dd.codigo_producto, dd.descripcion ORDER BY unidades DESC;
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

// ======================================================
// RANKING RUTAS R (R% / PVR%)
// ✅ Mes actual  → fecha fin = día siguiente a última sync
// ✅ Mes cerrado → fecha fin = fin de mes completo
// El mes anterior siempre usa fin de mes completo
// Cutoff: hasta feb 2026 → R% (sin PVR); marzo 2026 → transición R% + PVR%; desde abril 2026 → solo PVR%
// ======================================================
const obtenerRankingRutasDescartable = async (anioNum, mesNum, metasPorPreventa, diasTranscurridos, diasLaborablesMes) => {
  const hoy = new Date();
  const esMesActual = hoy.getFullYear() === anioNum && hoy.getMonth() + 1 === mesNum;

  // ✅ fecha fin dinámica para el mes consultado
  const inicio = getFechaInicioMes(anioNum, mesNum);
  const fin    = await getFechaFinQuery(anioNum, mesNum);

  // Mes anterior: siempre fin de mes completo
  let mesPrev = mesNum - 1, anioPrev = anioNum;
  if (mesPrev === 0) { mesPrev = 12; anioPrev--; }
  const inicioPrev = getFechaInicioMes(anioPrev, mesPrev);
  const finPrev    = getFechaFinMes(anioPrev, mesPrev);

  // Hasta febrero 2026 → SOLO autoventa (R%, excluye PVR%).
  // Marzo 2026 → mes de transición: R% (sin PVR%) + PVR% (incluye ambos).
  // Desde abril 2026 → SOLO prevendedores (PVR%).
  const esTransicion = (a, m) => a === 2026 && m === 3;
  const soloPVR = (a, m) => (a > 2026) || (a === 2026 && m >= 4);
  // CORRECCIÓN 2026-09-29: `R%` también matchea 'RUTA 113'/'RUTA 131'/
  // 'RUTA 132'/'RUTA 132.1' (rutas OK, ajenas a esta migración
  // autoventa→prevendedor) — se excluyen explícitamente en las 2 ramas
  // que usan `R%`. Defensivo hoy (esas facturas nunca tienen status=5,
  // el único status que esta consulta mira — confirmado con datos
  // reales), pero cierra el riesgo si eso cambiara.
  const buildSellerFilter = (alias, a, m) => {
    if (esTransicion(a, m)) {
      // R% no captura PVR% porque PVR empieza con P, no con R.
      // Necesitamos ambos prefijos explícitos.
      return `((${alias}.seller_code ILIKE 'R%' AND ${alias}.seller_code NOT ILIKE 'RUTA %') OR ${alias}.seller_code ILIKE 'PVR%')`;
    }
    return soloPVR(a, m)
      ? `${alias}.seller_code ILIKE 'PVR%'`
      : `(${alias}.seller_code ILIKE 'R%' AND ${alias}.seller_code NOT ILIKE 'PVR%' AND ${alias}.seller_code NOT ILIKE 'RUTA %')`;
  };

  const filtroOActual = buildSellerFilter('o', anioNum,  mesNum);
  const filtroFActual = buildSellerFilter('f', anioNum,  mesNum);
  const filtroOPrev   = buildSellerFilter('o', anioPrev, mesPrev);
  const filtroFPrev   = buildSellerFilter('f', anioPrev, mesPrev);
  const etiquetaFiltro = (a, m) => esTransicion(a, m) ? 'R% + PVR% (transición)' : (soloPVR(a, m) ? 'PVR%' : 'R% (sin PVR)');
  const etiqActual    = etiquetaFiltro(anioNum,  mesNum);
  const etiqPrev      = etiquetaFiltro(anioPrev, mesPrev);

  console.log(`📅 RankingR ${anioNum}-${mesNum}: ${inicio} → ${fin} (filtro=${etiqActual}, prev=${etiqPrev})`);
const sqlActual = `
  SELECT x.usuario,
         SUM(x.unidades) AS unidades,
         SUM(x.dolares) AS dolares,
         SUM(x.cant_ordenes) AS cant_ordenes,
         SUM(x.cant_facturas) AS cant_facturas
  FROM (

    -- =========================
    -- ORDENES (${etiqActual} + STATUS 5)
    -- =========================
    SELECT
      o.seller_code AS usuario,
      SUM(dd.cantidad) AS unidades,
      SUM(dd.total) AS dolares,
      COUNT(DISTINCT o.code) AS cant_ordenes,
      0::int AS cant_facturas
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE dd.codigo_categoria = '7'
      AND o.status = 5
      AND ${filtroOActual}
      AND COALESCE(o.fecha_entrega, o.fecha_creacion) >= '${inicio}'
      AND COALESCE(o.fecha_entrega, o.fecha_creacion) <  '${fin}'
    GROUP BY o.seller_code

    UNION ALL

    -- =========================
    -- FACTURAS (${etiqActual} + STATUS 5)
    -- =========================
    SELECT
      f.seller_code AS usuario,
      SUM(dd.cantidad) AS unidades,
      SUM(dd.total) AS dolares,
      0::int AS cant_ordenes,
      COUNT(DISTINCT f.code) AS cant_facturas
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE dd.codigo_categoria = '7'
      AND f.status = 5
      AND ${filtroFActual}
      AND COALESCE(f.fecha_entrega, f.fecha_creacion) >= '${inicio}'
      AND COALESCE(f.fecha_entrega, f.fecha_creacion) <  '${fin}'
    GROUP BY f.seller_code

  ) x
  GROUP BY x.usuario
  ORDER BY dolares DESC;
`;


const sqlPrev = `
  SELECT x.usuario,
         SUM(x.unidades) AS unidades,
         SUM(x.dolares) AS dolares,
         SUM(x.cant_ordenes) AS cant_ordenes
  FROM (
    SELECT
      o.seller_code AS usuario,
      SUM(dd.cantidad) AS unidades,
      SUM(dd.total) AS dolares,
      COUNT(DISTINCT o.code) AS cant_ordenes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE dd.codigo_categoria = '7'
      AND o.status = 5
      AND ${filtroOPrev}
      AND COALESCE(o.fecha_entrega, o.fecha_creacion) >= '${inicioPrev}'
      AND COALESCE(o.fecha_entrega, o.fecha_creacion) <  '${finPrev}'
    GROUP BY o.seller_code

    UNION ALL

    SELECT
      f.seller_code AS usuario,
      SUM(dd.cantidad) AS unidades,
      SUM(dd.total) AS dolares,
      0::int AS cant_ordenes
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE dd.codigo_categoria = '7'
      AND f.status = 5
      AND ${filtroFPrev}
      AND COALESCE(f.fecha_entrega, f.fecha_creacion) >= '${inicioPrev}'
      AND COALESCE(f.fecha_entrega, f.fecha_creacion) <  '${finPrev}'
    GROUP BY f.seller_code
  ) x
  GROUP BY x.usuario;
`;

  const actual   = await sequelize.query(sqlActual, { type: Sequelize.QueryTypes.SELECT });
  const anterior = await sequelize.query(sqlPrev,   { type: Sequelize.QueryTypes.SELECT });
  const mapPrev  = {};
  anterior.forEach(r => {
    mapPrev[r.usuario] = { dolares: Number(r.dolares) || 0, unidades: Number(r.unidades) || 0 };
  });

  return actual.map(r => {
    const montoActual       = Number(r.dolares) || 0;
    const montoAnterior     = mapPrev[r.usuario]?.dolares   || 0;
    const unidadesAnterior  = mapPrev[r.usuario]?.unidades  || 0;
    const proyeccion        = esMesActual && diasTranscurridos > 0
      ? (montoActual / diasTranscurridos) * diasLaborablesMes
      : montoActual;
    const variacionAbs  = montoActual - montoAnterior;
    const variacionPorc = montoAnterior > 0 ? (variacionAbs / montoAnterior) * 100 : null;
    const unidadesActual    = Number(r.unidades) || 0;
    const varAbsUnidades    = unidadesActual - unidadesAnterior;
    return {
      usuario: r.usuario, unidades: unidadesActual, dolares: montoActual,
      meta: metasPorPreventa[r.usuario] || 0,
      proyeccion: Number(proyeccion.toFixed(2)),
      vsMesAnterior: {
        monto_anterior:          Number(montoAnterior.toFixed(2)),
        variacion_abs:           Number(variacionAbs.toFixed(2)),
        variacion_porc:          variacionPorc !== null ? Number(variacionPorc.toFixed(2)) : null,
        unidades_anterior:       unidadesAnterior,
        variacion_abs_unidades:  varAbsUnidades,
      },
    };
  });
};

const obtenerVentaPorProducto = async (anioNum, mesNum) => {
  // Ventas por producto siempre usa mes completo
  const inicio = getFechaInicioMes(anioNum, mesNum);
  const fin    = getFechaFinMes(anioNum, mesNum);
  const sql = `
    SELECT dd.descripcion AS producto, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE dd.codigo_categoria='7' AND o.status IN('2','4','5')
      AND (o.seller_code ILIKE 'PV%' OR o.seller_code ILIKE 'R%' OR o.seller_code ILIKE 'TELEVENTA%')
      AND o.fecha_entrega>='${inicio}' AND o.fecha_entrega<'${fin}'
    GROUP BY dd.descripcion ORDER BY unidades DESC;
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

// ================================================================
// CANAL DESCARTABLE (A%, V%, M%)
// Función base — recibe fechas ya calculadas externamente
// ================================================================
const obtenerVentasDescartablePorCanal = async (fechaInicio, fechaFin) => {
  const sql = `
    SELECT o.seller_code, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares,
           COUNT(DISTINCT o.customer_code) AS clientes,
           ARRAY_AGG(DISTINCT o.customer_code) AS customer_codes,
           'FACTURA' AS origen
    FROM facturas o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE (o.seller_code ILIKE 'A%' OR o.seller_code ILIKE 'M%')
      AND dd.codigo_categoria='7' AND o.status IN('2','4','5')
      AND COALESCE(o.fecha_entrega, o.fecha_creacion)>='${fechaInicio}'
      AND COALESCE(o.fecha_entrega, o.fecha_creacion)<'${fechaFin}'
    GROUP BY o.seller_code

    UNION ALL

    -- VIP: Facturas V% + seller '18' → usa fecha_creacion (igual que tu query validado)
    SELECT o.seller_code, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares,
           COUNT(DISTINCT o.customer_code) AS clientes,
           ARRAY_AGG(DISTINCT o.customer_code) AS customer_codes,
           'FACTURA' AS origen
    FROM facturas o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE (o.seller_code ILIKE 'V%' OR o.seller_code = '18')
      AND dd.codigo_categoria='7' AND o.status IN('2')
      AND o.fecha_creacion>='${fechaInicio}'
      AND o.fecha_creacion<'${fechaFin}'
    GROUP BY o.seller_code

    UNION ALL

    -- Órdenes M% (sin cambio)
    SELECT o.seller_code, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares,
           COUNT(DISTINCT o.customer_code) AS clientes,
           ARRAY_AGG(DISTINCT o.customer_code) AS customer_codes,
           'ORDEN' AS origen
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.seller_code ILIKE 'M%'
      AND dd.codigo_categoria='7' AND o.status IN('2','4','5')
      AND COALESCE(o.fecha_entrega, o.fecha_creacion)>='${fechaInicio}'
      AND COALESCE(o.fecha_entrega, o.fecha_creacion)<'${fechaFin}'
    GROUP BY o.seller_code

    UNION ALL

    -- VIP: Órdenes V% + seller '18' → usa fecha_creacion
    SELECT o.seller_code, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares,
           COUNT(DISTINCT o.customer_code) AS clientes,
           ARRAY_AGG(DISTINCT o.customer_code) AS customer_codes,
           'ORDEN' AS origen
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE (o.seller_code ILIKE 'V%' OR o.seller_code = '18')
      AND dd.codigo_categoria='7' AND o.status IN('2')
      AND o.fecha_creacion>='${fechaInicio}'
      AND o.fecha_creacion<'${fechaFin}'
    GROUP BY o.seller_code

    ORDER BY seller_code;
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

const MetasHistoricasDescartablePorCanal = async () => {
  const sql = `
    SELECT sub.seller_code, MAX(sub.total_mes) AS meta_historica, mes_max_consumo.mes AS mes_mayor_consumo
    FROM (
      SELECT o.seller_code, DATE_TRUNC('month', o.fecha_entrega) AS mes, SUM(dd.total) AS total_mes
      FROM facturas o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE dd.codigo_categoria='7' AND o.status IN(2,4,5)
        AND o.seller_code IN('A1','A2','A3','A4.1','A5','A6','V1','V2','V3','V4','V5','V6')
      GROUP BY o.seller_code, DATE_TRUNC('month', o.fecha_entrega)
      UNION ALL
      SELECT o.seller_code, DATE_TRUNC('month', o.fecha_entrega) AS mes, SUM(dd.total) AS total_mes
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE dd.codigo_categoria='7' AND o.status IN(2,4,5) AND o.seller_code='M6'
      GROUP BY o.seller_code, DATE_TRUNC('month', o.fecha_entrega)
    ) AS sub
    LEFT JOIN (
      SELECT seller_code, mes, total_mes,
             RANK() OVER (PARTITION BY seller_code ORDER BY total_mes DESC) AS rank
      FROM (
        SELECT o.seller_code, DATE_TRUNC('month', o.fecha_entrega) AS mes, SUM(dd.total) AS total_mes
        FROM facturas o JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE dd.codigo_categoria='7' AND o.status IN(2,4,5)
          AND o.seller_code IN('A1','A2','A3','A4.1','A5','A6','V1','V2','V3','V4','V5','V6')
        GROUP BY o.seller_code, DATE_TRUNC('month', o.fecha_entrega)
        UNION ALL
        SELECT o.seller_code, DATE_TRUNC('month', o.fecha_entrega) AS mes, SUM(dd.total) AS total_mes
        FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE dd.codigo_categoria='7' AND o.status IN(2,4,5) AND o.seller_code='M6'
        GROUP BY o.seller_code, DATE_TRUNC('month', o.fecha_entrega)
      ) AS sub2
    ) AS mes_max_consumo
    ON sub.seller_code = mes_max_consumo.seller_code AND mes_max_consumo.rank = 1
    GROUP BY sub.seller_code, mes_max_consumo.mes;
  `;
  const filas = await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
  const mapa = {};
  filas.forEach(f => { mapa[f.seller_code] = { meta_historica: Number(f.meta_historica), mes_mayor_consumo: f.mes_mayor_consumo }; });
  return mapa;
};

// ================================================================
// ODOO descartable agrupado por equipo_ventas
// ================================================================
const obtenerOdooDescartablePorCanal = async (fechaInicio, fechaFin) => {
  const sql = `
   SELECT
        canal,
        SUM(total_imponible)  AS total_imponible,
        SUM(total_unidades)   AS total_unidades,
        SUM(rotacion)         AS rotacion,
        COUNT(DISTINCT customer_code) AS clientes
      FROM (

        -- ① ODOO por equipo_ventas (A%, V%, M%, etc.)
        --   Mantenemos cantidad como NUMERIC para conservar decimales
        --   (Odoo permite unidades fraccionales como 13,561.57).
        SELECT
          COALESCE(o.equipo_ventas, 'SIN EQUIPO') AS canal,
          COALESCE(SUM(dd.total),    0)::NUMERIC  AS total_imponible,
          COALESCE(SUM(dd.cantidad), 0)::NUMERIC  AS total_unidades,
          COUNT(DISTINCT o.code)                   AS rotacion,
          o.customer_code
        FROM ordenes o
        JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.origen_sistema   = 'ODOO'
          AND o.type             = 2
          AND o.status           IN (2)
          AND o.fecha_creacion   >= '${fechaInicio}'
          AND o.fecha_creacion   <  '${fechaFin}'
          AND dd.codigo_categoria = '7'
        GROUP BY o.equipo_ventas, o.customer_code

        UNION ALL

        -- ② Órdenes E% → canal 'Empresas'
        SELECT
          'Empresas'                               AS canal,
          COALESCE(SUM(dd.total),    0)::NUMERIC  AS total_imponible,
          COALESCE(SUM(dd.cantidad), 0)::NUMERIC  AS total_unidades,
          COUNT(DISTINCT o.code)                   AS rotacion,
          o.customer_code
        FROM ordenes o
        JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.seller_code      LIKE 'E%'
          AND dd.codigo_categoria = '7'
          AND o.fecha_creacion   >= '${fechaInicio}'
          AND o.fecha_creacion   <  '${fechaFin}'
        GROUP BY o.customer_code

        UNION ALL

        -- ③ Facturas E% → canal 'Empresas'
        SELECT
          'Empresas'                               AS canal,
          COALESCE(SUM(dd.total),    0)::NUMERIC  AS total_imponible,
          COALESCE(SUM(dd.cantidad), 0)::NUMERIC  AS total_unidades,
          COUNT(DISTINCT f.code)                   AS rotacion,
          f.customer_code
        FROM facturas f
        JOIN detalle_documento dd ON dd.documento_code = f.code
        WHERE f.seller_code      LIKE 'E%'
          AND dd.codigo_categoria = '7'
          AND f.fecha_creacion   >= '${fechaInicio}'
          AND f.fecha_creacion   <  '${fechaFin}'
        GROUP BY f.customer_code

      ) sub
      GROUP BY canal
      ORDER BY total_imponible DESC;
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

const obtenerVentasDescartablePorCanalMesAnterior = async (fechaInicio, fechaFin) => {
  const sql = `
    SELECT o.seller_code, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares, 'FACTURA' AS origen
    FROM facturas o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE (o.seller_code ILIKE 'A%' OR o.seller_code ILIKE 'V%' OR o.seller_code ILIKE 'M%')
      AND dd.codigo_categoria='7' AND o.status IN('2','4','5')
      AND COALESCE(o.fecha_entrega, o.fecha_creacion)>='${fechaInicio}' AND COALESCE(o.fecha_entrega, o.fecha_creacion)<'${fechaFin}'
    GROUP BY o.seller_code
    UNION ALL
    SELECT o.seller_code, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares, 'ORDEN' AS origen
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.seller_code='M6' AND dd.codigo_categoria='7' AND o.status IN('2','4','5')
      AND COALESCE(o.fecha_entrega, o.fecha_creacion)>='${fechaInicio}' AND COALESCE(o.fecha_entrega, o.fecha_creacion)<'${fechaFin}'
    GROUP BY o.seller_code
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

// ================================================================
// calcularVentasDescartableConComparativa
// ✅ Mes actual  → fecha fin = día siguiente a última sync
// ✅ Mes cerrado → fecha fin = fin de mes completo
// El mes anterior siempre usa fin de mes completo
// ================================================================
const calcularVentasDescartableConComparativa = async (anioNum, mesNum) => {
  const hoy = new Date();
  const esMesActual = anioNum === hoy.getFullYear() && mesNum === hoy.getMonth() + 1;

  // ✅ fecha fin dinámica para el mes consultado
  const fechaInicioMesActual = getFechaInicioMes(anioNum, mesNum);
  const fechaFinMesActual    = await getFechaFinQuery(anioNum, mesNum);

  // Mes anterior: siempre fin de mes completo
  let mesAnterior = mesNum - 1, anioAnterior = anioNum;
  if (mesAnterior === 0) { mesAnterior = 12; anioAnterior--; }
  const fechaInicioMesAnterior = getFechaInicioMes(anioAnterior, mesAnterior);
  const fechaFinMesAnterior    = getFechaFinMes(anioAnterior, mesAnterior);

  console.log(`📅 Descartable ${anioNum}-${mesNum}: ${fechaInicioMesActual} → ${fechaFinMesActual}`);

  const ventasActuales    = await obtenerVentasDescartablePorCanal(fechaInicioMesActual, fechaFinMesActual);
  const ventasMesAnterior = await obtenerVentasDescartablePorCanalMesAnterior(fechaInicioMesAnterior, fechaFinMesAnterior);

  const diasTranscurridos = getDiasHabilesTranscurridos(anioNum, mesNum);
  const diasLaborablesMes = getDiasLaborablesMes(anioNum, mesNum);
  const metasPorPreventa  = await MetasHistoricasDescartablePorCanal();
  const metasProyectadas  = {};

  ventasActuales.forEach(venta => {
    const preventa      = venta.seller_code;
    const metaHistorica = metasPorPreventa[preventa] || 0;
    const montoActual   = Number(venta.dolares) || 0;
    // ✅ solo proyectar si es mes actual y hay días transcurridos
    const proyeccion    = esMesActual && diasTranscurridos > 0
      ? (montoActual / diasTranscurridos) * diasLaborablesMes
      : montoActual;
    const ventaAnterior      = ventasMesAnterior.find(v => v.seller_code === preventa);
    const montoAnterior      = ventaAnterior ? Number(ventaAnterior.dolares)   || 0 : 0;
    const unidadesAnterior   = ventaAnterior ? Number(ventaAnterior.unidades)  || 0 : 0;
    const variacionAbs       = montoActual - montoAnterior;
    const variacionPorc      = montoAnterior > 0 ? (variacionAbs / montoAnterior) * 100 : null;
    const unidadesActual     = Number(venta.unidades) || 0;
    const varAbsUnidades     = unidadesActual - unidadesAnterior;
    const varPorcUnidades    = unidadesAnterior > 0 ? (varAbsUnidades / unidadesAnterior) * 100 : null;

    metasProyectadas[preventa] = {
      ...venta,
      clientes:   Number(venta.clientes) || 0,
      customer_codes: Array.isArray(venta.customer_codes) ? venta.customer_codes.filter(Boolean) : [],
      meta: metaHistorica,
      proyeccion: Number(proyeccion.toFixed(2)),
      vsMesAnterior: {
        monto_anterior:          Number(montoAnterior.toFixed(2)),
        variacion_abs:           Number(variacionAbs.toFixed(2)),
        variacion_porc:          variacionPorc !== null ? Number(variacionPorc.toFixed(2)) : null,
        unidades_anterior:       unidadesAnterior,
        variacion_abs_unidades:  varAbsUnidades,
        variacion_porc_unidades: varPorcUnidades !== null ? Number(varPorcUnidades.toFixed(2)) : null,
      },
    };
  });
  return metasProyectadas;
};

const obtenerPrecioPromedioPorPreventa = async (anioNum, mesNum) => {
  const inicio = getFechaInicioMes(anioNum, mesNum);
  const fin    = getFechaFinMes(anioNum, mesNum);
  const sql = `
    SELECT o.seller_code AS preventa, dd.codigo_producto, dd.descripcion,
           SUM(dd.cantidad) AS unidades, SUM(dd.total) AS monto,
           CASE WHEN SUM(dd.cantidad)>0 THEN SUM(dd.total)/SUM(dd.cantidad) ELSE 0 END AS precio_promedio
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status IN('2','4','5') AND dd.codigo_categoria='7'
      AND (o.seller_code ILIKE 'PV%' OR o.seller_code ILIKE 'PREVENTA%'
        OR o.seller_code ILIKE 'TELEVENTA%' OR o.seller_code ILIKE 'R%')
      AND o.fecha_entrega>='${inicio}' AND o.fecha_entrega<'${fin}'
    GROUP BY o.seller_code, dd.codigo_producto, dd.descripcion ORDER BY o.seller_code;
  `;
  return await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
};

const obtenerPrecioPromedioMesAnterior = async (anioNum, mesNum) => {
  const fecha    = new Date(anioNum, mesNum - 2, 1);
  const anioPrev = fecha.getFullYear();
  const mesPrev  = fecha.getMonth() + 1;
  return await obtenerPrecioPromedioPorPreventa(anioPrev, mesPrev);
};

function clasificarPresentacion(descripcion = "") {
  const text = descripcion.toUpperCase();
  if (text.includes("300ML"))                    return "300ML";
  if (text.includes("500ML"))                    return "500ML";
  if (text.includes("625ML"))                    return "625ML";
  if (text.includes("1.5") || text.includes("1.5L")) return "1.5L";
  if (text.includes("1L SPORT"))                 return "1L SPORT";
  if (text.includes("1L"))                       return "1L";
  if (text.includes("GALON") || text.includes("GALÓN")) return "GALON";
  if (text.includes("6L"))                       return "6L";
  return "OTROS";
}

function procesarTablaPrecioPromedio(actual, anterior, productosVendidos) {
  const mapAnterior = {};
  anterior.forEach(row => {
    const categoria = clasificarPresentacion(row.descripcion);
    mapAnterior[`${row.preventa}_${categoria}`] = Number(row.precio_promedio) || 0;
  });
  const respuesta = {};
  actual.forEach(row => {
    const categoria = clasificarPresentacion(row.descripcion);
    if (categoria === "OTROS") return;
    if (!productosVendidos[row.preventa]?.has(categoria)) return;
    const precioActual   = Number(row.precio_promedio) || 0;
    const precioAnterior = mapAnterior[`${row.preventa}_${categoria}`] || 0;
    const variacion      = precioAnterior > 0 ? ((precioActual - precioAnterior) / precioAnterior) * 100 : null;
    if (!respuesta[row.preventa]) respuesta[row.preventa] = {};
    respuesta[row.preventa][categoria] = {
      precio:     Number(precioActual.toFixed(2)),
      vsAnterior: variacion !== null ? Number(variacion.toFixed(2)) : null,
    };
  });
  return respuesta;
}

async function obtenerProductosVendidosMes(anio, mes) {
  const inicio = getFechaInicioMes(anio, mes);
  const fin    = getFechaFinMes(anio, mes);
  const sql = `
    SELECT o.seller_code AS preventa, dd.descripcion
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE dd.codigo_categoria='7' AND o.status IN('2','4','5')
      AND o.fecha_creacion>='${inicio}' AND o.fecha_creacion<'${fin}'
  `;
  const rows = await sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
  const mapa = {};
  rows.forEach(item => {
    const categoria = clasificarPresentacion(item.descripcion);
    if (categoria === "OTROS") return;
    if (!mapa[item.preventa]) mapa[item.preventa] = new Set();
    mapa[item.preventa].add(categoria);
  });
  return mapa;
}

// ================================================================
// calcularKPIsMes
// ✅ Ranking      → fecha fin dinámica (sync si mes actual, fin mes si cerrado)
// ✅ topClientes, ventaPorProducto, etc. → siempre fin de mes completo
// ================================================================
const calcularKPIsMes = async (anioNum, mesNum) => {

  const fechaInicioStr = getFechaInicioMes(anioNum, mesNum);

  // ✅ fecha fin dinámica para el ranking principal
  const fechaFinRankingStr = await getFechaFinQuery(anioNum, mesNum);

  // fin de mes completo para el resto de queries
  const fechaFinMesStr = getFechaFinMes(anioNum, mesNum);

  const hoy          = new Date();
  const esMesActual  = anioNum === hoy.getFullYear() && mesNum === hoy.getMonth() + 1;
  const esMesCerrado = anioNum < hoy.getFullYear() ||
    (anioNum === hoy.getFullYear() && mesNum < hoy.getMonth() + 1);

  console.log(`📅 KPIs ${anioNum}-${mesNum} | ranking: ${fechaInicioStr} → ${fechaFinRankingStr} | mes completo: → ${fechaFinMesStr}`);

  // ── Query ranking ─────────────────────────────────────────────
  const querySQL = `
        SELECT
            o.seller_code    AS preventa,
            SUM(dd.cantidad) AS sum_quantity,
            SUM(dd.total)    AS sum_total
        FROM ordenes o
        INNER JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE
            o.type   = 2
            AND o.status = 5
            -- Solo descartable (categoría '7'): cuadra con la guía de entrega de
            -- MobilVendor y con tendencia6MesesPreventa. Sin este filtro se sumaban
            -- líneas no-descartable / anticipos / envíos e inflaban cada ruta.
            AND dd.codigo_categoria = '7'
            AND (
                o.seller_code ILIKE 'PV%'
                OR o.seller_code ILIKE 'PREVENTA%'
                OR o.seller_code ILIKE 'TELEVENTA%'
            )
            AND o.seller_code NOT ILIKE 'PVR%'
            AND o.fecha_entrega >= :fechaInicio
            AND o.fecha_entrega <  :fechaFin
        GROUP BY o.seller_code
        ORDER BY
            CASE
                WHEN o.seller_code ILIKE 'PREVENTA VIP%' THEN 1
                WHEN o.seller_code ILIKE 'PV%'           THEN 2
                WHEN o.seller_code ILIKE 'TELEVENTA%'    THEN 3
                ELSE 4
            END ASC,
            o.seller_code ASC;

  `;

  const resultadosSQL = await sequelize.query(querySQL, {
    replacements: { fechaInicio: fechaInicioStr, fechaFin: fechaFinRankingStr },
    type: Sequelize.QueryTypes.SELECT
  });

  // ── Query unidades por presentación por preventa ───────────────
  const queryPresentaciones = `
    SELECT
        o.seller_code  AS preventa,
        dd.descripcion AS descripcion,
        SUM(dd.cantidad) AS cantidad
    FROM ordenes o
    INNER JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE
        o.type   = 2
        AND o.status = 5
        -- Mismo universo descartable que el ranking (categoría '7').
        AND dd.codigo_categoria = '7'
        AND (
            o.seller_code ILIKE 'PV%'
            OR o.seller_code ILIKE 'PREVENTA%'
            OR o.seller_code ILIKE 'TELEVENTA%'
        )
        AND o.seller_code NOT ILIKE 'PVR%'
        AND o.fecha_entrega >= :fechaInicio
        AND o.fecha_entrega <  :fechaFin
    GROUP BY o.seller_code, dd.descripcion
  `;
  const resultadosPresentaciones = await sequelize.query(queryPresentaciones, {
    replacements: { fechaInicio: fechaInicioStr, fechaFin: fechaFinRankingStr },
    type: Sequelize.QueryTypes.SELECT
  });

  // Agrupar en mapa: { preventa -> { presentacion -> unidades } }
  const mapaPresentaciones = {};
  resultadosPresentaciones.forEach(row => {
    const presentacion = clasificarPresentacion(row.descripcion);
    if (presentacion === "OTROS") return;
    if (!mapaPresentaciones[row.preventa]) mapaPresentaciones[row.preventa] = {};
    mapaPresentaciones[row.preventa][presentacion] =
      (mapaPresentaciones[row.preventa][presentacion] || 0) + Number(row.cantidad);
  });

  const metasPorPreventa  = await obtenerMetasHistoricasPreventas();
  const diasTranscurridos = getDiasHabilesTranscurridos(anioNum, mesNum);
  const diasLaborablesMes = getDiasLaborablesMes(anioNum, mesNum);

  let rankingPreventasSQL = resultadosSQL.map(r => {
    const preventa      = r.preventa;
    const unidades      = Number(r.sum_quantity);
    const monto         = Number(r.sum_total);
    const metaHistorica = metasPorPreventa[preventa] || 0;
    const proyeccion    = esMesCerrado || diasTranscurridos === 0
      ? monto
      : (monto / diasTranscurridos) * diasLaborablesMes;
    return {
      preventa,
      unidades,
      monto,
      meta: metaHistorica,
      proyeccion: Number(proyeccion.toFixed(2)),
      unidadesPorPresentacion: mapaPresentaciones[preventa] || {},
    };
  });
  rankingPreventasSQL.sort((a, b) => b.monto - a.monto);

  const unidadesTotalesSQL = rankingPreventasSQL.reduce((a, b) => a + b.unidades, 0);
  const montoTotalSQL      = rankingPreventasSQL.reduce((a, b) => a + b.monto, 0);

  // ── Top clientes (mes completo) ───────────────────────────────
  const topActual = await obtenerTop20Clientes(anioNum, mesNum);
  let topAnterior = [];
  try {
    const fechaAnterior = new Date(anioNum, mesNum - 1, 1);
    fechaAnterior.setMonth(fechaAnterior.getMonth() - 1);
    topAnterior = await obtenerTop20Clientes(
      fechaAnterior.getFullYear(),
      fechaAnterior.getMonth() + 1
    );
  } catch { topAnterior = []; }

  const top20Final = topActual.map(cli => {
    const anterior      = topAnterior.find(c => c.codigo_cliente === cli.codigo_cliente)
      || { monto_consumido: 0, unidades_consumidas: 0 };
    const variacionAbs  = Number(cli.monto_consumido) - Number(anterior.monto_consumido);
    const variacionPorc = anterior.monto_consumido > 0
      ? (variacionAbs / anterior.monto_consumido) * 100
      : null;
    return {
      codigo             : cli.codigo_cliente,
      cliente            : cli.cliente,
      preventa           : cli.preventa,
      montoActual        : Number(cli.monto_consumido),
      montoAnterior      : Number(anterior.monto_consumido),
      variacionMontoAbs  : variacionAbs,
      variacionMontoPorc : variacionPorc !== null ? Number(variacionPorc.toFixed(2)) : null,
      unidadesActual     : Number(cli.unidades_consumidas),
      unidadesAnterior   : Number(anterior.unidades_consumidas),
    };
  });

  // ── Ranking rutas R (fecha fin dinámica se calcula internamente) ──
  const rankingRutasR    = await obtenerRankingRutasDescartable(
    anioNum, mesNum, metasPorPreventa, diasTranscurridos, diasLaborablesMes
  );
  const ventaPorProducto = dedupeProductosVendidos(await obtenerVentaPorProducto(anioNum, mesNum));

  // ventasDescartable en calcularKPIsMes usa fin de mes completo
  // (la versión con comparativa se llama aparte en obtenerDatosDashboard)
  const ventasDescartable = await obtenerVentasDescartablePorCanal(fechaInicioStr, fechaFinMesStr);

  const metaMensualUnidades         = META_MENSUAL_UNIDADES_PREVENTA;
  const metaMensualDolares          = META_MENSUAL_USD_PREVENTA;
  const cumplimientoUnidadesMensual = metaMensualUnidades > 0
    ? (unidadesTotalesSQL / metaMensualUnidades) * 100 : 0;
  const cumplimientoUSDMensual      = metaMensualDolares > 0
    ? (montoTotalSQL / metaMensualDolares) * 100 : 0;

  return {
    kpisGenerales: {
      unidadesTotales: unidadesTotalesSQL,
      montoTotal     : montoTotalSQL,
      metaMensualUnidades,
      metaMensualDolares,
      cumplimientoUnidadesMensual,
      cumplimientoUSDMensual,
    },
    rankingPreventas        : rankingPreventasSQL,
    rankingRutasR,
    topClientes             : top20Final,
    ventaPorProducto,
    ventasDescartablePorCanal: ventasDescartable,
    clientesDetalle         : {},
    resumenGeneral          : {
      ordenesGeneradas  : rankingPreventasSQL.length,
      ordenesEntregadas : rankingPreventasSQL.length,
      clientesEnRuta    : 0,
      clientesSinConsumo: 0,
    },
    _raw: { unidadesTotales: unidadesTotalesSQL, montoTotal: montoTotalSQL },
  };
};

// ================================================================
// HELPERS PARA CARDS DE RESUMEN
// ================================================================
const agruparDescartablePorCanalResumen = (ventasPorPreventa = {}) => {
  const resumen = {
    DOMICILIO: { canal: "DOMICILIO", unidades: 0, monto: 0, montoReal: 0, mesAnterior: 0, variacionAbs: 0, variacionPorc: 0, unidadesAnterior: 0 },
    MAYORISTA: { canal: "MAYORISTA", unidades: 0, monto: 0, montoReal: 0, mesAnterior: 0, variacionAbs: 0, variacionPorc: 0, unidadesAnterior: 0 },
    VIP:       { canal: "VIP",       unidades: 0, monto: 0, montoReal: 0, mesAnterior: 0, variacionAbs: 0, variacionPorc: 0, unidadesAnterior: 0 },
  };
  Object.values(ventasPorPreventa).forEach(v => {
    const seller = v.seller_code || "";
    let canal = null;
    if      (seller.startsWith("A")) canal = "DOMICILIO";
    else if (seller.startsWith("M")) canal = "MAYORISTA";
    else if (seller.startsWith("V")) canal = "VIP";
    if (!canal) return;
    resumen[canal].unidades         += Number(v.unidades   || 0);
    resumen[canal].monto            += Number(v.proyeccion || v.dolares || 0);
    resumen[canal].montoReal        += Number(v.dolares    || 0);
    resumen[canal].mesAnterior      += Number(v.vsMesAnterior?.monto_anterior    || 0);
    resumen[canal].unidadesAnterior += Number(v.vsMesAnterior?.unidades_anterior || 0);
  });
  Object.keys(resumen).forEach(c => {
    const r = resumen[c];
    r.variacionAbs  = r.monto - r.mesAnterior;
    r.variacionPorc = r.mesAnterior > 0 ? (r.variacionAbs / r.mesAnterior) * 100 : null;
  });
  return resumen;
};

const resumirRankingParaCard = (ranking = [], canal) => {
  const resumen = { canal, unidades: 0, monto: 0, montoReal: 0, mesAnterior: 0, variacionAbs: 0, variacionPorc: 0, unidadesAnterior: 0 };
  ranking.forEach(r => {
    resumen.unidades         += Number(r.unidades || 0);
    resumen.monto            += Number(r.proyeccion || r.monto || 0);
    resumen.montoReal        += Number(r.monto || r.dolares || 0);   // actual sin proyectar
    if (r.vsMesAnterior) {
      resumen.mesAnterior      += Number(r.vsMesAnterior.monto_anterior    || 0);
      resumen.unidadesAnterior += Number(r.vsMesAnterior.unidades_anterior || 0);
    }
  });
  resumen.variacionAbs  = resumen.monto - resumen.mesAnterior;
  resumen.variacionPorc = resumen.mesAnterior > 0
    ? (resumen.variacionAbs / resumen.mesAnterior) * 100
    : null;
  return resumen;
};

// ===================================
// ================================================================
// TENDENCIA 6 MESES PREVENTA (ordenes rutas PV* + TELEVENTA*)
// ================================================================
const tendencia6MesesPreventa = async (anioNum, mesNum) => {
  const NOMBRES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  let mesInicio = mesNum - 11, anioInicio = anioNum;
  while (mesInicio <= 0) { mesInicio += 12; anioInicio--; }
  const inicio6 = getFechaInicioMes(anioInicio, mesInicio);
  const fin6    = getFechaFinMes(anioNum, mesNum);

  // Suma todos los canales que componen el total del dashboard:
  // 1) TIENDAS: PV*/PREVENTA*/TELEVENTA* ordenes (status=5, fecha_entrega)
  // 2) RURAL:   R*/PVR* ordenes + facturas (fecha_creacion)
  // 3) DOMICILIO/VIP/MAYORISTA: A*/V*/M* facturas + M6 ordenes (COALESCE fecha_entrega, fecha_creacion)
  // 4) COTTSA:   facturas company_id=3 (fecha_creacion, sin filtro categoría)
  // 5) ODOO Descartable: ordenes RUTAS_ODOO categoria 7 (fecha_creacion)
  const RUTAS_ODOO_DESCARTABLE = [
    'Carmen Garcia','Estefania Flores','Tamara Villacres',
    'RUTA E1','RUTA E2','RUTA E3','RUTA E4','RUTA E5',
    'RUTA E6','RUTA E7','RUTA E8','RUTA E9','RUTA E10',
    'RUTA EA1','RUTA U2','Distribucion OK/E','Domicilio',
  ];
  const odooPlaceholders = RUTAS_ODOO_DESCARTABLE.map((_, i) => `:odoo${i}`).join(', ');
  const bindings = { inicio6, fin6 };
  RUTAS_ODOO_DESCARTABLE.forEach((r, i) => { bindings[`odoo${i}`] = r; });

  const rows = await sequelize.query(`
    SELECT mes_periodo, SUM(dolares) AS dolares, SUM(unidades) AS unidades
    FROM (
      SELECT DATE_TRUNC('month', o.fecha_entrega) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.type = 2 AND o.status = 5 AND dd.codigo_categoria = '7'
        AND (o.seller_code ILIKE 'PV%' OR o.seller_code ILIKE 'PREVENTA%' OR o.seller_code ILIKE 'TELEVENTA%')
        AND o.seller_code NOT ILIKE 'PVR%'
        AND o.fecha_entrega >= :inicio6 AND o.fecha_entrega < :fin6
      GROUP BY DATE_TRUNC('month', o.fecha_entrega)

      UNION ALL

      SELECT DATE_TRUNC('month', o.fecha_creacion) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE dd.codigo_categoria = '7' AND o.status IN (2,4,5)
        AND (o.seller_code ILIKE 'R%' OR o.seller_code ILIKE 'PVR%')
        AND o.fecha_creacion >= :inicio6 AND o.fecha_creacion < :fin6
      GROUP BY DATE_TRUNC('month', o.fecha_creacion)

      UNION ALL

      SELECT DATE_TRUNC('month', f.fecha_creacion) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE dd.codigo_categoria = '7' AND f.status IN (0,2,3,4,5)
        AND (f.seller_code ILIKE 'R%' OR f.seller_code ILIKE 'PVR%')
        AND f.fecha_creacion >= :inicio6 AND f.fecha_creacion < :fin6
      GROUP BY DATE_TRUNC('month', f.fecha_creacion)

      UNION ALL

      SELECT DATE_TRUNC('month', COALESCE(f.fecha_entrega, f.fecha_creacion)) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE dd.codigo_categoria = '7' AND f.status IN (0,2,3,4,5)
        AND (f.seller_code ILIKE 'A%' OR f.seller_code ILIKE 'V%' OR f.seller_code ILIKE 'M%')
        AND COALESCE(f.fecha_entrega, f.fecha_creacion) >= :inicio6
        AND COALESCE(f.fecha_entrega, f.fecha_creacion) < :fin6
      GROUP BY DATE_TRUNC('month', COALESCE(f.fecha_entrega, f.fecha_creacion))

      UNION ALL

      SELECT DATE_TRUNC('month', COALESCE(o.fecha_entrega, o.fecha_creacion)) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE dd.codigo_categoria = '7' AND o.status IN (2,4,5)
        AND o.seller_code = 'M6'
        AND COALESCE(o.fecha_entrega, o.fecha_creacion) >= :inicio6
        AND COALESCE(o.fecha_entrega, o.fecha_creacion) < :fin6
      GROUP BY DATE_TRUNC('month', COALESCE(o.fecha_entrega, o.fecha_creacion))

      UNION ALL

      SELECT DATE_TRUNC('month', f.fecha_creacion) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.company_id = 3 AND f.status IN (0,2,3,4,5)
        AND f.fecha_creacion >= :inicio6 AND f.fecha_creacion < :fin6
      GROUP BY DATE_TRUNC('month', f.fecha_creacion)

      UNION ALL

      SELECT DATE_TRUNC('month', o.fecha_creacion) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.type = 2 AND o.status IN (2,4,5) AND dd.codigo_categoria = '7'
        AND o.seller_nombre IN (${odooPlaceholders})
        AND o.fecha_creacion >= :inicio6 AND o.fecha_creacion < :fin6
      GROUP BY DATE_TRUNC('month', o.fecha_creacion)
    ) sub
    GROUP BY mes_periodo
    ORDER BY mes_periodo
  `, { replacements: bindings, type: Sequelize.QueryTypes.SELECT });

  const hoy = new Date();
  return rows.map(r => {
    const d        = new Date(r.mes_periodo);
    const mes      = d.getMonth() + 1;
    const anio     = d.getFullYear();
    const dolares  = Number(Number(r.dolares  || 0).toFixed(2));
    const unidades = Number(r.unidades || 0);
    const esCurrent = anio === hoy.getFullYear() && mes === hoy.getMonth() + 1;
    const diasT = esCurrent ? getDiasHabilesTranscurridos(anio, mes) : 0;
    const diasL = esCurrent ? getDiasLaborablesMes(anio, mes) : 0;
    const proyeccion = esCurrent && diasT > 0
      ? Number(((dolares / diasT) * diasL).toFixed(2))
      : dolares;
    return { label: NOMBRES[d.getMonth()], anio, mes, dolares, unidades, proyeccion };
  });
};

//  ✅ Endpoint Principal — Dashboard
// ===================================
const obtenerDatosDashboard = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    if (!anio || !mes)
      return res.status(400).json({ error: "Debe enviar ?anio=YYYY&mes=MM" });

    const anioNum = parseInt(anio, 10);
    const mesNum  = parseInt(mes,  10);

    if (isNaN(anioNum) || isNaN(mesNum) || mesNum < 1 || mesNum > 12)
      return res.status(400).json({ error: "Parámetros anio/mes inválidos." });

    // ── Visibilidad por rol/canal/sección ──
    //    'todo' → ve todo · 'secciones' → solo las secciones elegidas · 'canal' → por ruta.
    const vis = filtroVisibilidad(req.user);
    const pmPreventa = permisosModulo(req.user, '/dashboard/preventa');
    const verTodoPreventa = pmPreventa.modo === 'todo';
    const seccionesPreventa = pmPreventa.modo === 'secciones' ? pmPreventa.secciones : null; // Set | null
    // Mapea el seller_code de descartable a su sección (A→Domicilio, M→Mayorista, V→VIP).
    const seccionDescartable = (sc) => {
      const s = String(sc || '').toUpperCase();
      if (s.startsWith('A')) return 'DOMICILIO';
      if (s.startsWith('M')) return 'MAYORISTA';
      if (s.startsWith('V')) return 'VIP';
      return null;
    };

    const resumenActual     = await calcularKPIsMes(anioNum, mesNum);
    const objetivosGerencia = await obtenerObjetivosGerencia(anioNum, mesNum);

    let comparativaMesAnterior = null;
    let resumenPrev = null;

    try {
      const fecha    = new Date(anioNum, mesNum - 1, 1);
      fecha.setMonth(fecha.getMonth() - 1);
      const anioPrev = fecha.getFullYear();
      const mesPrev  = fecha.getMonth() + 1;
      resumenPrev    = await calcularKPIsMes(anioPrev, mesPrev);

      const uAct  = resumenActual._raw.unidadesTotales;
      const uPrev = resumenPrev._raw.unidadesTotales;
      const mAct  = resumenActual._raw.montoTotal;
      const mPrev = resumenPrev._raw.montoTotal;

      comparativaMesAnterior = {
        anio: anioPrev, mes: mesPrev,
        unidades: { anterior: uPrev, actual: uAct, variacionAbs: uAct - uPrev,
          variacionPorcentaje: uPrev > 0 ? ((uAct - uPrev) / uPrev) * 100 : null },
        monto: { anterior: mPrev, actual: mAct, variacionAbs: mAct - mPrev,
          variacionPorcentaje: mPrev > 0 ? ((mAct - mPrev) / mPrev) * 100 : null },
      };
    } catch (err) { console.error("❌ Error comparativa general:", err); }

    // ── vsMesAnterior + objetivo gerencia por ruta ────────────
    try {
      const rankingActual  = resumenActual.rankingPreventas || [];
      const rankingPrevMap = {};
      (resumenPrev?.rankingPreventas || []).forEach(r => {
        rankingPrevMap[r.preventa] = { monto: Number(r.monto) || 0, unidades: Number(r.unidades) || 0 };
      });

      resumenActual.rankingPreventas = rankingActual.map(r => {
        const montoActualRanking = Number(r.monto) || 0;
        const montoAnterior      = rankingPrevMap[r.preventa]?.monto    || 0;
        const unidadesAnterior   = rankingPrevMap[r.preventa]?.unidades || 0;
        const variacionAbs       = montoActualRanking - montoAnterior;
        const variacionPorc      = montoAnterior > 0 ? (variacionAbs / montoAnterior) * 100 : null;
        const rutaKey          = (r.preventa || "").toUpperCase();
        const objGerencia      = objetivosGerencia[rutaKey] || { meta_dolares: 0, meta_unidades: 0 };
        return {
          ...r,
          objetivo_gerencia         : objGerencia.meta_dolares,
          objetivo_gerencia_unidades: objGerencia.meta_unidades,
          vsMesAnterior: {
            monto_anterior:    montoAnterior,
            unidades_anterior: unidadesAnterior,
            variacion_abs :    Number(variacionAbs.toFixed(2)),
            variacion_porc:    variacionPorc !== null ? Number(variacionPorc.toFixed(2)) : null,
          },
        };
      });
    } catch (e) { console.error("❌ Error generando vsMesAnterior:", e); }

    // ── objetivo_gerencia (cupo) para Rutas R ──────────────────
    resumenActual.rankingRutasR = (resumenActual.rankingRutasR || []).map(r => {
      const rutaKey     = (r.usuario || "").toUpperCase();
      const objGerencia = objetivosGerencia[rutaKey] || { meta_dolares: 0, meta_unidades: 0 };
      return {
        ...r,
        objetivo_gerencia         : objGerencia.meta_dolares,
        objetivo_gerencia_unidades: objGerencia.meta_unidades,
      };
    });

    // ── Aplicar visibilidad a los rankings (Tiendas / Rural) ──
    if (seccionesPreventa) {
      if (!seccionesPreventa.has('TIENDAS')) resumenActual.rankingPreventas = [];
      if (!seccionesPreventa.has('RURAL'))   resumenActual.rankingRutasR = [];
    } else if (vis.restringe && !verTodoPreventa) {
      resumenActual.rankingPreventas = (resumenActual.rankingPreventas || [])
        .filter(r => vis.permite(r.preventa));
      resumenActual.rankingRutasR = (resumenActual.rankingRutasR || [])
        .filter(r => vis.permite(r.usuario));
    }

    // ── Descartable con comparativa (usa fecha fin dinámica internamente) ──
    const ventasDescartableConComparativa = await calcularVentasDescartableConComparativa(anioNum, mesNum);

    // ── Enriquecer descartable con objetivo_gerencia (cupo) ──
    Object.keys(ventasDescartableConComparativa).forEach(key => {
      const v      = ventasDescartableConComparativa[key];
      const rutaKey = (v.seller_code || key).toUpperCase();
      const obj    = objetivosGerencia[rutaKey] || { meta_dolares: 0, meta_unidades: 0 };
      ventasDescartableConComparativa[key] = {
        ...v,
        objetivo_gerencia          : obj.meta_dolares,
        objetivo_gerencia_unidades : obj.meta_unidades,
      };
    });

    // ── Filtrar descartable por visibilidad (ruta/canal). En modo 'secciones'
    //    el recorte se hace al final (tras las correcciones de mes anterior). ──
    if (vis.restringe && !verTodoPreventa && !seccionesPreventa) {
      Object.keys(ventasDescartableConComparativa).forEach(key => {
        const sc = ventasDescartableConComparativa[key]?.seller_code || key;
        if (!vis.permite(sc)) delete ventasDescartableConComparativa[key];
      });
    }

    const resumenDescartablePorCanal = agruparDescartablePorCanalResumen(ventasDescartableConComparativa);

    const resumenVentasPorCanal = {
      TIENDAS: resumirRankingParaCard(resumenActual.rankingPreventas, "PREVENTAS"),
      RURAL  : resumirRankingParaCard(resumenActual.rankingRutasR,    "RURAL"),
      ...resumenDescartablePorCanal,
    };

    // ── Corregir mesAnterior con totales completos del mes anterior ──────────
    // Sin esto, las rutas sin ventas en el mes actual no contribuyen al anterior
    if (resumenPrev) {
      // PREVENTAS: todas las rutas PV*/PREVENTA*/TELEVENTA* del mes anterior
      const tiendasPrev = (resumenPrev.rankingPreventas || [])
        .reduce((s, r) => s + Number(r.monto || 0), 0);
      resumenVentasPorCanal.TIENDAS.mesAnterior  = Number(tiendasPrev.toFixed(2));
      resumenVentasPorCanal.TIENDAS.variacionAbs = Number((resumenVentasPorCanal.TIENDAS.monto - tiendasPrev).toFixed(2));
      resumenVentasPorCanal.TIENDAS.variacionPorc = tiendasPrev > 0
        ? Number(((resumenVentasPorCanal.TIENDAS.variacionAbs / tiendasPrev) * 100).toFixed(2)) : null;

      // RURAL: todas las rutas R*/PVR* del mes anterior
      const ruralPrev = (resumenPrev.rankingRutasR || [])
        .reduce((s, r) => s + Number(r.dolares || 0), 0);
      resumenVentasPorCanal.RURAL.mesAnterior  = Number(ruralPrev.toFixed(2));
      resumenVentasPorCanal.RURAL.variacionAbs = Number((resumenVentasPorCanal.RURAL.monto - ruralPrev).toFixed(2));
      resumenVentasPorCanal.RURAL.variacionPorc = ruralPrev > 0
        ? Number(((resumenVentasPorCanal.RURAL.variacionAbs / ruralPrev) * 100).toFixed(2)) : null;

      // DOMICILIO / MAYORISTA / VIP: todas las rutas A*/V*/M* del mes anterior
      const descPrev = { DOMICILIO: 0, MAYORISTA: 0, VIP: 0 };
      (resumenPrev.ventasDescartablePorCanal || []).forEach(v => {
        const s = v.seller_code || '';
        if      (s.startsWith('A')) descPrev.DOMICILIO += Number(v.dolares || 0);
        else if (s.startsWith('M')) descPrev.MAYORISTA += Number(v.dolares || 0);
        else if (s.startsWith('V')) descPrev.VIP       += Number(v.dolares || 0);
      });
      ['DOMICILIO', 'MAYORISTA', 'VIP'].forEach(c => {
        const prev = descPrev[c];
        resumenVentasPorCanal[c].mesAnterior   = Number(prev.toFixed(2));
        resumenVentasPorCanal[c].variacionAbs  = Number((resumenVentasPorCanal[c].monto - prev).toFixed(2));
        resumenVentasPorCanal[c].variacionPorc = prev > 0
          ? Number(((resumenVentasPorCanal[c].variacionAbs / prev) * 100).toFixed(2)) : null;
      });
    }

    if (comparativaMesAnterior && resumenActual.kpisGenerales) {
      resumenActual.kpisGenerales = {
        ...resumenActual.kpisGenerales,
        periodoAntUnidadesPorc: comparativaMesAnterior.unidades?.variacionPorcentaje ?? null,
        periodoAntMontoPorc   : comparativaMesAnterior.monto?.variacionPorcentaje    ?? null,
      };
    }

    // ── Filtrar top clientes por visibilidad (ruta/canal) ────────────────
    if (vis.restringe && !verTodoPreventa && !seccionesPreventa) {
      resumenActual.topClientes = (resumenActual.topClientes || [])
        .filter(c => vis.permite(c.preventa || c.ruta));
    }

    const { _raw, clientesDetalle, topClientes: _tc, ...publicResumen } = resumenActual;

    const productosVendidos   = await obtenerProductosVendidosMes(anioNum, mesNum);
    const preciosActual       = await obtenerPrecioPromedioPorPreventa(anioNum, mesNum);
    const preciosAnterior     = await obtenerPrecioPromedioMesAnterior(anioNum, mesNum);
    const precioPromedioTabla = procesarTablaPrecioPromedio(preciosActual, preciosAnterior, productosVendidos);

    const tendencia6Meses = await tendencia6MesesPreventa(anioNum, mesNum);

    const fechaInicioMesActualStr = getFechaInicioMes(anioNum, mesNum);
    const fechaFinMesActualStr    = await getFechaFinQuery(anioNum, mesNum);

    let mesAntO = mesNum - 1, anioAntO = anioNum;
    if (mesAntO === 0) { mesAntO = 12; anioAntO--; }
    const fechaInicioMesAntO = getFechaInicioMes(anioAntO, mesAntO);
    const fechaFinMesAntO    = getFechaFinMes(anioAntO, mesAntO);

    const [odooActual, odooAnterior] = await Promise.all([
      obtenerOdooDescartablePorCanal(fechaInicioMesActualStr, fechaFinMesActualStr),
      obtenerOdooDescartablePorCanal(fechaInicioMesAntO,      fechaFinMesAntO),
    ]);

    const hoyO          = new Date();
    const esMesActualO  = anioNum === hoyO.getFullYear() && mesNum === hoyO.getMonth() + 1;
    const diasTransO    = getDiasHabilesTranscurridos(anioNum, mesNum);
    const diasLabO      = getDiasLaborablesMes(anioNum, mesNum);

    const ventasDescartableOdoo = odooActual.map(curr => {
      const prev        = odooAnterior.find(p => p.canal === curr.canal);
      const montoAct    = Number(curr.total_imponible) || 0;
      const montoAnt    = prev ? Number(prev.total_imponible) || 0 : 0;
      const varAbs      = Number((montoAct - montoAnt).toFixed(2));
      const varPorc     = montoAnt > 0 ? Number(((varAbs / montoAnt) * 100).toFixed(2)) : null;
      const proyeccion  = esMesActualO && diasTransO > 0
        ? Number(((montoAct / diasTransO) * diasLabO).toFixed(2))
        : montoAct;
      return {
        ...curr,
        customer_codes: Array.isArray(curr.customer_codes) ? curr.customer_codes.filter(Boolean) : [],
        proyeccion,
        vsMesAnterior: { monto_anterior: montoAnt, variacion_abs: varAbs, variacion_porc: varPorc },
      };
    });

    // ── Recorte final por SECCIONES elegidas (módulo Preventa/Descartable) ──
    //    Se hace aquí, después de todos los cálculos, para no romper las
    //    correcciones de mes anterior (que asumen todos los canales presentes).
    if (seccionesPreventa) {
      // Descartable MobilVendor (keyed por seller_code)
      Object.keys(ventasDescartableConComparativa).forEach(k => {
        const sec = seccionDescartable(ventasDescartableConComparativa[k]?.seller_code || k);
        if (!sec || !seccionesPreventa.has(sec)) delete ventasDescartableConComparativa[k];
      });
      // Cards por canal (TIENDAS, RURAL, DOMICILIO, MAYORISTA, VIP)
      Object.keys(resumenVentasPorCanal).forEach(k => {
        if (!seccionesPreventa.has(k)) delete resumenVentasPorCanal[k];
      });
      // Descartable Odoo (por nombre de canal, best-effort; si no se mapea, se conserva)
      for (let i = ventasDescartableOdoo.length - 1; i >= 0; i--) {
        const c = String(ventasDescartableOdoo[i].canal || '').toUpperCase();
        const sec = c.includes('DOMICIL') ? 'DOMICILIO'
                  : c.includes('MAYOR')   ? 'MAYORISTA'
                  : (c.includes('VIP') || c.includes('MODERNO')) ? 'VIP' : null;
        if (sec && !seccionesPreventa.has(sec)) ventasDescartableOdoo.splice(i, 1);
      }
    }

    return res.status(200).json({
      ...publicResumen,
      comparativaMesAnterior,
      topClientes             : resumenActual.topClientes,
      precioPromedioTabla,
      ventasDescartablePorCanal: ventasDescartableConComparativa,
      ventasDescartableOdoo,
      resumenVentasPorCanal,
      tendencia6Meses,
    });

  } catch (error) {
    console.error("❌ ERROR EN DASHBOARD:", error);
    return res.status(500).json({ message: "Error al obtener los datos del dashboard" });
  }
};

module.exports = {
  obtenerDatosDashboard,
  obtenerDetalleRuta,
  // ── Funciones canónicas reutilizadas por el chatbot para que sus
  //    cifras coincidan EXACTAMENTE con las del dashboard ──
  calcularKPIsMes,
  calcularVentasDescartableConComparativa,
  agruparDescartablePorCanalResumen,
  obtenerTop20Clientes,
};
