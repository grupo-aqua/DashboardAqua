// src/tools/topProductos.js
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias } = require("../util/fechas");
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
const LIMITE_DEFAULT = 10;
const LIMITE_MAX = 50;

const inputSchema = {
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
  grupo: z.enum(GRUPOS_VALIDOS).optional(),
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
};

// Sin `grupo`: ranking general, sin restricción de canal (comportamiento
// original de esta tool) — `categoria` opcional se suma como filtro extra.
// Misma estructura de 3 ramas que ventasPorRuta/ventasPorGrupo — confirmado
// contra datos reales: los pedidos "Website" quedan en `ordenes` con
// origen_sistema='ODOO' (no 'MOBILVENDOR') y seller_code vacío, por eso
// necesitan su propia rama en vez de calzar en la rama MOBILVENDOR.
// $1=inicio, $2=fin, $3=limite, $4=categoria (o NULL)
const SQL_GENERAL = `
  WITH base AS (
    SELECT
      dd.codigo_producto AS codigo,
      dd.descripcion      AS descripcion,
      dd.cantidad         AS unidades,
      dd.total            AS dolares,
      dd.descripcion_categoria AS categoria
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2

    UNION ALL

    SELECT
      dd.codigo_producto AS codigo,
      dd.descripcion      AS descripcion,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      dd.descripcion_categoria AS categoria
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
      AND f.fecha_creacion >= $1
      AND f.fecha_creacion <  $2

    UNION ALL

    SELECT
      dd.codigo_producto AS codigo,
      dd.descripcion      AS descripcion,
      dd.cantidad         AS unidades,
      dd.total            AS dolares,
      dd.descripcion_categoria AS categoria
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2
  )
  SELECT
    b.codigo,
    COALESCE(p.nombre_producto, MIN(b.descripcion)) AS descripcion,
    SUM(b.unidades) AS unidades,
    SUM(b.dolares)  AS dolares
  FROM base b
  LEFT JOIN productos p ON p.codigo_producto = b.codigo
  WHERE ($4::text IS NULL OR b.categoria = $4)
  GROUP BY b.codigo, p.nombre_producto
  ORDER BY dolares DESC
  LIMIT $3;
`;

// `grupo` es uno de los 8 canales estilo botellón (no PREVENTA, ver abajo).
// $1=inicio, $2=fin, $3=limite, $4=grupo, $5=categoria (o NULL)
const SQL_GRUPO = `
  WITH base AS (
    SELECT
      ${CASE_GRUPO_ORDENES} AS grupo,
      dd.codigo_producto AS codigo,
      dd.descripcion      AS descripcion,
      dd.cantidad         AS unidades,
      dd.total            AS dolares,
      dd.descripcion_categoria AS categoria
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
      dd.codigo_producto AS codigo,
      dd.descripcion      AS descripcion,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      dd.descripcion_categoria AS categoria
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
      dd.codigo_producto AS codigo,
      dd.descripcion      AS descripcion,
      dd.cantidad         AS unidades,
      dd.total            AS dolares,
      dd.descripcion_categoria AS categoria
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2
  )
  SELECT
    b.codigo,
    COALESCE(p.nombre_producto, MIN(b.descripcion)) AS descripcion,
    SUM(b.unidades) AS unidades,
    SUM(b.dolares)  AS dolares
  FROM base b
  LEFT JOIN productos p ON p.codigo_producto = b.codigo
  WHERE b.grupo = $4
    AND ($5::text IS NULL OR b.categoria = $5)
  GROUP BY b.codigo, p.nombre_producto
  ORDER BY dolares DESC
  LIMIT $3;
`;

// PREVENTA: mismo filtro validado que ventasPorGrupo (ver clasificacion.js),
// por fecha_entrega. `categoria` siempre viene resuelta (default DESCARTABLE
// si el caller no la especificó — ver topProductos()), nunca NULL acá.
// $1=inicio, $2=fin, $3=limite, $4=categoria
const SQL_PREVENTA = `
  SELECT
    dd.codigo_producto AS codigo,
    COALESCE(p.nombre_producto, MIN(dd.descripcion)) AS descripcion,
    SUM(dd.cantidad) AS unidades,
    SUM(dd.total)    AS dolares
  FROM ordenes o
  JOIN detalle_documento dd ON dd.documento_code = o.code
  LEFT JOIN productos p ON p.codigo_producto = dd.codigo_producto
  WHERE o.type = 2
    AND o.status = 5
    AND ${FILTRO_PREVENTA_SELLER("$4")}
    AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
    AND dd.descripcion_categoria = $4
    AND o.fecha_entrega >= $1
    AND o.fecha_entrega <  $2
  GROUP BY dd.codigo_producto, p.nombre_producto
  ORDER BY dolares DESC
  LIMIT $3;
`;

async function topProductos({ fecha_inicio, fecha_fin, limite, grupo, categoria }) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const limiteReal = limite ?? LIMITE_DEFAULT;
  let rows;

  if (grupo === "PREVENTA") {
    // Sin categoría explícita, PREVENTA muestra su categoría validada
    // (DESCARTABLE) por default — pero se puede pedir otra (ej. BOTELLÓN)
    // para ver qué más venden esas rutas fuera del ranking oficial.
    const inicioTs = `${fecha_inicio} 00:00:00`;
    const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
    const categoriaEfectiva = categoria || CATEGORIA_PREVENTA;
    ({ rows } = await pool.query(SQL_PREVENTA, [inicioTs, finTs, limiteReal, categoriaEfectiva]));
  } else if (grupo) {
    const inicioTs = `${fecha_inicio} 00:00:00`;
    const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
    ({ rows } = await pool.query(SQL_GRUPO, [inicioTs, finTs, limiteReal, grupo, categoria ?? null]));
  } else {
    const inicioTs = `${fecha_inicio} 00:00:00`;
    const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
    ({ rows } = await pool.query(SQL_GENERAL, [inicioTs, finTs, limiteReal, categoria ?? null]));
  }

  return {
    grupo: grupo || null,
    categoria: grupo === "PREVENTA" ? categoria || CATEGORIA_PREVENTA : categoria || null,
    productos: rows.map((r) => ({
      codigo: r.codigo,
      descripcion: r.descripcion,
      unidades: Number(r.unidades) || 0,
      dolares: Number(r.dolares) || 0,
    })),
  };
}

module.exports = { topProductos, inputSchema };
