// src/tools/resumenDiario.js
const { z } = require("zod");
const { pool } = require("../db");
const { esFechaValida, sumarDias } = require("../util/fechas");
const {
  CASE_GRUPO_ORDENES,
  FILTRO_ORDENES_GRUPO_VALIDO,
  CASE_GRUPO_FACTURAS,
  GRUPOS_VALIDOS,
  FILTRO_CLIENTE_VALIDO,
  FILTRO_FACTURAS_NO_DUPLICADO,
} = require("../sql/clasificacion");

const TOP_RUTAS_LIMITE = 10;
// Baseline del chequeo de hueco de sync: mismo día de la semana, 4 semanas atrás.
const SEMANAS_BASELINE = 4;
// Si el conteo de documentos del día cae por debajo de este % del promedio
// baseline, se marca posible_hueco_sync = true (no se afirma una caída real).
const UMBRAL_HUECO_SYNC = 0.5;

const inputSchema = {
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

const SQL_DIA = `
  WITH base AS (
    SELECT
      ${CASE_GRUPO_ORDENES} AS grupo,
      o.seller_code AS ruta,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND ${FILTRO_ORDENES_GRUPO_VALIDO}
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2

    UNION ALL

    SELECT
      ${CASE_GRUPO_FACTURAS} AS grupo,
      f.seller_code AS ruta,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      f.code AS doc_code
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
      AND f.fecha_creacion >= $1
      AND f.fecha_creacion <  $2

    UNION ALL

    SELECT
      'DOMICILIO' AS grupo,
      o.seller_code AS ruta,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2
  )
  SELECT grupo, ruta, unidades, dolares, doc_code
  FROM base
  WHERE grupo = ANY($3::text[]);
`;

const SQL_NUM_DOCUMENTOS = `
  WITH base AS (
    SELECT ${CASE_GRUPO_ORDENES} AS grupo, o.code AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND ${FILTRO_ORDENES_GRUPO_VALIDO}
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2

    UNION ALL

    SELECT ${CASE_GRUPO_FACTURAS} AS grupo, f.code AS doc_code
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
      AND f.fecha_creacion >= $1
      AND f.fecha_creacion <  $2

    UNION ALL

    SELECT 'DOMICILIO' AS grupo, o.code AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2
  )
  SELECT COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  WHERE grupo = ANY($3::text[]);
`;

async function numDocumentosEnRango(inicioTs, finTs) {
  const { rows } = await pool.query(SQL_NUM_DOCUMENTOS, [inicioTs, finTs, GRUPOS_VALIDOS]);
  return Number(rows[0]?.num_documentos) || 0;
}

async function resumenDiario({ fecha }) {
  if (!esFechaValida(fecha)) throw new Error("fecha inválida");

  const inicioTs = `${fecha} 00:00:00`;
  const finTs = `${sumarDias(fecha, 1)} 00:00:00`;

  const { rows } = await pool.query(SQL_DIA, [inicioTs, finTs, GRUPOS_VALIDOS]);

  const porGrupoMap = new Map();
  const porRutaMap = new Map();
  const docCodes = new Set();
  let dolaresTotales = 0;
  let unidadesTotales = 0;

  for (const r of rows) {
    const dolares = Number(r.dolares) || 0;
    const unidades = Number(r.unidades) || 0;
    dolaresTotales += dolares;
    unidadesTotales += unidades;
    docCodes.add(r.doc_code);

    // seller_code puede venir vacío (ej. VIP se clasifica por
    // codigo_tipo_negocio, no por seller_code).
    const ruta = r.ruta || "SIN_RUTA_ASIGNADA";
    porGrupoMap.set(r.grupo, (porGrupoMap.get(r.grupo) || 0) + dolares);
    porRutaMap.set(ruta, (porRutaMap.get(ruta) || 0) + dolares);
  }

  const porGrupo = [...porGrupoMap.entries()]
    .map(([grupo, dolares]) => ({ grupo, dolares: Number(dolares.toFixed(2)) }))
    .sort((a, b) => b.dolares - a.dolares);

  const topRutas = [...porRutaMap.entries()]
    .map(([ruta, dolares]) => ({ ruta, dolares: Number(dolares.toFixed(2)) }))
    .sort((a, b) => b.dolares - a.dolares)
    .slice(0, TOP_RUTAS_LIMITE);

  const numDocumentos = docCodes.size;

  // Chequeo de calidad de datos: comparar contra el mismo día de la semana
  // en las SEMANAS_BASELINE semanas anteriores, para no confundir un hueco
  // de sync con una caída real de ventas.
  const fechasBaseline = Array.from({ length: SEMANAS_BASELINE }, (_, i) => sumarDias(fecha, -7 * (i + 1)));
  const conteosBaseline = await Promise.all(
    fechasBaseline.map((f) => numDocumentosEnRango(`${f} 00:00:00`, `${sumarDias(f, 1)} 00:00:00`))
  );
  const promedioBaseline =
    conteosBaseline.length > 0 ? conteosBaseline.reduce((a, b) => a + b, 0) / conteosBaseline.length : 0;
  const posibleHuecoSync = promedioBaseline > 0 && numDocumentos < promedioBaseline * UMBRAL_HUECO_SYNC;

  return {
    fecha,
    dolares_totales: Number(dolaresTotales.toFixed(2)),
    unidades_totales: unidadesTotales,
    por_grupo: porGrupo,
    top_rutas: topRutas,
    num_documentos: numDocumentos,
    posible_hueco_sync: posibleHuecoSync,
  };
}

module.exports = { resumenDiario, inputSchema };
