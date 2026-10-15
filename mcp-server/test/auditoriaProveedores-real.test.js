// test/auditoriaProveedores-real.test.js
// Prueba de regresión con datos reales para auditoriaProveedores — ver
// TODO.md para la investigación completa. Pedido explícito del usuario
// (2026-10-15): mismo espíritu que auditoriaClientes.duplicados_en_odoo/
// activos_sin_consumo, pero para proveedores (res.partner, supplier_rank>0).
require("dotenv").config();
const { auditoriaProveedores } = require("../src/tools/auditoriaProveedores");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

// Los 2 duplicados reales confirmados en la investigación.
const RUC_INTPUBLI = "0993079332001";
const RUC_PACO = "1790040275001";

async function main() {
  // 1) Categoría duplicados — los 2 casos reales conocidos.
  const dup = await auditoriaProveedores({ categoria: "duplicados" });
  asegurar(dup.total >= 2, `duplicados.total tiene al menos los 2 casos conocidos (llegó: ${dup.total})`);
  const intpubli = dup.items.find((it) => it.ruc === RUC_INTPUBLI);
  const paco = dup.items.find((it) => it.ruc === RUC_PACO);
  asegurar(!!intpubli, `RUC ${RUC_INTPUBLI} (INTRI PRINT PUBLICIDAD) aparece en duplicados`);
  asegurar(!!paco, `RUC ${RUC_PACO} (PA-CO COMERCIAL E INDUSTRIAL) aparece en duplicados`);
  asegurar(intpubli.partners.length === 2, "INTRI PRINT: exactamente 2 partners");

  // 2) partner_con_mas_historial debe ser el de fecha_creacion MÁS ANTIGUA.
  const masAntiguo = intpubli.partners.reduce((a, b) => (a.fecha_creacion < b.fecha_creacion ? a : b));
  asegurar(intpubli.partner_con_mas_historial === masAntiguo.odoo_id, "partner_con_mas_historial es el de fecha_creacion más antigua");

  // 3) Categoría sin_movimiento — debe haber candidatos reales, y todos
  //    con dias_desde_ultima > umbral (o nunca_tuvo_factura=true).
  const sinMov = await auditoriaProveedores({ categoria: "sin_movimiento", umbral_dias_inactividad: 180, limite: 500 });
  asegurar(sinMov.total > 0, `sin_movimiento tiene candidatos reales con umbral 180 días (${sinMov.total})`);
  asegurar(
    sinMov.items.every((it) => it.nunca_tuvo_factura || it.dias_desde_ultima > 180),
    "sin_movimiento: todo item tiene dias_desde_ultima > 180 o nunca_tuvo_factura=true"
  );

  // 4) resumen_por_tipo (sin categoría) coincide con los totales completos.
  const resumen = await auditoriaProveedores({});
  asegurar(resumen.duplicados.total === dup.total, `resumen.duplicados.total (${resumen.duplicados.total}) == dup.total (${dup.total})`);
  asegurar(resumen.duplicados.items.length <= 5, "resumen (sin categoría): duplicados trae muestra chica (<=5), no el listado completo");

  // 5) company_id filtra ambas categorías.
  const dupGrupoAqua = await auditoriaProveedores({ categoria: "duplicados", company_id: "1" });
  asegurar(dupGrupoAqua.items.every((it) => it.company_id === 1), "company_id=1: todo item de duplicados tiene company_id === 1");

  console.log("\nAUDITORIA PROVEEDORES REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
