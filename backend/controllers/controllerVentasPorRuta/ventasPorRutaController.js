// controllers/controllerVentasPorRuta/ventasPorRutaController.js
// Endpoint interno: ventas de una ruta en un rango de fechas, agrupadas por
// categoría de producto Y por condición de pago (CONTADO/CREDITO/SIN_DATO).
// Reusa la misma conexión (Sequelize → Postgres ventas_mv), el mismo
// criterio de "venta confirmada" (status IN (2,4,5)) y el mismo dd.total
// (ya confirmado CON IVA, 22-sep-2026: SUM(dd.total) == f.total/o.total en
// ~250k documentos reales, ratio 1.0000) que ya usan qPreventa/
// qBotellonesOrdenes en controllerConsolidado — NO se recalcula el dólar
// desde cero, solo se agrega la dimensión de condición de pago encima.
//
// Condición de pago: MISMA lógica ya validada en
// mcp-server/src/sql/clasificacion.js (CONDICION_PAGO_CLIENTE /
// CONDICION_PAGO_FACTURA) — señal transaccional (facturas out_invoice:
// fecha_vencimiento vs fecha_creacion, ≤1 día = CONTADO) cuando existe,
// fallback a clientes.metodo_pago_cliente ('Pago Inmediato' = CONTADO,
// cualquier otro texto no vacío = CREDITO) en cualquier otro caso
// (ordenes, notas de crédito, facturas sin fecha_vencimiento).

const Sequelize = require("sequelize");
const { sequelize } = require("../../models");

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const CONDICION_PAGO_CASE = `
  CASE
    WHEN doc.origen = 'factura' AND doc.tipo_movimiento = 'out_invoice' AND doc.fecha_vencimiento IS NOT NULL
         AND ROUND(EXTRACT(EPOCH FROM (doc.fecha_vencimiento - doc.fecha_creacion))/86400) <= 1
      THEN 'CONTADO'
    WHEN doc.origen = 'factura' AND doc.tipo_movimiento = 'out_invoice' AND doc.fecha_vencimiento IS NOT NULL
      THEN 'CREDITO'
    WHEN c.metodo_pago_cliente ILIKE 'pago inmediato' THEN 'CONTADO'
    WHEN c.metodo_pago_cliente IS NOT NULL AND c.metodo_pago_cliente <> '' THEN 'CREDITO'
    ELSE 'SIN_DATO'
  END
`;

// Sub-producto de BOTELLÓN por codigo_producto real de Odoo (NO por
// descripcion_categoria, que agrupa los 5 SKUs juntos) — catálogo cerrado y
// confirmado por Alberto 26-sep-2026 (ver icl-backend/db/schema.sql,
// productos + producto_alias_ids). 2331 y 4813 son el MISMO producto que 28
// (suscripción mensual / duplicado de compañía DISTRINTER); 285 es el id de
// product.template de 189 (Odoo a veces sincronizó ese en vez del id de
// product.product). 443 y 489 NO son botellón pese a nombres viejos en esta
// misma tabla (son "recogedor de basura" y "servicio de luz" hoy en
// Odoo) — deliberadamente excluidos, quedan sin clasificar (NULL).
const SUB_PRODUCTO_BOTELLON_CASE = `
  CASE
    WHEN dd.codigo_producto IN ('28','2331','4813') THEN 'LIQUIDO_PET'
    WHEN dd.codigo_producto IN ('189','285')        THEN 'ENVASE_PET'
    WHEN dd.codigo_producto IN ('45')                THEN 'LIQUIDO_PP'
    WHEN dd.codigo_producto IN ('381')                THEN 'ENVASE_PP'
    WHEN dd.codigo_producto IN ('335')                THEN 'COMPUESTO'
    ELSE NULL
  END
`;

// GET /api/ventas-por-ruta?ruta=<codigo>&fecha_inicio=YYYY-MM-DD&fecha_fin=YYYY-MM-DD
const obtenerVentasPorRuta = async (req, res) => {
  try {
    const { ruta, fecha_inicio, fecha_fin } = req.query;

    if (!ruta || !fecha_inicio || !fecha_fin) {
      return res.status(400).json({ error: "Debe enviar ruta, fecha_inicio y fecha_fin" });
    }
    if (!FECHA_REGEX.test(fecha_inicio) || !FECHA_REGEX.test(fecha_fin)) {
      return res.status(400).json({ error: "fecha_inicio y fecha_fin deben tener formato YYYY-MM-DD" });
    }

    const inicio = `${fecha_inicio} 00:00:00`;
    // Fin exclusivo (día siguiente a fecha_fin) para incluir fecha_fin completo.
    const finDate = new Date(`${fecha_fin}T00:00:00Z`);
    finDate.setUTCDate(finDate.getUTCDate() + 1);
    const fin = finDate.toISOString().replace("T", " ").substring(0, 19);

    // GROUPING SETS: (categoria) da por_categoria igual que antes, sin tocar
    // ese cálculo; (condicion_pago) da el desglose de Liquidación;
    // (sub_producto_botellon) da el desglose nuevo para el cuadre de
    // líquido/envase; (es_regalia) reemplaza la detección vieja y rota de
    // "categoria = REGALIA" (esa categoría NUNCA existió en los datos
    // reales, confirmado 17-sep-2026 Y de nuevo 05-oct-2026 — cuadreService
    // siempre calculó regalia=0 en cada cuadre hasta ahora). Una regalía es
    // cualquier línea con cantidad>0 pero total=0 sobre un producto normal
    // (confirmado contra datos reales: 6478 u. de BOTELLÓN regaladas en los
    // últimos 30 días, no 0 como asumía el código viejo); () da el total
    // general — las 5 vistas salen de la MISMA suma de dd.total, así que
    // total_dolares_general siempre reconcilia exacto contra los 4 desgloses.
    const sql = `
      SELECT
        categoria,
        condicion_pago,
        sub_producto_botellon,
        es_regalia,
        SUM(unidades) AS unidades,
        SUM(dolares)  AS dolares,
        COUNT(DISTINCT doc_code) AS documentos
      FROM (
        SELECT
          COALESCE(dd.descripcion_categoria, 'SIN CATEGORÍA') AS categoria,
          ${CONDICION_PAGO_CASE} AS condicion_pago,
          ${SUB_PRODUCTO_BOTELLON_CASE} AS sub_producto_botellon,
          (dd.total = 0 AND dd.cantidad > 0) AS es_regalia,
          dd.cantidad AS unidades,
          dd.total    AS dolares,
          doc.code    AS doc_code
        FROM (
          SELECT o.code, o.fecha_creacion, o.customer_code,
                 NULL::varchar AS tipo_movimiento, NULL::timestamp AS fecha_vencimiento,
                 'orden' AS origen
          FROM ordenes o
          WHERE o.route_code = :ruta
            AND o.status IN (2,4,5)
            AND o.fecha_creacion >= :inicio
            AND o.fecha_creacion <  :fin

          UNION ALL

          SELECT f.code, f.fecha_creacion, f.customer_code,
                 f.tipo_movimiento, f.fecha_vencimiento,
                 'factura' AS origen
          FROM facturas f
          WHERE f.route_code = :ruta
            AND f.status IN (2,4,5)
            AND f.fecha_creacion >= :inicio
            AND f.fecha_creacion <  :fin
        ) doc
        JOIN detalle_documento dd ON dd.documento_code = doc.code
        LEFT JOIN clientes c ON c.codigo_cliente = doc.customer_code
      ) base
      GROUP BY GROUPING SETS ((categoria), (condicion_pago), (sub_producto_botellon), (es_regalia), ())
    `;

    const filas = await sequelize.query(sql, {
      replacements: { ruta, inicio, fin },
      type: Sequelize.QueryTypes.SELECT,
    });

    const por_categoria = [];
    const por_condicion_pago = { CONTADO: null, CREDITO: null, SIN_DATO: null };
    const porSubProducto = { LIQUIDO_PET: null, ENVASE_PET: null, LIQUIDO_PP: null, ENVASE_PP: null, COMPUESTO: null };
    let total = { unidades: 0, dolares: 0 };
    let regalia = { unidades: 0, documentos: 0 };

    // Con 5 dimensiones en GROUPING SETS, cada fila trae las OTRAS 4 en NULL
    // (semántica estándar de GROUPING SETS) — hay que exigir las 4 en NULL
    // para identificar a qué "vista" pertenece cada fila, si no una fila de
    // (es_regalia) se cuela como si fuera de (categoria), etc.
    for (const r of filas) {
      const unidades = Number(r.unidades) || 0;
      const dolares = Number(Number(r.dolares || 0).toFixed(2));
      const documentos = Number(r.documentos) || 0;
      const soloCategoria = r.categoria != null && r.condicion_pago == null && r.sub_producto_botellon == null && r.es_regalia == null;
      const soloCondicionPago = r.condicion_pago != null && r.categoria == null && r.sub_producto_botellon == null && r.es_regalia == null;
      const soloSubProducto = r.sub_producto_botellon != null && r.categoria == null && r.condicion_pago == null && r.es_regalia == null;
      const soloRegalia = r.es_regalia != null && r.categoria == null && r.condicion_pago == null && r.sub_producto_botellon == null;
      const esTotalGeneral = r.categoria == null && r.condicion_pago == null && r.sub_producto_botellon == null && r.es_regalia == null;

      if (esTotalGeneral) {
        total = { unidades, dolares };
      } else if (soloCategoria) {
        por_categoria.push({ categoria: r.categoria, unidades, dolares });
      } else if (soloCondicionPago) {
        por_condicion_pago[r.condicion_pago] = { unidades, dolares, documentos };
      } else if (soloSubProducto) {
        porSubProducto[r.sub_producto_botellon] = { unidades, dolares };
      } else if (soloRegalia && (r.es_regalia === true || r.es_regalia === "t")) {
        regalia = { unidades, documentos };
      }
    }

    por_categoria.sort((a, b) => b.dolares - a.dolares);

    const vacio = { unidades: 0, dolares: 0, documentos: 0 };
    const vacioSub = { unidades: 0, dolares: 0 };

    // Descomposición de COMPUESTO (id 335, confirmada por Alberto 26-sep-2026):
    // cada unidad vendida ahí cuenta +1 hacia líquido_PET Y +1 hacia
    // envase_PET al mismo tiempo, no como categoría aparte.
    const compuesto = porSubProducto.COMPUESTO || vacioSub;
    const liquidoPetBase = porSubProducto.LIQUIDO_PET || vacioSub;
    const envasePetBase = porSubProducto.ENVASE_PET || vacioSub;

    return res.json({
      unidades_totales: total.unidades,
      dolares_totales: total.dolares,
      por_categoria,
      por_condicion_pago: {
        contado: por_condicion_pago.CONTADO || vacio,
        credito: por_condicion_pago.CREDITO || vacio,
        sin_dato: por_condicion_pago.SIN_DATO || vacio,
      },
      regalia,
      por_producto_botellon: {
        liquido_pet: {
          unidades: liquidoPetBase.unidades + compuesto.unidades,
          dolares: Number((liquidoPetBase.dolares + compuesto.dolares).toFixed(2)),
        },
        envase_pet: {
          unidades: envasePetBase.unidades + compuesto.unidades,
          dolares: Number((envasePetBase.dolares + compuesto.dolares).toFixed(2)),
        },
        liquido_pp: porSubProducto.LIQUIDO_PP || vacioSub,
        envase_pp: porSubProducto.ENVASE_PP || vacioSub,
        // Crudo, sin descomponer — para poder auditar/depurar sin rehacer la consulta.
        compuesto,
      },
    });
  } catch (error) {
    console.error("❌ ERROR VENTAS POR RUTA:", error);
    return res.status(500).json({ message: "Error al obtener ventas por ruta", detail: error.message });
  }
};

// GET /api/ventas-por-ruta/precio-promedio-liquido?dias=60
// Precio promedio REAL de venta (Fuente B, confirmada por Alberto 05-oct-2026
// para valorizar diferencias de cuadre de líquido sin explicar) — NUNCA el
// list_price de Odoo, que no refleja descuentos por cliente/convenio (se
// encontraron cientos de product.pricelist.item con precio fijo muy por
// debajo del catálogo). Se recalcula en cada llamada sobre una ventana móvil
// (default 60 días, ventana ya validada 04-oct-2026: $1.7682/u PET, $1.1143/u
// PP, estable contra una ventana de 7 días) — NUNCA hardcodeado. Agregado
// GLOBAL (todas las rutas), no por ruta — el precio de venta no depende de
// qué ruta lo vendió. Misma clasificación SUB_PRODUCTO_BOTELLON_CASE que ya
// usa /api/ventas-por-ruta, pero EXCLUYE a propósito COMPUESTO (ver abajo).
const obtenerPrecioPromedioLiquido = async (req, res) => {
  try {
    const dias = parseInt(req.query.dias, 10) || 60;
    if (dias <= 0 || dias > 365) {
      return res.status(400).json({ error: "dias debe ser un entero entre 1 y 365" });
    }

    const sql = `
      SELECT
        sub_producto_botellon,
        SUM(unidades) AS unidades,
        SUM(dolares)  AS dolares
      FROM (
        SELECT
          ${SUB_PRODUCTO_BOTELLON_CASE} AS sub_producto_botellon,
          dd.cantidad AS unidades,
          dd.total    AS dolares
        FROM (
          SELECT o.code, o.fecha_creacion FROM ordenes o
          WHERE o.status IN (2,4,5) AND o.fecha_creacion >= now() - make_interval(days => :dias)
          UNION ALL
          SELECT f.code, f.fecha_creacion FROM facturas f
          WHERE f.status IN (2,4,5) AND f.fecha_creacion >= now() - make_interval(days => :dias)
        ) doc
        JOIN detalle_documento dd ON dd.documento_code = doc.code
        WHERE dd.codigo_producto IN ('28','2331','4813','45')
      ) base
      WHERE sub_producto_botellon IS NOT NULL
      GROUP BY sub_producto_botellon
    `;

    const filas = await sequelize.query(sql, {
      replacements: { dias },
      type: Sequelize.QueryTypes.SELECT,
    });

    // A propósito SIN COMPUESTO (id 335, ni en el WHERE de arriba ni acá):
    // compuesto empaqueta envase+líquido+depósito en un solo precio mucho
    // más alto (~$7.75/u) que no representa el precio de una unidad de SOLO
    // líquido — mezclarlo infló el precio casi 30% en la primera prueba
    // (de $1.77 a $2.30/u). Para valorizar una diferencia de líquido hace
    // falta el precio de líquido puro, no el de un combo con depósito.
    const vacio = { unidades: 0, dolares: 0 };
    const porSub = { LIQUIDO_PET: vacio, LIQUIDO_PP: vacio };
    for (const r of filas) {
      porSub[r.sub_producto_botellon] = { unidades: Number(r.unidades) || 0, dolares: Number(r.dolares) || 0 };
    }

    const unidadesPet = porSub.LIQUIDO_PET.unidades;
    const dolaresPet = porSub.LIQUIDO_PET.dolares;
    const unidadesPp = porSub.LIQUIDO_PP.unidades;
    const dolaresPp = porSub.LIQUIDO_PP.dolares;

    return res.json({
      dias,
      liquido_pet: {
        unidades: unidadesPet,
        dolares: Number(dolaresPet.toFixed(2)),
        precio_promedio: unidadesPet > 0 ? Number((dolaresPet / unidadesPet).toFixed(4)) : null,
      },
      liquido_pp: {
        unidades: unidadesPp,
        dolares: Number(dolaresPp.toFixed(2)),
        precio_promedio: unidadesPp > 0 ? Number((dolaresPp / unidadesPp).toFixed(4)) : null,
      },
    });
  } catch (error) {
    console.error("❌ ERROR PRECIO PROMEDIO LIQUIDO:", error);
    return res.status(500).json({ message: "Error al calcular precio promedio de líquido", detail: error.message });
  }
};

// GET /api/ventas-por-ruta/por-producto?ruta=&fecha_inicio=&fecha_fin=&ids=40,4814,1476
// Genérico, por codigo_producto crudo (05-oct-2026, bloque A — descartable/
// hielo) — a propósito SIN clasificación/descomposición (eso es para
// botellón, que tiene el caso especial de COMPUESTO). Cualquier mapeo de
// "estos ids son el mismo producto" (alias de compañía, etc.) se resuelve
// del lado de icl-backend (tabla producto_alias_ids), que es donde vive esa
// relación — este endpoint es una agregación cruda, no debe duplicar ese
// conocimiento acá.
const obtenerVentaPorProducto = async (req, res) => {
  try {
    const { ruta, fecha_inicio, fecha_fin, ids } = req.query;

    if (!ruta || !fecha_inicio || !fecha_fin || !ids) {
      return res.status(400).json({ error: "Debe enviar ruta, fecha_inicio, fecha_fin e ids" });
    }
    if (!FECHA_REGEX.test(fecha_inicio) || !FECHA_REGEX.test(fecha_fin)) {
      return res.status(400).json({ error: "fecha_inicio y fecha_fin deben tener formato YYYY-MM-DD" });
    }
    const listaIds = ids.split(",").map((s) => s.trim()).filter(Boolean);
    if (!listaIds.length) {
      return res.status(400).json({ error: "ids no puede quedar vacío" });
    }

    const inicio = `${fecha_inicio} 00:00:00`;
    const finDate = new Date(`${fecha_fin}T00:00:00Z`);
    finDate.setUTCDate(finDate.getUTCDate() + 1);
    const fin = finDate.toISOString().replace("T", " ").substring(0, 19);

    const sql = `
      SELECT dd.codigo_producto, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares
      FROM (
        SELECT o.code FROM ordenes o
        WHERE o.route_code = :ruta AND o.status IN (2,4,5)
          AND o.fecha_creacion >= :inicio AND o.fecha_creacion < :fin
        UNION ALL
        SELECT f.code FROM facturas f
        WHERE f.route_code = :ruta AND f.status IN (2,4,5)
          AND f.fecha_creacion >= :inicio AND f.fecha_creacion < :fin
      ) doc
      JOIN detalle_documento dd ON dd.documento_code = doc.code
      WHERE dd.codigo_producto IN (:ids)
      GROUP BY dd.codigo_producto
    `;

    const filas = await sequelize.query(sql, {
      replacements: { ruta, inicio, fin, ids: listaIds },
      type: Sequelize.QueryTypes.SELECT,
    });

    const por_producto = {};
    for (const id of listaIds) por_producto[id] = { unidades: 0, dolares: 0 };
    for (const r of filas) {
      por_producto[r.codigo_producto] = { unidades: Number(r.unidades) || 0, dolares: Number(Number(r.dolares || 0).toFixed(2)) };
    }

    return res.json({ por_producto });
  } catch (error) {
    console.error("❌ ERROR VENTA POR PRODUCTO:", error);
    return res.status(500).json({ message: "Error al obtener venta por producto", detail: error.message });
  }
};

// GET /api/ventas-por-ruta/precio-promedio-producto?ids=40,1476,...&dias=60
// Genérico (05-oct-2026, bloque B) — mismo concepto que precio-promedio-
// liquido (Fuente B, promedio real transaccional, NUNCA list_price) pero
// por codigo_producto arbitrario, sin PET/PP ni COMPUESTO — eso es
// específico de botellón. Lo usa DESCARTABLE para cobrar diferencia sin
// explicar con el mismo patrón que líquido. Agregado GLOBAL (todas las
// rutas), ventana móvil — se recalcula en cada llamada, nunca hardcodeado.
const obtenerPrecioPromedioProducto = async (req, res) => {
  try {
    const dias = parseInt(req.query.dias, 10) || 60;
    const { ids } = req.query;
    if (!ids) {
      return res.status(400).json({ error: "Debe enviar ids" });
    }
    if (dias <= 0 || dias > 365) {
      return res.status(400).json({ error: "dias debe ser un entero entre 1 y 365" });
    }
    const listaIds = ids.split(",").map((s) => s.trim()).filter(Boolean);
    if (!listaIds.length) {
      return res.status(400).json({ error: "ids no puede quedar vacío" });
    }

    const sql = `
      SELECT dd.codigo_producto, SUM(dd.cantidad) AS unidades, SUM(dd.total) AS dolares
      FROM (
        SELECT o.code FROM ordenes o
        WHERE o.status IN (2,4,5) AND o.fecha_creacion >= now() - make_interval(days => :dias)
        UNION ALL
        SELECT f.code FROM facturas f
        WHERE f.status IN (2,4,5) AND f.fecha_creacion >= now() - make_interval(days => :dias)
      ) doc
      JOIN detalle_documento dd ON dd.documento_code = doc.code
      WHERE dd.codigo_producto IN (:ids) AND dd.total > 0
      GROUP BY dd.codigo_producto
    `;

    const filas = await sequelize.query(sql, {
      replacements: { dias, ids: listaIds },
      type: Sequelize.QueryTypes.SELECT,
    });

    const por_producto = {};
    for (const id of listaIds) por_producto[id] = { unidades: 0, dolares: 0, precio_promedio: null };
    for (const r of filas) {
      const unidades = Number(r.unidades) || 0;
      const dolares = Number(Number(r.dolares || 0).toFixed(2));
      por_producto[r.codigo_producto] = {
        unidades,
        dolares,
        precio_promedio: unidades > 0 ? Number((dolares / unidades).toFixed(4)) : null,
      };
    }

    return res.json({ dias, por_producto });
  } catch (error) {
    console.error("❌ ERROR PRECIO PROMEDIO PRODUCTO:", error);
    return res.status(500).json({ message: "Error al calcular precio promedio por producto", detail: error.message });
  }
};

module.exports = {
  obtenerVentasPorRuta,
  obtenerPrecioPromedioLiquido,
  obtenerVentaPorProducto,
  obtenerPrecioPromedioProducto,
};
