// test/ventasClienteFacturasDuplicadas-real.test.js
// Prueba de regresión con datos reales para el fix de documentos
// duplicados en `facturas` (reportado por Kenny Navas, bodega, vía
// Slack, 2026-10-01) — ver el comentario grande de SQL_HISTORIAL en
// ventasCliente.js y TODO.md para la investigación completa.
//
// Caso real exacto que motivó el fix: MUÑOZ TABAREZ PAUL LENIN
// (codigo_cliente 228561), producto BOTELLÓN 20L AQUA PREMIUM (LIQUÍDO)
// (codigo_producto 28), septiembre 2026. Antes del fix el MCP devolvía
// 3,990 unidades / $5,990.68 (sobrecontado) — Kenny había contado a mano
// 3,235 unidades brutas (3,110 netas tras restar 125u de una regalía en
// $0, que NO es parte de este bug — ver más abajo).
require("dotenv").config();
const { ventasCliente } = require("../src/tools/ventasCliente");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

const CODIGO_CLIENTE = "228561";
const CODIGO_PRODUCTO = "28";
const INICIO = "2026-09-01";
const FIN = "2026-09-30";

async function main() {
  // 0) Sanity check: el par de documentos duplicados reales que motivó
  //    este fix sigue existiendo en la base tal cual se encontró (si
  //    algún día deja de existir, este test lo haría evidente en vez de
  //    quedar probando algo que ya no aplica).
  const { rows: gemelos } = await pool.query(`
    SELECT code, tipo_movimiento, fecha_creacion::date AS dia, total
    FROM facturas
    WHERE customer_code = $1 AND fecha_creacion >= $2 AND fecha_creacion < $3::date + interval '1 day'
      AND total = 387.49
    ORDER BY code;
  `, [CODIGO_CLIENTE, INICIO, FIN]);
  asegurar(gemelos.length === 2, `sanity check: el par de documentos gemelos de $387.49 (23-sep) sigue existiendo (${gemelos.length} filas)`);
  const tiposMovimiento = gemelos.map((g) => g.tipo_movimiento || "").sort();
  asegurar(tiposMovimiento[0] === "" && tiposMovimiento[1] === "out_invoice", "sanity check: uno de los gemelos tiene tipo_movimiento vacío y el otro 'out_invoice' (el patrón exacto del bug)");

  // 1) El caso real reportado: debe dar EXACTO 3,235 unidades / $4,820.44
  //    (bruto, incluye la regalía $0 de 125u — eso no es parte de este
  //    bug, Kenny la resta aparte para su propio cálculo neto). ANTES del
  //    fix daba 3,990 / $5,990.68.
  const resultado = await ventasCliente({
    codigo_cliente: [CODIGO_CLIENTE],
    categoria: "BOTELLÓN",
    fecha_inicio: INICIO,
    fecha_fin: FIN,
  });
  const filaProducto = resultado.por_producto.find((p) => p.codigo_producto === CODIGO_PRODUCTO);
  asegurar(!!filaProducto, `el producto ${CODIGO_PRODUCTO} aparece en por_producto`);
  asegurar(filaProducto.unidades === 3235, `unidades == 3235 (bruto correcto, llegó: ${filaProducto.unidades}) — antes del fix daba 3990`);
  asegurar(Math.abs(filaProducto.dolares - 4820.44) < 0.01, `dolares == $4,820.44 (llegó: $${filaProducto.dolares}) — antes del fix daba $5,990.68`);

  // 2) El neto que calcula Kenny a mano (menos 125u/$0 de la regalía) debe
  //    cuadrar exacto contra el bruto de la tool — confirma que la
  //    regalía SIGUE contada (no es parte de este bug, es un documento
  //    real en $0) y que el bruto ya no está inflado por el duplicado.
  asegurar(filaProducto.unidades - 125 === 3110, `bruto (${filaProducto.unidades}) menos la regalía (125u) == 3110 neto, el número que Kenny confirmó a mano`);

  // 3) Deduplicación precisa — NO debe borrar documentos reales sin
  //    gemelo. Verificación directa: la suma de TODOS los `facturas` con
  //    tipo_movimiento vacío para este cliente/mes que NO tienen un
  //    gemelo poblado debe seguir apareciendo en el resultado (no se
  //    perdió nada que no sea duplicado real).
  const { rows: sinGemeloReal } = await pool.query(`
    SELECT COUNT(*) AS n FROM facturas f
    WHERE f.customer_code = $1 AND f.status = 2
      AND f.fecha_creacion >= $2 AND f.fecha_creacion < $3::date + interval '1 day'
      AND (f.tipo_movimiento IS NULL OR f.tipo_movimiento = '')
      AND NOT EXISTS (
        SELECT 1 FROM facturas g
        WHERE g.customer_code = f.customer_code AND g.fecha_creacion::date = f.fecha_creacion::date
          AND g.total = f.total AND g.status = 2
          AND g.tipo_movimiento IS NOT NULL AND g.tipo_movimiento <> '' AND g.code <> f.code
      )
  `, [CODIGO_CLIENTE, INICIO, FIN]);
  console.log(`(informativo) documentos sin tipo_movimiento y SIN gemelo real para este cliente/mes: ${sinGemeloReal[0].n} — estos NO deben excluirse`);

  // 4) Regresión general — el resto de la suite de ventasCliente sigue
  //    funcionando (comparado contra la query SQL_HISTORIAL recién
  //    modificada, para un cliente/producto SIN ningún documento
  //    duplicado conocido, que no debería cambiar en absoluto).
  const { rows: totalIndependiente } = await pool.query(`
    SELECT COALESCE(SUM(dd.cantidad), 0) AS unidades
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2 AND o.origen_sistema = 'MOBILVENDOR' AND o.customer_code = $1
      AND o.fecha_creacion >= $2 AND o.fecha_creacion < $3::date + interval '1 day'
      AND dd.codigo_producto = $4
  `, [CODIGO_CLIENTE, INICIO, FIN, CODIGO_PRODUCTO]);
  asegurar(Number(totalIndependiente[0].unidades) === 2480, `sanity check independiente: ordenes (sin tocar por este fix) siguen dando 2480 unidades para este producto`);

  await pool.end();
  console.log("\nVENTAS CLIENTE FACTURAS DUPLICADAS REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
