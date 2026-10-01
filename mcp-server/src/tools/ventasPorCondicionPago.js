// src/tools/ventasPorCondicionPago.js
// Ventas de un grupo de canal desglosadas por condición de pago
// (CONTADO/CREDITO) — ver clasificacion.js (CONDICION_PAGO_FACTURA/
// CONDICION_PAGO_CLIENTE) para la investigación completa de por qué existen
// 2 señales y cómo se combinan.
//
// Motivo: la vieja asunción "contado=MobilVendor / crédito=Odoo" (usar
// origen_sistema como proxy) es INCORRECTA como regla general — Alberto
// confirmó clientes VIP e HIELO en MobilVendor que son de crédito. Esta
// tool usa la condición de pago REAL del documento/cliente, nunca el
// origen_sistema.
//
// Enfoque híbrido (decisión de Alberto, 2026-09-16): `facturas` usa la
// señal TRANSACCIONAL (fecha_vencimiento - fecha_creacion, propia de cada
// documento); `ordenes` — incluido PREVENTA, que nunca genera factura
// propia — usa `clientes.metodo_pago_cliente` como fallback. Excluir
// PREVENTA hubiera repetido el mismo punto ciego ya corregido con LIQ y el
// universo de status: cobertura completa, no solo lo más simple de
// construir.
//
// Cada fila de salida trae `fuente_condicion` ('TRANSACCIONAL',
// 'METODO_PAGO_CLIENTE' o 'NOTA_CREDITO') para poder rastrear si un patrón
// raro viene del fallback, de una nota de crédito o de la señal
// transaccional, sin rehacer la investigación. 'NOTA_CREDITO' (agregado
// 2026-09-16, reportado por el usuario tras verificar la tool en vivo)
// usa el MISMO fallback de cliente que 'METODO_PAGO_CLIENTE' (la
// clasificación CONTADO/CREDITO no cambia) pero se etiqueta distinto porque
// son documentos de `facturas` (out_refund), no `ordenes` — un renglón
// CREDITO/METODO_PAGO_CLIENTE con dólares negativos en un canal que
// factura por `facturas` (ej. VIP) era ilegible sin conocer que
// "METODO_PAGO_CLIENTE" era el fallback también para notas de crédito con
// fecha_vencimiento no confiable, no solo para órdenes.
//
// ============================================================
// Fallback de Odoo para SIN_DATO (Bug 2, pedido explícito del usuario,
// 2026-09-29) — ver odooCondicionPagoFallback.js para la investigación
// completa (por qué existe el SIN_DATO de DOMICILIO, qué % se resuelve).
// ============================================================
// Después de calcular SIN_DATO normalmente (como siempre), se intenta EN
// VIVO resolver esos clientes específicos cruzando su RUC contra Odoo
// (res.partner.property_payment_term_id, con fallback a la factura más
// reciente vía account.move.invoice_payment_term_id). Los que se resuelven
// se mueven de SIN_DATO a CONTADO/CREDITO con `fuente_condicion` =
// 'ODOO_FALLBACK' (nueva, para poder distinguir siempre de dónde salió
// cada dólar — mismo principio de trazabilidad que ya usan TRANSACCIONAL/
// METODO_PAGO_CLIENTE/NOTA_CREDITO). SOLO LECTURA: nunca escribe nada, ni
// en Postgres ni en Odoo — el fallback se aplica solo en la respuesta de
// esta consulta puntual. Si Odoo no responde, se degrada con gracia (ver
// comentario grande de odooCondicionPagoFallback.js) — nunca rompe una
// respuesta que ya era válida sin el fallback.
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias } = require("../util/fechas");
const { resolverCondicionPagoOdoo } = require("../integrations/odooCondicionPagoFallback");
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
  CONDICION_PAGO_CLIENTE,
  FUENTE_CONDICION_PAGO_CLIENTE,
  CONDICION_PAGO_FACTURA,
  FUENTE_CONDICION_PAGO_FACTURA,
} = require("../sql/clasificacion");

const MAX_RANGO_DIAS = 400;

const inputSchema = {
  grupo: z.enum(GRUPOS_VALIDOS),
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

// $1 = grupo, $2 = inicio (timestamp), $3 = fin exclusivo (timestamp),
// $4 = categoria (o NULL para no filtrar por categoría). LEFT JOIN clientes
// (nunca INNER) — no hay FK que garantice que todo customer_code tenga fila
// en clientes; con INNER JOIN un cliente faltante haría desaparecer el
// documento de la suma en vez de degradar a SIN_DATO.
const SQL = `
  WITH base AS (
    SELECT
      ${CONDICION_PAGO_CLIENTE("c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_CLIENTE} AS fuente_condicion,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND ${FILTRO_ORDENES_GRUPO_VALIDO}
      AND (${CASE_GRUPO_ORDENES}) = $1
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      ${CONDICION_PAGO_FACTURA("f", "c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_FACTURA("f")} AS fuente_condicion,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      f.code AS doc_code
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    LEFT JOIN clientes c ON c.codigo_cliente = f.customer_code
    WHERE f.status = 2
      AND (${CASE_GRUPO_FACTURAS}) = $1
      AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND f.fecha_creacion >= $2
      AND f.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      ${CONDICION_PAGO_CLIENTE("c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_CLIENTE} AS fuente_condicion,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND $1 = 'DOMICILIO'
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)
  )
  SELECT
    condicion_pago,
    fuente_condicion,
    SUM(unidades) AS unidades,
    SUM(dolares)  AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  GROUP BY GROUPING SETS ((condicion_pago, fuente_condicion), (condicion_pago), ());
`;

// PREVENTA — misma ventana status=5/fecha_entrega/FILTRO_PREVENTA_SELLER ya
// validada contra Excel real en ventasPorGrupo.js (no se toca ese criterio
// acá, esta tool solo agrega la dimensión de condición de pago encima). Solo
// `ordenes` (PREVENTA nunca genera facturas propias) — condición SIEMPRE por
// fallback de cliente, no hay fecha_vencimiento en `ordenes`.
// $1 = inicio (timestamp), $2 = fin exclusivo (timestamp), $3 = categoria.
const SQL_PREVENTA = `
  SELECT
    ${CONDICION_PAGO_CLIENTE("c")} AS condicion_pago,
    ${FUENTE_CONDICION_PAGO_CLIENTE} AS fuente_condicion,
    SUM(dd.cantidad) AS unidades,
    SUM(dd.total)    AS dolares,
    COUNT(DISTINCT o.code) AS num_documentos
  FROM ordenes o
  JOIN detalle_documento dd ON dd.documento_code = o.code
  LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
  WHERE o.type = 2
    AND o.status = 5
    AND ${FILTRO_PREVENTA_SELLER("$3")}
    AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
    AND dd.descripcion_categoria = $3
    AND o.fecha_entrega >= $1
    AND o.fecha_entrega <  $2
  GROUP BY GROUPING SETS ((condicion_pago, fuente_condicion), (condicion_pago), ());
`;

// Fallback de Odoo (Bug 2) — MISMO WHERE base que SQL (reutiliza
// CONDICION_PAGO_CLIENTE/CONDICION_PAGO_FACTURA, nunca reescribe la
// clasificación), pero agrupa por cliente (customer_code + ruc) en vez de
// por (condicion_pago, fuente_condicion), y filtra a SIN_DATO únicamente —
// son los candidatos a resolver por RUC contra Odoo.
// `fuente_condicion` viaja en el GROUP BY (no solo condicion_pago) porque
// un mismo cliente SIN_DATO puede venir etiquetado METODO_PAGO_CLIENTE o
// NOTA_CREDITO (ver comentario grande arriba) — aplicarFallbackOdoo() debe
// saber exactamente de qué bucket con-fuente restar cada fila, no asumir
// que siempre es METODO_PAGO_CLIENTE.
const SQL_SIN_DATO_CLIENTES = `
  WITH base AS (
    SELECT
      o.customer_code AS customer_code,
      TRIM(c.identificacion_cliente) AS ruc,
      ${CONDICION_PAGO_CLIENTE("c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_CLIENTE} AS fuente_condicion,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND ${FILTRO_ORDENES_GRUPO_VALIDO}
      AND (${CASE_GRUPO_ORDENES}) = $1
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      f.customer_code AS customer_code,
      TRIM(c.identificacion_cliente) AS ruc,
      ${CONDICION_PAGO_FACTURA("f", "c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_FACTURA("f")} AS fuente_condicion,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      f.code AS doc_code
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    LEFT JOIN clientes c ON c.codigo_cliente = f.customer_code
    WHERE f.status = 2
      AND (${CASE_GRUPO_FACTURAS}) = $1
      AND ${FILTRO_CLIENTE_VALIDO("f.customer_code")}
      AND ${FILTRO_FACTURAS_NO_DUPLICADO("f")}
      AND f.fecha_creacion >= $2
      AND f.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      o.customer_code AS customer_code,
      TRIM(c.identificacion_cliente) AS ruc,
      ${CONDICION_PAGO_CLIENTE("c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_CLIENTE} AS fuente_condicion,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
    WHERE o.status = 2
      AND o.equipo_ventas = 'Website'
      AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
      AND $1 = 'DOMICILIO'
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)
  )
  SELECT
    customer_code,
    ruc,
    fuente_condicion,
    SUM(unidades) AS unidades,
    SUM(dolares)  AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  WHERE condicion_pago = 'SIN_DATO' AND ruc IS NOT NULL AND ruc != ''
  GROUP BY customer_code, ruc, fuente_condicion;
`;

// PREVENTA — misma restricción de siempre (solo ordenes, condición siempre
// por fallback de cliente, nunca NOTA_CREDITO — eso solo existe en
// `facturas`), agrupado por cliente y filtrado a SIN_DATO.
const SQL_PREVENTA_SIN_DATO_CLIENTES = `
  SELECT
    o.customer_code AS customer_code,
    TRIM(c.identificacion_cliente) AS ruc,
    SUM(dd.cantidad) AS unidades,
    SUM(dd.total)    AS dolares,
    COUNT(DISTINCT o.code) AS num_documentos
  FROM ordenes o
  JOIN detalle_documento dd ON dd.documento_code = o.code
  LEFT JOIN clientes c ON c.codigo_cliente = o.customer_code
  WHERE o.type = 2
    AND o.status = 5
    AND ${FILTRO_PREVENTA_SELLER("$3")}
    AND ${FILTRO_CLIENTE_VALIDO("o.customer_code")}
    AND dd.descripcion_categoria = $3
    AND o.fecha_entrega >= $1
    AND o.fecha_entrega <  $2
    AND (${CONDICION_PAGO_CLIENTE("c")}) = 'SIN_DATO'
    AND TRIM(c.identificacion_cliente) IS NOT NULL
    AND TRIM(c.identificacion_cliente) != ''
  GROUP BY o.customer_code, TRIM(c.identificacion_cliente);
`;

// Combina las filas GROUPING SETS en { totales, por_condicion, por_condicion_y_fuente }.
function desagregar(rows) {
  const totales = { unidades: 0, dolares: 0, num_documentos: 0 };
  const por_condicion = [];
  const por_condicion_y_fuente = [];

  for (const r of rows) {
    const unidades = Number(r.unidades) || 0;
    const dolares = Number(r.dolares) || 0;
    const num_documentos = Number(r.num_documentos) || 0;

    if (r.condicion_pago == null && r.fuente_condicion == null) {
      totales.unidades = unidades;
      totales.dolares = dolares;
      totales.num_documentos = num_documentos;
    } else if (r.fuente_condicion == null) {
      por_condicion.push({ condicion_pago: r.condicion_pago, unidades, dolares, num_documentos });
    } else {
      por_condicion_y_fuente.push({
        condicion_pago: r.condicion_pago,
        fuente_condicion: r.fuente_condicion,
        unidades,
        dolares,
        num_documentos,
      });
    }
  }

  por_condicion.sort((a, b) => b.dolares - a.dolares);
  por_condicion_y_fuente.sort((a, b) => b.dolares - a.dolares);
  return { totales, por_condicion, por_condicion_y_fuente };
}

// Intenta resolver por Odoo los clientes SIN_DATO (`sinDatoRows`, filas de
// SQL_SIN_DATO_CLIENTES/SQL_PREVENTA_SIN_DATO_CLIENTES: customer_code, ruc,
// unidades, dolares, num_documentos) y mueve lo resuelto de SIN_DATO a
// CONTADO/CREDITO con fuente_condicion='ODOO_FALLBACK', mutando copias de
// los buckets de `desagregado`. `totales` nunca cambia — es una
// reclasificación de dólares que ya estaban contados, no dólares nuevos.
// Degradación con gracia: cualquier fallo consultando Odoo se atrapa acá y
// se reporta en `fallback_odoo.error`, sin tocar el resultado ya válido
// que existía sin el fallback (ver diseño documentado en
// odooCondicionPagoFallback.js).
async function aplicarFallbackOdoo(desagregado, sinDatoRows) {
  const filasConRuc = (sinDatoRows || []).filter((r) => r.ruc);
  const resumen = { intentados: filasConRuc.length, resueltos: 0, dolares_resueltos: 0, error: null };

  if (filasConRuc.length === 0) {
    return { ...desagregado, fallback_odoo: resumen };
  }

  let resoluciones;
  try {
    resoluciones = await resolverCondicionPagoOdoo(filasConRuc.map((r) => r.ruc));
  } catch (err) {
    resumen.error = `No se pudo consultar Odoo para el fallback: ${err.message}`;
    return { ...desagregado, fallback_odoo: resumen };
  }

  const porCondicionMap = new Map(desagregado.por_condicion.map((r) => [r.condicion_pago, { ...r }]));
  const porCondicionYFuenteMap = new Map(
    desagregado.por_condicion_y_fuente.map((r) => [`${r.condicion_pago}|${r.fuente_condicion}`, { ...r }])
  );

  for (const fila of filasConRuc) {
    const resolucion = resoluciones.get(fila.ruc);
    if (!resolucion) continue; // Odoo tampoco lo tiene — sigue SIN_DATO.

    const unidades = Number(fila.unidades) || 0;
    const dolares = Number(fila.dolares) || 0;
    const numDocumentos = Number(fila.num_documentos) || 0;

    const sinDatoAgg = porCondicionMap.get("SIN_DATO");
    if (sinDatoAgg) {
      sinDatoAgg.unidades -= unidades;
      sinDatoAgg.dolares -= dolares;
      sinDatoAgg.num_documentos -= numDocumentos;
    }
    // `fila.fuente_condicion` viene directo de la columna real (no de la
    // constante SQL, que trae comillas embebidas para usarse dentro de un
    // SELECT) — en SQL_PREVENTA_SIN_DATO_CLIENTES no existe esa columna
    // (PREVENTA siempre es METODO_PAGO_CLIENTE, nunca NOTA_CREDITO), de ahí
    // el fallback fijo para ese caso.
    const fuenteOrigen = fila.fuente_condicion || "METODO_PAGO_CLIENTE";
    const sinDatoFuente = porCondicionYFuenteMap.get(`SIN_DATO|${fuenteOrigen}`);
    if (sinDatoFuente) {
      sinDatoFuente.unidades -= unidades;
      sinDatoFuente.dolares -= dolares;
      sinDatoFuente.num_documentos -= numDocumentos;
    }

    const destino = resolucion.condicion_pago;
    const aggDestino = porCondicionMap.get(destino) || {
      condicion_pago: destino,
      unidades: 0,
      dolares: 0,
      num_documentos: 0,
    };
    aggDestino.unidades += unidades;
    aggDestino.dolares += dolares;
    aggDestino.num_documentos += numDocumentos;
    porCondicionMap.set(destino, aggDestino);

    const keyFuente = `${destino}|ODOO_FALLBACK`;
    const fuenteDestino = porCondicionYFuenteMap.get(keyFuente) || {
      condicion_pago: destino,
      fuente_condicion: "ODOO_FALLBACK",
      unidades: 0,
      dolares: 0,
      num_documentos: 0,
    };
    fuenteDestino.unidades += unidades;
    fuenteDestino.dolares += dolares;
    fuenteDestino.num_documentos += numDocumentos;
    porCondicionYFuenteMap.set(keyFuente, fuenteDestino);

    resumen.resueltos++;
    resumen.dolares_resueltos += dolares;
  }

  resumen.dolares_resueltos = Number(resumen.dolares_resueltos.toFixed(2));

  return {
    totales: desagregado.totales,
    por_condicion: [...porCondicionMap.values()].sort((a, b) => b.dolares - a.dolares),
    por_condicion_y_fuente: [...porCondicionYFuenteMap.values()].sort((a, b) => b.dolares - a.dolares),
    fallback_odoo: resumen,
  };
}

async function totalesGrupo(grupo, inicioTs, finTs, categoria) {
  const params = [grupo, inicioTs, finTs, categoria ?? null];
  const { rows } = await pool.query(SQL, params);
  const desagregado = desagregar(rows);

  const { rows: sinDatoRows } = await pool.query(SQL_SIN_DATO_CLIENTES, params);
  return aplicarFallbackOdoo(desagregado, sinDatoRows);
}

async function totalesPreventa(inicioTs, finTs, categoria) {
  const categoriaEfectiva = categoria || CATEGORIA_PREVENTA;
  const params = [inicioTs, finTs, categoriaEfectiva];
  const { rows } = await pool.query(SQL_PREVENTA, params);
  const desagregado = desagregar(rows);

  const { rows: sinDatoRows } = await pool.query(SQL_PREVENTA_SIN_DATO_CLIENTES, params);
  return aplicarFallbackOdoo(desagregado, sinDatoRows);
}

async function ventasPorCondicionPago({ grupo, categoria, fecha_inicio, fecha_fin }) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;

  const esPreventa = grupo === "PREVENTA";
  const { totales, por_condicion, por_condicion_y_fuente, fallback_odoo } = esPreventa
    ? await totalesPreventa(inicioTs, finTs, categoria)
    : await totalesGrupo(grupo, inicioTs, finTs, categoria);

  return {
    grupo,
    categoria: esPreventa ? categoria || CATEGORIA_PREVENTA : categoria || null,
    unidades_totales: totales.unidades,
    dolares_totales: Number(totales.dolares.toFixed(2)),
    num_documentos: totales.num_documentos,
    por_condicion: por_condicion.map((r) => ({
      ...r,
      dolares: Number(r.dolares.toFixed(2)),
    })),
    por_condicion_y_fuente: por_condicion_y_fuente.map((r) => ({
      ...r,
      dolares: Number(r.dolares.toFixed(2)),
    })),
    fallback_odoo,
  };
}

module.exports = { ventasPorCondicionPago, inputSchema, totalesGrupo, totalesPreventa };
