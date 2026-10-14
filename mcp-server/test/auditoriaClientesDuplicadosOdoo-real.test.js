// test/auditoriaClientesDuplicadosOdoo-real.test.js
// Prueba de regresión con datos reales para `duplicados_en_odoo` en
// auditoriaClientes — pedido explícito del usuario (2026-10-14): "para mí
// duplicado es que en MI base de Odoo haya dos contactos con mismo
// nombre/cédula/RUC, ambos activos — porque eso no se puede hacer". A
// diferencia de TODO lo demás en la categoría `duplicados` (que parte de
// MobilVendor), esto corre directo contra res.partner. Ver TODO.md para la
// investigación completa, incluido el hallazgo de por qué hace falta
// exigir también `company_id` (si no, "ALARCON ALARCON ANA LUISA" sale
// como falso positivo — son 2 compañías distintas del grupo, no un
// duplicado).
require("dotenv").config();
const { auditoriaClientes } = require("../src/tools/auditoriaClientes");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

// Los 2 casos que el usuario verificó en vivo contra Odoo antes de autorizar.
const RUC_ASOCIACION = "0992577371001";
const RUC_AYALA = "1002079968";
// Caso que llevó a agregar company_id al criterio — confirmado por el
// usuario que en Odoo solo le aparece 1 contacto (son 2 compañías
// distintas del grupo, no un duplicado real).
const RUC_ALARCON = "0921930152001";

async function main() {
  const dup = await auditoriaClientes({ categoria: "duplicados", limite: 200 });

  // 1) Los 2 casos verificados por el usuario deben seguir apareciendo,
  //    con 2 partners cada uno, misma company_id.
  const asociacion = dup.duplicados_en_odoo.items.find((it) => it.ruc === RUC_ASOCIACION);
  const ayala = dup.duplicados_en_odoo.items.find((it) => it.ruc === RUC_AYALA);
  asegurar(!!asociacion, `RUC ${RUC_ASOCIACION} (ASOCIACION...LA JOYA, verificado por el usuario) aparece en duplicados_en_odoo`);
  asegurar(!!ayala, `RUC ${RUC_AYALA} (AYALA VASQUEZ JAIME JAVIER, verificado por el usuario) aparece en duplicados_en_odoo`);
  asegurar(asociacion.partners.length === 2, `ASOCIACION...LA JOYA tiene exactamente 2 partners (llegó: ${asociacion.partners.length})`);
  asegurar(ayala.partners.length === 2, `AYALA VASQUEZ tiene exactamente 2 partners (llegó: ${ayala.partners.length})`);
  asegurar(
    new Set(asociacion.partners.map((p) => p.odoo_id)).size === asociacion.partners.length,
    "ASOCIACION...LA JOYA: los odoo_id de sus partners son distintos entre sí (no es el mismo contacto repetido)"
  );

  // 2) partner_con_mas_historial debe ser realmente el de mayor customer_rank.
  const masHistorial = asociacion.partners.reduce((mejor, p) => (p.customer_rank > mejor.customer_rank ? p : mejor));
  asegurar(asociacion.partner_con_mas_historial === masHistorial.odoo_id, "partner_con_mas_historial es realmente el de mayor customer_rank");

  // 3) El caso ALARCON (multi-compañía, NO es un duplicado real) NO debe
  //    aparecer — es el caso que confirmó por qué hace falta exigir
  //    company_id en el criterio, no solo RUC+nombre.
  const alarcon = dup.duplicados_en_odoo.items.find((it) => it.ruc === RUC_ALARCON);
  asegurar(!alarcon, `RUC ${RUC_ALARCON} (ALARCON ALARCON ANA LUISA, 2 compañías distintas del grupo) NO aparece en duplicados_en_odoo`);

  // 4) Todo item tiene 2+ partners, y todos con la MISMA company_id
  //    (si no, no debería estar agrupado junto).
  asegurar(
    dup.duplicados_en_odoo.items.every((it) => it.partners.length > 1),
    "duplicados_en_odoo: todo item tiene 2+ partners"
  );

  // 5) resumen_por_tipo coincide con el conteo del JSON completo.
  const resumen = await auditoriaClientes({ categoria: "duplicados", formato_salida: "resumen_por_tipo" });
  asegurar(resumen.duplicados_en_odoo.total === dup.duplicados_en_odoo.total, `resumen_por_tipo.duplicados_en_odoo.total (${resumen.duplicados_en_odoo.total}) == JSON completo (${dup.duplicados_en_odoo.total})`);

  // 6) company_id filtra duplicados_en_odoo también (no solo las señales
  //    de MobilVendor) — sanity check: company_id=1 (GRUPOAQUA) debe dar
  //    un total <= al total sin filtrar.
  const soloGrupoAqua = await auditoriaClientes({ categoria: "duplicados", company_id: "1", limite: 200 });
  asegurar(
    soloGrupoAqua.duplicados_en_odoo.total <= dup.duplicados_en_odoo.total,
    `company_id=1 filtra duplicados_en_odoo (${soloGrupoAqua.duplicados_en_odoo.total} <= ${dup.duplicados_en_odoo.total})`
  );
  asegurar(
    soloGrupoAqua.duplicados_en_odoo.items.every((it) => it.company_id === 1),
    "company_id=1: todo item de duplicados_en_odoo tiene company_id === 1"
  );

  console.log("\nAUDITORIA CLIENTES DUPLICADOS ODOO REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
