// ops/facturas-duplicados/backfill_duplicados.js
// Corre DENTRO del contenedor dashboard_backend (docker cp + docker exec).
//
// Backfill de los pares de `facturas` duplicados ya existentes en la base
// (MobilVendor↔Odoo, ver TODO.md: "Propuesta de diseño COMPLETA —
// reconciliación de facturas"). Marcado NO DESTRUCTIVO: nunca borra una
// fila, solo setea `duplicado_de` en la fila "vacía" apuntando a la fila
// "llena" que debe seguir contando en los reportes.
//
// Detección: mismo customer_code + mismo día (fecha_creacion::date) + mismo
// total exacto, un lado con tipo_movimiento vacío (MobilVendor sin
// contraparte conocida) y el otro con tipo_movimiento poblado (confirmado,
// ver causa raíz en TODO.md).
//
// Seguridad contra falsos positivos (cuentas de cadena/consolidadas como
// TIA, El Rosado — ver TODO.md): solo se marca automáticamente un par
// cuando la relación es 1-a-1 EN AMBOS SENTIDOS (la fila "vacía" tiene
// EXACTAMENTE 1 candidata "llena", y esa candidata tiene EXACTAMENTE 1
// candidata "vacía"). Si hay ambigüedad (2+ candidatos de cualquier lado),
// el par se guarda en `facturas_duplicados_revision_manual` para revisión
// humana — nunca se marca solo.
//
// Uso:
//   node backfill_duplicados.js                  → dry-run, solo reporta
//   node backfill_duplicados.js --aplicar         → aplica los cambios reales
require("dotenv").config();
const sequelize = require("/app/db");

const APLICAR = process.argv.includes("--aplicar");

const SQL_CANDIDATOS = `
  WITH candidatos AS (
    SELECT
      f.code AS code_vacio,
      g.code AS code_lleno,
      f.total,
      COUNT(*) OVER (PARTITION BY f.code) AS num_llenos_para_este_vacio,
      COUNT(*) OVER (PARTITION BY g.code) AS num_vacios_para_este_lleno
    FROM facturas f
    JOIN facturas g
      ON g.customer_code = f.customer_code
     AND g.fecha_creacion::date = f.fecha_creacion::date
     AND g.total = f.total
     AND g.status = 2
     AND g.tipo_movimiento IS NOT NULL AND g.tipo_movimiento <> ''
     AND g.code <> f.code
     AND g.duplicado_de IS NULL
    WHERE f.status = 2
      AND (f.tipo_movimiento IS NULL OR f.tipo_movimiento = '')
      AND f.duplicado_de IS NULL
  )
  SELECT DISTINCT code_vacio, code_lleno, total, num_llenos_para_este_vacio, num_vacios_para_este_lleno
  FROM candidatos;
`;

async function main() {
  const [rowsCrudos] = await sequelize.query(SQL_CANDIDATOS);
  // pg devuelve COUNT(*) (bigint) como STRING — convertir antes de comparar,
  // si no "1" !== 1 y todo termina marcado como ambiguo (bug real
  // encontrado al validar este script en vivo, ver TODO.md).
  const rows = rowsCrudos.map((r) => ({
    ...r,
    num_llenos_para_este_vacio: Number(r.num_llenos_para_este_vacio),
    num_vacios_para_este_lleno: Number(r.num_vacios_para_este_lleno),
  }));

  const seguros = rows.filter(
    (r) => r.num_llenos_para_este_vacio === 1 && r.num_vacios_para_este_lleno === 1
  );
  const ambiguosSet = new Map(); // dedupe por par code_vacio/code_lleno
  for (const r of rows) {
    if (r.num_llenos_para_este_vacio !== 1 || r.num_vacios_para_este_lleno !== 1) {
      ambiguosSet.set(`${r.code_vacio}|${r.code_lleno}`, r);
    }
  }
  const ambiguos = [...ambiguosSet.values()];

  const totalSeguro = seguros.reduce((acc, r) => acc + Number(r.total), 0);

  console.log("=".repeat(70));
  console.log(`Candidatos totales encontrados : ${rows.length}`);
  console.log(`Seguros (1-a-1, auto-marcar)    : ${seguros.length}  ($${totalSeguro.toFixed(2)})`);
  console.log(`Ambiguos (revisión manual)      : ${ambiguos.length}`);
  console.log("=".repeat(70));

  if (!APLICAR) {
    console.log("\nDRY-RUN — no se escribió nada. Correr con --aplicar para aplicar los cambios.\n");
    if (ambiguos.length) {
      console.log("Ejemplos de casos ambiguos (primeros 10):");
      ambiguos.slice(0, 10).forEach((r) =>
        console.log(`  ${r.code_vacio} <-> ${r.code_lleno} (vacios_candidatos=${r.num_vacios_para_este_lleno}, llenos_candidatos=${r.num_llenos_para_este_vacio})`)
      );
    }
    await sequelize.close();
    return;
  }

  const t = await sequelize.transaction();
  try {
    let marcados = 0;
    let promosReapuntadas = 0;

    for (const r of seguros) {
      await sequelize.query(
        `UPDATE facturas SET duplicado_de = :codeLleno WHERE code = :codeVacio AND duplicado_de IS NULL`,
        { replacements: { codeLleno: r.code_lleno, codeVacio: r.code_vacio }, transaction: t }
      );
      marcados++;

      const [promosActualizadas] = await sequelize.query(
        `UPDATE promo_lineas_venta SET documento_code = :codeLleno WHERE documento_code = :codeVacio RETURNING 1`,
        { replacements: { codeLleno: r.code_lleno, codeVacio: r.code_vacio }, transaction: t }
      );
      promosReapuntadas += promosActualizadas.length;
    }

    for (const r of ambiguos) {
      await sequelize.query(
        `INSERT INTO facturas_duplicados_revision_manual (code_candidato_a, code_candidato_b, motivo)
         VALUES (:a, :b, 'AMBIGUO_MULTIPLES_CANDIDATOS')
         ON CONFLICT (code_candidato_a, code_candidato_b) DO NOTHING`,
        { replacements: { a: r.code_vacio, b: r.code_lleno }, transaction: t }
      );
    }

    await t.commit();
    console.log(`\n✅ Aplicado: ${marcados} filas marcadas duplicado_de, ${promosReapuntadas} líneas de promo reapuntadas, ${ambiguos.length} pares a revisión manual.\n`);
  } catch (err) {
    await t.rollback();
    console.error("❌ ERROR, rollback completo:", err.message);
    process.exitCode = 1;
  }

  await sequelize.close();
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
