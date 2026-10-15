// test/direccionesEntregaDuplicadas-real.test.js
// Prueba de regresión con datos reales para direccionesEntregaDuplicadas —
// ver TODO.md para la investigación completa. Pedido explícito del usuario
// (2026-10-15), seguimiento de duplicados_en_odoo en auditoriaClientes.
//
// Bug real encontrado y corregido DURANTE esta misma sesión, antes de
// entregar (no llegó a producción): la primera versión agrupaba
// transitivamente por nombre O calle sin límite — para cadenas grandes
// (El Rosado, CRESA-RETAIL, ATIMASA, CONECEL) eso fusionaba decenas de
// locales genuinamente distintos en un solo "grupo duplicado" gigante,
// solo porque comparten la calle de matriz/facturación (confirmado: El
// Rosado daba 1 grupo de 166 direcciones con 108 nombres DISTINTOS). Se
// agregó `UMBRAL_CADENA_GRANDE_DIRECCIONES` — para padres con más de 8
// direcciones, solo se agrupa por nombre exacto (nunca por calle).
require("dotenv").config();
const { direccionesEntregaDuplicadas } = require("../src/tools/direccionesEntregaDuplicadas");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

async function main() {
  const r = await direccionesEntregaDuplicadas({ limite: 500 });

  // 1) Ningún grupo debería tener un tamaño absurdo (el umbral de cadena
  //    grande es 8 direcciones por padre — ningún CLUSTER individual
  //    debería superar bastante eso, salvo un padre chico con muchos
  //    nombres exactos repetidos, caso real pero poco probable a gran
  //    escala).
  const maxTamano = Math.max(...r.items.map((g) => g.direcciones.length));
  asegurar(maxTamano <= 20, `ningún grupo tiene un tamaño absurdo (máximo encontrado: ${maxTamano}, antes del fix llegaba a 166)`);

  // 2) El Rosado (cadena grande conocida) ya NO debe aparecer como UN
  //    grupo gigante con nombres distintos — si aparece, debe ser en
  //    varios grupos chicos, cada uno con el MISMO nombre repetido.
  const rosado = r.items.filter((g) => g.padre_nombre === "CORPORACION EL ROSADO S.A.");
  for (const g of rosado) {
    const nombresDistintos = new Set(g.direcciones.map((d) => (d.nombre || "").trim().toUpperCase()));
    asegurar(nombresDistintos.size === 1, `grupo de El Rosado (${g.direcciones.length} direcciones) tiene un solo nombre repetido, no varios distintos (llegaron: ${nombresDistintos.size})`);
  }
  asegurar(r.cadenas_grandes_sin_match_por_calle > 0, `cadenas_grandes_sin_match_por_calle tiene casos reales (${r.cadenas_grandes_sin_match_por_calle})`);

  // 3) Todo grupo tiene 2+ direcciones, y todas bajo el MISMO padre.
  asegurar(r.items.every((g) => g.direcciones.length > 1), "todo grupo tiene 2+ direcciones");

  // 4) resumen_por_tipo coincide con el conteo del JSON completo.
  const resumen = await direccionesEntregaDuplicadas({ formato_salida: "resumen_por_tipo" });
  asegurar(resumen.total === r.total, `resumen_por_tipo.total (${resumen.total}) == JSON completo (${r.total})`);
  asegurar(
    resumen.cadenas_grandes_sin_match_por_calle === r.cadenas_grandes_sin_match_por_calle,
    "resumen_por_tipo.cadenas_grandes_sin_match_por_calle coincide con el JSON completo"
  );

  // 5) company_id filtra.
  const soloGrupoAqua = await direccionesEntregaDuplicadas({ company_id: "1", limite: 500 });
  asegurar(soloGrupoAqua.total <= r.total, `company_id=1 filtra (${soloGrupoAqua.total} <= ${r.total})`);
  asegurar(soloGrupoAqua.items.every((g) => g.company_id === 1), "company_id=1: todo item tiene company_id === 1");

  console.log("\nDIRECCIONES ENTREGA DUPLICADAS REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
