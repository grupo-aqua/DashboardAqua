const {
  Orden,
  Factura,
  DetalleDocumento,
} = require("../../models");

const Sequelize = require("sequelize");
const { sequelize } = require("../../models");
const MetaPreventa = require("../../models/metaPreventa");
const { getDiasHabilesTranscurridos, getDiasLaborablesMes } = require('../../utils/diasFestivos');
const { filtroVisibilidad, permiteSeccion } = require('../../utils/visibilidadRutas');
const { dedupeProductosVendidos } = require('../../utils/dedupeProductos');
const MODULO_BOTELLON = '/dashboard/botellon';

// Secciones que tienen metas configurables (solo autoventas)
const SECCIONES_CON_METAS = ["TIENDAS_VIP", "TIENDAS", "MAYORISTA", "RURAL"];

/* ======================================================
   CONFIGURACIÓN DE GRUPOS BOTELLÓN
====================================================== */
// `canal` = canal de ruta al que pertenece el grupo (para visibilidad por rol).
// '__ADMIN__' = grupo especial sin canal de ruta (solo lo ve ADMIN).
const GRUPOS = {
  DOMICILIO: {
    campo: "o.route_code",
    filtro: "o.route_code ILIKE 'A%'",
    canal: "A",
  },
  EMPRESAS: {
    campo: "o.seller_code",
    filtro: "o.seller_code ILIKE 'E%'",
    canal: "E",
  },
  MAYORISTA: {
    campo: "o.seller_code",
    filtro: "o.seller_code ILIKE 'M%'",
    canal: "M",
  },
  QUITO: {
    campo: "o.seller_code",
    filtro: "o.seller_code = 'U1'",
    canal: "U",
  },
  RURAL: {
    campo: "o.seller_code",
    filtro: "o.seller_code ILIKE 'R%'",
    canal: "R",
  },
  TELEVENTA_VIP: {
    campo: "o.seller_code",
    filtro: "o.seller_code ILIKE '148399%'",
    canal: "__ADMIN__",
  },
  TIENDAS: {
    campo: "o.seller_code",
    filtro: "o.seller_code ILIKE 'T%' AND o.seller_code NOT ILIKE 'TV%'",
    canal: "T",
  },
  TIENDAS_VIP: {
    campo: "o.seller_code",
    filtro: "o.seller_code ILIKE 'TV%'",
    canal: "TV",
  },
  VIP: {
    campo: "f.codigo_tipo_negocio",
    filtro: "f.codigo_tipo_negocio = '29'",
    canal: "__ADMIN__",
  },
};

/* ======================================================
   RANGO DE FECHAS
====================================================== */
const getRangoFechas = (anio, mes) => {
  const inicio = `${anio}-${String(mes).padStart(2, "0")}-01 00:00:00`;
  const mesSig = mes === 12 ? 1 : mes + 1;
  const anioSig = mes === 12 ? anio + 1 : anio;
  const fin = `${anioSig}-${String(mesSig).padStart(2, "0")}-01 00:00:00`;
  return { inicio, fin };
};

/* ======================================================
   FILTRO POR TIPO DE PRODUCTO (LÍQUIDO / ENVASE / TODO)

   Regla de negocio del código 29 (BOTELLÓN 20L AQUA PREMIUM, ENVASE+LÍQUIDO):
   - Si la factura del 29 trae una NotCr con DISC asociada → el cliente devolvió
     el envase, por lo que la línea del 29 se reclasifica como LÍQUIDO.
   - Si no hay NotCr DISC asociada → la línea cuenta como ENVASE
     (cliente compró envase + líquido).

   Cuadre matemático garantizado:  LÍQUIDO + ENVASE = TODO

   - LÍQUIDO  → BOTELLÓN sin ENVASE/PET en descripción y no [29]/[11]
                + [29]/[11] cuyas facturas SÍ tienen NotCr DISC asociada
                + todas las líneas DISC (sus signos los ajusta signedSumFactura)
   - ENVASE   → [29]/[11] cuyas facturas NO tienen NotCr DISC asociada
                + cualquier otro BOTELLÓN con ENVASE/PET en descripción
                  (excluyendo DISC)
   - TODO     → sin filtro (BOTELLÓN ∪ DISC del filtro padre)

   Refs Odoo (default_code = producto_codigo_interno):
     [29] BOTELLÓN 20L AQUA PREMIUM (ENVASE+LIQUÍDO)
     [11] BOTELLON VERDE PET

   IMPORTANTE: las NotCr (tipo_movimiento = 'out_refund') deben restarse,
   no excluirse. Por eso en queries sobre `facturas` debe usarse
   `signedSumFactura(aliasFactura, aliasDD, 'total')` en lugar de
   `SUM(aliasDD.total)`, y análogo para cantidad.
====================================================== */
const ENVASE_CODES = ['29', '11'];

// Filtro de exclusión para queries de VIP que solo filtran por
// codigo_tipo_negocio = '29'. La tabla principal (obtenerGrupoBotellon) usa
// un CASE WHEN con prioridad: si el seller_code matchea DOMICILIO/MAYORISTA/
// EMPRESAS/RURAL/TIENDAS/TIENDAS_VIP, la factura se clasifica en ese grupo
// (NO en VIP) aunque el cliente sea tipo_negocio=29. Para que el detalle
// VIP cuadre con la tabla principal, hay que excluir esas facturas.
const filtroExclusionVip = (alias = 'f') => `
  AND (${alias}.seller_code IS NULL OR (
    ${alias}.seller_code NOT IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')
    AND ${alias}.seller_code NOT ILIKE 'M%'
    AND ${alias}.seller_code NOT ILIKE 'E%'
    AND ${alias}.seller_code NOT ILIKE 'R%'
    AND ${alias}.seller_code NOT ILIKE 'T%'
  ))
`;

const normalizarTipoProducto = (raw) => {
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'liquido' || v === 'líquido') return 'liquido';
  if (v === 'envase') return 'envase';
  return 'todo';
};

// Predicado SQL: la factura raíz de la línea actual tiene una NotCr con DISC asociada.
// El matching se hace por invoice_origin (campo Odoo que en una NotCr apunta al
// `code` de la factura original) y como fallback parent_id.
//
//   - Si la línea actual está en una factura original (out_invoice):
//       la factura raíz es ella misma. Buscamos NCs cuyo invoice_origin = code.
//   - Si la línea actual está en una NotCr (out_refund):
//       la factura raíz es la apuntada por invoice_origin (o parent_id) propio.
//       Buscamos otras NCs que apunten a esa misma factura raíz.
const facturaTieneNcDisc = (aliasFactura) => `EXISTS (
  SELECT 1 FROM facturas __nc
  JOIN detalle_documento __ddc ON __ddc.documento_code = __nc.code
  WHERE __nc.tipo_movimiento = 'out_refund'
    AND __ddc.producto_codigo_interno = 'DISC'
    AND __nc.invoice_origin IS NOT NULL
    AND __nc.invoice_origin = CASE
        WHEN ${aliasFactura}.tipo_movimiento = 'out_refund'
          THEN COALESCE(${aliasFactura}.invoice_origin, ${aliasFactura}.parent_id)
        ELSE ${aliasFactura}.code
      END
)`;

// Devuelve el fragmento extra a aplicar SOBRE registros ya filtrados por
// (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC'). Empieza con AND si aplica.
const buildFiltroProductoBotellon = (tipoProducto, alias = 'dd', aliasFactura = null) => {
  const envaseList = ENVASE_CODES.map(c => `'${c}'`).join(',');
  if (tipoProducto === 'liquido') {
    if (aliasFactura) {
      // Líquido = líquido puro + códigos 29/11 cuyas facturas tienen NC DISC asociada.
      // Las líneas DISC NO se cuentan monetariamente (solo se usan para clasificar la línea del 29).
      return ` AND (
        (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.descripcion NOT ILIKE '%ENVASE%'
            AND ${alias}.descripcion NOT ILIKE '%PET%'
            AND ${alias}.producto_codigo_interno <> 'DISC'
            AND ${alias}.producto_codigo_interno NOT IN (${envaseList}))
        OR (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.producto_codigo_interno IN (${envaseList})
            AND ${facturaTieneNcDisc(aliasFactura)})
      ) `;
    }
    // Sin aliasFactura (queries de ordenes, sin NotCr): líquido puro
    return ` AND ${alias}.descripcion_categoria = 'BOTELLÓN'
             AND ${alias}.descripcion NOT ILIKE '%ENVASE%'
             AND ${alias}.descripcion NOT ILIKE '%PET%'
             AND ${alias}.producto_codigo_interno <> 'DISC'
             AND ${alias}.producto_codigo_interno NOT IN (${envaseList}) `;
  }
  if (tipoProducto === 'envase') {
    if (aliasFactura) {
      return ` AND (
        (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.producto_codigo_interno IN (${envaseList})
            AND NOT ${facturaTieneNcDisc(aliasFactura)})
        OR (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.producto_codigo_interno NOT IN (${envaseList})
            AND ${alias}.producto_codigo_interno <> 'DISC'
            AND (${alias}.descripcion ILIKE '%ENVASE%' OR ${alias}.descripcion ILIKE '%PET%'))
      ) `;
    }
    // Sin aliasFactura (ordenes): 29/11 + otros BOTELLÓN con ENVASE/PET
    return ` AND (
      (${alias}.descripcion_categoria = 'BOTELLÓN' AND ${alias}.producto_codigo_interno IN (${envaseList}))
      OR (${alias}.descripcion_categoria = 'BOTELLÓN'
          AND ${alias}.producto_codigo_interno NOT IN (${envaseList})
          AND ${alias}.producto_codigo_interno <> 'DISC'
          AND (${alias}.descripcion ILIKE '%ENVASE%' OR ${alias}.descripcion ILIKE '%PET%'))
    ) `;
  }
  // tipoProducto = 'todo': solo BOTELLÓN, sin DISC (preserva el valor histórico).
  return ` AND ${alias}.descripcion_categoria = 'BOTELLÓN' `;
};

// Para queries DOMICILIO que combinan BOTELLÓN + SUSCRIPCION.
// La SUSCRIPCION es siempre líquido (no envase).
const buildFiltroCategoriaBotellonOSuscripcion = (tipoProducto, alias = 'dd', aliasFactura = null) => {
  const envaseList = ENVASE_CODES.map(c => `'${c}'`).join(',');
  if (tipoProducto === 'liquido') {
    if (aliasFactura) {
      // Líquido = líquido puro + códigos 29/11 con NC DISC asociada + SUSCRIPCION.
      // Las líneas DISC NO se cuentan monetariamente.
      return `(
        (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.descripcion NOT ILIKE '%ENVASE%'
            AND ${alias}.descripcion NOT ILIKE '%PET%'
            AND ${alias}.producto_codigo_interno <> 'DISC'
            AND ${alias}.producto_codigo_interno NOT IN (${envaseList}))
        OR (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.producto_codigo_interno IN (${envaseList})
            AND ${facturaTieneNcDisc(aliasFactura)})
        OR ${alias}.descripcion_categoria = 'SUSCRIPCION'
      )`;
    }
    return `(
      (${alias}.descripcion_categoria = 'BOTELLÓN'
          AND ${alias}.descripcion NOT ILIKE '%ENVASE%'
          AND ${alias}.descripcion NOT ILIKE '%PET%'
          AND ${alias}.producto_codigo_interno <> 'DISC'
          AND ${alias}.producto_codigo_interno NOT IN (${envaseList}))
      OR ${alias}.descripcion_categoria = 'SUSCRIPCION'
    )`;
  }
  if (tipoProducto === 'envase') {
    if (aliasFactura) {
      return `(
        (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.producto_codigo_interno IN (${envaseList})
            AND NOT ${facturaTieneNcDisc(aliasFactura)})
        OR (${alias}.descripcion_categoria = 'BOTELLÓN'
            AND ${alias}.producto_codigo_interno NOT IN (${envaseList})
            AND ${alias}.producto_codigo_interno <> 'DISC'
            AND (${alias}.descripcion ILIKE '%ENVASE%' OR ${alias}.descripcion ILIKE '%PET%'))
      )`;
    }
    return `(
      (${alias}.descripcion_categoria = 'BOTELLÓN' AND ${alias}.producto_codigo_interno IN (${envaseList}))
      OR (${alias}.descripcion_categoria = 'BOTELLÓN'
          AND ${alias}.producto_codigo_interno NOT IN (${envaseList})
          AND ${alias}.producto_codigo_interno <> 'DISC'
          AND (${alias}.descripcion ILIKE '%ENVASE%' OR ${alias}.descripcion ILIKE '%PET%'))
    )`;
  }
  // 'todo': BOTELLÓN + SUSCRIPCION. NO incluye DISC (los reembolsos de envase no
  // se descuentan del total — solo afectan la clasificación de la línea del 29).
  return `(${alias}.descripcion_categoria = 'BOTELLÓN' OR ${alias}.descripcion_categoria = 'SUSCRIPCION')`;
};

// Helper para sumas con signo en queries sobre `facturas`. Las notas de crédito
// (tipo_movimiento = 'out_refund') se restan, replicando "Análisis de Facturas"
// de Odoo. Para queries sobre `ordenes` (sin NotCr) seguir usando SUM(...) plano.
//   signedSumFactura('f', 'dd', 'total')
//     → SUM(CASE WHEN f.tipo_movimiento='out_refund' THEN -dd.total ELSE dd.total END)
const signedSumFactura = (aliasFactura, aliasDD, field) =>
  `SUM(CASE WHEN ${aliasFactura}.tipo_movimiento = 'out_refund' THEN -${aliasDD}.${field} ELSE ${aliasDD}.${field} END)`;

// Versión por fila (sin SUM) para usar dentro de UNION ALL antes de un SUM externo.
const signedColFactura = (aliasFactura, aliasDD, field) =>
  `CASE WHEN ${aliasFactura}.tipo_movimiento = 'out_refund' THEN -${aliasDD}.${field} ELSE ${aliasDD}.${field} END`;

/* ======================================================
   META HISTÓRICA BOTELLÓN (USD + MES)
====================================================== */
const metaHistoricaBotellon = async () => {
  const [rows] = await sequelize.query(`
      WITH ventas_base AS (

      /* ===================== ORDENES ===================== */
      SELECT
        CASE
          WHEN o.seller_code ILIKE 'M%'  THEN 'MAYORISTA'
          WHEN o.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
          WHEN o.seller_code ILIKE 'T%'  AND o.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
          WHEN o.seller_code IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1') THEN 'RUTA_COMBINADA'
          WHEN o.seller_code ILIKE 'R%'  THEN 'RURAL'
          WHEN o.seller_code = '148399'  THEN 'TELEVENTA_VIP'
        END AS grupo,
        o.seller_code AS codigo,
        DATE_TRUNC('month', o.fecha_creacion) AS mes,
        SUM(dd.total) AS total_usd
      FROM ordenes o
      JOIN detalle_documento dd
        ON dd.documento_code = o.code
      WHERE
        o.status IN (2)
        AND o.origen_sistema = 'MOBILVENDOR'
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        AND (
          o.seller_code ILIKE 'M%'
          OR o.seller_code ILIKE 'TV%'
          OR (o.seller_code ILIKE 'T%' AND o.seller_code NOT ILIKE 'TV%')
          OR o.seller_code ILIKE 'R%'
          OR o.seller_code = '148399'
        )
      GROUP BY grupo, o.seller_code, DATE_TRUNC('month', o.fecha_creacion)

      UNION ALL

      /* ===================== FACTURAS ===================== */
      SELECT
        CASE
          WHEN f.seller_code ILIKE 'M%'  THEN 'MAYORISTA'
          WHEN f.route_code  ILIKE 'A%'  THEN 'DOMICILIO'
          WHEN f.seller_code ILIKE 'E%'  THEN 'EMPRESAS'
          WHEN f.seller_code IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1') THEN 'RUTA_COMBINADA'
          WHEN f.seller_code ILIKE 'R%'  THEN 'RURAL'
          WHEN f.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
          WHEN f.seller_code ILIKE 'T%'  AND f.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
          WHEN f.codigo_tipo_negocio = '29' THEN 'VIP'
          WHEN f.seller_code = 'U1'      THEN 'QUITO'
        END AS grupo,
        f.seller_code AS codigo,
        DATE_TRUNC('month', CASE WHEN f.codigo_tipo_negocio = '29' THEN f.fecha_creacion ELSE f.fecha_entrega END) AS mes,
        SUM(dd.total) AS total_usd
      FROM facturas f
      JOIN detalle_documento dd
        ON dd.documento_code = f.code
      WHERE
        f.status IN (2)
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
      GROUP BY grupo, f.seller_code, DATE_TRUNC('month', CASE WHEN f.codigo_tipo_negocio = '29' THEN f.fecha_creacion ELSE f.fecha_entrega END)
    ),

    /*  AQUÍ ESTÁ LA DIFERENCIA CLAVE */
    ventas_mensuales AS (
      SELECT
        grupo,
        codigo,
        mes,
        SUM(total_usd) AS total_usd
      FROM ventas_base
      GROUP BY grupo, codigo, mes
    ),

    ranking AS (
      SELECT
        grupo,
        codigo,
        mes,
        total_usd,
        ROW_NUMBER() OVER (
          PARTITION BY grupo, codigo
          ORDER BY total_usd DESC
        ) AS rn
      FROM ventas_mensuales
    )

    SELECT
      grupo,
      codigo,
      total_usd AS meta_historica_usd,
      mes AS mes_meta_historica
    FROM ranking
    WHERE rn = 1
    ORDER BY grupo, codigo;

      `);

  return rows;
};

/* ======================================================
   DÍAS HÁBILES — importados de utils/diasFestivos.js
   (lunes–sábado, excluyendo festivos nacionales)
====================================================== */

const obtenerGrupoBotellon = async (nombreGrupo, anio, mes, metasConfigMap = {}, vis = null, tipoProducto = 'todo') => {
  const hoyDate = new Date();
  const esMesActual = hoyDate.getFullYear() === anio && hoyDate.getMonth() + 1 === mes;

  const { inicio, fin: finFull } = getRangoFechas(anio, mes);
  // Para el mes actual, cortamos en hoy 00:00:00 para ser consistentes con diasTranscurridos
  const finHoy = `${hoyDate.getFullYear()}-${String(hoyDate.getMonth() + 1).padStart(2, '0')}-${String(hoyDate.getDate()).padStart(2, '0')} 00:00:00`;
  const fin = esMesActual ? finHoy : finFull;

  const { inicio: inicioAnt, fin: finAnt } = getRangoFechas(
    mes === 1 ? anio - 1 : anio,
    mes === 1 ? 12 : mes - 1
  );

  const diasTrans = getDiasHabilesTranscurridos(anio, mes);
  const diasMes = getDiasLaborablesMes(anio, mes);

  const filtroProductoBotellon = buildFiltroProductoBotellon(tipoProducto);
  // facturas: pasamos alias 'f' para que envase excluya NotCr y líquido incluya NotCr de envase
  const filtroBotellonOSuscripcion = buildFiltroCategoriaBotellonOSuscripcion(tipoProducto, 'dd', 'f');
  const incluirSuscripcion = tipoProducto !== 'envase';

  const sql = `
  SELECT
  grupo,
  codigo,
  SUM(unidades) AS unidades,
  SUM(dolares)  AS dolares
FROM (

  /* ===================== ORDENES ===================== */
  SELECT
    CASE
      WHEN o.seller_code ILIKE 'M%'  THEN 'MAYORISTA'
      WHEN o.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
      WHEN o.seller_code ILIKE 'T%'  AND o.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
      WHEN o.seller_code IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1') THEN 'RUTA_COMBINADA'
      WHEN o.seller_code ILIKE 'R%'  THEN 'RURAL'
      WHEN o.seller_code = '148399'  THEN 'TELEVENTA_VIP'
    END AS grupo,
    o.seller_code AS codigo,
    SUM(dd.cantidad) AS unidades,
    SUM(dd.total) AS dolares
  FROM ordenes o
  JOIN detalle_documento dd
    ON dd.documento_code = o.code
  WHERE
    o.status = 2
    AND o.origen_sistema = 'MOBILVENDOR'
    AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
    ${filtroProductoBotellon}
    AND (
      o.seller_code ILIKE 'M%'
      OR o.seller_code ILIKE 'TV%'
      OR (o.seller_code ILIKE 'T%' AND o.seller_code NOT ILIKE 'TV%')
      OR o.seller_code ILIKE 'R%'
      OR o.seller_code = '148399'
    )
    AND o.fecha_creacion >= :inicio
    AND o.fecha_creacion <  :fin
  GROUP BY grupo, o.seller_code

  UNION ALL

  /* ===================== FACTURAS (DOMICILIO + OTROS) — neto NotCr ===================== */
  SELECT
    CASE
      WHEN f.seller_code IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')
        THEN 'DOMICILIO'
      WHEN f.seller_code ILIKE 'M%' THEN 'MAYORISTA'
      WHEN f.seller_code ILIKE 'E%' THEN 'EMPRESAS'
      WHEN f.seller_code IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1') THEN 'RUTA_COMBINADA'
      WHEN f.seller_code ILIKE 'R%' THEN 'RURAL'
      WHEN f.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
      WHEN f.seller_code ILIKE 'T%' AND f.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
      WHEN f.codigo_tipo_negocio = '29' THEN 'VIP'
      WHEN f.seller_code = 'U1' THEN 'QUITO'
      ELSE 'OTROS'
    END AS grupo,
    f.seller_code AS codigo,
    ${signedSumFactura('f', 'dd', 'cantidad')} AS unidades,
    ${signedSumFactura('f', 'dd', 'total')}    AS dolares
  FROM facturas f
  JOIN detalle_documento dd
    ON dd.documento_code = f.code
  WHERE
    f.status = 2
    AND ${filtroBotellonOSuscripcion}
    AND f.fecha_creacion >= :inicio
    AND f.fecha_creacion <  :fin
  GROUP BY grupo, f.seller_code

  UNION ALL

  /* ===================== WEBSITE ===================== */
  SELECT
    'DOMICILIO' AS grupo,
    o.seller_code AS codigo,
    SUM(dd.cantidad) AS unidades,
    SUM(dd.total) AS dolares
  FROM ordenes o
  JOIN detalle_documento dd
    ON dd.documento_code = o.code
  WHERE
    o.status = 2
    AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
    ${filtroProductoBotellon}
    AND o.equipo_ventas = 'Website'
    AND o.fecha_creacion >= :inicio
    AND o.fecha_creacion <  :fin
  GROUP BY o.seller_code

  ${incluirSuscripcion ? `UNION ALL

  /* ===================== SUSCRIPCION — neto NotCr ===================== */
  SELECT
    'DOMICILIO' AS grupo,
    f.seller_code AS codigo,
    COUNT(DISTINCT dd.id_detalle) AS unidades,
    ${signedSumFactura('f', 'dd', 'total')} AS dolares
  FROM facturas f
  JOIN detalle_documento dd
    ON dd.documento_code = f.code
  WHERE
    f.status = 2
    AND dd.descripcion_categoria = 'SUSCRIPCION'
    AND f.fecha_creacion >= :inicio
    AND f.fecha_creacion <  :fin
  GROUP BY f.seller_code` : ''}

) t
WHERE grupo = :grupo
GROUP BY grupo, codigo
ORDER BY codigo;
  `;

  // Ventas actuales
  let actual = await sequelize.query(sql, {
    replacements: { inicio, fin, grupo: nombreGrupo },
    type: Sequelize.QueryTypes.SELECT,
  });

  // Ventas del mes anterior
  let anterior = await sequelize.query(sql, {
    replacements: {
      inicio: inicioAnt,
      fin: finAnt,
      grupo: nombreGrupo,
    },
    type: Sequelize.QueryTypes.SELECT,
  });

  // Conteo de documentos (facturas MV + ordenes MV) del mes actual por grupo
  const countSql = `
    SELECT
      COALESCE(SUM(num_facturas), 0) AS num_facturas,
      COALESCE(SUM(num_ordenes),  0) AS num_ordenes
    FROM (
      /* ORDENES MOBILVENDOR */
      SELECT
        CASE
          WHEN o.seller_code ILIKE 'M%'  THEN 'MAYORISTA'
          WHEN o.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
          WHEN o.seller_code ILIKE 'T%'  AND o.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
          WHEN o.seller_code IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1') THEN 'RUTA_COMBINADA'
          WHEN o.seller_code ILIKE 'R%'  THEN 'RURAL'
          WHEN o.seller_code = '148399'  THEN 'TELEVENTA_VIP'
        END AS grupo,
        0 AS num_facturas,
        COUNT(DISTINCT o.code) AS num_ordenes
      FROM ordenes o
      WHERE o.status IN (2)
        AND o.origen_sistema = 'MOBILVENDOR'
        AND o.fecha_creacion >= :inicio
        AND o.fecha_creacion <  :fin
        AND (
          o.seller_code ILIKE 'M%'
          OR o.seller_code ILIKE 'TV%'
          OR (o.seller_code ILIKE 'T%' AND o.seller_code NOT ILIKE 'TV%')
          OR o.seller_code ILIKE 'R%'
          OR o.seller_code = '148399'
        )
        AND EXISTS (
          SELECT 1 FROM detalle_documento dd
          WHERE dd.documento_code = o.code
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroProductoBotellon}
        )
      GROUP BY grupo

      UNION ALL

      /* FACTURAS */
      SELECT
        CASE
          WHEN f.seller_code ILIKE 'M%'  THEN 'MAYORISTA'
          WHEN f.route_code  ILIKE 'A%'  THEN 'DOMICILIO'
          WHEN f.seller_code ILIKE 'E%'  THEN 'EMPRESAS'
          WHEN f.seller_code IN ('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1') THEN 'RUTA_COMBINADA'
          WHEN f.seller_code ILIKE 'R%'  THEN 'RURAL'
          WHEN f.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
          WHEN f.seller_code ILIKE 'T%'  AND f.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
          WHEN f.codigo_tipo_negocio = '29' THEN 'VIP'
          WHEN f.seller_code = 'U1'      THEN 'QUITO'
          ELSE 'OTROS'
        END AS grupo,
        COUNT(DISTINCT f.code) AS num_facturas,
        0 AS num_ordenes
      FROM facturas f
      WHERE f.status IN (2)
        AND (
          f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        )
        AND EXISTS (
          SELECT 1 FROM detalle_documento dd
          WHERE dd.documento_code = f.code
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroProductoBotellon}
        )
      GROUP BY grupo
    ) t
    WHERE grupo = :grupo
  `;
  const countsRes = await sequelize.query(countSql, {
    replacements: { inicio, fin, grupo: nombreGrupo },
    type: Sequelize.QueryTypes.SELECT,
  });
  const numFacturas = Number(countsRes[0]?.num_facturas || 0);
  const numOrdenes = Number(countsRes[0]?.num_ordenes || 0);

  // ── Filtrar filas solo para VENDEDOR (ruta exacta). El SUPERVISOR ve toda la
  //    tabla del grupo/canal que ya se le permitió mostrar. ──
  if (vis && vis.rol === 'VENDEDOR') {
    actual = actual.filter(r => vis.permite(r.codigo));
    anterior = anterior.filter(r => vis.permite(r.codigo));
  }

  // Mapeo de ventas del mes anterior por código de ruta
  const mapAnterior = {};
  anterior.forEach(r => mapAnterior[r.codigo] = {
    dolares: Number(r.dolares) || 0,
    unidades: Number(r.unidades) || 0
  });

  const metas = await metaHistoricaBotellon();

  // Total de ventas (actual + mes anterior) con sus respectivas variaciones
  const totalActual = actual.reduce((acc, r) => {
    acc.unidades += Number(r.unidades);
    acc.dolares += Number(r.dolares);
    return acc;
  }, { unidades: 0, dolares: 0 });

  // Calcular el total del mes anterior
  const totalAnterior = {
    unidades: anterior.reduce((acc, r) => acc + (mapAnterior[r.codigo]?.unidades || 0), 0),
    dolares: anterior.reduce((acc, r) => acc + (mapAnterior[r.codigo]?.dolares || 0), 0)
  };

  // Proyección del total (usa real si mes cerrado o diasTrans=0)
  const proyeccionTotalDolares = esMesActual && diasTrans > 0
    ? (totalActual.dolares / diasTrans) * diasMes
    : totalActual.dolares;
  const proyeccionTotalUnidades = esMesActual && diasTrans > 0
    ? Math.round((totalActual.unidades / diasTrans) * diasMes)
    : totalActual.unidades;

  // Variación: proyección vs mes anterior
  const variacionAbs = proyeccionTotalDolares - totalAnterior.dolares;
  const variacionPorc = totalAnterior.dolares > 0 ? (variacionAbs / totalAnterior.dolares) * 100 : 0;

  const variacionAbsUnidades = proyeccionTotalUnidades - totalAnterior.unidades;
  const variacionPorcUnidades =
    totalAnterior.unidades > 0 ? (variacionAbsUnidades / totalAnterior.unidades) * 100 : null;

  return {
    total: {
      unidades: totalActual.unidades,
      dolares: totalActual.dolares,
      numFacturas,
      numOrdenes,
      mesAnterior: {
        dolares: totalAnterior.dolares,
        variacionAbs: Number(variacionAbs.toFixed(2)),
        variacionPorc: Number(variacionPorc.toFixed(2)),
        unidades: totalAnterior.unidades,
        variacionAbsUnidades: Math.round(variacionAbsUnidades),
        variacionPorcUnidades: variacionPorcUnidades !== null ? Number(variacionPorcUnidades.toFixed(2)) : null,
      }
    },
    detalle: actual.map(r => {
      const ant = mapAnterior[r.codigo] || { dolares: 0, unidades: 0 };
      // const variacionAbs = r.dolares - ant.dolares;
      const dolaresActual = Number(r.dolares) || 0;
      const variacionAbs = dolaresActual - ant.dolares;
      const variacionPorc = ant.dolares > 0 ? (variacionAbs / ant.dolares) * 100 : null;

      const proyeccionDolares = diasTrans > 0 ? (r.dolares / diasTrans) * diasMes : 0;

      const proyeccionUnidades = diasTrans > 0 ? (r.unidades / diasTrans) * diasMes : 0;

      const meta = metas.find(m => m.codigo === r.codigo);
      const metaConfig = r.codigo ? metasConfigMap[r.codigo.toUpperCase()] : null;

      const variacionAbsUnidadesDet = Number(r.unidades) - (ant.unidades || 0);
      const variacionPorcUnidadesDet =
        (ant.unidades || 0) > 0 ? (variacionAbsUnidadesDet / ant.unidades) * 100 : null;

      return {
        codigo: r.codigo,
        unidades: Number(r.unidades),
        dolares: Number(r.dolares),
        meta: {
          meta_historica: meta ? Number(meta.meta_historica_usd).toFixed(2) : "0.00",
          mes_mayor_consumo: meta?.mes_meta_historica || null,
        },
        cupo: metaConfig
          ? {
            cupo_dolares: Number(metaConfig.meta_dolares),
            cupo_unidades: Number(metaConfig.meta_unidades),
          }
          : null,
        proyeccion: {
          dolares: Number(proyeccionDolares.toFixed(2)),
          unidades: Number(proyeccionUnidades.toFixed(0))
        }, vsMesAnterior: {
          monto_anterior: ant.dolares,
          variacion_abs: Number(variacionAbs.toFixed(2)),
          variacion_porc: variacionPorc !== null ? Number(variacionPorc.toFixed(2)) : null,

          unidades: ant.unidades,
          variacion_abs_unidades: variacionAbsUnidadesDet,
          variacion_porc_unidades: variacionPorcUnidadesDet !== null ? Number(variacionPorcUnidadesDet.toFixed(2)) : null,
        },
      };
    }),
  };
};




/* ======================================================
   TENDENCIA 6 MESES BOTELLÓN (ordenes MV + facturas E/A/V/U1)
====================================================== */
const tendencia6MesesBotellon = async (anioNum, mesNum, tipoProducto = 'todo') => {
  const NOMBRES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  let mesInicio = mesNum - 11, anioInicio = anioNum;
  while (mesInicio <= 0) { mesInicio += 12; anioInicio--; }
  const inicio6 = `${anioInicio}-${String(mesInicio).padStart(2, '0')}-01 00:00:00`;
  let mesFin = mesNum + 1, anioFin = anioNum;
  if (mesFin === 13) { mesFin = 1; anioFin++; }
  const fin6 = `${anioFin}-${String(mesFin).padStart(2, '0')}-01 00:00:00`;

  const filtroProductoBotellon = buildFiltroProductoBotellon(tipoProducto);
  const filtroProductoBotellonFact = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

  const rows = await sequelize.query(`
    SELECT mes_periodo, SUM(dolares) AS dolares, SUM(unidades) AS unidades
    FROM (
      SELECT DATE_TRUNC('month', o.fecha_creacion) AS mes_periodo,
             SUM(dd.total) AS dolares, SUM(dd.cantidad) AS unidades
      FROM ordenes o
      JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.status IN (2)
        AND o.origen_sistema = 'MOBILVENDOR'
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellon}
        AND o.fecha_creacion >= :inicio6 AND o.fecha_creacion < :fin6
      GROUP BY DATE_TRUNC('month', o.fecha_creacion)

      UNION ALL

      SELECT DATE_TRUNC('month', f.fecha_creacion) AS mes_periodo,
             ${signedSumFactura('f', 'dd', 'total')}    AS dolares,
             ${signedSumFactura('f', 'dd', 'cantidad')} AS unidades
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellonFact}
        AND f.fecha_creacion >= :inicio6 AND f.fecha_creacion < :fin6
      GROUP BY DATE_TRUNC('month', f.fecha_creacion)
    ) combinado
    GROUP BY mes_periodo
    ORDER BY mes_periodo
  `, { replacements: { inicio6, fin6 }, type: Sequelize.QueryTypes.SELECT });

  const hoy = new Date();
  return rows.map(r => {
    const d = new Date(r.mes_periodo);
    const mes = d.getMonth() + 1;
    const anio = d.getFullYear();
    const dolares = Number(Number(r.dolares || 0).toFixed(2));
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

/* ======================================================
   CONTROLLER EXPRESS
====================================================== */
const obtenerDashboardBotellones = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);

    if (!anio || !mes) {
      return res.status(400).json({ error: "anio y mes requeridos" });
    }

    const anioNum = Number(anio);
    const mesNum = Number(mes);

    // ── Visibilidad por rol/canal (ADMIN=todo · SUPERVISOR=canal · VENDEDOR=ruta) ──
    const vis = filtroVisibilidad(req.user);

    // Cargar metas configuradas para este mes/año (solo secciones TV, T, M, R)
    const metasDB = await MetaPreventa.findAll({
      where: { anio: anioNum, mes: mesNum, seccion: SECCIONES_CON_METAS },
    });
    // Agrupar por seccion → { [seccion]: { [codigo_ruta]: meta } }
    const metasPorSeccion = {};
    metasDB.forEach(m => {
      if (!metasPorSeccion[m.seccion]) metasPorSeccion[m.seccion] = {};
      metasPorSeccion[m.seccion][m.codigo_ruta.toUpperCase()] = m;
    });

    const botellones = {};

    for (const nombre of Object.keys(GRUPOS)) {
      // Visibilidad por módulo/sección: el ADMIN ve todo; el resto ve la sección
      // solo si se le concedió (sección explícita, módulo completo, o por canal).
      if (!permiteSeccion(req.user, MODULO_BOTELLON, nombre, GRUPOS[nombre].canal)) continue;

      const metasConfigMap = SECCIONES_CON_METAS.includes(nombre)
        ? (metasPorSeccion[nombre] || {})
        : {};

      botellones[nombre] = await obtenerGrupoBotellon(
        nombre,
        anioNum,
        mesNum,
        metasConfigMap,
        vis,
        tipoProducto
      );
    }

    const tendencia6Meses = await tendencia6MesesBotellon(anioNum, mesNum, tipoProducto);

    return res.json({
      anio: anioNum,
      mes: mesNum,
      botellones,
      tendencia6Meses,
    });
  } catch (error) {
    console.error("❌ ERROR BOTELLONES:", error);
    res.status(500).json({ message: "Error dashboard botellones" });
  }
};

/* ======================================================
   CLIENTES VIP BOTELLÓN
   GET /api/botellones/clientes-vip?anio=YYYY&mes=MM
====================================================== */
const obtenerClientesVipBotellon = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );

    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    // Clientes VIP: todas las queries son sobre facturas (f0/f2/f3/f4/f5/f)
    const filtroDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const filtroDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const filtroDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const filtroDD4 = buildFiltroProductoBotellon(tipoProducto, 'dd4', 'f4');
    const filtroDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');
    const filtroDD = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

    const clientes = await sequelize.query(`
      SELECT
        base.customer_code                                         AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)             AS nombre_cliente,
        COALESCE(dc.calle1_direccion_cliente, c.direccion_cliente, '')        AS direccion_entrega,
        COALESCE(tn.descripcion, '')                                          AS tipo_negocio,
        COALESCE(sc.descripcion_subcanal, '')                                 AS subcanal,
        COALESCE(base.codigo_subcanal, '')                                    AS codigo_subcanal,
        COALESCE(dc.telefono_direccion_cliente, c.telefono_cliente, '')       AS telefono,
        COALESCE(dc.latitud_direccion_cliente::text,  c.latitud_cliente::text,  '')  AS latitud,
        COALESCE(dc.longitud_direccion_cliente::text, c.longitud_cliente::text, '')  AS longitud,
        COALESCE(act.cantidad_actual,  0)                          AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                          AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                          AS consumo_anterior,
        COALESCE(mx.max_consumo,       0)                          AS max_consumo,
        ult.ultima_factura
      FROM (
        -- Todos los clientes VIP que compraron BOTELLÓN en el año seleccionado.
        -- También capturamos el codigo_subcanal MÁS RECIENTE de cada cliente,
        -- para poder filtrar por subcanal en el frontend.
        SELECT
          f0.customer_code,
          (
            SELECT f0b.codigo_subcanal FROM facturas f0b
            WHERE f0b.customer_code = f0.customer_code
              AND f0b.codigo_tipo_negocio = '29'
              AND f0b.status = 2
              AND f0b.fecha_creacion >= :iniYear AND f0b.fecha_creacion < :finYear
              AND f0b.codigo_subcanal IS NOT NULL
            ORDER BY f0b.fecha_creacion DESC LIMIT 1
          ) AS codigo_subcanal
        FROM facturas f0
        JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
        WHERE f0.codigo_tipo_negocio = '29'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${filtroDD0}
          AND f0.status = 2
          AND f0.fecha_creacion >= :iniYear
          AND f0.fecha_creacion <  :finYear
          ${filtroExclusionVip('f0')}
        GROUP BY f0.customer_code
      ) base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN subcanales sc ON sc.codigo_subcanal = base.codigo_subcanal
      LEFT JOIN LATERAL (
        SELECT calle1_direccion_cliente,
               telefono_direccion_cliente,
               latitud_direccion_cliente,
               longitud_direccion_cliente
        FROM direcciones_clientes
        WHERE codigo_cliente = base.customer_code
        ORDER BY
          (latitud_direccion_cliente  IS NOT NULL AND longitud_direccion_cliente IS NOT NULL) DESC,
          (telefono_direccion_cliente IS NOT NULL) DESC
        LIMIT 1
      ) dc ON true
      LEFT JOIN LATERAL (
        -- Consumo actual del mes: alineado con la tabla principal (status=2,
        -- fecha_creacion, y excluyendo seller_codes que el CASE WHEN asigna a
        -- otros grupos como DOMICILIO/MAYORISTA/EMPRESAS/RURAL/TIENDAS).
        SELECT ${signedSumFactura('f2', 'dd2', 'cantidad')} AS cantidad_actual,
               ${signedSumFactura('f2', 'dd2', 'total')}    AS consumo_actual
        FROM facturas f2
        JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
        WHERE f2.customer_code = base.customer_code
          AND f2.codigo_tipo_negocio = '29'
          AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
          ${filtroDD2}
          AND f2.status = 2
          AND f2.fecha_creacion >= :inicio
          AND f2.fecha_creacion <  :fin
          AND (f2.seller_code IS NULL OR (
            f2.seller_code NOT IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')
            AND f2.seller_code NOT ILIKE 'M%'
            AND f2.seller_code NOT ILIKE 'E%'
            AND f2.seller_code NOT ILIKE 'R%'
            AND f2.seller_code NOT ILIKE 'T%'
          ))
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f3', 'dd3', 'total')} AS consumo_anterior
        FROM facturas f3
        JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
        WHERE f3.customer_code = base.customer_code
          AND f3.codigo_tipo_negocio = '29'
          AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
          ${filtroDD3}
          AND f3.status = 2
          AND f3.fecha_creacion >= :iniAnt
          AND f3.fecha_creacion <  :finAnt
          AND (f3.seller_code IS NULL OR (
            f3.seller_code NOT IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')
            AND f3.seller_code NOT ILIKE 'M%'
            AND f3.seller_code NOT ILIKE 'E%'
            AND f3.seller_code NOT ILIKE 'R%'
            AND f3.seller_code NOT ILIKE 'T%'
          ))
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT MAX(dd4.total) AS max_consumo
        FROM facturas f4
        JOIN detalle_documento dd4 ON dd4.documento_code = f4.code
        WHERE f4.customer_code = base.customer_code
          AND f4.codigo_tipo_negocio = '29'
          AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC')
          ${filtroDD4}
          AND f4.status IN (2,4,5)
          ${filtroExclusionVip('f4')}
      ) mx ON true
      LEFT JOIN LATERAL (
        SELECT MAX(f5.fecha_creacion)::date AS ultima_factura
        FROM facturas f5
        JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
        WHERE f5.customer_code = base.customer_code
          AND f5.codigo_tipo_negocio = '29'
          AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC')
          ${filtroDD5}
          AND f5.status IN (2,4,5)
          ${filtroExclusionVip('f5')}
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `, {
      replacements: { iniYear, finYear, inicio, fin, iniAnt, finAnt },
      type: Sequelize.QueryTypes.SELECT,
    });

    const totalClientes = clientes.length;
    const clientesConConsumo = clientes.filter(c => Number(c.consumo_actual) > 0).length;
    const clientesSinConsumo = totalClientes - clientesConConsumo;

    // IMPORTANTE: alineado con la tabla principal de VIP (obtenerGrupoBotellon).
    // - status = 2: solo facturas confirmadas.
    // - fecha_creacion: VIP se reporta por fecha de creación.
    // - EXCLUIR facturas cuyo seller_code las asigne a otros grupos. La tabla
    //   principal usa un CASE WHEN con prioridad: si el seller_code matchea
    //   Domicilio/Mayorista/Empresas/Rural/Tiendas_VIP/Tiendas, esas facturas
    //   se clasifican en ese grupo, NO en VIP, aunque el cliente sea tipo_negocio=29.
    const productosVendidos = await sequelize.query(`
      SELECT dd.descripcion AS producto,
             ${signedSumFactura('f', 'dd', 'cantidad')} AS unidades_vendidas,
             ${signedSumFactura('f', 'dd', 'total')}    AS monto_usd
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.codigo_tipo_negocio = '29'
        AND f.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroDD}
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        AND (f.seller_code IS NULL OR (
          f.seller_code NOT IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')
          AND f.seller_code NOT ILIKE 'M%'
          AND f.seller_code NOT ILIKE 'E%'
          AND f.seller_code NOT ILIKE 'R%'
          AND f.seller_code NOT ILIKE 'T%'
        ))
      GROUP BY dd.descripcion
      ORDER BY unidades_vendidas DESC
    `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });

    return res.json({
      clientes,
      resumen: { totalClientes, clientesConConsumo, clientesSinConsumo },
      productosVendidos: dedupeProductosVendidos(productosVendidos),
    });
  } catch (error) {
    console.error('❌ ERROR CLIENTES VIP BOTELLÓN:', error);
    return res.status(500).json({ message: 'Error al obtener clientes VIP', detail: error.message });
  }
};

/* ======================================================
   RUTAS ODOO EMPRESA (constante compartida)
====================================================== */
const RUTAS_ODOO_EMPRESAS = [
  'Carmen Garcia', 'Estefania Flores', 'Tamara Villacres',
  'RUTA E1', 'RUTA E2', 'RUTA E3', 'RUTA E4', 'RUTA E5',
  'RUTA E6', 'RUTA E7', 'RUTA E8', 'RUTA E9', 'RUTA E10',
  'RUTA EA1', 'Distribucion OK/E',
];

/* Helper: totales consolidados Empresa (3 fuentes: facturas Odoo + facturas
   MobilVendor + ordenes Odoo confirmadas + ordenes MobilVendor).

   CORRECCIÓN 2026-09-08: `f.seller_code ILIKE 'E%'` SIN restringir
   `origen_sistema` matcheaba, además de las facturas reales de MobilVendor,
   las facturas del equipo Odoo "Ventas" (seller_code E1-E10/EA1/EQ1 — un
   equipo Odoo sin relación con Empresas; sus facturas reales tienen
   seller_code NULO, se identifican por `equipo_ventas_nombre='Empresas'`).
   Mismo bug y mismo fix ya aplicado y validado en
   mcp-server/src/sql/clasificacion.js (ver TODO.md) — acá se replica el
   patrón de 3 fuentes ya probado (dedup exhaustivo: 0 coincidencias de
   código y 0 por heurística cliente+fecha+monto entre las 3 fuentes).

   Se agrega además una 4ta fuente que no existía: ordenes de MobilVendor
   (ruta, seller_code E%) — 50 documentos / $506.22 (BOTELLÓN+DISC,
   histórico) que quedaban fuera por completo, mismo hueco que tenía
   mcp-server antes del fix (CASE_GRUPO_ORDENES sin rama EMPRESAS).

   La rama de `ordenes` Odoo (equipo_ventas='Empresas', pedidos CONFIRMADOS
   sin exigir factura) se deja intacta a propósito — es una decisión de
   negocio ya tomada (ver comentario de "reporte del jefe" abajo), no un bug;
   `equipo_ventas` viene siempre vacío para ordenes de origen MobilVendor, así
   que ese filtro nunca matchea filas de MobilVendor por accidente. */
const queryTotalesEmpresas = async (inicio, fin, tipoProducto = 'todo') => {
  const rutasRepl = {};
  RUTAS_ODOO_EMPRESAS.forEach((r, i) => { rutasRepl[`re${i}`] = r; });
  const rutasPH = RUTAS_ODOO_EMPRESAS.map((_, i) => `:re${i}`).join(', ');

  const filtroProductoBotellon = buildFiltroProductoBotellon(tipoProducto);
  // Variante para facturas: aplica la regla de NotCr (envase devuelto → líquido)
  const filtroProductoBotellonFact = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

  // Sin exclusión VIP: el reporte del jefe en "Análisis de Facturas" considera
  // Empresas a CUALQUIER cliente facturado por usuarios E* (MV) o por el equipo
  // 'Empresas' en Odoo, sin importar si el cliente está clasificado como VIP
  // (codigo_tipo_negocio='29'). Mantener vacío para machear con su total.
  const excluyeVipPorFactura = '';
  const excluyeVipPorOrden = '';
  // Excluir POS (pos.order) que se sincroniza como `ordenes` pero no es
  // venta del equipo Empresas, sino caja de TPV.
  const excluyePOS = `AND o.equipo_ventas <> 'Point of Sale'`;

  const rows = await sequelize.query(`
    SELECT COALESCE(SUM(sub.unidades), 0) AS unidades,
           COALESCE(SUM(sub.dolares),  0) AS dolares
    FROM (
      -- ① Odoo: facturas EMPRESA por equipo real (excluye clientes VIP)
      SELECT COALESCE(${signedSumFactura('f', 'dd', 'cantidad')}, 0) AS unidades,
             COALESCE(${signedSumFactura('f', 'dd', 'total')}, 0)    AS dolares
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.equipo_ventas_nombre = 'Empresas' AND f.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellonFact}
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        ${excluyeVipPorFactura}
      UNION ALL
      -- ② MobilVendor: facturas EMPRESA (seller_code E%, solo origen MobilVendor)
      SELECT COALESCE(${signedSumFactura('f', 'dd', 'cantidad')}, 0) AS unidades,
             COALESCE(${signedSumFactura('f', 'dd', 'total')}, 0)    AS dolares
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.origen_sistema = 'MOBILVENDOR' AND f.seller_code ILIKE 'E%' AND f.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellonFact}
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        ${excluyeVipPorFactura}
      UNION ALL
      -- ③ Odoo: ordenes EMPRESA CONFIRMADAS, sin exigir factura (decisión de
      --   negocio ya tomada, no se toca) — excluye VIP y POS
      SELECT COALESCE(SUM(dd.cantidad), 0), COALESCE(SUM(dd.total), 0)
      FROM ordenes o
      JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.equipo_ventas = 'Empresas'
        AND o.type = 2 AND o.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellon}
        AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
        ${excluyeVipPorOrden}
        ${excluyePOS}
      UNION ALL
      -- ④ MobilVendor: ordenes EMPRESA (ruta, seller_code E%) — fuente nueva,
      --   no existía ninguna rama de ordenes MobilVendor para EMPRESAS.
      SELECT COALESCE(SUM(dd.cantidad), 0), COALESCE(SUM(dd.total), 0)
      FROM ordenes o
      JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.origen_sistema = 'MOBILVENDOR' AND o.seller_code ILIKE 'E%'
        AND o.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellon}
        AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
    ) sub
  `, {
    replacements: { inicio, fin, ...rutasRepl },
    type: Sequelize.QueryTypes.SELECT,
  });

  const countsRows = await sequelize.query(`
    SELECT
      COALESCE((
        SELECT COUNT(DISTINCT f.code)
        FROM facturas f
        WHERE f.status = 2
          AND (f.equipo_ventas_nombre = 'Empresas' OR (f.origen_sistema = 'MOBILVENDOR' AND f.seller_code ILIKE 'E%'))
          AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
          AND EXISTS (
            SELECT 1 FROM detalle_documento dd
            WHERE dd.documento_code = f.code
              AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
              ${filtroProductoBotellonFact}
          )
          ${excluyeVipPorFactura}
      ), 0) AS num_facturas,
      COALESCE((
        SELECT COUNT(DISTINCT o.code)
        FROM ordenes o
        WHERE (
          (o.equipo_ventas = 'Empresas' AND o.type = 2 ${excluyePOS})
          OR (o.origen_sistema = 'MOBILVENDOR' AND o.seller_code ILIKE 'E%')
        )
          AND o.status = 2
          AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
          AND EXISTS (
            SELECT 1 FROM detalle_documento dd
            WHERE dd.documento_code = o.code
              AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
              ${filtroProductoBotellon}
          )
          ${excluyeVipPorOrden}
      ), 0) AS num_ordenes
  `, {
    replacements: { inicio, fin, ...rutasRepl },
    type: Sequelize.QueryTypes.SELECT,
  });

  return {
    unidades: Number(rows[0]?.unidades || 0),
    dolares: Number(rows[0]?.dolares || 0),
    numFacturas: Number(countsRows[0]?.num_facturas || 0),
    numOrdenes: Number(countsRows[0]?.num_ordenes || 0),
  };
};

/* ======================================================
   EMPRESAS CONSOLIDADO
   GET /api/botellones/empresas-consolidado?anio=YYYY&mes=MM
====================================================== */
const obtenerEmpresasConsolidado = async (req, res) => {
  try {
    // Visibilidad: sección EMPRESAS (canal 'E') del módulo botellón.
    if (!permiteSeccion(req.user, MODULO_BOTELLON, 'EMPRESAS', 'E')) return res.json(null);
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const hoyEmp = new Date();
    const esMesActualEmp = hoyEmp.getFullYear() === anioNum && hoyEmp.getMonth() + 1 === mesNum;

    const { inicio, fin: finFull } = getRangoFechas(anioNum, mesNum);
    const finHoyEmp = `${hoyEmp.getFullYear()}-${String(hoyEmp.getMonth() + 1).padStart(2, '0')}-${String(hoyEmp.getDate()).padStart(2, '0')} 00:00:00`;
    const fin = esMesActualEmp ? finHoyEmp : finFull;

    const { inicio: inicioAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );

    const diasTrans = getDiasHabilesTranscurridos(anioNum, mesNum);
    const diasMes = getDiasLaborablesMes(anioNum, mesNum);

    const [actual, anterior] = await Promise.all([
      queryTotalesEmpresas(inicio, fin, tipoProducto),
      queryTotalesEmpresas(inicioAnt, finAnt, tipoProducto),
    ]);

    const proyDolares = esMesActualEmp && diasTrans > 0
      ? (actual.dolares / diasTrans) * diasMes
      : actual.dolares;
    const proyUnidades = esMesActualEmp && diasTrans > 0
      ? Math.round((actual.unidades / diasTrans) * diasMes)
      : actual.unidades;

    // Variación: proyección vs mes anterior
    const variacionAbs = proyDolares - anterior.dolares;
    const variacionPorc = anterior.dolares > 0 ? (variacionAbs / anterior.dolares) * 100 : 0;
    const varAbsUnid = proyUnidades - anterior.unidades;
    const varPorcUnid = anterior.unidades > 0 ? (varAbsUnid / anterior.unidades) * 100 : 0;

    return res.json({
      total: {
        unidades: actual.unidades,
        dolares: actual.dolares,
        numFacturas: actual.numFacturas,
        numOrdenes: actual.numOrdenes,
        mesAnterior: {
          dolares: anterior.dolares,
          variacionAbs: Number(variacionAbs.toFixed(2)),
          variacionPorc: Number(variacionPorc.toFixed(2)),
          unidades: anterior.unidades,
          variacionAbsUnidades: Math.round(varAbsUnid),
          variacionPorcUnidades: Number(varPorcUnid.toFixed(2)),
        },
      },
      detalle: [{
        proyeccion: {
          dolares: Number(proyDolares.toFixed(2)),
          unidades: Number(proyUnidades.toFixed(0)),
        },
      }],
    });
  } catch (error) {
    console.error('❌ ERROR EMPRESAS CONSOLIDADO:', error);
    return res.status(500).json({ message: 'Error empresas consolidado', detail: error.message });
  }
};

/* ======================================================
   CLIENTES DOMICILIO BOTELLÓN
   GET /api/botellones/clientes-domicilio?anio=YYYY&mes=MM
====================================================== */
const obtenerClientesDomicilioBotellon = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );

    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    const incluirSuscripcion = tipoProducto !== 'envase';
    // Filtros con conciencia de NotCr para queries sobre facturas (alias f0/f2/f3/f4/f5)
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD4 = buildFiltroProductoBotellon(tipoProducto, 'dd4', 'f4');
    const fDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');
    const fDD = buildFiltroProductoBotellon(tipoProducto, 'dd');

    const clientes = await sequelize.query(`
SELECT
  base.customer_code AS codigo_cliente,
  base.origen_cliente,

  COALESCE(c.nombre_cliente, base.customer_code) AS nombre_cliente,
  COALESCE(dc.calle1_direccion_cliente, c.direccion_cliente, '') AS direccion_entrega,
  COALESCE(tn.descripcion, '') AS tipo_negocio,
  COALESCE(dc.telefono_direccion_cliente, c.telefono_cliente, '') AS telefono,
  COALESCE(dc.latitud_direccion_cliente::text, c.latitud_cliente::text, '') AS latitud,
  COALESCE(dc.longitud_direccion_cliente::text, c.longitud_cliente::text, '') AS longitud,

  COALESCE(act.cantidad_actual, 0) AS cantidad_actual,
  COALESCE(act.consumo_actual, 0) AS consumo_actual,
  COALESCE(ant.consumo_anterior, 0) AS consumo_anterior,
  COALESCE(mx.max_consumo, 0) AS max_consumo,
  ult.ultima_factura

FROM (

  /* ================= BASE SIN DUPLICADOS ================= */
  SELECT
    f0.customer_code,

    CASE
      WHEN MAX(CASE WHEN f0.equipo_ventas = 'Website' THEN 1 ELSE 0 END) = 1 THEN 'WEBSITE'
      WHEN MAX(CASE WHEN dd0.descripcion_categoria = 'SUSCRIPCION' THEN 1 ELSE 0 END) = 1 THEN 'SUSCRIPCION'
      ELSE 'MV'
    END AS origen_cliente

  FROM facturas f0
  JOIN detalle_documento dd0 ON dd0.documento_code = f0.code

  WHERE
  (
    (f0.seller_code ILIKE 'A%' AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC') ${fDD0})
    ${incluirSuscripcion ? "OR dd0.descripcion_categoria = 'SUSCRIPCION'" : ''}
    OR (f0.equipo_ventas = 'Website' AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC') ${fDD0})
  )
  AND f0.status = 2
  AND f0.fecha_creacion >= :inicio
  AND f0.fecha_creacion <  :fin

  GROUP BY f0.customer_code

) base

LEFT JOIN clientes c 
  ON c.codigo_cliente = base.customer_code

LEFT JOIN tipos_negocio tn 
  ON tn.codigo = c.codigo_tipo_negocio


/* ================= DIRECCIÓN ================= */
LEFT JOIN LATERAL (
  SELECT
    calle1_direccion_cliente,
    telefono_direccion_cliente,
    latitud_direccion_cliente,
    longitud_direccion_cliente
  FROM direcciones_clientes
  WHERE codigo_cliente = base.customer_code
  ORDER BY
    (latitud_direccion_cliente IS NOT NULL AND longitud_direccion_cliente IS NOT NULL) DESC,
    (telefono_direccion_cliente IS NOT NULL) DESC
  LIMIT 1
) dc ON true


/* ================= CONSUMO ACTUAL (neto NotCr) ================= */
LEFT JOIN LATERAL (
  SELECT
    ${signedSumFactura('f2', 'dd2', 'cantidad')} AS cantidad_actual,
    ${signedSumFactura('f2', 'dd2', 'total')}    AS consumo_actual
  FROM facturas f2
  JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
  WHERE f2.customer_code = base.customer_code
    AND (
      (f2.seller_code ILIKE 'A%' AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC') ${fDD2})
      ${incluirSuscripcion ? "OR dd2.descripcion_categoria = 'SUSCRIPCION'" : ''}
      OR (f2.equipo_ventas = 'Website' AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC') ${fDD2})
    )
    AND f2.status = 2
    AND f2.fecha_creacion >= :inicio
    AND f2.fecha_creacion <  :fin
) act ON true


/* ================= CONSUMO ANTERIOR (neto NotCr) ================= */
LEFT JOIN LATERAL (
  SELECT ${signedSumFactura('f3', 'dd3', 'total')} AS consumo_anterior
  FROM facturas f3
  JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
  WHERE f3.customer_code = base.customer_code
    AND (
      (f3.seller_code ILIKE 'A%' AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC') ${fDD3})
      ${incluirSuscripcion ? "OR dd3.descripcion_categoria = 'SUSCRIPCION'" : ''}
      OR (f3.equipo_ventas = 'Website' AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC') ${fDD3})
    )
    AND f3.status = 2
    AND f3.fecha_creacion >= :iniAnt
    AND f3.fecha_creacion <  :finAnt
) ant ON true


/* ================= MAX CONSUMO ================= */
LEFT JOIN LATERAL (
  SELECT MAX(dd4.total) AS max_consumo
  FROM facturas f4
  JOIN detalle_documento dd4 ON dd4.documento_code = f4.code
  WHERE f4.customer_code = base.customer_code
    AND (
      (f4.seller_code ILIKE 'A%' AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC') ${fDD4})
      ${incluirSuscripcion ? "OR dd4.descripcion_categoria = 'SUSCRIPCION'" : ''}
      OR (f4.equipo_ventas = 'Website' AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC') ${fDD4})
    )
    AND f4.status IN (0,2,3,4,5)
) mx ON true


/* ================= ÚLTIMA FACTURA ================= */
LEFT JOIN LATERAL (
  SELECT MAX(f5.fecha_creacion)::date AS ultima_factura
  FROM facturas f5
  JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
  WHERE f5.customer_code = base.customer_code
    AND (
      (f5.seller_code ILIKE 'A%' AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC') ${fDD5})
      ${incluirSuscripcion ? "OR dd5.descripcion_categoria = 'SUSCRIPCION'" : ''}
      OR (f5.equipo_ventas = 'Website' AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC') ${fDD5})
    )
    AND f5.status IN (0,2,3,4,5)
) ult ON true

ORDER BY consumo_actual DESC NULLS LAST;
`, {
      replacements: { inicio, fin, iniAnt, finAnt },
      type: Sequelize.QueryTypes.SELECT,
    });

    const totalClientes = clientes.length;
    const clientesConConsumo = clientes.filter(c => Number(c.consumo_actual) > 0).length;
    const clientesSinConsumo = totalClientes - clientesConConsumo;

const productosVendidos = await sequelize.query(`
WITH base AS (

  /* ================= FACTURAS DOMICILIO (A1..A7 + TA2) ================= */
  SELECT
    dd.descripcion,
    dd.descripcion_categoria,
    dd.cantidad,
    dd.total
  FROM facturas f
  JOIN detalle_documento dd
    ON dd.documento_code = f.code
  WHERE
    f.status = 2
    AND ${buildFiltroCategoriaBotellonOSuscripcion(tipoProducto, 'dd', 'f')}
    AND f.fecha_creacion >= :inicio
    AND f.fecha_creacion <  :fin
    AND f.seller_code IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')

  UNION ALL

  /* ================= WEBSITE (ORDENES) ================= */
  SELECT
    dd.descripcion,
    dd.descripcion_categoria,
    dd.cantidad,
    dd.total
  FROM ordenes o
  JOIN detalle_documento dd
    ON dd.documento_code = o.code
  WHERE
    o.status = 2
    AND o.equipo_ventas = 'Website'
    AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
    ${fDD}
    AND o.fecha_creacion >= :inicio
    AND o.fecha_creacion <  :fin

  ${incluirSuscripcion ? `UNION ALL

  /* ================= SUSCRIPCIÓN (FORMA EXACTA DEL QUERY PRINCIPAL) ================= */
  SELECT
    'SUSCRIPCIÓN' AS descripcion,
    'SUSCRIPCION' AS descripcion_categoria,
    COUNT(DISTINCT dd.id_detalle) AS cantidad,
    ${signedSumFactura('f', 'dd', 'total')} AS total
  FROM facturas f
  JOIN detalle_documento dd
    ON dd.documento_code = f.code
  WHERE
    f.status = 2
    AND dd.descripcion_categoria = 'SUSCRIPCION'
    AND f.fecha_creacion >= :inicio
    AND f.fecha_creacion <  :fin` : ''}

)

SELECT
  CASE
    WHEN descripcion_categoria = 'SUSCRIPCION' THEN 'SUSCRIPCIÓN'
    ELSE descripcion
  END AS producto,

  SUM(cantidad) AS unidades_vendidas,
  SUM(total)    AS monto_usd

FROM base
GROUP BY 1
ORDER BY unidades_vendidas DESC;
`, {
  replacements: { inicio, fin },
  type: Sequelize.QueryTypes.SELECT
});

    return res.json({
      clientes,
      resumen: { totalClientes, clientesConConsumo, clientesSinConsumo },
      productosVendidos: dedupeProductosVendidos(productosVendidos),
    });
  } catch (error) {
    console.error('❌ ERROR CLIENTES DOMICILIO BOTELLÓN:', error);
    return res.status(500).json({ message: 'Error al obtener clientes Domicilio', detail: error.message });
  }
};

/* ======================================================
   CLIENTES EMPRESAS BOTELLÓN (consolidado MobilVendor + Odoo)
   GET /api/botellones/clientes-empresas?anio=YYYY&mes=MM
====================================================== */
const obtenerClientesEmpresasBotellon = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    // Placeholders para rutas Odoo
    const rutasRepl = {};
    RUTAS_ODOO_EMPRESAS.forEach((r, i) => { rutasRepl[`re${i}`] = r; });
    const rutasPH = RUTAS_ODOO_EMPRESAS.map((_, i) => `:re${i}`).join(', ');

    // Empresas clientes: mezcla facturas (f*) y ordenes Odoo (o*). Variantes:
    //  - sin aliasFactura → para ordenes
    //  - con aliasFactura → para facturas (aplica regla NotCr)
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3');
    const fDD4 = buildFiltroProductoBotellon(tipoProducto, 'dd4');
    const fDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5');
    const fDD = buildFiltroProductoBotellon(tipoProducto, 'dd');
    const fDD0Fact = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD2Fact = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3Fact = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD4Fact = buildFiltroProductoBotellon(tipoProducto, 'dd4', 'f4');
    const fDD5Fact = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');
    const fDDFact = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

    const clientes = await sequelize.query(`
      SELECT
        base.customer_code                                                          AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)                              AS nombre_cliente,
        COALESCE(dc.calle1_direccion_cliente, c.direccion_cliente, '')              AS direccion_entrega,
        COALESCE(tn.descripcion, '')                                                AS tipo_negocio,
        COALESCE(dc.telefono_direccion_cliente, c.telefono_cliente, '')             AS telefono,
        COALESCE(dc.latitud_direccion_cliente::text,  c.latitud_cliente::text,  '') AS latitud,
        COALESCE(dc.longitud_direccion_cliente::text, c.longitud_cliente::text, '') AS longitud,
        COALESCE(act.cantidad_actual,  0)                                           AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                                           AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                                           AS consumo_anterior,
        COALESCE(mx.max_consumo,       0)                                           AS max_consumo,
        ult.ultima_factura
      FROM (
        SELECT DISTINCT src.customer_code FROM (
          -- MobilVendor facturas E%
          SELECT f0.customer_code FROM facturas f0
          JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
          WHERE f0.seller_code ILIKE 'E%' AND f0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0Fact}
            AND f0.fecha_creacion >= :iniYear AND f0.fecha_creacion < :finYear
          UNION
          -- Odoo ordenes empresa (excluye POS)
          SELECT o0.customer_code FROM ordenes o0
          JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
          WHERE o0.equipo_ventas = 'Empresas'
            AND o0.type = 2 AND o0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0}
            AND o0.fecha_creacion >= :iniYear AND o0.fecha_creacion < :finYear
            AND o0.equipo_ventas <> 'Point of Sale'
        ) src
      ) base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT calle1_direccion_cliente, telefono_direccion_cliente,
               latitud_direccion_cliente, longitud_direccion_cliente
        FROM direcciones_clientes
        WHERE codigo_cliente = base.customer_code
        ORDER BY
          (latitud_direccion_cliente  IS NOT NULL AND longitud_direccion_cliente IS NOT NULL) DESC,
          (telefono_direccion_cliente IS NOT NULL) DESC
        LIMIT 1
      ) dc ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.cantidad), 0) AS cantidad_actual,
               COALESCE(SUM(sub.total),   0) AS consumo_actual
        FROM (
          SELECT ${signedColFactura('f2', 'dd2', 'cantidad')} AS cantidad,
                 ${signedColFactura('f2', 'dd2', 'total')}    AS total
          FROM facturas f2
          JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
          WHERE f2.customer_code = base.customer_code AND f2.seller_code ILIKE 'E%'
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC') ${fDD2Fact} AND f2.status = 2
            AND f2.fecha_creacion >= :inicio AND f2.fecha_creacion < :fin
          UNION ALL
          SELECT dd2.cantidad, dd2.total FROM ordenes o2
          JOIN detalle_documento dd2 ON dd2.documento_code = o2.code
          WHERE o2.customer_code = base.customer_code
            AND o2.equipo_ventas = 'Empresas'
            AND o2.type = 2 AND o2.status = 2
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
            ${fDD2}
            AND o2.fecha_creacion >= :inicio AND o2.fecha_creacion < :fin
        ) sub
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.total), 0) AS consumo_anterior
        FROM (
          SELECT ${signedColFactura('f3', 'dd3', 'total')} AS total
          FROM facturas f3
          JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
          WHERE f3.customer_code = base.customer_code AND f3.seller_code ILIKE 'E%'
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC') ${fDD3Fact} AND f3.status = 2
            AND f3.fecha_creacion >= :iniAnt AND f3.fecha_creacion < :finAnt
          UNION ALL
          SELECT dd3.total FROM ordenes o3
          JOIN detalle_documento dd3 ON dd3.documento_code = o3.code
          WHERE o3.customer_code = base.customer_code
            AND o3.equipo_ventas = 'Empresas'
            AND o3.type = 2 AND o3.status = 2
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
            ${fDD3}
            AND o3.fecha_creacion >= :iniAnt AND o3.fecha_creacion < :finAnt
        ) sub
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(sub.total), 0) AS max_consumo
        FROM (
          -- MAX: excluir NotCr (queremos pico real de consumo, no refund)
          SELECT dd4.total FROM facturas f4
          JOIN detalle_documento dd4 ON dd4.documento_code = f4.code
          WHERE f4.customer_code = base.customer_code AND f4.seller_code ILIKE 'E%'
            AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC') ${fDD4Fact} AND f4.status IN (2,4,5)
            AND f4.tipo_movimiento <> 'out_refund'
          UNION ALL
          SELECT dd4.total FROM ordenes o4
          JOIN detalle_documento dd4 ON dd4.documento_code = o4.code
          WHERE o4.customer_code = base.customer_code
            AND o4.equipo_ventas = 'Empresas'
            AND o4.type = 2 AND o4.status IN (2,4,5)
            AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC')
            ${fDD4}
        ) sub
      ) mx ON true
      LEFT JOIN LATERAL (
        SELECT GREATEST(
          (SELECT MAX(f5.fecha_creacion)::date FROM facturas f5
           JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
           WHERE f5.customer_code = base.customer_code AND f5.seller_code ILIKE 'E%'
             AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC') ${fDD5Fact} AND f5.status IN (2,4,5)),
          (SELECT MAX(o5.fecha_creacion)::date FROM ordenes o5
           JOIN detalle_documento dd5 ON dd5.documento_code = o5.code
           WHERE o5.customer_code = base.customer_code
             AND o5.equipo_ventas = 'Empresas'
             AND o5.type = 2 AND o5.status IN (2,4,5)
             AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC') ${fDD5})
        ) AS ultima_factura
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `, {
      replacements: { iniYear, finYear, inicio, fin, iniAnt, finAnt, ...rutasRepl },
      type: Sequelize.QueryTypes.SELECT,
    });

    const totalClientes = clientes.length;
    const clientesConConsumo = clientes.filter(c => Number(c.consumo_actual) > 0).length;
    const clientesSinConsumo = totalClientes - clientesConConsumo;

    // Productos vendidos consolidados (facturas E% + ordenes Odoo)
    const productosVendidos = await sequelize.query(`
      SELECT
        sub.descripcion  AS producto,
        SUM(sub.cantidad) AS unidades_vendidas,
        SUM(sub.total)    AS monto_usd
      FROM (
        -- Facturas E%: signed sum + excluye facturas de clientes VIP
        SELECT dd.descripcion,
               CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS cantidad,
               CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS total
        FROM facturas f
        JOIN detalle_documento dd ON dd.documento_code = f.code
        WHERE f.seller_code ILIKE 'E%' AND f.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${fDDFact}
          AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        UNION ALL
        -- Ordenes Odoo Empresas (equipo de ventas)
        SELECT dd.descripcion, dd.cantidad, dd.total
        FROM ordenes o
        JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.equipo_ventas = 'Empresas'
          AND o.type = 2 AND o.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${fDD}
          AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
      ) sub
      GROUP BY sub.descripcion
      ORDER BY unidades_vendidas DESC
    `, {
      replacements: { inicio, fin, ...rutasRepl },
      type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({
      clientes,
      resumen: { totalClientes, clientesConConsumo, clientesSinConsumo },
      productosVendidos: dedupeProductosVendidos(productosVendidos).map(p => ({
        producto: p.producto,
        unidades: Number(p.unidades_vendidas || 0),
        monto: Number(p.monto_usd || 0),
      })),
    });
  } catch (error) {
    console.error('❌ ERROR CLIENTES EMPRESAS BOTELLÓN:', error);
    return res.status(500).json({ message: 'Error al obtener clientes Empresas', detail: error.message });
  }
};

/* ======================================================
   VIP — SUBCANALES (tipos_negocio con totales)
   GET /api/botellones/vip-subcanales?anio=YYYY&mes=MM
====================================================== */
const obtenerVipSubcanales = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    // Todas las queries de VIP-subcanales son sobre facturas (alias f0/f2/f3/f)
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

    /*
     * Clientes VIP identificados directamente por f.codigo_tipo_negocio y f.codigo_subcanal
     * en la tabla facturas (campos nuevos sincronizados desde Odoo, igual que en ordenes).
     * Agrupamos por canal (tipos_negocio) → subcanal (subcanales) usando los campos de la factura.
     */
    const subcanales = await sequelize.query(`
      SELECT
        COALESCE(tn.descripcion, 'Sin Canal')                                   AS canal,
        COALESCE(sc.descripcion_subcanal, 'Sin Clasificar')                     AS subcanal,
        COALESCE(base.codigo_subcanal, '')                                      AS codigo_subcanal,
        COUNT(DISTINCT base.customer_code)                                       AS total_clientes,
        COUNT(DISTINCT CASE WHEN COALESCE(act.consumo_actual, 0) > 0
              THEN base.customer_code END)                                       AS clientes_con_consumo,
        COALESCE(SUM(act.cantidad_actual), 0)                                   AS unidades_actual,
        COALESCE(SUM(act.consumo_actual),  0)                                   AS monto_actual,
        COALESCE(SUM(ant.consumo_anterior),0)                                   AS monto_anterior
      FROM (
        -- Universo VIP: customer_code de facturas con codigo_tipo_negocio '29' + BOTELLÓN en el año
        -- El canal/subcanal viene de los campos codigo_tipo_negocio y codigo_subcanal de la factura
        SELECT DISTINCT f0.customer_code, f0.codigo_tipo_negocio, f0.codigo_subcanal
        FROM facturas f0
        JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
        WHERE f0.codigo_tipo_negocio = '29'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${fDD0}
          AND f0.status = 2
          AND f0.fecha_creacion >= :iniYear
          AND f0.fecha_creacion <  :finYear
      ) base
      -- Canal y subcanal desde los campos directos de la factura
      LEFT JOIN subcanales sc ON sc.codigo_subcanal = base.codigo_subcanal
      LEFT JOIN tipos_negocio tn ON tn.codigo = sc.codigo_tipo_negocio
      -- Métricas del mes actual por customer_code + tipo_negocio VIP + BOTELLÓN (neto NotCr)
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f2', 'dd2', 'cantidad')} AS cantidad_actual,
               ${signedSumFactura('f2', 'dd2', 'total')}    AS consumo_actual
        FROM facturas f2
        JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
        WHERE f2.customer_code = base.customer_code
          AND f2.codigo_tipo_negocio = '29'
          AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
          ${fDD2}
          AND f2.status = 2
          AND f2.fecha_creacion >= :inicio
          AND f2.fecha_creacion <  :fin
      ) act ON true
      -- Métricas del mes anterior (neto NotCr)
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f3', 'dd3', 'total')} AS consumo_anterior
        FROM facturas f3
        JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
        WHERE f3.customer_code = base.customer_code
          AND f3.codigo_tipo_negocio = '29'
          AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
          ${fDD3}
          AND f3.status = 2
          AND f3.fecha_creacion >= :iniAnt
          AND f3.fecha_creacion <  :finAnt
      ) ant ON true
      GROUP BY COALESCE(tn.descripcion, 'Sin Canal'),
               COALESCE(sc.descripcion_subcanal, 'Sin Clasificar'),
               COALESCE(base.codigo_subcanal, '')
      ORDER BY canal, monto_actual DESC NULLS LAST
    `, {
      replacements: { iniYear, finYear, inicio, fin, iniAnt, finAnt },
      type: Sequelize.QueryTypes.SELECT,
    });

    // Alineado con la tabla principal VIP: el CASE WHEN de obtenerGrupoBotellon
    // asigna a VIP solo facturas cuyo seller_code NO matchee otros grupos.
    const productosVendidos = await sequelize.query(`
      SELECT dd.descripcion AS producto,
             ${signedSumFactura('f', 'dd', 'cantidad')} AS unidades_vendidas,
             ${signedSumFactura('f', 'dd', 'total')}    AS monto_usd
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.codigo_tipo_negocio = '29'
        AND f.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${fDD}
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        AND (f.seller_code IS NULL OR (
          f.seller_code NOT IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2')
          AND f.seller_code NOT ILIKE 'M%'
          AND f.seller_code NOT ILIKE 'E%'
          AND f.seller_code NOT ILIKE 'R%'
          AND f.seller_code NOT ILIKE 'T%'
        ))
      GROUP BY dd.descripcion
      ORDER BY unidades_vendidas DESC
    `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });

    return res.json({ subcanales, productosVendidos: dedupeProductosVendidos(productosVendidos) });
  } catch (error) {
    console.error('❌ ERROR VIP SUBCANALES:', error);
    return res.status(500).json({ message: 'Error al obtener subcanales VIP', detail: error.message });
  }
};

/* ======================================================
   VIP — CLIENTES POR TIPO DE NEGOCIO
   GET /api/botellones/vip-clientes-tipo?tipo=X&anio=YYYY&mes=MM
====================================================== */
const obtenerVipClientesPorTipo = async (req, res) => {
  try {
    const { tipo, anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    // VIP clientes-por-tipo: todas las queries usan facturas (f0/f0b/f2/f3/f4/f5)
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD0b = buildFiltroProductoBotellon(tipoProducto, 'dd0b', 'f0b');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD4 = buildFiltroProductoBotellon(tipoProducto, 'dd4', 'f4');
    const fDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');

    const clientes = await sequelize.query(`
      SELECT
        base.customer_code                                                        AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)                           AS nombre_cliente,
        COALESCE(sc.descripcion_subcanal, 'Sin Clasificar')                      AS tipo_negocio,
        COALESCE(tn.descripcion, 'Sin Canal')                                    AS canal,
        COALESCE(dc.telefono_direccion_cliente, c.telefono_cliente, '')          AS telefono,
        COALESCE(act.cantidad_actual,  0)                                        AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                                        AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                                        AS consumo_anterior,
        COALESCE(mx.max_consumo,       0)                                        AS max_consumo,
        ult.ultima_factura,
        COALESCE(nsuc.total_sucursales, 1)                                       AS total_sucursales
      FROM (
        -- Universo VIP: customer_code con código_subcanal y tipo_negocio desde la factura
        SELECT DISTINCT f0.customer_code, f0.codigo_tipo_negocio, f0.codigo_subcanal
        FROM facturas f0
        JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
        WHERE f0.codigo_tipo_negocio = '29'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${fDD0}
          AND f0.status = 2
          AND f0.fecha_creacion >= :iniYear
          AND f0.fecha_creacion <  :finYear
      ) base
      -- Nombre e info del cliente
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      -- Canal y subcanal desde campos directos de la factura
      LEFT JOIN subcanales sc ON sc.codigo_subcanal = base.codigo_subcanal
      LEFT JOIN tipos_negocio tn ON tn.codigo = sc.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT telefono_direccion_cliente
        FROM direcciones_clientes
        WHERE codigo_cliente = base.customer_code
        ORDER BY (telefono_direccion_cliente IS NOT NULL) DESC
        LIMIT 1
      ) dc ON true
      -- Sucursales del cliente — por customer_code
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT f0b.customer_address_code) AS total_sucursales
        FROM facturas f0b
        JOIN detalle_documento dd0b ON dd0b.documento_code = f0b.code
        WHERE f0b.customer_code = base.customer_code
          AND (dd0b.descripcion_categoria = 'BOTELLÓN' OR dd0b.producto_codigo_interno = 'DISC')
          ${fDD0b}
          AND f0b.status = 2
      ) nsuc ON true
      -- Consumo mes actual (neto NotCr) — por customer_code, sin filtrar seller
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f2', 'dd2', 'cantidad')} AS cantidad_actual,
               ${signedSumFactura('f2', 'dd2', 'total')}    AS consumo_actual
        FROM facturas f2
        JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
        WHERE f2.customer_code = base.customer_code
          AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
          ${fDD2}
          AND f2.status = 2
          AND f2.fecha_creacion >= :inicio
          AND f2.fecha_creacion <  :fin
      ) act ON true
      -- Consumo mes anterior (neto NotCr) — por customer_code, sin filtrar seller
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f3', 'dd3', 'total')} AS consumo_anterior
        FROM facturas f3
        JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
        WHERE f3.customer_code = base.customer_code
          AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
          ${fDD3}
          AND f3.status = 2
          AND f3.fecha_creacion >= :iniAnt
          AND f3.fecha_creacion <  :finAnt
      ) ant ON true
      -- Máximo histórico — por customer_code
      LEFT JOIN LATERAL (
        SELECT MAX(dd4.total) AS max_consumo
        FROM facturas f4
        JOIN detalle_documento dd4 ON dd4.documento_code = f4.code
        WHERE f4.customer_code = base.customer_code
          AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC')
          ${fDD4}
          AND f4.status IN (2,4,5)
      ) mx ON true
      -- Última factura — por customer_code
      LEFT JOIN LATERAL (
        SELECT MAX(f5.fecha_creacion)::date AS ultima_factura
        FROM facturas f5
        JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
        WHERE f5.customer_code = base.customer_code
          AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC')
          ${fDD5}
          AND f5.status IN (2,4,5)
      ) ult ON true
      WHERE COALESCE(sc.descripcion_subcanal, 'Sin Clasificar') = :tipo
      ORDER BY consumo_actual DESC NULLS LAST
    `, {
      replacements: { iniYear, finYear, inicio, fin, iniAnt, finAnt, tipo: tipo || '' },
      type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({ clientes });
  } catch (error) {
    console.error('❌ ERROR VIP CLIENTES POR TIPO:', error);
    return res.status(500).json({ message: 'Error al obtener clientes VIP por tipo', detail: error.message });
  }
};

/* ======================================================
   VIP — DETALLE POR SUCURSAL (customer_address_code)
   GET /api/botellones/vip-cliente-detalle?clienteCode=X&anio=YYYY&mes=MM
====================================================== */
const obtenerVipDetalleCliente = async (req, res) => {
  try {
    const { clienteCode, anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!clienteCode || !anio || !mes)
      return res.status(400).json({ error: 'clienteCode, anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );

    // VIP detalle-cliente: queries sobre facturas (f0/f2/f3/f5)
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');

    const clienteInfo = await sequelize.query(`
      SELECT c.nombre_cliente,
             COALESCE(tn.descripcion, 'Sin Clasificar') AS tipo_negocio,
             c.telefono_cliente AS telefono
      FROM clientes c
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      WHERE c.codigo_cliente = :clienteCode
    `, { replacements: { clienteCode }, type: Sequelize.QueryTypes.SELECT });

    const sucursales = await sequelize.query(`
      SELECT
        CASE
          WHEN LOWER(TRIM(COALESCE(dc.descripcion_direccion_cliente,''))) = ANY(ARRAY['delivery','invoice','contact','private','other',''])
          THEN COALESCE(dc.calle1_direccion_cliente, base.customer_address_code::text)
          ELSE COALESCE(NULLIF(TRIM(dc.descripcion_direccion_cliente),''), dc.calle1_direccion_cliente, base.customer_address_code::text)
        END AS nombre_sucursal,
        COALESCE(dc.calle1_direccion_cliente, '')                                                               AS direccion,
        COALESCE(dc.codigo_direccion_cliente,   base.customer_address_code::text)                               AS codigo_sucursal,
        COALESCE(dc.telefono_direccion_cliente, '')                              AS telefono,
        COALESCE(dc.latitud_direccion_cliente::text,  '')                        AS latitud,
        COALESCE(dc.longitud_direccion_cliente::text, '')                        AS longitud,
        base.customer_address_code,
        COALESCE(act.cantidad_actual,  0)                                        AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                                        AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                                        AS consumo_anterior,
        ult.ultima_factura
      FROM (
        SELECT DISTINCT f0.customer_address_code
        FROM facturas f0
        JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
        WHERE f0.customer_code = :clienteCode
          AND f0.codigo_tipo_negocio = '29'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${fDD0}
          AND f0.status = 2
      ) base
      LEFT JOIN direcciones_clientes dc
             ON dc.codigo_cliente           = :clienteCode
            AND dc.codigo_direccion_cliente = base.customer_address_code
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f2', 'dd2', 'cantidad')} AS cantidad_actual,
               ${signedSumFactura('f2', 'dd2', 'total')}    AS consumo_actual
        FROM facturas f2
        JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
        WHERE f2.customer_code         = :clienteCode
          AND f2.customer_address_code = base.customer_address_code
          AND f2.codigo_tipo_negocio = '29'
          AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
          ${fDD2}
          AND f2.status = 2
          AND f2.fecha_creacion >= :inicio
          AND f2.fecha_creacion <  :fin
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT ${signedSumFactura('f3', 'dd3', 'total')} AS consumo_anterior
        FROM facturas f3
        JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
        WHERE f3.customer_code         = :clienteCode
          AND f3.customer_address_code = base.customer_address_code
          AND f3.codigo_tipo_negocio = '29'
          AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
          ${fDD3}
          AND f3.status = 2
          AND f3.fecha_creacion >= :iniAnt
          AND f3.fecha_creacion <  :finAnt
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT MAX(f5.fecha_creacion)::date AS ultima_factura
        FROM facturas f5
        JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
        WHERE f5.customer_code         = :clienteCode
          AND f5.customer_address_code = base.customer_address_code
          AND f5.codigo_tipo_negocio = '29'
          AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC')
          ${fDD5}
          AND f5.status IN (2,4,5)
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `, {
      replacements: { clienteCode, inicio, fin, iniAnt, finAnt },
      type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({
      cliente: clienteInfo[0] || { nombre_cliente: clienteCode, tipo_negocio: '—', telefono: '' },
      sucursales,
    });
  } catch (error) {
    console.error('❌ ERROR VIP DETALLE CLIENTE:', error);
    return res.status(500).json({ message: 'Error al obtener detalle cliente VIP', detail: error.message });
  }
};

/* ======================================================
   EMPRESAS — SUBCANALES (tipos_negocio con totales)
   GET /api/botellones/empresas-subcanales?anio=YYYY&mes=MM
====================================================== */
const obtenerEmpresasSubcanales = async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    const rutasRepl = {};
    RUTAS_ODOO_EMPRESAS.forEach((r, i) => { rutasRepl[`re${i}`] = r; });
    const rutasPH = RUTAS_ODOO_EMPRESAS.map((_, i) => `:re${i}`).join(', ');

    // Empresas mezcla facturas (f*) y ordenes Odoo (o*). Necesitamos variantes:
    //  - sin aliasFactura → para subqueries sobre ordenes (no aplica NotCr)
    //  - con aliasFactura → para subqueries sobre facturas (aplica NotCr)
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3');
    const fDD = buildFiltroProductoBotellon(tipoProducto, 'dd');
    const fDD0Fact = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD2Fact = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3Fact = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDDFact = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

    const subcanales = await sequelize.query(`
      SELECT
        COALESCE(tn.descripcion, 'EMPRESA')                                     AS tipo_negocio,
        COUNT(DISTINCT base.customer_code)                                       AS total_clientes,
        COUNT(DISTINCT CASE WHEN COALESCE(act.consumo_actual, 0) > 0
              THEN base.customer_code END)                                       AS clientes_con_consumo,
        COALESCE(SUM(act.cantidad_actual), 0)                                   AS unidades_actual,
        COALESCE(SUM(act.consumo_actual),  0)                                   AS monto_actual,
        COALESCE(SUM(ant.consumo_anterior),0)                                   AS monto_anterior
      FROM (
        SELECT DISTINCT src.customer_code FROM (
          SELECT f0.customer_code FROM facturas f0
          JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
          WHERE f0.seller_code ILIKE 'E%' AND f0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0Fact}
            AND f0.fecha_creacion >= :iniYear AND f0.fecha_creacion < :finYear
          UNION
          SELECT o0.customer_code FROM ordenes o0
          JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
          WHERE o0.equipo_ventas = 'Empresas'
            AND o0.type = 2 AND o0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0}
            AND o0.fecha_creacion >= :iniYear AND o0.fecha_creacion < :finYear
            AND o0.equipo_ventas <> 'Point of Sale'
        ) src
      ) base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.cantidad), 0) AS cantidad_actual,
               COALESCE(SUM(sub.total),   0) AS consumo_actual
        FROM (
          SELECT ${signedColFactura('f2', 'dd2', 'cantidad')} AS cantidad,
                 ${signedColFactura('f2', 'dd2', 'total')}    AS total
          FROM facturas f2
          JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
          WHERE f2.customer_code = base.customer_code AND f2.seller_code ILIKE 'E%'
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC') ${fDD2Fact} AND f2.status = 2
            AND f2.fecha_creacion >= :inicio AND f2.fecha_creacion < :fin
          UNION ALL
          SELECT dd2.cantidad, dd2.total FROM ordenes o2
          JOIN detalle_documento dd2 ON dd2.documento_code = o2.code
          WHERE o2.customer_code = base.customer_code
            AND o2.equipo_ventas = 'Empresas'
            AND o2.type = 2 AND o2.status = 2
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
            ${fDD2}
            AND o2.fecha_creacion >= :inicio AND o2.fecha_creacion < :fin
        ) sub
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.total), 0) AS consumo_anterior
        FROM (
          SELECT ${signedColFactura('f3', 'dd3', 'total')} AS total
          FROM facturas f3
          JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
          WHERE f3.customer_code = base.customer_code AND f3.seller_code ILIKE 'E%'
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC') ${fDD3Fact} AND f3.status = 2
            AND f3.fecha_creacion >= :iniAnt AND f3.fecha_creacion < :finAnt
          UNION ALL
          SELECT dd3.total FROM ordenes o3
          JOIN detalle_documento dd3 ON dd3.documento_code = o3.code
          WHERE o3.customer_code = base.customer_code
            AND o3.equipo_ventas = 'Empresas'
            AND o3.type = 2 AND o3.status = 2
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
            ${fDD3}
            AND o3.fecha_creacion >= :iniAnt AND o3.fecha_creacion < :finAnt
        ) sub
      ) ant ON true
      GROUP BY COALESCE(tn.descripcion, 'EMPRESA')
      ORDER BY monto_actual DESC NULLS LAST
    `, {
      replacements: { iniYear, finYear, inicio, fin, iniAnt, finAnt, ...rutasRepl },
      type: Sequelize.QueryTypes.SELECT,
    });

    const productosVendidos = await sequelize.query(`
      SELECT sub.descripcion AS producto,
             SUM(sub.cantidad) AS unidades_vendidas,
             SUM(sub.total)    AS monto_usd
      FROM (
        -- Facturas E%: signed sum + excluye clientes VIP
        SELECT dd.descripcion,
               CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS cantidad,
               CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS total
        FROM facturas f
        JOIN detalle_documento dd ON dd.documento_code = f.code
        WHERE f.seller_code ILIKE 'E%' AND f.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${fDDFact}
          AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
        UNION ALL
        -- Ordenes Odoo Empresas (equipo de ventas)
        SELECT dd.descripcion, dd.cantidad, dd.total
        FROM ordenes o
        JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.equipo_ventas = 'Empresas'
          AND o.type = 2 AND o.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${fDD}
          AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
      ) sub
      GROUP BY sub.descripcion
      ORDER BY unidades_vendidas DESC
    `, { replacements: { inicio, fin, ...rutasRepl }, type: Sequelize.QueryTypes.SELECT });

    return res.json({ subcanales, productosVendidos: dedupeProductosVendidos(productosVendidos) });
  } catch (error) {
    console.error('❌ ERROR EMPRESAS SUBCANALES:', error);
    return res.status(500).json({ message: 'Error al obtener subcanales Empresas', detail: error.message });
  }
};

/* ======================================================
   EMPRESAS — CLIENTES POR TIPO DE NEGOCIO
   GET /api/botellones/empresas-clientes-tipo?tipo=X&anio=YYYY&mes=MM
====================================================== */
const obtenerEmpresasClientesPorTipo = async (req, res) => {
  try {
    const { tipo, anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    const rutasRepl = {};
    RUTAS_ODOO_EMPRESAS.forEach((r, i) => { rutasRepl[`re${i}`] = r; });
    const rutasPH = RUTAS_ODOO_EMPRESAS.map((_, i) => `:re${i}`).join(', ');

    // Empresas clientes-por-tipo: mezcla facturas + ordenes Odoo
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0');
    const fDD0b = buildFiltroProductoBotellon(tipoProducto, 'dd0b');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3');
    const fDD4 = buildFiltroProductoBotellon(tipoProducto, 'dd4');
    const fDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5');
    const fDD0Fact = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD0bFact = buildFiltroProductoBotellon(tipoProducto, 'dd0b', 'f0b');
    const fDD2Fact = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3Fact = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD4Fact = buildFiltroProductoBotellon(tipoProducto, 'dd4', 'f4');
    const fDD5Fact = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');

    const clientes = await sequelize.query(`
      SELECT
        base.customer_code                                                          AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)                             AS nombre_cliente,
        COALESCE(tn.descripcion, 'EMPRESA')                                        AS tipo_negocio,
        COALESCE(dc.telefono_direccion_cliente, c.telefono_cliente, '')            AS telefono,
        COALESCE(act.cantidad_actual,  0)                                          AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                                          AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                                          AS consumo_anterior,
        COALESCE(mx.max_consumo,       0)                                          AS max_consumo,
        ult.ultima_factura,
        COALESCE(nsuc.total_sucursales, 1)                                         AS total_sucursales
      FROM (
        SELECT DISTINCT src.customer_code FROM (
          SELECT f0.customer_code FROM facturas f0
          JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
          WHERE f0.seller_code ILIKE 'E%' AND f0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0Fact}
            AND f0.fecha_creacion >= :iniYear AND f0.fecha_creacion < :finYear
          UNION
          SELECT o0.customer_code FROM ordenes o0
          JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
          WHERE o0.equipo_ventas = 'Empresas'
            AND o0.type = 2 AND o0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0}
            AND o0.fecha_creacion >= :iniYear AND o0.fecha_creacion < :finYear
            AND o0.equipo_ventas <> 'Point of Sale'
        ) src
      ) base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT telefono_direccion_cliente
        FROM direcciones_clientes
        WHERE codigo_cliente = base.customer_code
        ORDER BY (telefono_direccion_cliente IS NOT NULL) DESC
        LIMIT 1
      ) dc ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT suc_code) AS total_sucursales
        FROM (
          SELECT f0b.customer_address_code::text AS suc_code
          FROM facturas f0b
          JOIN detalle_documento dd0b ON dd0b.documento_code = f0b.code
          WHERE f0b.customer_code = base.customer_code
            AND f0b.seller_code ILIKE 'E%'
            AND (dd0b.descripcion_categoria = 'BOTELLÓN' OR dd0b.producto_codigo_interno = 'DISC')
            ${fDD0bFact}
            AND f0b.status = 2
          UNION
          SELECT o0b.customer_address_code::text AS suc_code
          FROM ordenes o0b
          JOIN detalle_documento dd0b ON dd0b.documento_code = o0b.code
          WHERE o0b.customer_code = base.customer_code
            AND o0b.equipo_ventas = 'Empresas'
            AND o0b.type = 2 AND o0b.status = 2
            AND (dd0b.descripcion_categoria = 'BOTELLÓN' OR dd0b.producto_codigo_interno = 'DISC')
            ${fDD0b}
        ) suc_all
        WHERE suc_code IS NOT NULL
      ) nsuc ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.cantidad), 0) AS cantidad_actual,
               COALESCE(SUM(sub.total),   0) AS consumo_actual
        FROM (
          SELECT ${signedColFactura('f2', 'dd2', 'cantidad')} AS cantidad,
                 ${signedColFactura('f2', 'dd2', 'total')}    AS total
          FROM facturas f2
          JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
          WHERE f2.customer_code = base.customer_code AND f2.seller_code ILIKE 'E%'
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC') ${fDD2Fact} AND f2.status = 2
            AND f2.fecha_creacion >= :inicio AND f2.fecha_creacion < :fin
          UNION ALL
          SELECT dd2.cantidad, dd2.total FROM ordenes o2
          JOIN detalle_documento dd2 ON dd2.documento_code = o2.code
          WHERE o2.customer_code = base.customer_code
            AND o2.equipo_ventas = 'Empresas'
            AND o2.type = 2 AND o2.status = 2
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
            ${fDD2}
            AND o2.fecha_creacion >= :inicio AND o2.fecha_creacion < :fin
        ) sub
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.total), 0) AS consumo_anterior
        FROM (
          SELECT ${signedColFactura('f3', 'dd3', 'total')} AS total
          FROM facturas f3
          JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
          WHERE f3.customer_code = base.customer_code AND f3.seller_code ILIKE 'E%'
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC') ${fDD3Fact} AND f3.status = 2
            AND f3.fecha_creacion >= :iniAnt AND f3.fecha_creacion < :finAnt
          UNION ALL
          SELECT dd3.total FROM ordenes o3
          JOIN detalle_documento dd3 ON dd3.documento_code = o3.code
          WHERE o3.customer_code = base.customer_code
            AND o3.equipo_ventas = 'Empresas'
            AND o3.type = 2 AND o3.status = 2
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
            ${fDD3}
            AND o3.fecha_creacion >= :iniAnt AND o3.fecha_creacion < :finAnt
        ) sub
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(sub.total), 0) AS max_consumo
        FROM (
          -- MAX: excluir NotCr (queremos pico real de consumo, no refund)
          SELECT dd4.total FROM facturas f4
          JOIN detalle_documento dd4 ON dd4.documento_code = f4.code
          WHERE f4.customer_code = base.customer_code AND f4.seller_code ILIKE 'E%'
            AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC') ${fDD4Fact} AND f4.status IN (2,4,5)
            AND f4.tipo_movimiento <> 'out_refund'
          UNION ALL
          SELECT dd4.total FROM ordenes o4
          JOIN detalle_documento dd4 ON dd4.documento_code = o4.code
          WHERE o4.customer_code = base.customer_code
            AND o4.equipo_ventas = 'Empresas'
            AND o4.type = 2 AND o4.status IN (2,4,5)
            AND (dd4.descripcion_categoria = 'BOTELLÓN' OR dd4.producto_codigo_interno = 'DISC')
            ${fDD4}
        ) sub
      ) mx ON true
      LEFT JOIN LATERAL (
        SELECT GREATEST(
          (SELECT MAX(f5.fecha_creacion)::date FROM facturas f5
           JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
           WHERE f5.customer_code = base.customer_code AND f5.seller_code ILIKE 'E%'
             AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC') ${fDD5Fact} AND f5.status IN (2,4,5)),
          (SELECT MAX(o5.fecha_creacion)::date FROM ordenes o5
           JOIN detalle_documento dd5 ON dd5.documento_code = o5.code
           WHERE o5.customer_code = base.customer_code
             AND o5.equipo_ventas = 'Empresas'
             AND o5.type = 2 AND o5.status IN (2,4,5)
             AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC') ${fDD5})
        ) AS ultima_factura
      ) ult ON true
      WHERE COALESCE(tn.descripcion, 'EMPRESA') = :tipo
      ORDER BY consumo_actual DESC NULLS LAST
    `, {
      replacements: { iniYear, finYear, inicio, fin, iniAnt, finAnt, tipo: tipo || '', ...rutasRepl },
      type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({ clientes });
  } catch (error) {
    console.error('❌ ERROR EMPRESAS CLIENTES POR TIPO:', error);
    return res.status(500).json({ message: 'Error al obtener clientes Empresas por tipo', detail: error.message });
  }
};

/* ======================================================
   EMPRESAS — DETALLE POR SUCURSAL (customer_address_code)
   GET /api/botellones/empresas-cliente-detalle?clienteCode=X&anio=YYYY&mes=MM
====================================================== */
const obtenerEmpresasDetalleCliente = async (req, res) => {
  try {
    const { clienteCode, anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!clienteCode || !anio || !mes)
      return res.status(400).json({ error: 'clienteCode, anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );

    const rutasRepl = {};
    RUTAS_ODOO_EMPRESAS.forEach((r, i) => { rutasRepl[`re${i}`] = r; });
    const rutasPH = RUTAS_ODOO_EMPRESAS.map((_, i) => `:re${i}`).join(', ');

    // Empresas detalle-cliente: mezcla facturas + ordenes
    const fDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0');
    const fDD2 = buildFiltroProductoBotellon(tipoProducto, 'dd2');
    const fDD3 = buildFiltroProductoBotellon(tipoProducto, 'dd3');
    const fDD5 = buildFiltroProductoBotellon(tipoProducto, 'dd5');
    const fDD0Fact = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const fDD2Fact = buildFiltroProductoBotellon(tipoProducto, 'dd2', 'f2');
    const fDD3Fact = buildFiltroProductoBotellon(tipoProducto, 'dd3', 'f3');
    const fDD5Fact = buildFiltroProductoBotellon(tipoProducto, 'dd5', 'f5');

    const clienteInfo = await sequelize.query(`
      SELECT c.nombre_cliente,
             COALESCE(tn.descripcion, 'Sin Clasificar') AS tipo_negocio,
             c.telefono_cliente AS telefono
      FROM clientes c
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      WHERE c.codigo_cliente = :clienteCode
    `, { replacements: { clienteCode }, type: Sequelize.QueryTypes.SELECT });

    const sucursales = await sequelize.query(`
      SELECT
        CASE
          WHEN LOWER(TRIM(COALESCE(dc.descripcion_direccion_cliente,''))) = ANY(ARRAY['delivery','invoice','contact','private','other',''])
          THEN COALESCE(dc.calle1_direccion_cliente, base.customer_address_code::text)
          ELSE COALESCE(NULLIF(TRIM(dc.descripcion_direccion_cliente),''), dc.calle1_direccion_cliente, base.customer_address_code::text)
        END AS nombre_sucursal,
        COALESCE(dc.calle1_direccion_cliente, '')                                AS direccion,
        COALESCE(dc.codigo_direccion_cliente, base.customer_address_code::text)  AS codigo_sucursal,
        COALESCE(dc.telefono_direccion_cliente, '')                              AS telefono,
        COALESCE(dc.latitud_direccion_cliente::text,  '')                        AS latitud,
        COALESCE(dc.longitud_direccion_cliente::text, '')                        AS longitud,
        base.customer_address_code,
        COALESCE(act.cantidad_actual,  0)                                        AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                                        AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                                        AS consumo_anterior,
        ult.ultima_factura
      FROM (
        SELECT DISTINCT suc_code AS customer_address_code
        FROM (
          SELECT f0.customer_address_code::text AS suc_code
          FROM facturas f0
          JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
          WHERE f0.customer_code = :clienteCode
            AND f0.seller_code ILIKE 'E%'
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0Fact}
            AND f0.status = 2
          UNION
          SELECT o0.customer_address_code::text AS suc_code
          FROM ordenes o0
          JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
          WHERE o0.customer_code = :clienteCode
            AND o0.equipo_ventas = 'Empresas'
            AND o0.equipo_ventas <> 'Point of Sale'
            AND o0.type = 2 AND o0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${fDD0}
        ) suc_src
        WHERE suc_code IS NOT NULL
      ) base
      LEFT JOIN direcciones_clientes dc
             ON dc.codigo_cliente           = :clienteCode
            AND dc.codigo_direccion_cliente = base.customer_address_code
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.cantidad), 0) AS cantidad_actual,
               COALESCE(SUM(sub.total),   0) AS consumo_actual
        FROM (
          -- Facturas Empresa (signed: NotCr resta)
          SELECT ${signedColFactura('f2', 'dd2', 'cantidad')} AS cantidad,
                 ${signedColFactura('f2', 'dd2', 'total')}    AS total
          FROM facturas f2
          JOIN detalle_documento dd2 ON dd2.documento_code = f2.code
          WHERE f2.customer_code = :clienteCode
            AND f2.customer_address_code = base.customer_address_code
            AND f2.seller_code ILIKE 'E%'
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC') ${fDD2Fact} AND f2.status = 2
            AND f2.fecha_creacion >= :inicio AND f2.fecha_creacion < :fin
          UNION ALL
          -- Ordenes Odoo Empresa (excluye POS)
          SELECT dd2.cantidad, dd2.total FROM ordenes o2
          JOIN detalle_documento dd2 ON dd2.documento_code = o2.code
          WHERE o2.customer_code = :clienteCode
            AND o2.customer_address_code::text = base.customer_address_code
            AND o2.equipo_ventas = 'Empresas'
            AND o2.equipo_ventas <> 'Point of Sale'
            AND o2.type = 2 AND o2.status = 2
            AND (dd2.descripcion_categoria = 'BOTELLÓN' OR dd2.producto_codigo_interno = 'DISC')
            ${fDD2}
            AND o2.fecha_creacion >= :inicio AND o2.fecha_creacion < :fin
        ) sub
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sub.total), 0) AS consumo_anterior
        FROM (
          SELECT ${signedColFactura('f3', 'dd3', 'total')} AS total
          FROM facturas f3
          JOIN detalle_documento dd3 ON dd3.documento_code = f3.code
          WHERE f3.customer_code = :clienteCode
            AND f3.customer_address_code = base.customer_address_code
            AND f3.seller_code ILIKE 'E%'
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC') ${fDD3Fact} AND f3.status = 2
            AND f3.fecha_creacion >= :iniAnt AND f3.fecha_creacion < :finAnt
          UNION ALL
          SELECT dd3.total FROM ordenes o3
          JOIN detalle_documento dd3 ON dd3.documento_code = o3.code
          WHERE o3.customer_code = :clienteCode
            AND o3.customer_address_code::text = base.customer_address_code
            AND o3.equipo_ventas = 'Empresas'
            AND o3.equipo_ventas <> 'Point of Sale'
            AND o3.type = 2 AND o3.status = 2
            AND (dd3.descripcion_categoria = 'BOTELLÓN' OR dd3.producto_codigo_interno = 'DISC')
            ${fDD3}
            AND o3.fecha_creacion >= :iniAnt AND o3.fecha_creacion < :finAnt
        ) sub
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT MAX(f5.fecha_creacion)::date AS ultima_factura
        FROM facturas f5
        JOIN detalle_documento dd5 ON dd5.documento_code = f5.code
        WHERE f5.customer_code = :clienteCode
          AND f5.customer_address_code = base.customer_address_code
          AND f5.seller_code ILIKE 'E%'
          AND (dd5.descripcion_categoria = 'BOTELLÓN' OR dd5.producto_codigo_interno = 'DISC')
          ${fDD5Fact}
          AND f5.status IN (2,4,5)
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `, {
      replacements: { clienteCode, inicio, fin, iniAnt, finAnt, ...rutasRepl },
      type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({
      cliente: clienteInfo[0] || { nombre_cliente: clienteCode, tipo_negocio: '—', telefono: '' },
      sucursales,
    });
  } catch (error) {
    console.error('❌ ERROR EMPRESAS DETALLE CLIENTE:', error);
    return res.status(500).json({ message: 'Error al obtener detalle cliente Empresas', detail: error.message });
  }
};

/* ======================================================
   QUITO CONSOLIDADO (MV U1 + Odoo equipo_ventas='Quito')
   GET /api/botellones/quito-consolidado?anio=YYYY&mes=MM
====================================================== */
const queryTotalesQuito = async (inicio, fin, tipoProducto = 'todo') => {
  const filtroProductoBotellon = buildFiltroProductoBotellon(tipoProducto);
  const filtroProductoBotellonFact = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

  const rows = await sequelize.query(`
    SELECT COALESCE(SUM(sub.unidades), 0) AS unidades,
           COALESCE(SUM(sub.dolares),  0) AS dolares
    FROM (
      -- MobilVendor: facturas seller_code = U1 (neto NotCr)
      SELECT COALESCE(${signedSumFactura('f', 'dd', 'cantidad')}, 0) AS unidades,
             COALESCE(${signedSumFactura('f', 'dd', 'total')}, 0)    AS dolares
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.seller_code = 'U1' AND f.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellonFact}
        AND f.fecha_creacion >= :inicio
        AND f.fecha_creacion <  :fin
      UNION ALL
      -- Odoo: ordenes equipo_ventas = Quito
      SELECT COALESCE(SUM(dd.cantidad), 0), COALESCE(SUM(dd.total), 0)
      FROM ordenes o
      JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Quito'
        AND o.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroProductoBotellon}
        AND o.fecha_creacion >= :inicio
        AND o.fecha_creacion <  :fin
    ) sub
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });

  const countsRows = await sequelize.query(`
    SELECT
      COALESCE((
        SELECT COUNT(DISTINCT f.code)
        FROM facturas f
        WHERE f.seller_code = 'U1' AND f.status = 2
          AND f.fecha_creacion >= :inicio
          AND f.fecha_creacion <  :fin
          AND EXISTS (
            SELECT 1 FROM detalle_documento dd
            WHERE dd.documento_code = f.code
              AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
              ${filtroProductoBotellonFact}
          )
      ), 0) AS num_facturas,
      COALESCE((
        SELECT COUNT(DISTINCT o.code)
        FROM ordenes o
        WHERE o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Quito'
          AND o.status = 2
          AND o.fecha_creacion >= :inicio
          AND o.fecha_creacion <  :fin
          AND EXISTS (
            SELECT 1 FROM detalle_documento dd
            WHERE dd.documento_code = o.code
              AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
              ${filtroProductoBotellon}
          )
      ), 0) AS num_ordenes
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });

  return {
    unidades: Number(rows[0]?.unidades || 0),
    dolares: Number(rows[0]?.dolares || 0),
    numFacturas: Number(countsRows[0]?.num_facturas || 0),
    numOrdenes: Number(countsRows[0]?.num_ordenes || 0),
  };
};

const queryTotalesWebsite = async (inicio, fin, tipoProducto = 'todo') => {
  const filtroProductoBotellon = buildFiltroProductoBotellon(tipoProducto);

  const rows = await sequelize.query(`
    SELECT COALESCE(SUM(dd.cantidad), 0) AS unidades,
           COALESCE(SUM(dd.total),   0) AS dolares
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Website'
      AND o.status = 2
      AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
      ${filtroProductoBotellon}
      AND o.fecha_creacion >= :inicio
      AND o.fecha_creacion <  :fin
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });

  const countsRows = await sequelize.query(`
    SELECT COALESCE(COUNT(DISTINCT o.code), 0) AS num_ordenes
    FROM ordenes o
    WHERE o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Website'
      AND o.status = 2
      AND o.fecha_creacion >= :inicio
      AND o.fecha_creacion <  :fin
      AND EXISTS (
        SELECT 1 FROM detalle_documento dd
        WHERE dd.documento_code = o.code
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroProductoBotellon}
      )
  `, { replacements: { inicio, fin }, type: Sequelize.QueryTypes.SELECT });

  return {
    unidades: Number(rows[0]?.unidades || 0),
    dolares: Number(rows[0]?.dolares || 0),
    numFacturas: 0,
    numOrdenes: Number(countsRows[0]?.num_ordenes || 0),
  };
};

const buildConsolidadoResponse = (actual, anterior, esMesActual, diasTrans, diasMes) => {
  const proyDolares = esMesActual && diasTrans > 0
    ? (actual.dolares / diasTrans) * diasMes
    : actual.dolares;
  const proyUnidades = esMesActual && diasTrans > 0
    ? Math.round((actual.unidades / diasTrans) * diasMes)
    : actual.unidades;

  const variacionAbs = proyDolares - anterior.dolares;
  const variacionPorc = anterior.dolares > 0 ? (variacionAbs / anterior.dolares) * 100 : 0;
  const varAbsUnid = proyUnidades - anterior.unidades;
  const varPorcUnid = anterior.unidades > 0 ? (varAbsUnid / anterior.unidades) * 100 : 0;

  return {
    total: {
      unidades: actual.unidades,
      dolares: actual.dolares,
      numFacturas: actual.numFacturas ?? 0,
      numOrdenes: actual.numOrdenes ?? 0,
      mesAnterior: {
        dolares: anterior.dolares,
        variacionAbs: Number(variacionAbs.toFixed(2)),
        variacionPorc: Number(variacionPorc.toFixed(2)),
        unidades: anterior.unidades,
        variacionAbsUnidades: Math.round(varAbsUnid),
        variacionPorcUnidades: Number(varPorcUnid.toFixed(2)),
      },
    },
    detalle: [{
      proyeccion: {
        dolares: Number(proyDolares.toFixed(2)),
        unidades: Number(proyUnidades.toFixed(0)),
      },
    }],
  };
};

const obtenerQuitoConsolidado = async (req, res) => {
  try {
    // Visibilidad: sección QUITO (canal 'U') del módulo botellón.
    if (!permiteSeccion(req.user, MODULO_BOTELLON, 'QUITO', 'U')) return res.json(null);
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const hoyQ = new Date();
    const esMesActualQ = hoyQ.getFullYear() === anioNum && hoyQ.getMonth() + 1 === mesNum;
    const { inicio, fin: finFull } = getRangoFechas(anioNum, mesNum);
    const finHoyQ = `${hoyQ.getFullYear()}-${String(hoyQ.getMonth() + 1).padStart(2, '0')}-${String(hoyQ.getDate()).padStart(2, '0')} 00:00:00`;
    const fin = esMesActualQ ? finHoyQ : finFull;
    const { inicio: inicioAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const diasTrans = getDiasHabilesTranscurridos(anioNum, mesNum);
    const diasMes = getDiasLaborablesMes(anioNum, mesNum);

    const [actual, anterior] = await Promise.all([
      queryTotalesQuito(inicio, fin, tipoProducto),
      queryTotalesQuito(inicioAnt, finAnt, tipoProducto),
    ]);

    return res.json(buildConsolidadoResponse(actual, anterior, esMesActualQ, diasTrans, diasMes));
  } catch (error) {
    console.error('❌ ERROR QUITO CONSOLIDADO:', error);
    return res.status(500).json({ message: 'Error quito consolidado', detail: error.message });
  }
};

const obtenerWebsiteConsolidado = async (req, res) => {
  try {
    // WEBSITE no es un canal de ruta → solo ADMIN o módulo botellón concedido completo.
    if (!permiteSeccion(req.user, MODULO_BOTELLON, 'WEBSITE', '__ADMIN__')) return res.json(null);
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const hoyW = new Date();
    const esMesActualW = hoyW.getFullYear() === anioNum && hoyW.getMonth() + 1 === mesNum;
    const { inicio, fin: finFull } = getRangoFechas(anioNum, mesNum);
    const finHoyW = `${hoyW.getFullYear()}-${String(hoyW.getMonth() + 1).padStart(2, '0')}-${String(hoyW.getDate()).padStart(2, '0')} 00:00:00`;
    const fin = esMesActualW ? finHoyW : finFull;
    const { inicio: inicioAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const diasTrans = getDiasHabilesTranscurridos(anioNum, mesNum);
    const diasMes = getDiasLaborablesMes(anioNum, mesNum);

    const [actual, anterior] = await Promise.all([
      queryTotalesWebsite(inicio, fin, tipoProducto),
      queryTotalesWebsite(inicioAnt, finAnt, tipoProducto),
    ]);

    return res.json(buildConsolidadoResponse(actual, anterior, esMesActualW, diasTrans, diasMes));
  } catch (error) {
    console.error('❌ ERROR WEBSITE CONSOLIDADO:', error);
    return res.status(500).json({ message: 'Error website consolidado', detail: error.message });
  }
};

/* ======================================================
   CLIENTES QUITO / WEBSITE BOTELLÓN
   GET /api/botellones/clientes-quito|website?anio=YYYY&mes=MM
====================================================== */
const buildClientesOdooBotellon = (fuenteQuery) => async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );

    const { clientesSql, productosSql, replacements } = fuenteQuery({ inicio, fin, iniAnt, finAnt, anioNum, tipoProducto });

    const clientes = await sequelize.query(clientesSql, {
      replacements, type: Sequelize.QueryTypes.SELECT,
    });

    const totalClientes = clientes.length;
    const clientesConConsumo = clientes.filter(c => Number(c.consumo_actual) > 0).length;
    const clientesSinConsumo = totalClientes - clientesConConsumo;

    const productosVendidos = await sequelize.query(productosSql, {
      replacements, type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({
      clientes,
      resumen: { totalClientes, clientesConConsumo, clientesSinConsumo },
      productosVendidos: dedupeProductosVendidos(productosVendidos),
    });
  } catch (error) {
    console.error('❌ ERROR CLIENTES BOTELLÓN ODOO:', error);
    return res.status(500).json({ message: 'Error al obtener clientes', detail: error.message });
  }
};

const fuenteQuito = ({ inicio, fin, iniAnt, finAnt, anioNum, tipoProducto = 'todo' }) => {
  const iniYear = `${anioNum}-01-01 00:00:00`;
  const finYear = `${anioNum + 1}-01-01 00:00:00`;
  // Fuente Quito: mezcla facturas (U1) + ordenes Odoo
  const filtroDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0');
  const filtroDD = buildFiltroProductoBotellon(tipoProducto, 'dd');
  const filtroDD0Fact = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
  const filtroDDFact = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');
  return {
    replacements: { inicio, fin, iniAnt, finAnt, iniYear, finYear },
    clientesSql: `
      WITH base AS (
        -- MV U1
        SELECT DISTINCT f0.customer_code
        FROM facturas f0
        JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
        WHERE f0.seller_code = 'U1'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${filtroDD0Fact}
          AND f0.status = 2
          AND f0.fecha_creacion >= :iniYear
          AND f0.fecha_creacion <  :finYear
        UNION
        -- Odoo Quito
        SELECT DISTINCT o0.customer_code
        FROM ordenes o0
        JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
        WHERE o0.origen_sistema = 'ODOO' AND o0.equipo_ventas = 'Quito'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${filtroDD0}
          AND o0.status = 2
          AND o0.fecha_creacion >= :iniYear
          AND o0.fecha_creacion <  :finYear
      )
      SELECT
        base.customer_code                                AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)    AS nombre_cliente,
        COALESCE(c.direccion_cliente, '')                 AS direccion_entrega,
        COALESCE(tn.descripcion, '')                      AS tipo_negocio,
        COALESCE(c.telefono_cliente, '')                  AS telefono,
        COALESCE(c.latitud_cliente::text,  '')            AS latitud,
        COALESCE(c.longitud_cliente::text, '')            AS longitud,
        COALESCE(act.cantidad_actual,  0)                 AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                 AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                 AS consumo_anterior,
        ult.ultima_factura
      FROM base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT SUM(cant) AS cantidad_actual, SUM(tot) AS consumo_actual FROM (
          SELECT dd.cantidad AS cant, dd.total AS tot
          FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code
            AND f.seller_code = 'U1'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDFact}
            AND f.status = 2
            AND f.fecha_creacion >= :inicio
            AND f.fecha_creacion <  :fin
          UNION ALL
          SELECT dd.cantidad, dd.total
          FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Quito'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDD}
            AND o.status = 2
            AND o.fecha_creacion >= :inicio
            AND o.fecha_creacion <  :fin
        ) s
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT SUM(tot) AS consumo_anterior FROM (
          SELECT dd.total AS tot
          FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code
            AND f.seller_code = 'U1'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDFact}
            AND f.status = 2
            AND f.fecha_creacion >= :iniAnt
            AND f.fecha_creacion <  :finAnt
          UNION ALL
          SELECT dd.total
          FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Quito'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDD}
            AND o.status = 2
            AND o.fecha_creacion >= :iniAnt
            AND o.fecha_creacion <  :finAnt
        ) s
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT MAX(fecha)::date AS ultima_factura FROM (
          SELECT f.fecha_creacion AS fecha
          FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code AND f.seller_code = 'U1'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC') ${filtroDDFact}
            AND f.status = 2
          UNION ALL
          SELECT o.fecha_creacion
          FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Quito'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC') ${filtroDD}
            AND o.status = 2
        ) s
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `,
    productosSql: `
      SELECT producto, SUM(unidades_vendidas) AS unidades_vendidas, SUM(monto_usd) AS monto_usd
      FROM (
        SELECT dd.descripcion AS producto,
               ${signedSumFactura('f', 'dd', 'cantidad')} AS unidades_vendidas,
               ${signedSumFactura('f', 'dd', 'total')}    AS monto_usd
        FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
        WHERE f.seller_code = 'U1' AND f.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroDDFact}
          AND f.fecha_creacion >= :inicio
          AND f.fecha_creacion <  :fin
        GROUP BY dd.descripcion
        UNION ALL
        SELECT dd.descripcion, SUM(dd.cantidad), SUM(dd.total)
        FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Quito'
          AND o.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroDD}
          AND o.fecha_creacion >= :inicio
          AND o.fecha_creacion <  :fin
        GROUP BY dd.descripcion
      ) p
      GROUP BY producto
      ORDER BY unidades_vendidas DESC
    `,
  };
};

const fuenteWebsite = ({ inicio, fin, iniAnt, finAnt, anioNum, tipoProducto = 'todo' }) => {
  const iniYear = `${anioNum}-01-01 00:00:00`;
  const finYear = `${anioNum + 1}-01-01 00:00:00`;
  const filtroDD0 = buildFiltroProductoBotellon(tipoProducto, 'dd0');
  const filtroDD = buildFiltroProductoBotellon(tipoProducto, 'dd');
  return {
    replacements: { inicio, fin, iniAnt, finAnt, iniYear, finYear },
    clientesSql: `
      WITH base AS (
        SELECT DISTINCT o0.customer_code
        FROM ordenes o0
        JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
        WHERE o0.origen_sistema = 'ODOO' AND o0.equipo_ventas = 'Website'
          AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
          ${filtroDD0}
          AND o0.status = 2
          AND o0.fecha_creacion >= :iniYear
          AND o0.fecha_creacion <  :finYear
      )
      SELECT
        base.customer_code                                AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)    AS nombre_cliente,
        COALESCE(c.direccion_cliente, '')                 AS direccion_entrega,
        COALESCE(tn.descripcion, '')                      AS tipo_negocio,
        COALESCE(c.telefono_cliente, '')                  AS telefono,
        COALESCE(c.latitud_cliente::text,  '')            AS latitud,
        COALESCE(c.longitud_cliente::text, '')            AS longitud,
        COALESCE(act.cantidad_actual,  0)                 AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                 AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                 AS consumo_anterior,
        ult.ultima_factura
      FROM base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT SUM(dd.cantidad) AS cantidad_actual, SUM(dd.total) AS consumo_actual
        FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.customer_code = base.customer_code
          AND o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Website'
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroDD}
          AND o.status = 2
          AND o.fecha_creacion >= :inicio
          AND o.fecha_creacion <  :fin
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT SUM(dd.total) AS consumo_anterior
        FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.customer_code = base.customer_code
          AND o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Website'
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroDD}
          AND o.status = 2
          AND o.fecha_creacion >= :iniAnt
          AND o.fecha_creacion <  :finAnt
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT MAX(o.fecha_creacion)::date AS ultima_factura
        FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE o.customer_code = base.customer_code
          AND o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Website'
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC') ${filtroDD}
          AND o.status = 2
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `,
    productosSql: `
      SELECT dd.descripcion AS producto,
             SUM(dd.cantidad) AS unidades_vendidas,
             SUM(dd.total)    AS monto_usd
      FROM ordenes o
      JOIN detalle_documento dd ON dd.documento_code = o.code
      WHERE o.origen_sistema = 'ODOO' AND o.equipo_ventas = 'Website'
        AND o.status = 2
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${filtroDD}
        AND o.fecha_creacion >= :inicio
        AND o.fecha_creacion <  :fin
      GROUP BY dd.descripcion
      ORDER BY unidades_vendidas DESC
    `,
  };
};

const obtenerClientesQuitoBotellon = buildClientesOdooBotellon(fuenteQuito);
const obtenerClientesWebsiteBotellon = buildClientesOdooBotellon(fuenteWebsite);

/* ======================================================
   EMPRESAS — PRODUCTOS POR SUCURSAL (BOTELLÓN)
   GET /api/botellones/empresas-sucursal-productos
       ?clienteCode=X&addressCode=Y&anio=YYYY&mes=MM&tipoProducto=todo|liquido|envase
   Devuelve los productos vendidos a esa (cliente, sucursal) en el mes,
   combinando MV (facturas seller_code ILIKE 'E%') + Odoo (ordenes con
   seller_nombre en RUTAS_ODOO_EMPRESAS), filtrando categoría BOTELLÓN
   y respetando el filtro de tipoProducto activo.
====================================================== */
const obtenerEmpresasProductosSucursal = async (req, res) => {
  try {
    const { clienteCode, addressCode, anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!clienteCode || !addressCode || !anio || !mes)
      return res.status(400).json({ ok: false, error: 'clienteCode, addressCode, anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum  = parseInt(mes,  10);
    if (isNaN(anioNum) || isNaN(mesNum) || mesNum < 1 || mesNum > 12)
      return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);

    const rutasRepl = {};
    RUTAS_ODOO_EMPRESAS.forEach((r, i) => { rutasRepl[`re${i}`] = r; });
    const rutasPH = RUTAS_ODOO_EMPRESAS.map((_, i) => `:re${i}`).join(', ');

    // ddm es de facturas (alias f), ddo es de ordenes Odoo (sin NotCr)
    const fDDmv = buildFiltroProductoBotellon(tipoProducto, 'ddm', 'f');
    const fDDod = buildFiltroProductoBotellon(tipoProducto, 'ddo');


    const filas = await sequelize.query(`
      SELECT descripcion AS producto,
             SUM(cantidad) AS unidades_vendidas,
             SUM(total)    AS monto_usd
      FROM (
        SELECT ddm.descripcion, ddm.cantidad, ddm.total
        FROM facturas f
        JOIN detalle_documento ddm ON ddm.documento_code = f.code
        WHERE f.customer_code = :clienteCode
          AND f.customer_address_code = :addressCode
          AND f.seller_code ILIKE 'E%'
          AND (ddm.descripcion_categoria = 'BOTELLÓN' OR ddm.producto_codigo_interno = 'DISC')
          ${fDDmv}
          AND f.status = 2
          AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin

        UNION ALL

        SELECT ddo.descripcion, ddo.cantidad, ddo.total
        FROM ordenes o
        JOIN detalle_documento ddo ON ddo.documento_code = o.code
        WHERE o.customer_code = :clienteCode
          AND o.customer_address_code::text = :addressCode
          AND o.equipo_ventas = 'Empresas'
          AND o.equipo_ventas <> 'Point of Sale'
          AND o.type = 2 AND o.status = 2
          AND (ddo.descripcion_categoria = 'BOTELLÓN' OR ddo.producto_codigo_interno = 'DISC')
          ${fDDod}
          AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
      ) comb
      GROUP BY descripcion
      ORDER BY monto_usd DESC
    `, {
      replacements: { clienteCode, addressCode, inicio, fin, ...rutasRepl },
      type: Sequelize.QueryTypes.SELECT,
    });

    // Limpia el prefijo "[código] " y consolida líneas con el mismo nombre.
    const limpiar = (n) => (n ? n.replace(/^\[[^\]]+\]\s*/, '').trim() : '');
    const map = new Map();
    for (const f of filas) {
      const nombre = limpiar(f.producto);
      if (!map.has(nombre)) {
        map.set(nombre, { producto: nombre, unidades_vendidas: 0, monto_usd: 0 });
      }
      const acc = map.get(nombre);
      acc.unidades_vendidas += Number(f.unidades_vendidas) || 0;
      acc.monto_usd         += Number(f.monto_usd)         || 0;
    }
    const productos = dedupeProductosVendidos(Array.from(map.values())).sort((a, b) => b.monto_usd - a.monto_usd);

    return res.json({ ok: true, productos });
  } catch (error) {
    console.error('❌ ERROR EMPRESAS PRODUCTOS SUCURSAL:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/* ======================================================
   VIP — PRODUCTOS POR SUCURSAL (BOTELLÓN)
   GET /api/botellones/vip-sucursal-productos
       ?clienteCode=X&addressCode=Y&anio=YYYY&mes=MM&tipoProducto=todo|liquido|envase
   Devuelve los productos vendidos a esa (cliente, sucursal) VIP en el mes,
   sumados desde facturas con codigo_tipo_negocio='29'.
====================================================== */
const obtenerVipProductosSucursal = async (req, res) => {
  try {
    const { clienteCode, addressCode, anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!clienteCode || !addressCode || !anio || !mes)
      return res.status(400).json({ ok: false, error: 'clienteCode, addressCode, anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum  = parseInt(mes,  10);
    if (isNaN(anioNum) || isNaN(mesNum) || mesNum < 1 || mesNum > 12)
      return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const fDD = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');

    const filas = await sequelize.query(`
      SELECT dd.descripcion AS producto,
             ${signedSumFactura('f', 'dd', 'cantidad')} AS unidades_vendidas,
             ${signedSumFactura('f', 'dd', 'total')}    AS monto_usd
      FROM facturas f
      JOIN detalle_documento dd ON dd.documento_code = f.code
      WHERE f.customer_code = :clienteCode
        AND f.customer_address_code = :addressCode
        AND f.codigo_tipo_negocio = '29'
        AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
        ${fDD}
        AND f.status = 2
        AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
      GROUP BY dd.descripcion
      ORDER BY monto_usd DESC
    `, {
      replacements: { clienteCode, addressCode, inicio, fin },
      type: Sequelize.QueryTypes.SELECT,
    });

    // Limpia el prefijo "[código] " y consolida líneas con el mismo nombre.
    const limpiar = (n) => (n ? n.replace(/^\[[^\]]+\]\s*/, '').trim() : '');
    const map = new Map();
    for (const f of filas) {
      const nombre = limpiar(f.producto);
      if (!map.has(nombre)) {
        map.set(nombre, { producto: nombre, unidades_vendidas: 0, monto_usd: 0 });
      }
      const acc = map.get(nombre);
      acc.unidades_vendidas += Number(f.unidades_vendidas) || 0;
      acc.monto_usd         += Number(f.monto_usd)         || 0;
    }
    const productos = dedupeProductosVendidos(Array.from(map.values())).sort((a, b) => b.monto_usd - a.monto_usd);

    return res.json({ ok: true, productos });
  } catch (error) {
    console.error('❌ ERROR VIP PRODUCTOS SUCURSAL:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/* ======================================================
   CLIENTES POR GRUPO (Mayorista / Tiendas / Tiendas VIP / Rural)
   Vista agregada: 1 fila por cliente sumando TODAS las rutas
   del grupo (M%, T%, TV%, R%). Mismos filtros que la tabla
   principal del dashboard (facturas + órdenes MV, status=2,
   BOTELLÓN + DISC).
====================================================== */
const buildClientesGrupoBotellon = (filtroSellerColumn, label) => async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const tipoProducto = normalizarTipoProducto(req.query.tipoProducto);
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });

    const anioNum = parseInt(anio, 10);
    const mesNum = parseInt(mes, 10);
    if (isNaN(anioNum) || isNaN(mesNum))
      return res.status(400).json({ error: 'Parámetros inválidos' });

    const { inicio, fin } = getRangoFechas(anioNum, mesNum);
    const { inicio: iniAnt, fin: finAnt } = getRangoFechas(
      mesNum === 1 ? anioNum - 1 : anioNum,
      mesNum === 1 ? 12 : mesNum - 1
    );
    const iniYear = `${anioNum}-01-01 00:00:00`;
    const finYear = `${anioNum + 1}-01-01 00:00:00`;

    // Filtros de seller_code por alias (factura/orden).
    const fSel0 = filtroSellerColumn('f0');
    const oSel0 = filtroSellerColumn('o0');
    const fSel  = filtroSellerColumn('f');
    const oSel  = filtroSellerColumn('o');

    const filtroDD0F = buildFiltroProductoBotellon(tipoProducto, 'dd0', 'f0');
    const filtroDD0O = buildFiltroProductoBotellon(tipoProducto, 'dd0');
    const filtroDDF  = buildFiltroProductoBotellon(tipoProducto, 'dd', 'f');
    const filtroDDO  = buildFiltroProductoBotellon(tipoProducto, 'dd');

    const clientesSql = `
      WITH base AS (
        SELECT DISTINCT customer_code FROM (
          SELECT f0.customer_code
          FROM facturas f0
          JOIN detalle_documento dd0 ON dd0.documento_code = f0.code
          WHERE ${fSel0}
            AND f0.status = 2
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${filtroDD0F}
            AND f0.fecha_creacion >= :iniYear
            AND f0.fecha_creacion <  :finYear
          UNION
          SELECT o0.customer_code
          FROM ordenes o0
          JOIN detalle_documento dd0 ON dd0.documento_code = o0.code
          WHERE ${oSel0}
            AND o0.status = 2
            AND o0.origen_sistema = 'MOBILVENDOR'
            AND (dd0.descripcion_categoria = 'BOTELLÓN' OR dd0.producto_codigo_interno = 'DISC')
            ${filtroDD0O}
            AND o0.fecha_creacion >= :iniYear
            AND o0.fecha_creacion <  :finYear
        ) u
      )
      SELECT
        base.customer_code                                AS codigo_cliente,
        COALESCE(c.nombre_cliente, base.customer_code)    AS nombre_cliente,
        COALESCE(c.direccion_cliente, '')                 AS direccion_entrega,
        COALESCE(tn.descripcion, '')                      AS tipo_negocio,
        COALESCE(c.telefono_cliente, '')                  AS telefono,
        COALESCE(c.latitud_cliente::text, '')             AS latitud,
        COALESCE(c.longitud_cliente::text, '')            AS longitud,
        COALESCE(act.cantidad_actual,  0)                 AS cantidad_actual,
        COALESCE(act.consumo_actual,   0)                 AS consumo_actual,
        COALESCE(ant.consumo_anterior, 0)                 AS consumo_anterior,
        COALESCE(rt.rutas, '')                            AS rutas,
        ult.ultima_factura
      FROM base
      LEFT JOIN clientes c ON c.codigo_cliente = base.customer_code
      LEFT JOIN tipos_negocio tn ON tn.codigo = c.codigo_tipo_negocio
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(seller, ', ' ORDER BY seller) AS rutas FROM (
          SELECT DISTINCT UPPER(TRIM(f.seller_code)) AS seller
          FROM facturas f
          JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code
            AND ${fSel}
            AND f.status = 2
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDF}
            AND f.fecha_creacion >= :iniYear
            AND f.fecha_creacion <  :finYear
          UNION
          SELECT DISTINCT UPPER(TRIM(o.seller_code))
          FROM ordenes o
          JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND ${oSel}
            AND o.status = 2
            AND o.origen_sistema = 'MOBILVENDOR'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDO}
            AND o.fecha_creacion >= :iniYear
            AND o.fecha_creacion <  :finYear
        ) s
      ) rt ON true
      LEFT JOIN LATERAL (
        SELECT SUM(cant) AS cantidad_actual, SUM(tot) AS consumo_actual FROM (
          SELECT dd.cantidad AS cant, dd.total AS tot
          FROM facturas f
          JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code
            AND ${fSel}
            AND f.status = 2
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDF}
            AND f.fecha_creacion >= :inicio
            AND f.fecha_creacion <  :fin
          UNION ALL
          SELECT dd.cantidad, dd.total
          FROM ordenes o
          JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND ${oSel}
            AND o.status = 2
            AND o.origen_sistema = 'MOBILVENDOR'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDO}
            AND o.fecha_creacion >= :inicio
            AND o.fecha_creacion <  :fin
        ) s
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT SUM(tot) AS consumo_anterior FROM (
          SELECT dd.total AS tot
          FROM facturas f
          JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code
            AND ${fSel}
            AND f.status = 2
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDF}
            AND f.fecha_creacion >= :iniAnt
            AND f.fecha_creacion <  :finAnt
          UNION ALL
          SELECT dd.total
          FROM ordenes o
          JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND ${oSel}
            AND o.status = 2
            AND o.origen_sistema = 'MOBILVENDOR'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDO}
            AND o.fecha_creacion >= :iniAnt
            AND o.fecha_creacion <  :finAnt
        ) s
      ) ant ON true
      LEFT JOIN LATERAL (
        SELECT MAX(fecha)::date AS ultima_factura FROM (
          SELECT f.fecha_creacion AS fecha
          FROM facturas f
          JOIN detalle_documento dd ON dd.documento_code = f.code
          WHERE f.customer_code = base.customer_code
            AND ${fSel}
            AND f.status = 2
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDF}
          UNION ALL
          SELECT o.fecha_creacion
          FROM ordenes o
          JOIN detalle_documento dd ON dd.documento_code = o.code
          WHERE o.customer_code = base.customer_code
            AND ${oSel}
            AND o.status = 2
            AND o.origen_sistema = 'MOBILVENDOR'
            AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
            ${filtroDDO}
        ) s
      ) ult ON true
      ORDER BY consumo_actual DESC NULLS LAST
    `;

    const productosSql = `
      SELECT producto, SUM(unidades_vendidas) AS unidades_vendidas, SUM(monto_usd) AS monto_usd
      FROM (
        SELECT dd.descripcion AS producto,
               SUM(dd.cantidad) AS unidades_vendidas,
               SUM(dd.total)    AS monto_usd
        FROM facturas f
        JOIN detalle_documento dd ON dd.documento_code = f.code
        WHERE ${fSel}
          AND f.status = 2
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroDDF}
          AND f.fecha_creacion >= :inicio
          AND f.fecha_creacion <  :fin
        GROUP BY dd.descripcion
        UNION ALL
        SELECT dd.descripcion, SUM(dd.cantidad), SUM(dd.total)
        FROM ordenes o
        JOIN detalle_documento dd ON dd.documento_code = o.code
        WHERE ${oSel}
          AND o.status = 2
          AND o.origen_sistema = 'MOBILVENDOR'
          AND (dd.descripcion_categoria = 'BOTELLÓN' OR dd.producto_codigo_interno = 'DISC')
          ${filtroDDO}
          AND o.fecha_creacion >= :inicio
          AND o.fecha_creacion <  :fin
        GROUP BY dd.descripcion
      ) p
      GROUP BY producto
      ORDER BY unidades_vendidas DESC
    `;

    const replacements = { inicio, fin, iniAnt, finAnt, iniYear, finYear };

    const clientes = await sequelize.query(clientesSql, {
      replacements, type: Sequelize.QueryTypes.SELECT,
    });

    const totalClientes = clientes.length;
    const clientesConConsumo = clientes.filter(c => Number(c.consumo_actual) > 0).length;
    const clientesSinConsumo = totalClientes - clientesConConsumo;

    const productosVendidos = await sequelize.query(productosSql, {
      replacements, type: Sequelize.QueryTypes.SELECT,
    });

    return res.json({
      clientes,
      resumen: { totalClientes, clientesConConsumo, clientesSinConsumo },
      productosVendidos: dedupeProductosVendidos(productosVendidos),
    });
  } catch (error) {
    console.error(`❌ ERROR CLIENTES ${label}:`, error);
    return res.status(500).json({ message: `Error al obtener clientes ${label}`, detail: error.message });
  }
};

const obtenerClientesMayoristaBotellon  = buildClientesGrupoBotellon((a) => `${a}.seller_code ILIKE 'M%'`, 'Mayorista');
const obtenerClientesTiendasBotellon    = buildClientesGrupoBotellon((a) => `(${a}.seller_code ILIKE 'T%' AND ${a}.seller_code NOT ILIKE 'TV%')`, 'Tiendas');
const obtenerClientesTiendasVipBotellon = buildClientesGrupoBotellon((a) => `${a}.seller_code ILIKE 'TV%'`, 'Tiendas VIP');
const obtenerClientesRuralBotellon      = buildClientesGrupoBotellon((a) => `${a}.seller_code ILIKE 'R%'`, 'Rural');

module.exports = {
  obtenerDashboardBotellones,
  obtenerClientesVipBotellon,
  obtenerClientesDomicilioBotellon,
  obtenerEmpresasConsolidado,
  obtenerClientesEmpresasBotellon,
  obtenerVipSubcanales,
  obtenerVipClientesPorTipo,
  obtenerVipDetalleCliente,
  obtenerVipProductosSucursal,
  obtenerEmpresasSubcanales,
  obtenerEmpresasClientesPorTipo,
  obtenerEmpresasDetalleCliente,
  obtenerEmpresasProductosSucursal,
  obtenerQuitoConsolidado,
  obtenerWebsiteConsolidado,
  obtenerClientesQuitoBotellon,
  obtenerClientesWebsiteBotellon,
  obtenerClientesMayoristaBotellon,
  obtenerClientesTiendasBotellon,
  obtenerClientesTiendasVipBotellon,
  obtenerClientesRuralBotellon,
};

