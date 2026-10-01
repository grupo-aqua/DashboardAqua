// src/tools/clientesPorGrupo.js
// Listado de CLIENTES (no rutas, no productos) que compraron dentro de un
// grupo/categoría en un rango de fechas — para preguntas tipo "dame los
// clientes de MAYORISTA que compraron BOTELLÓN estos 3 meses" o, con
// `por_mes:true`, "clientes que compraron en julio pero no en agosto"
// (se responde filtrando el desglose mensual: julio>0 y agosto=0/ausente).
//
// Mismo patrón de 3 ramas (ordenes MobilVendor + facturas Odoo + pedido web)
// que topProductos/ventasPorGrupo, agrupado por cliente en vez de por
// producto/ruta. PREVENTA usa su propia rama validada (status=5,
// fecha_entrega, filtro condicional de guía) — ver clasificacion.js.
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
const LIMITE_DEFAULT = 300;
const LIMITE_MAX = 1000;

const inputSchema = {
  grupo: z.enum(GRUPOS_VALIDOS),
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  por_mes: z.boolean().optional(),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
};

// Base común (3 ramas) reutilizada por ambas variantes de agregación de
// abajo — sin LIMIT ni ORDER BY acá: el recorte a `limite` CLIENTES (no
// filas) y el orden final por dólares se hacen en JS, después de agrupar.
// $1=inicio, $2=fin, $3=grupo, $4=categoria (o NULL)
const BASE_GRUPO = `
  WITH base AS (
    SELECT
      ${CASE_GRUPO_ORDENES} AS grupo,
      o.customer_code AS codigo_cliente,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      dd.descripcion_categoria AS categoria,
      o.code      AS doc_code,
      date_trunc('month', o.fecha_creacion)::date AS mes
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
      f.customer_code AS codigo_cliente,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      dd.descripcion_categoria AS categoria,
      f.code AS doc_code,
      date_trunc('month', f.fecha_creacion)::date AS mes
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
      o.customer_code AS codigo_cliente,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      dd.descripcion_categoria AS categoria,
      o.code      AS doc_code,
      date_trunc('month', o.fecha_creacion)::date AS mes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $1
      AND o.fecha_creacion <  $2
  ),
  filtrado AS (
    SELECT b.*, COALESCE(c.nombre_comercial_cliente, c.nombre_cliente) AS nombre
    FROM base b
    LEFT JOIN clientes c ON c.codigo_cliente = b.codigo_cliente
    WHERE b.grupo = $3
      AND ($4::text IS NULL OR b.categoria = $4)
  )
`;

// Sin desglose mensual: una fila por cliente, mes siempre NULL.
const SQL_GRUPO_SIMPLE = `
  ${BASE_GRUPO}
  SELECT codigo_cliente, nombre, NULL::date AS mes,
    SUM(unidades) AS unidades, SUM(dolares) AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM filtrado
  GROUP BY codigo_cliente, nombre;
`;

// Con desglose mensual: GROUPING SETS da, en una sola consulta, el total del
// cliente en todo el rango (mes IS NULL) Y su desglose mes a mes.
const SQL_GRUPO_POR_MES = `
  ${BASE_GRUPO}
  SELECT codigo_cliente, nombre, mes,
    SUM(unidades) AS unidades, SUM(dolares) AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM filtrado
  GROUP BY GROUPING SETS ((codigo_cliente, nombre), (codigo_cliente, nombre, mes));
`;

// PREVENTA: mismo filtro validado que ventasPorGrupo/topProductos (ver
// clasificacion.js), por fecha_entrega. `categoria` siempre resuelta (default
// DESCARTABLE si no se especifica — ver clientesPorGrupo() más abajo).
// $1=inicio, $2=fin, $3=categoria
const BASE_PREVENTA = `
  WITH base AS (
    SELECT
      o.customer_code AS codigo_cliente,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code,
      date_trunc('month', o.fecha_entrega)::date AS mes
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.type = 2
      AND o.status = 5
      AND ${FILTRO_PREVENTA_SELLER("$3")}
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND dd.descripcion_categoria = $3
      AND o.fecha_entrega >= $1
      AND o.fecha_entrega <  $2
  ),
  filtrado AS (
    SELECT b.*, COALESCE(c.nombre_comercial_cliente, c.nombre_cliente) AS nombre
    FROM base b
    LEFT JOIN clientes c ON c.codigo_cliente = b.codigo_cliente
  )
`;

const SQL_PREVENTA_SIMPLE = `
  ${BASE_PREVENTA}
  SELECT codigo_cliente, nombre, NULL::date AS mes,
    SUM(unidades) AS unidades, SUM(dolares) AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM filtrado
  GROUP BY codigo_cliente, nombre;
`;

const SQL_PREVENTA_POR_MES = `
  ${BASE_PREVENTA}
  SELECT codigo_cliente, nombre, mes,
    SUM(unidades) AS unidades, SUM(dolares) AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM filtrado
  GROUP BY GROUPING SETS ((codigo_cliente, nombre), (codigo_cliente, nombre, mes));
`;

// Arma { cliente, unidades, dolares, num_documentos, por_mes? } por cliente
// a partir de las filas (mes NULL = total, mes NOT NULL = detalle mensual).
function agruparPorCliente(rows, porMes) {
  const clientes = new Map();
  for (const r of rows) {
    const key = r.codigo_cliente;
    if (!clientes.has(key)) {
      clientes.set(key, {
        codigo_cliente: key,
        nombre: r.nombre || null,
        unidades: 0,
        dolares: 0,
        num_documentos: 0,
        por_mes: [],
      });
    }
    const c = clientes.get(key);
    const unidades = Number(r.unidades) || 0;
    const dolares = Number(r.dolares) || 0;
    const num_documentos = Number(r.num_documentos) || 0;

    if (r.mes == null) {
      c.unidades = unidades;
      c.dolares = dolares;
      c.num_documentos = num_documentos;
    } else {
      c.por_mes.push({
        mes: r.mes.toISOString().slice(0, 7),
        unidades,
        dolares,
        num_documentos,
      });
    }
  }
  const out = [...clientes.values()];
  if (porMes) out.forEach((c) => c.por_mes.sort((a, b) => a.mes.localeCompare(b.mes)));
  else out.forEach((c) => delete c.por_mes);
  return out.sort((a, b) => b.dolares - a.dolares);
}

async function clientesPorGrupo({ grupo, categoria, fecha_inicio, fecha_fin, por_mes, limite }) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
  const porMesEfectivo = !!por_mes;
  const limiteReal = limite ?? LIMITE_DEFAULT;

  let rows;
  if (grupo === "PREVENTA") {
    const categoriaEfectiva = categoria || CATEGORIA_PREVENTA;
    const sql = porMesEfectivo ? SQL_PREVENTA_POR_MES : SQL_PREVENTA_SIMPLE;
    ({ rows } = await pool.query(sql, [inicioTs, finTs, categoriaEfectiva]));
  } else {
    const sql = porMesEfectivo ? SQL_GRUPO_POR_MES : SQL_GRUPO_SIMPLE;
    ({ rows } = await pool.query(sql, [inicioTs, finTs, grupo, categoria ?? null]));
  }

  const todos = agruparPorCliente(rows, porMesEfectivo);
  const clientes = todos.slice(0, limiteReal);

  return {
    grupo,
    categoria: grupo === "PREVENTA" ? categoria || CATEGORIA_PREVENTA : categoria || null,
    fecha_inicio,
    fecha_fin,
    por_mes: porMesEfectivo,
    total_clientes: todos.length,
    clientes_devueltos: clientes.length,
    clientes,
  };
}

module.exports = { clientesPorGrupo, inputSchema };
