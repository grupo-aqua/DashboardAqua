// src/tools/ventasPorRuta.js
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias } = require("../util/fechas");
const { FILTRO_PREVENTA_SELLER, FILTRO_FACTURAS_NO_DUPLICADO } = require("../sql/clasificacion");

// Espacio incluido a propósito: hay códigos de ruta reales con espacio
// ("TELEVENTA 1", "PREVENTA VIP 1", "RUTA 113", "POS RUTA 131" — estas
// últimas de COTTSA, company_id=3) que esta regex rechazaba antes,
// devolviendo "código de ruta inválido" para rutas que sí existen.
const RUTA_RE = /^[A-Za-z0-9._ -]{1,20}$/;
const MAX_RANGO_DIAS = 400;
const MAX_RUTAS = 50;

// Mismo patrón que FILTRO_PREVENTA_SELLER (o.seller_code ILIKE 'PV%'/'PREVENTA%'/
// 'TELEVENTA%') pero evaluado del lado de JS sobre el valor exacto de cada ruta,
// para decidir qué SQL correr — ver hallazgo en TODO.md ("ventasPorRuta —
// brecha real para rutas de preventa"): antes de este fix, pedir una ruta
// PVR*/PV1-14/PVM/PVQ1/TELEVENTA* daba $0 en silencio (usaba status=2, pero
// las órdenes de PREVENTA reales están en status=5).
const RUTA_PREVENTA_RE = /^(PV|PREVENTA|TELEVENTA)/i;

// `ruta` acepta una sola ruta (string, retrocompatible) o un subconjunto
// (array) — mismo patrón ya usado para `codigo_cliente` en ventasCliente.
const RUTA_SCHEMA = z.string().regex(RUTA_RE, "código de ruta inválido");
const inputSchema = {
  ruta: z.union([RUTA_SCHEMA, z.array(RUTA_SCHEMA).min(1).max(MAX_RUTAS)]),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

// GROUPING SETS ((ruta_val, categoria), (categoria), (ruta_val), ()) en una
// sola consulta da, de una vez: el detalle por ruta+categoría (no se expone,
// pero alimenta el resto), el desglose por categoría agregado entre todas
// las rutas pedidas (categoria IS NOT NULL, ruta_val IS NULL), el desglose
// por ruta agregado entre todas las categorías (ruta_val IS NOT NULL,
// categoria IS NULL) y el total general (ambos NULL) — sin repetir el join
// cuatro veces.
const SQL = `
  WITH base AS (
    SELECT
      o.seller_code AS ruta_val,
      dd.descripcion_categoria AS categoria,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND o.seller_code = ANY($1::text[])
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3

    UNION ALL

    SELECT
      f.seller_code AS ruta_val,
      dd.descripcion_categoria AS categoria,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      f.code AS doc_code
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND f.seller_code = ANY($1::text[])
      AND f.fecha_creacion >= $2
      AND f.fecha_creacion <  $3

    UNION ALL

    -- Pedido web: solo aporta si el pedido web quedó con seller_code = alguna
    -- de las rutas consultadas (normalmente aplica a rutas DOMICILIO).
    SELECT
      o.seller_code AS ruta_val,
      dd.descripcion_categoria AS categoria,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND o.seller_code = ANY($1::text[])
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
  )
  SELECT
    ruta_val,
    categoria,
    SUM(unidades) AS unidades,
    SUM(dolares)  AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  GROUP BY GROUPING SETS ((ruta_val, categoria), (categoria), (ruta_val), ());
`;

// PREVENTA (PV*/PREVENTA*/TELEVENTA*): NO usa `status=2`/`fecha_creacion` como
// el resto de rutas — usa `type=2, status=5, fecha_entrega` (no fecha_creacion)
// y el filtro condicional por categoría de guía (waybill_code para
// DESCARTABLE, waybill_status='3' para el resto), MISMA lógica ya validada
// contra Excel real en ventasPorGrupo/topProductos (ver clasificacion.js).
// Solo `ordenes` — sin rama de facturas ni de pedido web, igual que
// SQL_PREVENTA en ventasPorGrupo.js (PREVENTA nunca pasa por esas ramas).
const SQL_PREVENTA = `
  WITH base AS (
    SELECT
      o.seller_code AS ruta_val,
      dd.descripcion_categoria AS categoria,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.type = 2
      AND o.status = 5
      AND o.seller_code = ANY($1::text[])
      AND ${FILTRO_PREVENTA_SELLER("dd.descripcion_categoria")}
      AND o.fecha_entrega >= $2
      AND o.fecha_entrega <  $3
  )
  SELECT
    ruta_val,
    categoria,
    SUM(unidades) AS unidades,
    SUM(dolares)  AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  GROUP BY GROUPING SETS ((ruta_val, categoria), (categoria), (ruta_val), ());
`;

// Combina las filas GROUPING SETS de una consulta en { totales, por_categoria, por_ruta }.
function desagregar(rows) {
  const totales = { unidades: 0, dolares: 0, num_documentos: 0 };
  const por_categoria = [];
  const por_ruta = [];

  for (const r of rows) {
    const unidades = Number(r.unidades) || 0;
    const dolares = Number(r.dolares) || 0;
    const num_documentos = Number(r.num_documentos) || 0;

    if (r.ruta_val == null && r.categoria == null) {
      totales.unidades = unidades;
      totales.dolares = dolares;
      totales.num_documentos = num_documentos;
    } else if (r.ruta_val == null) {
      por_categoria.push({ categoria: r.categoria || "SIN_CATEGORIA", unidades, dolares });
    } else if (r.categoria == null) {
      por_ruta.push({ ruta: r.ruta_val, unidades, dolares, num_documentos });
    }
    // filas (ruta_val, categoria) ambas no-null: detalle interno, no se expone.
  }

  por_categoria.sort((a, b) => b.dolares - a.dolares);
  por_ruta.sort((a, b) => b.dolares - a.dolares);
  return { totales, por_categoria, por_ruta };
}

function sumarDesagregados(a, b) {
  const totales = {
    unidades: a.totales.unidades + b.totales.unidades,
    dolares: a.totales.dolares + b.totales.dolares,
    num_documentos: a.totales.num_documentos + b.totales.num_documentos,
  };

  const porCategoriaMap = new Map();
  for (const c of [...a.por_categoria, ...b.por_categoria]) {
    const acc = porCategoriaMap.get(c.categoria) || { categoria: c.categoria, unidades: 0, dolares: 0 };
    acc.unidades += c.unidades;
    acc.dolares += c.dolares;
    porCategoriaMap.set(c.categoria, acc);
  }

  const por_categoria = [...porCategoriaMap.values()].sort((x, y) => y.dolares - x.dolares);
  const por_ruta = [...a.por_ruta, ...b.por_ruta].sort((x, y) => y.dolares - x.dolares);

  return { totales, por_categoria, por_ruta };
}

async function ventasPorRuta({ ruta, fecha_inicio, fecha_fin }) {
  if (diffDias(fecha_inicio, fecha_fin) < 0) {
    throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  }
  if (diffDias(fecha_inicio, fecha_fin) > MAX_RANGO_DIAS) {
    throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);
  }

  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;

  const rutasSolicitadas = Array.isArray(ruta) ? ruta : [ruta];
  const rutasPreventa = rutasSolicitadas.filter((r) => RUTA_PREVENTA_RE.test(r));
  const rutasNormales = rutasSolicitadas.filter((r) => !RUTA_PREVENTA_RE.test(r));

  const vacio = { totales: { unidades: 0, dolares: 0, num_documentos: 0 }, por_categoria: [], por_ruta: [] };

  const [resultNormal, resultPreventa] = await Promise.all([
    rutasNormales.length
      ? pool.query(SQL, [rutasNormales, inicioTs, finTs]).then((r) => desagregar(r.rows))
      : Promise.resolve(vacio),
    rutasPreventa.length
      ? pool.query(SQL_PREVENTA, [rutasPreventa, inicioTs, finTs]).then((r) => desagregar(r.rows))
      : Promise.resolve(vacio),
  ]);

  const { totales, por_categoria, por_ruta } = sumarDesagregados(resultNormal, resultPreventa);

  const base = {
    unidades_totales: totales.unidades,
    dolares_totales: totales.dolares,
    num_documentos: totales.num_documentos,
    por_categoria,
  };

  // Retrocompatible: si se pidió una sola ruta (string), se mantiene el campo
  // `ruta` singular y no se agrega `por_ruta` (redundante con un solo elemento).
  if (!Array.isArray(ruta)) {
    return { ruta, ...base };
  }
  return { rutas: rutasSolicitadas, ...base, por_ruta };
}

module.exports = { ventasPorRuta, inputSchema };
