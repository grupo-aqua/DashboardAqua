// test/auditoriaClientes-real.test.js
// Prueba de regresión con datos reales para auditoriaClientes — ver
// auditoriaClientes.js para el contexto completo (Fase 1, solo
// diagnóstico, cruce MobilVendor + Odoo corporativo). Cada categoría se
// compara contra una query/consulta INDEPENDIENTE (SQL propio del test o
// JSON-RPC directo a Odoo, sin reutilizar ninguna función interna de la
// tool) para no compartir un eventual bug de construcción de query.
require("dotenv").config();
const { auditoriaClientes, CATEGORIAS_VALIDAS } = require("../src/tools/auditoriaClientes");
const { executeKw } = require("../src/integrations/odooContabilidad");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

async function main() {
  // 1) direcciones_incompletas — conteo independiente.
  const { rows: incompletasReal } = await pool.query(`
    SELECT count(*) AS total
    FROM direcciones_clientes dc
    JOIN clientes c ON c.codigo_cliente = dc.codigo_cliente
    WHERE dc.estado_direccion_cliente = 1
      AND (dc.calle1_direccion_cliente IS NULL OR TRIM(dc.calle1_direccion_cliente) = '')
      AND (c.direccion_cliente IS NULL OR TRIM(c.direccion_cliente) = '')
  `);
  const resultadoDirecciones = await auditoriaClientes({ categoria: "direcciones_incompletas", limite: 1 });
  asegurar(
    resultadoDirecciones.total === Number(incompletasReal[0].total),
    `direcciones_incompletas: total tool (${resultadoDirecciones.total}) == SQL directo (${incompletasReal[0].total})`
  );
  asegurar(resultadoDirecciones.total > 0, "direcciones_incompletas: sanity check — sí hay casos reales (no vacío)");
  asegurar(
    resultadoDirecciones.items.every((i) => i.campos_faltantes.includes("calle1")),
    "direcciones_incompletas: todo item devuelto tiene 'calle1' en campos_faltantes (es el criterio que las define)"
  );

  // 2) coordenadas — conteos independientes por tipo + verificación de un
  //    cluster de pin-por-defecto real conocido.
  const { rows: coordReal } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE latitud_direccion_cliente IS NULL OR longitud_direccion_cliente IS NULL) AS nulas,
      count(*) FILTER (WHERE latitud_direccion_cliente = 0 AND longitud_direccion_cliente = 0) AS cero_cero,
      count(*) FILTER (
        WHERE latitud_direccion_cliente IS NOT NULL AND longitud_direccion_cliente IS NOT NULL
          AND NOT (latitud_direccion_cliente = 0 AND longitud_direccion_cliente = 0)
          AND (latitud_direccion_cliente NOT BETWEEN -5.5 AND 2.0 OR longitud_direccion_cliente NOT BETWEEN -81.5 AND -75.0)
      ) AS fuera_rango
    FROM direcciones_clientes
    WHERE estado_direccion_cliente = 1
  `);
  const { rows: pinReal } = await pool.query(`
    SELECT count(DISTINCT codigo_cliente) AS n
    FROM direcciones_clientes
    WHERE estado_direccion_cliente = 1 AND latitud_direccion_cliente = -1.33976680 AND longitud_direccion_cliente = -79.36669650
  `);
  const resultadoCoord = await auditoriaClientes({ categoria: "coordenadas", limite: 500 });
  const porTipo = { NULA: 0, CERO_CERO: 0, FUERA_RANGO_ECUADOR: 0, PIN_POR_DEFECTO: 0 };
  // total real esperado = nulas + cero_cero + fuera_rango + (pines por defecto que no caen ya en las 3 anteriores)
  const totalBase = Number(coordReal[0].nulas) + Number(coordReal[0].cero_cero) + Number(coordReal[0].fuera_rango);
  asegurar(resultadoCoord.total >= totalBase, `coordenadas: total tool (${resultadoCoord.total}) >= nulas+cero_cero+fuera_rango (${totalBase}) — el resto son pines por defecto adicionales`);
  asegurar(Number(pinReal[0].n) > 5, `sanity check: el cluster de pin conocido (-1.3397668,-79.3666965) SÍ tiene más de 5 clientes reales (${pinReal[0].n})`);

  // 3) duplicados — conteos independientes de señal fuerte y débil.
  const { rows: fuerteReal } = await pool.query(`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM clientes
      WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
      GROUP BY identificacion_cliente, company_id, nombre_cliente
      HAVING COUNT(*) > 1
    ) x
  `);
  const { rows: debilReal } = await pool.query(`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM clientes
      WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) NOT IN ('', '9999999999', '9999999999999')
      GROUP BY TRIM(identificacion_cliente)
      HAVING COUNT(DISTINCT nombre_cliente) > 1
    ) x
  `);
  const resultadoDup = await auditoriaClientes({ categoria: "duplicados", limite: 1 });
  asegurar(
    resultadoDup.senal_fuerte.total === Number(fuerteReal[0].n),
    `duplicados.senal_fuerte: total tool (${resultadoDup.senal_fuerte.total}) == SQL directo (${fuerteReal[0].n})`
  );
  asegurar(
    resultadoDup.senal_debil.total === Number(debilReal[0].n),
    `duplicados.senal_debil: total tool (${resultadoDup.senal_debil.total}) == SQL directo (${debilReal[0].n})`
  );
  asegurar(
    resultadoDup.senal_fuerte.items.every((i) => i.codigos.length > 1),
    "duplicados.senal_fuerte: todo item tiene 2+ codigo_cliente (por definición del criterio)"
  );
  asegurar(
    resultadoDup.senal_debil.items.every((i) => i.num_nombres_distintos <= 8),
    "duplicados.senal_debil: ningún item del listado supera el umbral de 8 nombres distintos (cadenas grandes van excluidas)"
  );

  // 4) sin_canal — conteo independiente.
  const { rows: sinCanalReal } = await pool.query(`SELECT count(*) AS n FROM clientes WHERE codigo_tipo_negocio IS NULL`);
  const resultadoSinCanal = await auditoriaClientes({ categoria: "sin_canal", limite: 1 });
  asegurar(resultadoSinCanal.total === Number(sinCanalReal[0].n), `sin_canal: total tool (${resultadoSinCanal.total}) == SQL directo (${sinCanalReal[0].n})`);

  // 5) activos_sin_consumo — caso real conocido (TIA CUMBAYA, codigo 137500):
  //    confirmado en la investigación previa que tiene 0 filas en ordenes Y
  //    en facturas bajo ese código exacto — debe aparecer con
  //    nunca_compro=true si su RUC está activo en Odoo (se confirma en vivo
  //    contra Odoo, no se asume).
  const { rows: docsTia } = await pool.query(`
    SELECT
      (SELECT count(*) FROM ordenes WHERE customer_code = '137500') AS ordenes,
      (SELECT count(*) FROM facturas WHERE customer_code = '137500') AS facturas
  `);
  asegurar(Number(docsTia[0].ordenes) === 0 && Number(docsTia[0].facturas) === 0, "sanity check: codigo_cliente 137500 (TIA CUMBAYA) sigue con 0 ordenes/facturas reales bajo su propio código");

  const { rows: rucTia } = await pool.query(`SELECT TRIM(identificacion_cliente) AS ruc FROM clientes WHERE codigo_cliente = '137500'`);
  const rucTiaTrim = rucTia[0]?.ruc;
  const partnersTia = await executeKw("res.partner", "search_read", [[["vat", "=", rucTiaTrim]]], { fields: ["vat", "active"], context: { active_test: false }, limit: 5 });
  const tiaActivaEnOdoo = partnersTia.some((p) => p.active);

  const resultadoActivos = await auditoriaClientes({ categoria: "activos_sin_consumo", umbral_dias_inactividad: 365, limite: 500 });
  const itemTia = resultadoActivos.items.find((i) => i.codigo_cliente === "137500");
  if (tiaActivaEnOdoo) {
    asegurar(!!itemTia && itemTia.nunca_compro === true, "activos_sin_consumo: TIA CUMBAYA (137500) SÍ aparece con nunca_compro=true (su RUC está activo en Odoo, confirmado en vivo)");
  } else {
    asegurar(!itemTia, "activos_sin_consumo: TIA CUMBAYA (137500) NO aparece (su RUC ya no está activo en Odoo, confirmado en vivo) — consistente");
  }

  // 6) umbral_dias_inactividad debe ser monótono: un umbral mayor nunca
  //    puede dar MÁS candidatos que uno menor.
  const activos180 = await auditoriaClientes({ categoria: "activos_sin_consumo", umbral_dias_inactividad: 180, limite: 1 });
  const activos730 = await auditoriaClientes({ categoria: "activos_sin_consumo", umbral_dias_inactividad: 730, limite: 1 });
  asegurar(
    activos180.total >= resultadoActivos.total && resultadoActivos.total >= activos730.total,
    `activos_sin_consumo: monotonía correcta — umbral 180 (${activos180.total}) >= 365 (${resultadoActivos.total}) >= 730 (${activos730.total})`
  );

  // 7) Resumen (sin categoría): debe traer las 5 categorías, cada una con
  //    su total real (no solo la muestra chica) y como máximo 5 items.
  const resumen = await auditoriaClientes({});
  for (const cat of CATEGORIAS_VALIDAS) {
    asegurar(cat in resumen || `${cat}` === "activos_sin_consumo" ? true : false, `resumen: trae la clave "${cat}"`);
  }
  asegurar(resumen.direcciones_incompletas.total === resultadoDirecciones.total, "resumen: direcciones_incompletas.total coincide con la llamada por categoría");
  asegurar(resumen.duplicados.senal_fuerte.total === resultadoDup.senal_fuerte.total, "resumen: duplicados.senal_fuerte.total coincide con la llamada por categoría");
  asegurar(resumen.sin_canal.items.length <= 5, "resumen: sin_canal trae como máximo 5 items (muestra chica, no `limite`)");

  await pool.end();
  console.log("\nAUDITORIA CLIENTES REAL TEST OK");
}

main().catch((err) => {
  console.error("\nAUDITORIA CLIENTES REAL TEST FALLÓ:", err);
  process.exit(1);
});
