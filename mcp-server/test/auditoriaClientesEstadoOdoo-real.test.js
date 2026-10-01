// test/auditoriaClientesEstadoOdoo-real.test.js
// Prueba de regresión con datos reales para el split activo/archivado
// (res.partner.active) agregado a auditoriaClientes el 2026-10-01 —
// reportado por Kenny Navas (bodega, vía Slack): la lista de "coordenadas
// mal puestas" mezclaba clientes archivados en Odoo sin distinguirlos,
// y esa misma lista alimenta auditoriaParadasFlota. Ver auditoriaClientes.js
// (comentario grande sobre clasificarActivoOdoo) y TODO.md.
require("dotenv").config();
const { auditoriaClientes } = require("../src/tools/auditoriaClientes");
const { executeKw } = require("../src/integrations/odooContabilidad");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

const ESTADOS = ["ACTIVO", "ARCHIVADO", "SIN_MATCH_ODOO", "SIN_RUC"];

function sumaEstados(porEstadoOdoo) {
  return ESTADOS.reduce((acc, k) => acc + (porEstadoOdoo[k] || 0), 0);
}

async function main() {
  // 1) Las 4 categorías que NO filtraban por Odoo traen por_estado_odoo con
  //    las 4 claves esperadas. `activos_sin_consumo` queda afuera a
  //    propósito: esa categoría YA usa res.partner.active como FILTRO (solo
  //    incluye activos, excluye archivados explícitamente en su propia
  //    lógica) — agregarle un split sería redundante (siempre 100% ACTIVO
  //    por construcción), no es lo que reportó Kenny.
  for (const categoria of ["direcciones_incompletas", "coordenadas", "sin_canal"]) {
    const r = await auditoriaClientes({ categoria, formato_salida: "resumen_por_tipo" });
    asegurar(!!r.por_estado_odoo, `${categoria}: resumen_por_tipo trae por_estado_odoo`);
    for (const k of ESTADOS) asegurar(typeof r.por_estado_odoo[k] === "number", `${categoria}: por_estado_odoo.${k} es numérico`);
  }

  // 2) coordenadas: hay casos reales ARCHIVADOS — esto es justo lo que
  //    reportó Kenny, confirmado con datos reales, no debe ser 0.
  const coord = await auditoriaClientes({ categoria: "coordenadas", formato_salida: "resumen_por_tipo" });
  asegurar(coord.por_estado_odoo.ARCHIVADO > 0, `coordenadas: hay candidatos ya archivados en Odoo mezclados (${coord.por_estado_odoo.ARCHIVADO}) — confirma el reporte de Kenny`);
  asegurar(sumaEstados(coord.por_estado_odoo) === coord.total, `coordenadas: por_estado_odoo suma exacto al total (${sumaEstados(coord.por_estado_odoo)} == ${coord.total})`);

  // 3) El JSON completo (no solo resumen) trae activo_odoo por item, y el
  //    por_estado_odoo del JSON coincide con el de resumen_por_tipo.
  const coordJson = await auditoriaClientes({ categoria: "coordenadas", limite: coord.total });
  asegurar(
    coordJson.items.every((i) => ESTADOS.includes(i.activo_odoo)),
    "coordenadas JSON: todo item trae activo_odoo con un valor reconocido"
  );
  asegurar(
    JSON.stringify(coordJson.por_estado_odoo) === JSON.stringify(coord.por_estado_odoo),
    "coordenadas: por_estado_odoo es el mismo en formato_salida=json y resumen_por_tipo (mismo universo, limite suficiente para traer todo)"
  );

  // 4) Verificación directa contra Odoo para un caso real: toma el primer
  //    item marcado ARCHIVADO y confirma en vivo que su RUC realmente
  //    tiene active=false en res.partner (no confía ciegamente en la tool).
  const archivado = coordJson.items.find((i) => i.activo_odoo === "ARCHIVADO");
  asegurar(!!archivado, "hay al menos 1 item ARCHIVADO en el JSON completo para verificar en vivo");
  const { rows: clienteArchivado } = await pool.query(
    "SELECT TRIM(identificacion_cliente) AS ruc FROM clientes WHERE codigo_cliente = $1",
    [archivado.codigo_cliente]
  );
  const rucArchivado = clienteArchivado[0]?.ruc;
  const partnersArchivado = await executeKw("res.partner", "search_read", [[["vat", "=", rucArchivado]]], {
    fields: ["vat", "active"],
    context: { active_test: false },
    limit: 5,
  });
  asegurar(
    partnersArchivado.length > 0 && partnersArchivado.every((p) => !p.active),
    `verificación en vivo: RUC ${rucArchivado} (codigo_cliente ${archivado.codigo_cliente}) realmente tiene active=false en Odoo, no es un falso ARCHIVADO`
  );

  // 5) duplicados: por_estado_odoo por señal, consistente entre
  //    resumen_por_tipo y JSON completo (cuenta por CÓDIGO único, no por
  //    grupo — un código no se cuenta 2 veces aunque aparezca en 2 pares).
  const dupResumen = await auditoriaClientes({ categoria: "duplicados", formato_salida: "resumen_por_tipo" });
  const dupJson = await auditoriaClientes({ categoria: "duplicados", limite: dupResumen.senal_fuerte.total });
  asegurar(
    JSON.stringify(dupJson.senal_fuerte.por_estado_odoo) === JSON.stringify(dupResumen.senal_fuerte.por_estado_odoo),
    "duplicados.senal_fuerte: por_estado_odoo coincide entre resumen_por_tipo y JSON completo"
  );
  const codigosUnicosFuerte = new Set(dupJson.senal_fuerte.items.flatMap((g) => g.codigos));
  asegurar(
    sumaEstados(dupJson.senal_fuerte.por_estado_odoo) === codigosUnicosFuerte.size,
    `duplicados.senal_fuerte: por_estado_odoo cuenta códigos ÚNICOS (${sumaEstados(dupJson.senal_fuerte.por_estado_odoo)} == ${codigosUnicosFuerte.size} códigos distintos en los grupos)`
  );

  // 6) activos_sin_consumo sigue funcionando igual que antes (ya usaba
  //    res.partner.active correctamente) — esta ampliación solo cambió DE
  //    DÓNDE sale el mapa (ahora se pasa desde el orquestador en vez de
  //    pedirlo internamente), no la lógica de negocio.
  const activos = await auditoriaClientes({ categoria: "activos_sin_consumo", limite: 1 });
  asegurar(activos.total > 0, `activos_sin_consumo sigue dando resultados reales tras el refactor (${activos.total})`);
  asegurar(typeof activos.sin_señal_confiable_de_activo === "number", "activos_sin_consumo sigue reportando sin_señal_confiable_de_activo");

  await pool.end();
  console.log("\nAUDITORIA CLIENTES ESTADO ODOO REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
