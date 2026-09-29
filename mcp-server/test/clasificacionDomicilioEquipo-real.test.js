// test/clasificacionDomicilioEquipo-real.test.js
// Prueba de regresión con datos reales para la corrección 2026-09-29 de
// CASE_GRUPO_FACTURAS (ver el comentario grande en clasificacion.js) — las
// facturas del equipo Odoo "Domicilio" (`equipo_ventas_nombre='Domicilio'`,
// 91% suscripciones de agua con débito recurrente, confirmado con
// `clientes.codigo_tipo_negocio='DM-01'`) caían en 'OTROS' (invisibles) y
// ahora se clasifican como DOMICILIO.
//
// Alcance deliberado: SOLO `CASE_GRUPO_FACTURAS`. `CASE_GRUPO_ORDENES` no se
// toca — 1 orden de suscripción genera hasta 21 facturas mensuales (mismo
// contrato), sumar también la orden sería doble conteo. Este test valida
// justamente eso: que `ordenes` sigue sin ver estas facturas.
require("dotenv").config();
const { pool } = require("../src/db");
const { CASE_GRUPO_FACTURAS, CASE_GRUPO_ORDENES } = require("../src/sql/clasificacion");
const { totalesGrupo } = require("../src/tools/ventasPorGrupo");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

// Rango cerrado (meses completos) — evita comparar contra datos que siguen
// cambiando en vivo, mismo motivo que fallbackOdooCondicionPago-real.test.js.
const INICIO = "2026-03-01 00:00:00";
const FIN = "2026-09-01 00:00:00";

async function main() {
  // 1) Las facturas del equipo Odoo "Domicilio" ahora clasifican como DOMICILIO.
  const { rows: grupoRows } = await pool.query(
    `
    SELECT (${CASE_GRUPO_FACTURAS}) AS grupo, COUNT(*) AS docs, SUM(dd.total) AS dolares
    FROM facturas f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2 AND f.fecha_creacion >= $1 AND f.fecha_creacion < $2
      AND f.equipo_ventas_nombre = 'Domicilio'
    GROUP BY 1
    `,
    [INICIO, FIN]
  );
  asegurar(
    grupoRows.length === 1 && grupoRows[0].grupo === "DOMICILIO",
    `todas las facturas del equipo Odoo "Domicilio" clasifican como DOMICILIO (llegó: ${JSON.stringify(grupoRows)})`
  );
  asegurar(Number(grupoRows[0].docs) > 0, `hay facturas reales del equipo Odoo "Domicilio" en el rango (${grupoRows[0].docs})`);

  // 2) Ninguna sigue en 'OTROS' (regresión del bug que se corrige).
  const { rows: otrosRows } = await pool.query(
    `
    SELECT COUNT(*) AS n
    FROM facturas f
    WHERE f.status = 2 AND f.fecha_creacion >= $1 AND f.fecha_creacion < $2
      AND f.equipo_ventas_nombre = 'Domicilio'
      AND (${CASE_GRUPO_FACTURAS}) = 'OTROS'
    `,
    [INICIO, FIN]
  );
  asegurar(Number(otrosRows[0].n) === 0, "ninguna factura del equipo Odoo Domicilio sigue cayendo en 'OTROS'");

  // 3) Alcance deliberado: CASE_GRUPO_ORDENES NO se tocó — las órdenes de
  //    este mismo equipo (contratos de suscripción) siguen sin clasificar
  //    (evita el doble conteo orden-contrato + sus facturas mensuales).
  const { rows: ordenesRows } = await pool.query(
    `
    SELECT (${CASE_GRUPO_ORDENES}) AS grupo, COUNT(*) AS n
    FROM ordenes o
    WHERE o.equipo_ventas_nombre = 'Domicilio'
      AND o.fecha_creacion >= $1 AND o.fecha_creacion < $2
    GROUP BY 1
    `,
    [INICIO, FIN]
  );
  const ordenesClasificadas = ordenesRows.filter((r) => r.grupo !== null);
  asegurar(
    ordenesClasificadas.length === 0,
    `CASE_GRUPO_ORDENES sigue sin clasificar órdenes del equipo Odoo Domicilio (evita doble conteo con sus facturas mensuales) — llegó: ${JSON.stringify(ordenesRows)}`
  );

  // 4) ventasPorGrupo(DOMICILIO) ahora incluye este monto — verificado contra
  //    el mismo total que ya validamos por SQL directo arriba.
  const resultado = await totalesGrupo("DOMICILIO", INICIO, FIN, undefined);
  const dolaresEsperadosMin = Number(grupoRows[0].dolares);
  asegurar(
    resultado.totales.dolares >= dolaresEsperadosMin - 0.01,
    `ventasPorGrupo DOMICILIO (${resultado.totales.dolares}) incluye al menos los $${dolaresEsperadosMin.toFixed(2)} del equipo Odoo Domicilio`
  );

  console.log("\nCLASIFICACION DOMICILIO EQUIPO ODOO REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
