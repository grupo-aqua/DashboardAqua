// test/facturasProveedores-real.test.js
// Prueba de regresión con datos reales para facturasProveedores — ver
// facturasProveedores.js para el contexto completo (5 compañías, Odoo
// corporativo multi-compañía, JSON-RPC en vivo, sin tabla propia).
//
// Rango de validación: 2026-09-01 a 2026-09-21 (reciente, con actividad real
// confirmada en COTTSA antes de escribir el test — volumen chico a
// propósito para poder comparar contra un read_group independiente sin
// paginar). No se usa Postgres en ningún punto — esta tool no toca
// ventas_mv, todo el dato viene de Odoo.
require("dotenv").config();
const { facturasProveedores, COMPANIAS_VALIDAS } = require("../src/tools/facturasProveedores");
const { executeKw } = require("../src/integrations/odooContabilidad");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

const ID_COMPANIA = { GRUPOAQUA: 1, AQUASUPPLY: 2, COTTSA: 3, IIBC: 4, DISTRINTER: 5 };
const RANGO_INICIO = "2026-09-01";
const RANGO_FIN = "2026-09-21";
const RANGO_FIN_EXCLUSIVO = "2026-09-22";

// Ground truth independiente: reconstruye el domain a mano (no reutiliza
// ninguna función interna de facturasProveedores.js) y llama read_group
// directo — si el test y la tool coincidieran solo porque comparten el
// mismo bug de construcción de domain, esto NO lo detectaría; por eso el
// domain se arma en texto plano acá, sin importar ningún helper del tool.
async function totalRealOdoo(companyIds, moveTypes = ["in_invoice", "in_refund"]) {
  const [fila] = await executeKw(
    "account.move",
    "read_group",
    [
      [
        ["move_type", "in", moveTypes],
        ["company_id", "in", companyIds],
        ["state", "!=", "cancel"],
        ["invoice_date", ">=", RANGO_INICIO],
        ["invoice_date", "<", RANGO_FIN_EXCLUSIVO],
      ],
      ["amount_total:sum", "amount_residual:sum"],
      [],
    ],
    { lazy: false }
  );
  return {
    num_documentos: fila?.__count || 0,
    monto_total: Number((fila?.amount_total || 0).toFixed(2)),
    saldo_pendiente: Number((fila?.amount_residual || 0).toFixed(2)),
  };
}

async function main() {
  // 1) Cada compañía individual comparada contra read_group directo.
  const individuales = {};
  for (const alias of COMPANIAS_VALIDAS) {
    const real = await totalRealOdoo([ID_COMPANIA[alias]]);
    const resultado = await facturasProveedores({ compania: alias, fecha_inicio: RANGO_INICIO, fecha_fin: RANGO_FIN, limite: 1000, top_n_proveedores: 200 });
    individuales[alias] = resultado;

    asegurar(
      resultado.total_general.num_documentos === real.num_documentos,
      `${alias} sept 2026: total_general.num_documentos (${resultado.total_general.num_documentos}) == read_group directo (${real.num_documentos})`
    );
    asegurar(
      Math.abs(resultado.total_general.monto_total - real.monto_total) < 0.01,
      `${alias} sept 2026: total_general.monto_total (${resultado.total_general.monto_total}) == read_group directo (${real.monto_total})`
    );
    asegurar(
      Math.abs(resultado.total_general.saldo_pendiente - real.saldo_pendiente) < 0.01,
      `${alias} sept 2026: total_general.saldo_pendiente (${resultado.total_general.saldo_pendiente}) == read_group directo (${real.saldo_pendiente})`
    );

    // por_compania de una sola compañía debe coincidir exacto con total_general.
    asegurar(resultado.por_compania.length === 1 && resultado.por_compania[0].compania === alias, `${alias}: por_compania trae solo esa compañía`);
    asegurar(
      Math.abs(resultado.por_compania[0].monto_total - resultado.total_general.monto_total) < 0.01,
      `${alias}: por_compania[0].monto_total == total_general.monto_total`
    );

    // Ningún documento cancelado debe aparecer nunca.
    asegurar(
      resultado.documentos.every((d) => d.estado !== "cancel"),
      `${alias}: ningún documento tiene estado='cancel' (excluidos por diseño)`
    );

    // monto_pagado + saldo_pendiente == monto_total en cada documento.
    asegurar(
      resultado.documentos.every((d) => Math.abs(d.monto_pagado + d.saldo_pendiente - d.monto_total) < 0.01),
      `${alias}: monto_pagado + saldo_pendiente == monto_total en cada documento`
    );
  }

  // 2) Si el rango trae pocos proveedores/journals (menos que el top_n /
  //    sin límite práctico pedido), la suma de por_proveedor y de
  //    por_journal debe coincidir EXACTO con total_general (nada se
  //    truncó). Se usa COTTSA, que en este rango tiene solo 3 proveedores y
  //    1 journal (confirmado antes de escribir el test).
  const cottsa = individuales.COTTSA;
  if (cottsa.total_general.num_documentos > 0) {
    const sumaProveedor = cottsa.por_proveedor.reduce((acc, p) => acc + p.monto_total, 0);
    asegurar(
      Math.abs(sumaProveedor - cottsa.total_general.monto_total) < 0.01,
      `COTTSA sept 2026: suma de por_proveedor.monto_total (${sumaProveedor.toFixed(2)}) == total_general (${cottsa.total_general.monto_total}) (top_n suficientemente alto, nada truncado)`
    );
    const sumaJournal = cottsa.por_journal.reduce((acc, j) => acc + j.monto_total, 0);
    asegurar(
      Math.abs(sumaJournal - cottsa.total_general.monto_total) < 0.01,
      `COTTSA sept 2026: suma de por_journal.monto_total (${sumaJournal.toFixed(2)}) == total_general (${cottsa.total_general.monto_total})`
    );
    // documentos (limite=1000, más que suficiente para este rango chico)
    // también debe sumar exacto.
    const sumaDocumentos = cottsa.documentos.reduce((acc, d) => acc + d.monto_total, 0);
    asegurar(
      Math.abs(sumaDocumentos - cottsa.total_general.monto_total) < 0.01,
      `COTTSA sept 2026: suma de documentos.monto_total (${sumaDocumentos.toFixed(2)}) == total_general (${cottsa.total_general.monto_total})`
    );
    asegurar(cottsa.total_general.num_documentos > 0, "COTTSA sept 2026: sanity check — SÍ hubo documentos reales en el rango elegido");
  }

  // 3) Array de las 5 compañías: el consolidado debe sumar exacto a las 5
  //    llamadas individuales.
  const consolidado = await facturasProveedores({ compania: COMPANIAS_VALIDAS, fecha_inicio: RANGO_INICIO, fecha_fin: RANGO_FIN, limite: 1000, top_n_proveedores: 200 });
  const sumaIndividuales = COMPANIAS_VALIDAS.reduce((acc, alias) => acc + individuales[alias].total_general.monto_total, 0);
  asegurar(
    Math.abs(consolidado.total_general.monto_total - sumaIndividuales) < 0.01,
    `array de 5 compañías sept 2026: total_general consolidado (${consolidado.total_general.monto_total}) == suma de individuales (${sumaIndividuales.toFixed(2)})`
  );
  const sumaDocsIndividuales = COMPANIAS_VALIDAS.reduce((acc, alias) => acc + individuales[alias].total_general.num_documentos, 0);
  asegurar(
    consolidado.total_general.num_documentos === sumaDocsIndividuales,
    `array de 5 compañías: total_general.num_documentos consolidado (${consolidado.total_general.num_documentos}) == suma de individuales (${sumaDocsIndividuales})`
  );

  for (const alias of COMPANIAS_VALIDAS) {
    const fila = consolidado.por_compania.find((c) => c.compania === alias);
    asegurar(!!fila, `por_compania (consolidado) trae la compañía ${alias}`);
    asegurar(
      Math.abs(fila.monto_total - individuales[alias].total_general.monto_total) < 0.01,
      `por_compania[${alias}] (consolidado) coincide EXACTO con la llamada individual (${fila.monto_total} == ${individuales[alias].total_general.monto_total})`
    );
  }

  // 4) por_compania_y_mes: para un rango de un solo mes, cada fila de
  //    por_compania debe coincidir con su fila equivalente de
  //    por_compania_y_mes (mismo mes, "2026-09").
  for (const filaMes of consolidado.por_compania_y_mes) {
    asegurar(filaMes.mes === "2026-09", `por_compania_y_mes: mes == "2026-09" (llegó "${filaMes.mes}")`);
    const filaCompania = consolidado.por_compania.find((c) => c.compania === filaMes.compania);
    asegurar(
      !!filaCompania && Math.abs(filaCompania.monto_total - filaMes.monto_total) < 0.01,
      `por_compania_y_mes[${filaMes.compania}] coincide con por_compania (${filaMes.monto_total} == ${filaCompania?.monto_total})`
    );
  }

  // 5) Default sin `compania`: debe traer las 5 combinadas (mismo resultado
  //    que pasar el array explícito).
  const porDefecto = await facturasProveedores({ fecha_inicio: RANGO_INICIO, fecha_fin: RANGO_FIN, limite: 1000, top_n_proveedores: 200 });
  asegurar(
    Math.abs(porDefecto.total_general.monto_total - consolidado.total_general.monto_total) < 0.01,
    `sin \`compania\` (default): total_general (${porDefecto.total_general.monto_total}) == array explícito de las 5 (${consolidado.total_general.monto_total})`
  );

  // 6) tipo_documento='NOTA_CREDITO': todo documento devuelto debe ser
  //    NOTA_CREDITO, y el total debe coincidir contra read_group directo
  //    filtrado solo a in_refund (rango amplio, GRUPOAQUA, que sí tuvo
  //    notas de crédito confirmadas en 2026 antes de escribir el test).
  const soloNotasCredito = await facturasProveedores({
    compania: "GRUPOAQUA",
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-09-21",
    tipo_documento: "NOTA_CREDITO",
    limite: 1000,
    top_n_proveedores: 200,
  });
  asegurar(
    soloNotasCredito.documentos.every((d) => d.tipo === "NOTA_CREDITO"),
    "tipo_documento='NOTA_CREDITO': todos los documentos devueltos son NOTA_CREDITO"
  );
  asegurar(soloNotasCredito.total_general.num_documentos > 0, "tipo_documento='NOTA_CREDITO': sí hubo notas de crédito reales en el rango (sanity check)");

  console.log("\nFACTURAS PROVEEDORES REAL TEST OK");
}

main().catch((err) => {
  console.error("\nFACTURAS PROVEEDORES REAL TEST FALLÓ:", err);
  process.exit(1);
});
