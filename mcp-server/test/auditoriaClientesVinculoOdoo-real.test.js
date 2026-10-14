// test/auditoriaClientesVinculoOdoo-real.test.js
// Prueba de regresión con datos reales para el fix de `senal_fuerte` en
// auditoriaClientes — reporte real del usuario (2026-10-14): el chatbot le
// mostró "Chichanda Zambrano Reuberto Marón" (RUC 1304562737001,
// codigo_cliente 112408/226828) como "duplicado real" con ambos códigos
// ACTIVO en Odoo, pero al buscar en Odoo solo existe 1 contacto. Ver
// TODO.md para la investigación completa: `activo_odoo` es una propiedad
// del RUC compartido, no de cada codigo_cliente — por eso se agregó
// `clasificacion_vinculo`/`vinculado_odoo` (vínculo directo
// codigo_cliente == id de Odoo, confirmado con este mismo caso real).
require("dotenv").config();
const { auditoriaClientes } = require("../src/tools/auditoriaClientes");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

const RUC_CHICHANDA = "1304562737001";
const CODIGO_REAL = "112408"; // el vinculado a Odoo (264 órdenes, hasta hoy)
const CODIGO_HUERFANO = "226828"; // huérfano de MobilVendor (8 órdenes, abandonado desde 2025-09-25)

async function main() {
  const dup = await auditoriaClientes({ categoria: "duplicados", limite: 2000 });

  // 1) El caso real exacto — debe seguir en senal_fuerte (SÍ es un
  //    duplicado real de MobilVendor), clasificado UN_SOLO_VINCULADO, con
  //    el código real marcado vinculado_odoo=true y el huérfano false, y
  //    sugerencia_maestro apuntando al código real (no al de más
  //    ventas_12m si difirieran — acá coinciden, pero la prioridad es el
  //    vínculo, no las ventas).
  const chichanda = dup.senal_fuerte.items.find((it) => it.identificacion === RUC_CHICHANDA);
  asegurar(!!chichanda, "Chichanda sigue en senal_fuerte (es un duplicado real de MobilVendor, no se excluyó)");
  asegurar(chichanda.clasificacion_vinculo === "UN_SOLO_VINCULADO", `Chichanda: clasificacion_vinculo es UN_SOLO_VINCULADO (llegó: ${chichanda.clasificacion_vinculo})`);
  const detalleReal = chichanda.detalle.find((d) => d.codigo_cliente === CODIGO_REAL);
  const detalleHuerfano = chichanda.detalle.find((d) => d.codigo_cliente === CODIGO_HUERFANO);
  asegurar(detalleReal.vinculado_odoo === true, `código real ${CODIGO_REAL}: vinculado_odoo === true`);
  asegurar(detalleHuerfano.vinculado_odoo === false, `código huérfano ${CODIGO_HUERFANO}: vinculado_odoo === false`);
  asegurar(chichanda.sugerencia_maestro === CODIGO_REAL, `sugerencia_maestro apunta al código real (${chichanda.sugerencia_maestro})`);

  // 2) Ningún item de senal_fuerte debe quedar TODOS_VINCULADOS — esos se
  //    sacaron a mismo_ruc_multiples_contactos_odoo.
  const conTodosVinculados = dup.senal_fuerte.items.filter((it) => it.clasificacion_vinculo === "TODOS_VINCULADOS");
  asegurar(conTodosVinculados.length === 0, "senal_fuerte: ningún item queda con clasificacion_vinculo=TODOS_VINCULADOS");

  // 3) mismo_ruc_multiples_contactos_odoo tiene contenido real, y cada
  //    grupo ahí tiene TODOS sus códigos vinculados (si no, no debería
  //    estar ahí) — se verifica indirectamente: el conteo de códigos del
  //    grupo debe calzar con el de un match directo contra Odoo (ya
  //    probado en vivo en la investigación, acá solo se confirma que el
  //    campo existe y no está vacío).
  asegurar(dup.mismo_ruc_multiples_contactos_odoo.total > 0, `mismo_ruc_multiples_contactos_odoo tiene casos reales (${dup.mismo_ruc_multiples_contactos_odoo.total})`);
  asegurar(dup.mismo_ruc_multiples_contactos_odoo.items.every((i) => i.codigos.length > 1), "mismo_ruc_multiples_contactos_odoo: todo item tiene 2+ codigo_cliente");

  // 4) por_clasificacion_vinculo suma exacto al total de senal_fuerte.
  const sumaClasificacion =
    dup.senal_fuerte.por_clasificacion_vinculo.UN_SOLO_VINCULADO +
    dup.senal_fuerte.por_clasificacion_vinculo.NINGUNO_VINCULADO +
    dup.senal_fuerte.por_clasificacion_vinculo.PARCIAL;
  asegurar(sumaClasificacion === dup.senal_fuerte.total, `por_clasificacion_vinculo suma exacto al total (${sumaClasificacion} == ${dup.senal_fuerte.total})`);

  // 5) resumen_por_tipo trae los mismos campos nuevos, consistentes con el
  //    formato json completo.
  const resumen = await auditoriaClientes({ categoria: "duplicados", formato_salida: "resumen_por_tipo" });
  asegurar(resumen.senal_fuerte.total === dup.senal_fuerte.total, "resumen_por_tipo: senal_fuerte.total coincide con el JSON completo");
  asegurar(
    JSON.stringify(resumen.senal_fuerte.por_clasificacion_vinculo) === JSON.stringify(dup.senal_fuerte.por_clasificacion_vinculo),
    "resumen_por_tipo: por_clasificacion_vinculo coincide con el JSON completo"
  );
  asegurar(resumen.mismo_ruc_multiples_contactos_odoo.total === dup.mismo_ruc_multiples_contactos_odoo.total, "resumen_por_tipo: mismo_ruc_multiples_contactos_odoo.total coincide con el JSON completo");

  console.log("\nAUDITORIA CLIENTES VINCULO ODOO REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
