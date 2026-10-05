// services/reconciliacionFacturasService.js
// Reconciliación de `facturas` MobilVendor↔Odoo — Tier 2 (heurístico,
// programado). Ver TODO.md: "Propuesta de diseño COMPLETA — reconciliación
// de facturas" para el diseño completo y `ops/facturas-duplicados/
// backfill_duplicados.js` para el backfill histórico one-time (MISMA
// lógica de detección, reutilizada acá para los casos nuevos que van
// apareciendo día a día).
//
// Por qué un job aparte del sync en tiempo real (Tier 1, en
// sincronizacionService.js): esta detección depende de que AMBOS lados
// (MobilVendor y Odoo) ya hayan escrito su versión del mismo documento real
// — eso puede tardar horas/días (ver TODO.md, causa raíz), así que no tiene
// sentido intentarlo documento por documento durante el sync. Corre UNA VEZ
// AL DÍA, después del cron de las 00:00, sobre la ventana de los últimos
// `DIAS_RETRO` días (la misma ventana retroactiva del sync regular).
//
// Seguridad: solo marca `duplicado_de` cuando la relación candidato→gemelo
// es 1-a-1 EN AMBOS SENTIDOS (ver detección abajo) — evita falsos positivos
// en cuentas de cadena/consolidadas (TIA, El Rosado — ver TODO.md). Los
// casos ambiguos van a `facturas_duplicados_revision_manual`, nunca se
// marcan solos. Nunca borra una fila.
"use strict";
const sequelize = require("../db");

const SQL_CANDIDATOS = `
  WITH candidatos AS (
    SELECT
      f.code AS code_vacio,
      g.code AS code_lleno,
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
      AND f.fecha_creacion >= :desde
  )
  SELECT DISTINCT code_vacio, code_lleno, num_llenos_para_este_vacio, num_vacios_para_este_lleno
  FROM candidatos;
`;

async function marcarFacturasDuplicadas(diasRetro = 10) {
  const desde = new Date();
  desde.setDate(desde.getDate() - diasRetro);

  const [rowsCrudos] = await sequelize.query(SQL_CANDIDATOS, {
    replacements: { desde: desde.toISOString().slice(0, 10) },
  });
  // pg devuelve COUNT(*) (bigint) como STRING — convertir antes de comparar
  // (bug real encontrado al validar el backfill en vivo, ver TODO.md).
  const rows = rowsCrudos.map((r) => ({
    ...r,
    num_llenos_para_este_vacio: Number(r.num_llenos_para_este_vacio),
    num_vacios_para_este_lleno: Number(r.num_vacios_para_este_lleno),
  }));

  const seguros = rows.filter(
    (r) => r.num_llenos_para_este_vacio === 1 && r.num_vacios_para_este_lleno === 1
  );
  const ambiguosMap = new Map();
  for (const r of rows) {
    if (r.num_llenos_para_este_vacio !== 1 || r.num_vacios_para_este_lleno !== 1) {
      ambiguosMap.set(`${r.code_vacio}|${r.code_lleno}`, r);
    }
  }
  const ambiguos = [...ambiguosMap.values()];

  if (!seguros.length && !ambiguos.length) {
    return { marcados: 0, promosReapuntadas: 0, aRevisionManual: 0 };
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
    return { marcados, promosReapuntadas, aRevisionManual: ambiguos.length };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = { marcarFacturasDuplicadas };
