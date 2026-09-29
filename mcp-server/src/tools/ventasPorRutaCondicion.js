// src/tools/ventasPorRutaCondicion.js
// Ventas por ruta desglosadas por condición de pago (CONTADO/CREDITO) —
// cruce que faltaba entre `ventasPorRuta`/`ventasPorGrupo` (desglose por
// ruta) y `ventasPorCondicionPago` (desglose por condición). Pedido
// explícito: reutilizar EXACTAMENTE la misma lógica de clasificación
// contado/crédito que ya usa `ventasPorCondicionPago`
// (CONDICION_PAGO_CLIENTE/CONDICION_PAGO_FACTURA/FUENTE_CONDICION_PAGO_*,
// importadas tal cual de clasificacion.js, sin reescribirlas) para que las
// 2 tools nunca puedan desalinearse entre sí.
//
// Acepta exactamente uno de `ruta` (mismo patrón que ventasPorRuta: string
// o array de hasta 50, filtra por seller_code directo — sin
// FILTRO_CLIENTE_VALIDO, mismo comportamiento ya existente en
// ventasPorRuta.js) o `grupo` (mismo patrón que ventasPorGrupo: CASE_GRUPO_*
// + FILTRO_CLIENTE_VALIDO), nunca ambos ni ninguno — cada modo tiene un WHERE
// de base distinto (filtrar por seller_code directo vs. clasificar por
// CASE_GRUPO_*) y no hay ningún caso de uso pedido que combine los dos, así
// que combinarlos sería inventar comportamiento sin validar.
//
// ============================================================
// Campos agregados MÁS ALLÁ del schema literal pedido (dolares_sin_dato /
// num_documentos_sin_dato / num_documentos_nota_credito) — justificado por
// el propio requisito #3 del pedido: "no forzar SIN_DATO a CREDITO" y
// "dolares_totales debe cuadrar sin importar el desglose". Sin un bucket
// SIN_DATO explícito, dolares_contado+dolares_credito+dolares_nota_credito
// quedaría MENOR que dolares_totales en cualquier ruta con
// metodo_pago_cliente sin poblar (ej. DOMICILIO) sin ninguna explicación
// visible — eso es exactamente el tipo de número "no cuadra" que este
// pedido pide evitar. Mismo principio de transparencia que ya usa
// `por_condicion_y_fuente` en ventasPorCondicionPago.js.
//
// ============================================================
// HALLAZGO IMPORTANTE (encontrado al construir esta tool, no antes) —
// colisión real en la clasificación RURAL existente
// ============================================================
// `CASE_GRUPO_FACTURAS`/`CASE_GRUPO_ORDENES` clasifican como RURAL todo
// seller_code que empieza con 'R' — eso incluye, sin querer, 'RUTA 113' /
// 'RUTA 131' / 'RUTA 132' / 'RUTA 132.1' (los seller_code COTTSA de las
// rutas "OK" de ventasRutaOk.js), porque también empiezan con 'R' de
// "RUTA". Confirmado con datos reales: las 7 rutas rurales genuinas
// (R1-R6, R1.2) suman ~$289K, mientras que las 4 rutas "OK" mal
// clasificadas ahí suman ~$2.72M — es decir, HOY, pedir `grupo=RURAL` en
// `ventasPorGrupo`/`ventasPorCondicionPago` da un número donde ~90% son en
// realidad ventas de rutas OK, no rural real. Esta tool REUTILIZA
// `CASE_GRUPO_FACTURAS`/`CASE_GRUPO_ORDENES` tal cual (mismo principio de
// "no reinventar" que aplica a la lógica de condición de pago) — no se
// corrige acá, sería una decisión de negocio unilateral sin pedido
// explícito. Reportado aparte en TODO.md para que Alberto decida si vale
// la pena separar el patrón 'R%' genuino de las 'RUTA %' de ventasRutaOk
// en una tarea propia.
//
// ============================================================
// aqua-premium-ne (requisito #2) — mismo manejo especial que ventasRutaOk
// ============================================================
// Solo aplica en modo `ruta` (nunca en modo `grupo`, aunque `grupo=RURAL`
// arrastre 'RUTA 113/131/132/132.1' por la colisión de arriba — mezclar
// una consulta en vivo a un sistema externo dentro de un desglose por
// GRUPO, sin que el usuario haya pedido esas rutas explícitamente, sería
// sorprendente). Cuando `ruta` incluye exactamente 'RUTA 113'/'RUTA 131'/
// 'RUTA 132' (NO 'RUTA 132.1' — comparte el mismo config_id de
// aqua-premium-ne que 'RUTA 132', ver RUTAS_OK en ventasRutaOk.js; sumarlo
// a ambas si se piden las dos por separado duplicaría el dato), se
// consulta en vivo pos.order de aqua-premium-ne para ese config_id y se
// suma al bucket CONTADO de esa fila — confirmado con datos reales
// (`pos.payment` de las 3 rutas, histórico completo: 100% de los pagos son
// "Cash"/"Cash 01", 0 métodos de crédito) que esas ventas son
// contado por diseño (POS, se cobra al momento). No se suma a
// `unidades_totales` (aqua-premium-ne no expone unidades por línea sin una
// consulta adicional más pesada — mismo alcance que ya tiene
// ventasRutaOk.js, que tampoco reporta unidades de esta fuente).
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias } = require("../util/fechas");
const { executeKw } = require("../integrations/aquaPremiumNe");
const {
  CASE_GRUPO_ORDENES,
  FILTRO_ORDENES_GRUPO_VALIDO,
  CASE_GRUPO_FACTURAS,
  GRUPOS_VALIDOS,
  CATEGORIAS_VALIDAS,
  FILTRO_PREVENTA_SELLER,
  CATEGORIA_PREVENTA,
  FILTRO_CLIENTE_VALIDO,
  CONDICION_PAGO_CLIENTE,
  FUENTE_CONDICION_PAGO_CLIENTE,
  CONDICION_PAGO_FACTURA,
  FUENTE_CONDICION_PAGO_FACTURA,
} = require("../sql/clasificacion");

const RUTA_RE = /^[A-Za-z0-9._ -]{1,20}$/;
const RUTA_PREVENTA_RE = /^(PV|PREVENTA|TELEVENTA)/i;
const MAX_RANGO_DIAS = 400;
const MAX_RUTAS = 50;

const RUTA_SCHEMA = z.string().regex(RUTA_RE, "código de ruta inválido");
const inputSchema = {
  ruta: z.union([RUTA_SCHEMA, z.array(RUTA_SCHEMA).min(1).max(MAX_RUTAS)]).optional(),
  grupo: z.enum(GRUPOS_VALIDOS).optional(),
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

// aqua-premium-ne: config_id por seller_code COTTSA — ver comentario grande
// de arriba (por qué 132.1 no está acá).
const AQUA_PREMIUM_NE_CONFIG_POR_RUTA = {
  "RUTA 113": 23,
  "RUTA 131": 25,
  "RUTA 132": 24,
};

function redondear(n) {
  return Number((n || 0).toFixed(2));
}

// ============================================================
// MODO GRUPO — mismo WHERE base que ventasPorGrupo.js, + columnas de
// condición de pago reutilizadas tal cual de clasificacion.js.
// $1=grupo, $2=inicio, $3=fin exclusivo, $4=categoria (o NULL).
// ============================================================
const SQL_GRUPO = `
  WITH base AS (
    SELECT
      o.seller_code AS ruta_val,
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
      AND o.fecha_creacion >= $2 AND o.fecha_creacion < $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      f.seller_code AS ruta_val,
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
      AND f.fecha_creacion >= $2 AND f.fecha_creacion < $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      o.seller_code AS ruta_val,
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
      AND o.fecha_creacion >= $2 AND o.fecha_creacion < $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)
  )
  SELECT ruta_val, condicion_pago, fuente_condicion,
    SUM(unidades) AS unidades, SUM(dolares) AS dolares, COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  GROUP BY ruta_val, condicion_pago, fuente_condicion;
`;

// PREVENTA en modo grupo — mismo WHERE que SQL_PREVENTA de
// ventasPorCondicionPago.js. $1=inicio, $2=fin exclusivo, $3=categoria.
const SQL_GRUPO_PREVENTA = `
  SELECT
    o.seller_code AS ruta_val,
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
    AND o.fecha_entrega >= $1 AND o.fecha_entrega < $2
  GROUP BY o.seller_code, condicion_pago, fuente_condicion;
`;

// ============================================================
// MODO RUTA — mismo WHERE base que ventasPorRuta.js (filtra seller_code
// directo, SIN FILTRO_CLIENTE_VALIDO — mismo comportamiento ya existente
// ahí), + columnas de condición de pago.
// $1=rutas[], $2=inicio, $3=fin exclusivo, $4=categoria (o NULL).
// ============================================================
const SQL_RUTA = `
  WITH base AS (
    SELECT
      o.seller_code AS ruta_val,
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
      AND o.seller_code = ANY($1::text[])
      AND o.fecha_creacion >= $2 AND o.fecha_creacion < $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      f.seller_code AS ruta_val,
      ${CONDICION_PAGO_FACTURA("f", "c")} AS condicion_pago,
      ${FUENTE_CONDICION_PAGO_FACTURA("f")} AS fuente_condicion,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      f.code AS doc_code
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    LEFT JOIN clientes c ON c.codigo_cliente = f.customer_code
    WHERE f.status = 2
      AND f.seller_code = ANY($1::text[])
      AND f.fecha_creacion >= $2 AND f.fecha_creacion < $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)

    UNION ALL

    SELECT
      o.seller_code AS ruta_val,
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
      AND o.seller_code = ANY($1::text[])
      AND o.fecha_creacion >= $2 AND o.fecha_creacion < $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)
  )
  SELECT ruta_val, condicion_pago, fuente_condicion,
    SUM(unidades) AS unidades, SUM(dolares) AS dolares, COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  GROUP BY ruta_val, condicion_pago, fuente_condicion;
`;

// PREVENTA en modo ruta — mismo WHERE que SQL_PREVENTA de ventasPorRuta.js.
// $1=rutas preventa[], $2=inicio, $3=fin exclusivo, $4=categoria.
const SQL_RUTA_PREVENTA = `
  SELECT
    o.seller_code AS ruta_val,
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
    AND o.seller_code = ANY($1::text[])
    AND ${FILTRO_PREVENTA_SELLER("dd.descripcion_categoria")}
    AND o.fecha_entrega >= $2 AND o.fecha_entrega < $3
  GROUP BY o.seller_code, condicion_pago, fuente_condicion;
`;

// Agrega filas crudas (ruta_val, condicion_pago, fuente_condicion, unidades,
// dolares, num_documentos) en un mapa por ruta con los buckets pedidos.
function agregarPorRuta(rows, mapa) {
  for (const r of rows) {
    const ruta = r.ruta_val || "SIN_RUTA_ASIGNADA";
    const unidades = Number(r.unidades) || 0;
    const dolares = Number(r.dolares) || 0;
    const numDocs = Number(r.num_documentos) || 0;

    const fila = mapa.get(ruta) || {
      ruta,
      unidades_totales: 0,
      dolares_totales: 0,
      dolares_contado: 0,
      dolares_credito: 0,
      dolares_sin_dato: 0,
      dolares_nota_credito: 0,
      num_documentos_contado: 0,
      num_documentos_credito: 0,
      num_documentos_sin_dato: 0,
      num_documentos_nota_credito: 0,
    };

    fila.unidades_totales += unidades;
    fila.dolares_totales += dolares;

    if (r.fuente_condicion === "NOTA_CREDITO") {
      fila.dolares_nota_credito += dolares;
      fila.num_documentos_nota_credito += numDocs;
    } else if (r.condicion_pago === "CONTADO") {
      fila.dolares_contado += dolares;
      fila.num_documentos_contado += numDocs;
    } else if (r.condicion_pago === "CREDITO") {
      fila.dolares_credito += dolares;
      fila.num_documentos_credito += numDocs;
    } else {
      fila.dolares_sin_dato += dolares;
      fila.num_documentos_sin_dato += numDocs;
    }

    mapa.set(ruta, fila);
  }
}

// Suma en vivo la contribución de aqua-premium-ne (100% CONTADO, ver
// comentario grande del archivo) a las filas de por_ruta que correspondan.
async function fusionarAquaPremiumNe(mapa, inicioStr, finStr) {
  const rutasConAquaPremium = [...mapa.keys()].filter((r) => AQUA_PREMIUM_NE_CONFIG_POR_RUTA[r]);
  if (rutasConAquaPremium.length === 0) return;

  await Promise.all(
    rutasConAquaPremium.map(async (ruta) => {
      const configId = AQUA_PREMIUM_NE_CONFIG_POR_RUTA[ruta];
      const [fila] = await executeKw(
        "pos.order",
        "read_group",
        [[["config_id", "=", configId], ["date_order", ">=", `${inicioStr} 00:00:00`], ["date_order", "<", `${finStr} 00:00:00`]], ["amount_total:sum"], []],
        { lazy: false }
      );
      const dolares = fila?.amount_total || 0;
      const numDocs = fila?.__count || 0;
      if (numDocs === 0) return;

      const filaRuta = mapa.get(ruta);
      filaRuta.dolares_totales += dolares;
      filaRuta.dolares_contado += dolares;
      filaRuta.num_documentos_contado += numDocs;
    })
  );
}

function filasFinales(mapa, limite) {
  return [...mapa.values()]
    .map((f) => ({
      ruta: f.ruta,
      unidades_totales: f.unidades_totales,
      dolares_totales: redondear(f.dolares_totales),
      dolares_contado: redondear(f.dolares_contado),
      dolares_credito: redondear(f.dolares_credito),
      dolares_sin_dato: redondear(f.dolares_sin_dato),
      dolares_nota_credito: redondear(f.dolares_nota_credito),
      num_documentos_contado: f.num_documentos_contado,
      num_documentos_credito: f.num_documentos_credito,
      num_documentos_sin_dato: f.num_documentos_sin_dato,
      num_documentos_nota_credito: f.num_documentos_nota_credito,
    }))
    .sort((a, b) => b.dolares_totales - a.dolares_totales)
    .slice(0, limite);
}

function totalesGlobales(mapa) {
  let unidades = 0, dolares = 0, numDocumentos = 0;
  for (const f of mapa.values()) {
    unidades += f.unidades_totales;
    dolares += f.dolares_totales;
    numDocumentos += f.num_documentos_contado + f.num_documentos_credito + f.num_documentos_sin_dato + f.num_documentos_nota_credito;
  }
  return { unidades_totales: unidades, dolares_totales: redondear(dolares), num_documentos: numDocumentos };
}

async function ventasPorRutaCondicion({ ruta, grupo, categoria, fecha_inicio, fecha_fin }) {
  if (!ruta && !grupo) throw new Error("hay que especificar `ruta` o `grupo` (no ambos, no ninguno)");
  if (ruta && grupo) throw new Error("`ruta` y `grupo` son excluyentes — pedir una consulta por ruta específica o por grupo, no combinadas");

  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
  const mapa = new Map();

  if (grupo) {
    const esPreventa = grupo === "PREVENTA";
    if (esPreventa) {
      const categoriaEfectiva = categoria || CATEGORIA_PREVENTA;
      const { rows } = await pool.query(SQL_GRUPO_PREVENTA, [inicioTs, finTs, categoriaEfectiva]);
      agregarPorRuta(rows, mapa);
    } else {
      const { rows } = await pool.query(SQL_GRUPO, [grupo, inicioTs, finTs, categoria ?? null]);
      agregarPorRuta(rows, mapa);
    }
  } else {
    const rutasSolicitadas = Array.isArray(ruta) ? ruta : [ruta];
    const rutasPreventa = rutasSolicitadas.filter((r) => RUTA_PREVENTA_RE.test(r));
    const rutasNormales = rutasSolicitadas.filter((r) => !RUTA_PREVENTA_RE.test(r));

    const [resultNormal, resultPreventa] = await Promise.all([
      rutasNormales.length ? pool.query(SQL_RUTA, [rutasNormales, inicioTs, finTs, categoria ?? null]) : Promise.resolve({ rows: [] }),
      rutasPreventa.length ? pool.query(SQL_RUTA_PREVENTA, [rutasPreventa, inicioTs, finTs, categoria ?? null]) : Promise.resolve({ rows: [] }),
    ]);
    agregarPorRuta(resultNormal.rows, mapa);
    agregarPorRuta(resultPreventa.rows, mapa);

    // Asegura que toda ruta pedida explícitamente aparezca en el resultado
    // aunque no haya tenido ventas en el rango (fila en $0, no ausente).
    for (const r of rutasNormales.concat(rutasPreventa)) {
      if (!mapa.has(r)) {
        mapa.set(r, {
          ruta: r,
          unidades_totales: 0,
          dolares_totales: 0,
          dolares_contado: 0,
          dolares_credito: 0,
          dolares_sin_dato: 0,
          dolares_nota_credito: 0,
          num_documentos_contado: 0,
          num_documentos_credito: 0,
          num_documentos_sin_dato: 0,
          num_documentos_nota_credito: 0,
        });
      }
    }

    await fusionarAquaPremiumNe(mapa, fecha_inicio, finExclusivo(fecha_fin));
  }

  const por_ruta = filasFinales(mapa, 1000);
  const totales = totalesGlobales(mapa);

  return {
    ...(grupo ? { grupo } : { ruta: Array.isArray(ruta) ? ruta : ruta }),
    categoria: categoria || (grupo === "PREVENTA" ? CATEGORIA_PREVENTA : null),
    fecha_inicio,
    fecha_fin,
    unidades_totales: totales.unidades_totales,
    dolares_totales: totales.dolares_totales,
    num_documentos: totales.num_documentos,
    por_ruta,
  };
}

module.exports = { ventasPorRutaCondicion, inputSchema };
