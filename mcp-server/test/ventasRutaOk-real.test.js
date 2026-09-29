// test/ventasRutaOk-real.test.js
// Prueba de regresión con datos reales para ventasRutaOk — ver
// ventasRutaOk.js para el contexto completo (dos fuentes: COTTSA vía
// Postgres + aqua-premium-ne vía JSON-RPC en vivo, sin deduplicar todavía
// por instrucción explícita de Alberto).
//
// Rango de validación: MAYO 2026 (2026-05-01 a 2026-05-31) — se eligió a
// propósito porque es un mes cerrado con actividad real CONFIRMADA en las 3
// rutas en AMBAS fuentes (investigación previa: aqua-premium-ne no tiene
// ninguna venta de estas rutas después del 2026-06-09; usar "mes actual"
// aquí daría $0 en esa fuente y no probaría nada). También se valida por
// separado que la advertencia SÍ aparece para un rango del mes actual, que
// es justamente el caso de uso principal que pidió Alberto.
require("dotenv").config();
const { ventasRutaOk, RUTAS_OK_VALIDAS } = require("../src/tools/ventasRutaOk");
const { executeKw } = require("../src/integrations/aquaPremiumNe");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

const MES_INICIO = "2026-05-01";
const MES_FIN = "2026-05-31";
const MES_INICIO_TS = "2026-05-01 00:00:00";
const MES_FIN_EXCLUSIVO_TS = "2026-06-01 00:00:00";

const CONFIG_ID_POR_RUTA = { 113: [23], 131: [25], 132: [24] };
const SELLER_CODES_COTTSA_POR_RUTA = { 113: ["RUTA 113"], 131: ["RUTA 131"], 132: ["RUTA 132", "RUTA 132.1"] };

async function totalCottsaRealSQL(sellerCodes) {
  const { rows } = await pool.query(
    `SELECT
       count(DISTINCT f.code) AS num_documentos,
       COALESCE(SUM(CASE WHEN f.tipo_movimiento = 'out_refund' THEN -f.total ELSE f.total END), 0) AS dolares
     FROM facturas f
     WHERE f.seller_code = ANY($1::text[])
       AND f.status = 2
       AND f.customer_code NOT IN ('8', '9')
       AND f.fecha_creacion >= $2 AND f.fecha_creacion < $3`,
    [sellerCodes, MES_INICIO_TS, MES_FIN_EXCLUSIVO_TS]
  );
  return { num_documentos: Number(rows[0].num_documentos), dolares: Number(rows[0].dolares) };
}

async function totalAquaPremiumRealJsonRpc(configIds) {
  const grupos = await executeKw(
    "pos.order",
    "read_group",
    [[["config_id", "in", configIds], ["date_order", ">=", MES_INICIO_TS], ["date_order", "<", MES_FIN_EXCLUSIVO_TS]], ["amount_total:sum"], []],
    {}
  );
  const fila = grupos[0] || { __count: 0, amount_total: 0 };
  return { num_documentos: fila.__count || 0, dolares: fila.amount_total || 0 };
}

async function main() {
  // 1) Cada ruta individual, mayo 2026: por_fuente.cottsa y
  //    por_fuente.aqua_premium_ne comparados contra las dos fuentes
  //    consultadas independientemente (SQL directo / JSON-RPC directo).
  for (const rutaKey of RUTAS_OK_VALIDAS) {
    const [realCottsa, realAqua, resultado] = await Promise.all([
      totalCottsaRealSQL(SELLER_CODES_COTTSA_POR_RUTA[rutaKey]),
      totalAquaPremiumRealJsonRpc(CONFIG_ID_POR_RUTA[rutaKey]),
      ventasRutaOk({ ruta: rutaKey, fecha_inicio: MES_INICIO, fecha_fin: MES_FIN }),
    ]);

    asegurar(
      Math.abs(resultado.por_fuente.cottsa.dolares - realCottsa.dolares) < 0.01,
      `ruta ${rutaKey} mayo 2026: por_fuente.cottsa.dolares (${resultado.por_fuente.cottsa.dolares}) == SQL directo (${realCottsa.dolares})`
    );
    asegurar(
      resultado.por_fuente.cottsa.num_documentos === realCottsa.num_documentos,
      `ruta ${rutaKey} mayo 2026: por_fuente.cottsa.num_documentos (${resultado.por_fuente.cottsa.num_documentos}) == SQL directo (${realCottsa.num_documentos})`
    );
    asegurar(
      Math.abs(resultado.por_fuente.aqua_premium_ne.dolares - realAqua.dolares) < 0.01,
      `ruta ${rutaKey} mayo 2026: por_fuente.aqua_premium_ne.dolares (${resultado.por_fuente.aqua_premium_ne.dolares}) == JSON-RPC directo (${realAqua.dolares})`
    );
    asegurar(
      resultado.por_fuente.aqua_premium_ne.num_documentos === realAqua.num_documentos,
      `ruta ${rutaKey} mayo 2026: por_fuente.aqua_premium_ne.num_documentos (${resultado.por_fuente.aqua_premium_ne.num_documentos}) == JSON-RPC directo (${realAqua.num_documentos})`
    );

    // total_combinado debe ser exactamente la suma de las dos fuentes.
    asegurar(
      Math.abs(resultado.total_combinado.dolares - (realCottsa.dolares + realAqua.dolares)) < 0.01,
      `ruta ${rutaKey} mayo 2026: total_combinado.dolares (${resultado.total_combinado.dolares}) == cottsa + aqua_premium_ne (${realCottsa.dolares + realAqua.dolares})`
    );

    // por_cliente debe sumar exacto al total_combinado.
    const sumaPorCliente = resultado.por_cliente.reduce((acc, c) => acc + c.dolares_total, 0);
    asegurar(
      Math.abs(sumaPorCliente - resultado.total_combinado.dolares) < 0.01,
      `ruta ${rutaKey} mayo 2026: suma de por_cliente.dolares_total (${sumaPorCliente.toFixed(2)}) == total_combinado (${resultado.total_combinado.dolares})`
    );

    // Ambas fuentes tuvieron actividad real en mayo 2026 (confirmado en la
    // investigación previa) — si alguna diera 0 documentos, el rango de
    // validación ya no sería representativo y el test dejaría de probar lo
    // que dice probar.
    asegurar(realCottsa.num_documentos > 0, `ruta ${rutaKey} mayo 2026: COTTSA SÍ tuvo documentos reales (sanity check del rango elegido)`);
    asegurar(realAqua.num_documentos > 0, `ruta ${rutaKey} mayo 2026: aqua-premium-ne SÍ tuvo órdenes reales (sanity check del rango elegido)`);

    // Sin advertencia — mayo 2026 está antes de la última actividad
    // conocida (2026-06-09).
    asegurar(resultado.advertencia_aqua_premium_ne === null, `ruta ${rutaKey} mayo 2026: sin advertencia_aqua_premium_ne`);
  }

  // 2) Array de las 3 rutas: el consolidado debe sumar exacto a las 3
  //    llamadas individuales, y por_ruta debe coincidir fila por fila.
  const individuales = {};
  for (const rutaKey of RUTAS_OK_VALIDAS) {
    individuales[rutaKey] = await ventasRutaOk({ ruta: rutaKey, fecha_inicio: MES_INICIO, fecha_fin: MES_FIN });
  }
  const consolidado = await ventasRutaOk({ ruta: RUTAS_OK_VALIDAS, fecha_inicio: MES_INICIO, fecha_fin: MES_FIN });

  const sumaIndividuales = RUTAS_OK_VALIDAS.reduce((acc, r) => acc + individuales[r].total_combinado.dolares, 0);
  asegurar(
    Math.abs(consolidado.total_combinado.dolares - sumaIndividuales) < 0.01,
    `array [113,131,132] mayo 2026: total_combinado consolidado (${consolidado.total_combinado.dolares}) == suma de individuales (${sumaIndividuales.toFixed(2)})`
  );

  for (const rutaKey of RUTAS_OK_VALIDAS) {
    const fila = consolidado.por_ruta.find((r) => r.ruta === rutaKey);
    asegurar(!!fila, `por_ruta trae la ruta ${rutaKey}`);
    asegurar(
      Math.abs(fila.total_combinado.dolares - individuales[rutaKey].total_combinado.dolares) < 0.01,
      `por_ruta[${rutaKey}] coincide EXACTO con la llamada individual (${fila.total_combinado.dolares} == ${individuales[rutaKey].total_combinado.dolares})`
    );
  }

  // 3) Default sin `ruta`: debe traer las 3 rutas combinadas (mismo
  //    resultado que pasar el array explícito).
  const porDefecto = await ventasRutaOk({ fecha_inicio: MES_INICIO, fecha_fin: MES_FIN });
  asegurar(
    Math.abs(porDefecto.total_combinado.dolares - consolidado.total_combinado.dolares) < 0.01,
    `sin \`ruta\` (default): total_combinado (${porDefecto.total_combinado.dolares}) == array explícito de las 3 (${consolidado.total_combinado.dolares})`
  );

  // 4) La advertencia SÍ debe aparecer para el mes actual (caso de uso
  //    principal de Alberto) — aqua-premium-ne no tiene datos desde el
  //    2026-06-09, así que un rango de septiembre 2026 cae después.
  const mesActual = await ventasRutaOk({ ruta: "113", fecha_inicio: "2026-09-01", fecha_fin: "2026-09-22" });
  asegurar(
    typeof mesActual.advertencia_aqua_premium_ne === "string" && mesActual.advertencia_aqua_premium_ne.length > 0,
    "SÍ aparece advertencia_aqua_premium_ne para un rango del mes actual (2026-09)"
  );
  asegurar(
    mesActual.por_fuente.aqua_premium_ne.dolares === 0 && mesActual.por_fuente.aqua_premium_ne.num_documentos === 0,
    "mes actual: aqua_premium_ne da $0/0 documentos (esperado, no es un bug — confirma la razón de la advertencia)"
  );

  await pool.end();
  console.log("\nVENTAS RUTA OK REAL TEST OK");
}

main().catch((err) => {
  console.error("\nVENTAS RUTA OK REAL TEST FALLÓ:", err);
  process.exit(1);
});
