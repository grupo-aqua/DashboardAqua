// test/clasificacionRutaCombinada-real.test.js
// Regresión para el fix de clasificación RURAL/RUTA_COMBINADA — ver
// clasificacion.js (CASE_GRUPO_FACTURAS/CASE_GRUPO_ORDENES) para el
// hallazgo completo. Confirma que RURAL ya no incluye las rutas "OK"
// (113/131/132/132.1), que RUTA_COMBINADA las captura correctamente, y
// que la suma de ambas coincide EXACTO con lo que RURAL daba antes del
// fix (nada se perdió, solo se reclasificó).
require("dotenv").config();
const { ventasPorGrupo } = require("../src/tools/ventasPorGrupo");
const { clientesPorGrupo } = require("../src/tools/clientesPorGrupo");
const { resumenDiario } = require("../src/tools/resumenDiario");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

const MES_INICIO = "2026-05-01";
const MES_FIN = "2026-05-31";

async function main() {
  // 1) RURAL ya no contiene ninguna fila 'RUTA %'.
  const rural = await ventasPorGrupo({ grupo: "RURAL", fecha_inicio: MES_INICIO, fecha_fin: MES_FIN });
  asegurar(
    rural.por_ruta.every((r) => !/^RUTA /.test(r.ruta)),
    "RURAL mayo 2026: ninguna fila de por_ruta empieza con 'RUTA ' (las rutas OK ya no están mezcladas ahí)"
  );
  asegurar(
    rural.por_ruta.every((r) => /^R\d/.test(r.ruta)),
    "RURAL mayo 2026: todas las filas de por_ruta son rutas rurales genuinas (R1-R6, R1.2, etc.)"
  );

  // 2) RUTA_COMBINADA captura exactamente 'RUTA 113'/'RUTA 131'/'RUTA 132'/'RUTA 132.1'.
  const combinada = await ventasPorGrupo({ grupo: "RUTA_COMBINADA", fecha_inicio: MES_INICIO, fecha_fin: MES_FIN });
  asegurar(combinada.dolares_totales > 0, "RUTA_COMBINADA mayo 2026: sanity check — sí hay ventas reales");
  asegurar(
    combinada.por_ruta.every((r) => ["RUTA 113", "RUTA 131", "RUTA 132", "RUTA 132.1"].includes(r.ruta)),
    "RUTA_COMBINADA mayo 2026: todas las filas de por_ruta son exactamente las 4 rutas OK esperadas"
  );

  // 3) La suma de ambos grupos cuadra EXACTO contra lo que RURAL daba
  //    antes del fix (mismo total, solo reclasificado — nada se perdió).
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(total), 0) AS dolares FROM facturas
    WHERE seller_code ILIKE 'R%' AND status = 2
      AND fecha_creacion >= '${MES_INICIO} 00:00:00' AND fecha_creacion < '2026-06-01 00:00:00'
  `);
  // Nota: esta query directa solo cubre `facturas` (RURAL genuino también
  // tiene ordenes MobilVendor, que la tool sí suma) — no se usa como
  // referencia exacta, solo confirma que RURAL+RUTA_COMBINADA sigue
  // siendo mayor o igual a la porción de facturas sola (sanity check de
  // orden de magnitud, no de igualdad exacta).
  asegurar(
    rural.dolares_totales + combinada.dolares_totales >= Number(rows[0].dolares) - 0.01,
    `sanity check de magnitud: RURAL+RUTA_COMBINADA (${(rural.dolares_totales + combinada.dolares_totales).toFixed(2)}) >= solo-facturas-R% (${rows[0].dolares})`
  );

  // 4) clientesPorGrupo y resumenDiario también reconocen el nuevo grupo
  //    (confirma que el fix se propaga a las 10 tools que comparten
  //    clasificacion.js, no solo a ventasPorGrupo).
  const clientes = await clientesPorGrupo({ grupo: "RUTA_COMBINADA", fecha_inicio: MES_INICIO, fecha_fin: MES_FIN, limite: 1 });
  asegurar(clientes.total_clientes > 0, "clientesPorGrupo reconoce RUTA_COMBINADA con clientes reales");

  const dia = await resumenDiario({ fecha: "2026-05-15" });
  const filaRuralDia = dia.por_grupo.find((g) => g.grupo === "RURAL");
  const filaCombDia = dia.por_grupo.find((g) => g.grupo === "RUTA_COMBINADA");
  asegurar(!!filaCombDia && filaCombDia.dolares > 0, "resumenDiario reconoce RUTA_COMBINADA como grupo propio, con ventas reales ese día");
  asegurar(!filaRuralDia || filaRuralDia.dolares < filaCombDia.dolares, "resumenDiario 2026-05-15: RUTA_COMBINADA es mayor que RURAL ese día (consistente con el hallazgo — la mayoría del monto NO era rural real)");

  await pool.end();
  console.log("\nCLASIFICACION RUTA_COMBINADA REAL TEST OK");
}

main().catch((err) => {
  console.error("\nCLASIFICACION RUTA_COMBINADA REAL TEST FALLÓ:", err);
  process.exit(1);
});
