// src/tools/ventasPorGrupo.js
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias, sumarDias } = require("../util/fechas");
const {
  CASE_GRUPO_ORDENES,
  FILTRO_ORDENES_GRUPO_VALIDO,
  CASE_GRUPO_FACTURAS,
  GRUPOS_VALIDOS,
  CATEGORIAS_VALIDAS,
  FILTRO_PREVENTA_SELLER,
  CATEGORIA_PREVENTA,
  FILTRO_CLIENTE_VALIDO,
  FILTRO_FACTURAS_NO_DUPLICADO,
} = require("../sql/clasificacion");

const MAX_RANGO_DIAS = 400;

const inputSchema = {
  grupo: z.enum(GRUPOS_VALIDOS),
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

// $1 = grupo, $2 = inicio (timestamp), $3 = fin exclusivo (timestamp),
// $4 = categoria (o NULL para no filtrar por categoría).
const SQL = `
  WITH base AS (
    SELECT
      ${CASE_GRUPO_ORDENES} AS grupo,
      o.seller_code AS ruta,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      dd.descripcion_categoria AS categoria
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND ${FILTRO_ORDENES_GRUPO_VALIDO}
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3

    UNION ALL

    SELECT
      ${CASE_GRUPO_FACTURAS} AS grupo,
      f.seller_code AS ruta,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      dd.descripcion_categoria AS categoria
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2
      AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND f.fecha_creacion >= $2
      AND f.fecha_creacion <  $3

    UNION ALL

    SELECT
      'DOMICILIO' AS grupo,
      o.seller_code AS ruta,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      dd.descripcion_categoria AS categoria
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
  )
  SELECT ruta, SUM(unidades) AS unidades, SUM(dolares) AS dolares
  FROM base
  WHERE grupo = $1
    AND ($4::text IS NULL OR categoria = $4)
  GROUP BY ruta
  ORDER BY dolares DESC;
`;

// ============================================================
// PREVENTA — ver clasificacion.js (FILTRO_PREVENTA_SELLER) para el porqué
// de cada pieza: status=5 (no 2), type=2, fecha_entrega (no fecha_creacion),
// sin rama de facturas ni de pedido web (calcularKPIsMes solo usa `ordenes`).
//
// A diferencia de los demás grupos, PREVENTA SIEMPRE necesita una categoría
// concreta (nunca "todas") — si no se especifica, se usa DESCARTABLE (la
// definición validada contra la guía de entrega), pero se puede pedir otra
// (ej. BOTELLÓN) para ver qué más venden esas rutas fuera del ranking
// oficial — eso ya no es el KPI validado, es una consulta exploratoria más.
// $1 = inicio (timestamp), $2 = fin exclusivo (timestamp), $3 = categoria.
// ============================================================
const SQL_PREVENTA = `
  SELECT
    o.seller_code AS ruta,
    SUM(dd.cantidad) AS unidades,
    SUM(dd.total)    AS dolares
  FROM ordenes o
  JOIN detalle_documento dd ON dd.documento_code = o.code
  WHERE o.type = 2
    AND o.status = 5
    AND ${FILTRO_PREVENTA_SELLER("$3")}
    AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
    AND dd.descripcion_categoria = $3
    AND o.fecha_entrega >= $1
    AND o.fecha_entrega <  $2
  GROUP BY o.seller_code
  ORDER BY dolares DESC;
`;

async function totalesGrupo(grupo, inicioTs, finTs, categoria) {
  const { rows } = await pool.query(SQL, [grupo, inicioTs, finTs, categoria ?? null]);
  return sumarFilas(rows);
}

async function totalesPreventa(inicioTs, finTs, categoria) {
  const categoriaEfectiva = categoria || CATEGORIA_PREVENTA;
  const { rows } = await pool.query(SQL_PREVENTA, [inicioTs, finTs, categoriaEfectiva]);
  return sumarFilas(rows);
}

function sumarFilas(rows) {
  const totales = rows.reduce(
    (acc, r) => {
      acc.unidades += Number(r.unidades) || 0;
      acc.dolares += Number(r.dolares) || 0;
      return acc;
    },
    { unidades: 0, dolares: 0 }
  );
  return { rows, totales };
}

async function ventasPorGrupo({ grupo, categoria, fecha_inicio, fecha_fin }) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
  const finAntStr = fecha_inicio;
  const inicioAntStr = sumarDias(fecha_inicio, -(largoDias + 1));
  const inicioAntTs = `${inicioAntStr} 00:00:00`;
  const finAntTs = `${finAntStr} 00:00:00`;

  const esPreventa = grupo === "PREVENTA";
  const actual = esPreventa
    ? await totalesPreventa(inicioTs, finTs, categoria)
    : await totalesGrupo(grupo, inicioTs, finTs, categoria);
  const anterior = esPreventa
    ? await totalesPreventa(inicioAntTs, finAntTs, categoria)
    : await totalesGrupo(grupo, inicioAntTs, finAntTs, categoria);

  const variacionAbs = actual.totales.dolares - anterior.totales.dolares;
  const variacionPct =
    anterior.totales.dolares > 0 ? (variacionAbs / anterior.totales.dolares) * 100 : null;

  return {
    grupo,
    categoria: esPreventa ? categoria || CATEGORIA_PREVENTA : categoria || null,
    unidades_totales: actual.totales.unidades,
    dolares_totales: Number(actual.totales.dolares.toFixed(2)),
    por_ruta: actual.rows.map((r) => ({
      // seller_code puede venir vacío (ej. VIP se clasifica por
      // codigo_tipo_negocio, no por seller_code).
      ruta: r.ruta || "SIN_RUTA_ASIGNADA",
      unidades: Number(r.unidades) || 0,
      dolares: Number(r.dolares) || 0,
    })),
    vs_periodo_anterior: {
      dolares: Number(anterior.totales.dolares.toFixed(2)),
      variacion_pct: variacionPct !== null ? Number(variacionPct.toFixed(2)) : null,
    },
  };
}

module.exports = { ventasPorGrupo, inputSchema, totalesGrupo, totalesPreventa };
