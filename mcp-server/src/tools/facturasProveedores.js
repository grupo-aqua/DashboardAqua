// src/tools/facturasProveedores.js
// Facturas y notas de crédito DE PROVEEDOR (account.move, move_type
// in_invoice/in_refund) de las 5 compañías del grupo, todas en la misma
// instancia Odoo corporativa multi-compañía (grupoaqua.odoo.com — ver
// src/integrations/odooContabilidad.js). Pedido directo de Alberto: el
// gerente quiere ver las facturas crudas de proveedor para armar su propio
// criterio (devengado vs. pagado) — esta tool NO decide qué es "gasto", ni
// filtra por devengado/pagado; solo expone estado/estado_pago/saldo para
// que ese criterio se aplique después, fuera de la tool.
//
// ============================================================
// Investigación previa (antes de construir, pedido explícito de Alberto)
// ============================================================
// 1) IDs de res.company (confirmado con `res.company.search_read` en vivo):
//      1 = GRUPOAQUA S.A.
//      2 = AQUASUPPLY S.A.
//      3 = COMPAÑIA DE TRADICION TROPICAL S.A. COTTSA
//      4 = IIBC S.A.
//      5 = DISTRIBUIDORA INTERNACIONAL DE ALIMENTOS S.A. DISTRINTER
// 2) Credenciales: se reutiliza la MISMA API key que ya usa
//    backend/services/odooServicio (cia@aqua.com.ec sobre grupoaqua.odoo.com)
//    — confirmado en vivo que ya tiene acceso de lectura a account.move con
//    move_type in_invoice/in_refund y a res.partner/res.company en las 5
//    compañías, sin necesidad de crear una key nueva. IMPORTANTE: NO es una
//    key de solo lectura dedicada/limitada — es la misma cuenta general que
//    ya usa todo el sync del backend (mismo alcance de confianza que
//    backend/.env, documentado en TODO.md; crear una key de accounting
//    dedicada y con permisos acotados queda como mejora de hardening
//    posterior, no bloqueante).
// 3) Volumen real, últimos 12 meses (confirmado con `read_group` antes de
//    comprometerse, ver TODO.md para el detalle completo por compañía):
//    ~9,432 documentos combinados (GRUPOAQUA es la más alta, ~7,880) — un
//    rango típico de mes/rango corto por compañía es perfectamente viable
//    en vivo; para rangos amplios (ej. los 12 meses completos) los
//    resúmenes (por_compania, por_compania_y_mes, por_proveedor, por_journal)
//    se calculan con `read_group` (agregación del lado de Odoo, no trae
//    cada fila a memoria) — solo la lista `documentos` (detalle crudo)
//    respeta `limite`.
// 4) Moneda: confirmado que las 5 compañías facturan en USD
//    (`res.company.currency_id`) — no hace falta conversión. Se expone
//    `moneda` por documento de todos modos (defensivo, por si algún
//    documento puntual llegara en otra moneda).
//
// ============================================================
// Decisión de diseño: se excluyen documentos state='cancel'
// ============================================================
// Un documento cancelado en Odoo no es una transacción real (el propio
// Odoo lo excluye de todos sus reportes) — excluirlo es un hecho, no un
// juicio de "qué es gasto". SÍ se incluyen 'draft' y 'posted' (ambos, sin
// filtrar) con su `estado` visible en cada fila, para que el criterio
// devengado/pagado y cualquier filtro adicional (ej. solo posted) lo decida
// quien lea el resultado, no la tool.
//
// ============================================================
// Conexión EN VIVO, sin caché (mismo patrón que aqua-premium-ne/ventasRutaOk)
// ============================================================
// Se consulta Odoo directo en cada llamada — sin sincronización a una tabla
// propia en ventas_mv. Si Odoo no responde, la tool falla explícito (nunca
// "$0" silencioso).
const { z } = require("zod");
const { executeKw } = require("../integrations/odooContabilidad");
const { finExclusivo, diffDias } = require("../util/fechas");

const MAX_RANGO_DIAS = 400;
const LIMITE_DEFAULT = 300;
const LIMITE_MAX = 1000;
const TOP_N_PROVEEDORES_DEFAULT = 20;
const TOP_N_PROVEEDORES_MAX = 200;

const COMPANIAS = {
  GRUPOAQUA: { id: 1, nombre: "GRUPOAQUA S.A." },
  AQUASUPPLY: { id: 2, nombre: "AQUASUPPLY S.A." },
  COTTSA: { id: 3, nombre: "COMPAÑIA DE TRADICION TROPICAL S.A. COTTSA" },
  IIBC: { id: 4, nombre: "IIBC S.A." },
  DISTRINTER: { id: 5, nombre: "DISTRIBUIDORA INTERNACIONAL DE ALIMENTOS S.A. DISTRINTER" },
};
const COMPANIAS_VALIDAS = Object.keys(COMPANIAS);
const ID_A_ALIAS_COMPANIA = Object.fromEntries(COMPANIAS_VALIDAS.map((alias) => [COMPANIAS[alias].id, alias]));

const TIPO_A_MOVE_TYPE = { FACTURA: "in_invoice", NOTA_CREDITO: "in_refund" };
const MOVE_TYPE_A_TIPO = { in_invoice: "FACTURA", in_refund: "NOTA_CREDITO" };

const CompaniaSchema = z.enum(COMPANIAS_VALIDAS);
const inputSchema = {
  compania: z.union([CompaniaSchema, z.array(CompaniaSchema).min(1).max(COMPANIAS_VALIDAS.length)]).default(COMPANIAS_VALIDAS),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tipo_documento: z.enum(["FACTURA", "NOTA_CREDITO"]).optional(),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
  top_n_proveedores: z.number().int().min(1).max(TOP_N_PROVEEDORES_MAX).default(TOP_N_PROVEEDORES_DEFAULT),
};

function redondear(n) {
  return Number((n || 0).toFixed(2));
}

function construirDominio({ companyIds, moveTypes, inicioStr, finStr }) {
  return [
    ["move_type", "in", moveTypes],
    ["company_id", "in", companyIds],
    ["state", "!=", "cancel"],
    ["invoice_date", ">=", inicioStr],
    ["invoice_date", "<", finStr],
  ];
}

async function resolverRucPorPartner(partnerIds) {
  if (partnerIds.length === 0) return new Map();
  const partners = await executeKw("res.partner", "read", [partnerIds], { fields: ["name", "vat"] });
  return new Map(partners.map((p) => [p.id, p.vat || null]));
}

async function totalGeneral(dominio) {
  const [fila] = await executeKw("account.move", "read_group", [dominio, ["amount_total:sum", "amount_residual:sum"], []], { lazy: false });
  return {
    num_documentos: fila?.__count || 0,
    monto_total: redondear(fila?.amount_total || 0),
    saldo_pendiente: redondear(fila?.amount_residual || 0),
  };
}

async function porCompania(dominio) {
  const grupos = await executeKw("account.move", "read_group", [dominio, ["amount_total:sum", "amount_residual:sum"], ["company_id"]], { lazy: false });
  return grupos
    .map((g) => ({
      compania: ID_A_ALIAS_COMPANIA[g.company_id[0]] || g.company_id[1],
      num_documentos: g.__count || 0,
      monto_total: redondear(g.amount_total || 0),
      saldo_pendiente: redondear(g.amount_residual || 0),
    }))
    .sort((a, b) => b.monto_total - a.monto_total);
}

async function porCompaniaYMes(dominio) {
  const grupos = await executeKw(
    "account.move",
    "read_group",
    [dominio, ["amount_total:sum", "amount_residual:sum"], ["company_id", "invoice_date:month"]],
    { lazy: false }
  );
  return grupos
    .map((g) => ({
      compania: ID_A_ALIAS_COMPANIA[g.company_id[0]] || g.company_id[1],
      mes: g["__range"]?.["invoice_date:month"]?.from?.slice(0, 7) || null,
      num_documentos: g.__count || 0,
      monto_total: redondear(g.amount_total || 0),
      saldo_pendiente: redondear(g.amount_residual || 0),
    }))
    .filter((f) => f.mes)
    .sort((a, b) => (a.mes === b.mes ? a.compania.localeCompare(b.compania) : a.mes.localeCompare(b.mes)));
}

async function porProveedor(dominio, topN) {
  const grupos = await executeKw("account.move", "read_group", [dominio, ["amount_total:sum", "amount_residual:sum"], ["partner_id"]], { lazy: false });
  const filas = grupos
    .filter((g) => g.partner_id)
    .map((g) => ({
      partnerId: g.partner_id[0],
      proveedor: g.partner_id[1],
      num_documentos: g.__count || 0,
      monto_total: redondear(g.amount_total || 0),
      saldo_pendiente: redondear(g.amount_residual || 0),
    }))
    .sort((a, b) => b.monto_total - a.monto_total)
    .slice(0, topN);

  const rucPorPartner = await resolverRucPorPartner(filas.map((f) => f.partnerId));
  return filas.map(({ partnerId, ...resto }) => ({ ...resto, ruc: rucPorPartner.get(partnerId) || null }));
}

async function porJournal(dominio) {
  const grupos = await executeKw("account.move", "read_group", [dominio, ["amount_total:sum", "amount_residual:sum"], ["journal_id"]], { lazy: false });
  return grupos
    .map((g) => ({
      journal: Array.isArray(g.journal_id) ? g.journal_id[1] : "SIN_JOURNAL",
      num_documentos: g.__count || 0,
      monto_total: redondear(g.amount_total || 0),
      saldo_pendiente: redondear(g.amount_residual || 0),
    }))
    .sort((a, b) => b.monto_total - a.monto_total);
}

async function documentosCrudos(dominio, limite) {
  const filas = await executeKw(
    "account.move",
    "search_read",
    [dominio],
    {
      fields: [
        "id", "name", "ref", "move_type", "state", "payment_state",
        "invoice_date", "invoice_date_due", "partner_id", "company_id",
        "currency_id", "journal_id", "amount_total", "amount_residual",
      ],
      order: "invoice_date desc, id desc",
      limit: limite,
    }
  );

  const rucPorPartner = await resolverRucPorPartner([...new Set(filas.map((f) => f.partner_id?.[0]).filter(Boolean))]);

  return filas.map((f) => ({
    compania: ID_A_ALIAS_COMPANIA[f.company_id[0]] || f.company_id[1],
    proveedor: f.partner_id ? f.partner_id[1] : null,
    ruc: f.partner_id ? rucPorPartner.get(f.partner_id[0]) || null : null,
    numero_documento: f.name,
    referencia: f.ref || null,
    tipo: MOVE_TYPE_A_TIPO[f.move_type] || f.move_type,
    fecha_factura: f.invoice_date || null,
    fecha_vencimiento: f.invoice_date_due || null,
    moneda: f.currency_id ? f.currency_id[1] : null,
    monto_total: redondear(f.amount_total),
    monto_pagado: redondear(f.amount_total - f.amount_residual),
    saldo_pendiente: redondear(f.amount_residual),
    estado: f.state,
    estado_pago: f.payment_state,
    journal: Array.isArray(f.journal_id) ? f.journal_id[1] : null,
  }));
}

async function facturasProveedores({ compania = COMPANIAS_VALIDAS, fecha_inicio, fecha_fin, tipo_documento, limite = LIMITE_DEFAULT, top_n_proveedores = TOP_N_PROVEEDORES_DEFAULT }) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);

  const companiasSolicitadas = Array.isArray(compania) ? compania : [compania];
  const companyIds = companiasSolicitadas.map((alias) => COMPANIAS[alias].id);
  const moveTypes = tipo_documento ? [TIPO_A_MOVE_TYPE[tipo_documento]] : ["in_invoice", "in_refund"];
  const finStr = finExclusivo(fecha_fin);

  const dominio = construirDominio({ companyIds, moveTypes, inicioStr: fecha_inicio, finStr });

  const [total, compania_, companiaYMes, proveedor, journal, documentos] = await Promise.all([
    totalGeneral(dominio),
    porCompania(dominio),
    porCompaniaYMes(dominio),
    porProveedor(dominio, top_n_proveedores),
    porJournal(dominio),
    documentosCrudos(dominio, limite),
  ]);

  return {
    rango: { fecha_inicio, fecha_fin },
    companias: companiasSolicitadas,
    tipo_documento: tipo_documento || "TODOS",
    total_general: total,
    por_compania: compania_,
    por_compania_y_mes: companiaYMes,
    por_proveedor: proveedor,
    por_journal: journal,
    documentos,
  };
}

module.exports = { facturasProveedores, inputSchema, COMPANIAS_VALIDAS };
