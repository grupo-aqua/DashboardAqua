// src/tools/auditoriaProveedores.js
// FASE 1, SOLO DIAGNÓSTICO — mismo espíritu que auditoriaClientes.js
// (duplicados_en_odoo / activos_sin_consumo) pero para PROVEEDORES
// (res.partner con supplier_rank>0), pedido explícito del usuario
// (2026-10-15): "lo mismo sería bueno para contactos que no son clientes
// sino proveedores, para ya limpiar toda la base". Corre directo contra
// Odoo, no depende de MobilVendor (los proveedores no existen ahí).
//
// ============================================================
// Investigado antes de construir (datos reales, no asumidos)
// ============================================================
// Total proveedores activos (supplier_rank>0): 2,044 — base MUCHO más
// chica y más limpia que la de clientes. Duplicados reales (mismo
// RUC+nombre EXACTO+company_id, ambos activos — MISMO criterio ya
// validado en duplicados_en_odoo): solo 2 grupos. Facturas de proveedor
// posted (in_invoice/in_refund) para el chequeo de "sin movimiento":
// 31,174 — se traen todas en una sola llamada (solo partner_id+invoice_date,
// liviano) y se calcula la última fecha por proveedor en JS, mismo patrón
// que auditoriaClientes.auditarActivosSinConsumo.
//
// 2 categorías: `duplicados` y `sin_movimiento`. Nunca fusiona/archiva/
// borra nada — solo señala para revisión humana en Odoo.
"use strict";
const { z } = require("zod");
const { executeKw } = require("../integrations/odooContabilidad");

const LIMITE_DEFAULT = 50;
const LIMITE_MAX = 500;
const MUESTRA_RESUMEN = 5;
const UMBRAL_DIAS_INACTIVIDAD_DEFAULT = 180;

const CATEGORIAS_VALIDAS = ["duplicados", "sin_movimiento"];

const inputSchema = {
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  company_id: z.string().optional(),
  umbral_dias_inactividad: z.number().int().min(1).default(UMBRAL_DIAS_INACTIVIDAD_DEFAULT),
  offset: z.number().int().min(0).default(0),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
  formato_salida: z.enum(["json", "resumen_por_tipo"]).default("json"),
};

function paginar(items, offset, limite) {
  const pagina = items.slice(offset, offset + limite);
  return { total: items.length, offset, limite, hay_mas: offset + pagina.length < items.length, items: pagina };
}

const DESCRIPCION_DUPLICADOS =
  "Duplicados reales de proveedores en Odoo — mismo RUC/cédula + mismo nombre EXACTO + MISMA company_id, 2+ partners con supplier_rank>0 y active=true. MISMO criterio ya validado en auditoriaClientes.duplicados_en_odoo (exige company_id porque una misma persona/RUC puede ser proveedor real de más de una compañía del grupo). `partner_con_mas_historial` es solo una sugerencia débil (no fusiona nada).";

async function auditarDuplicadosProveedores(companyId) {
  const domain = [["supplier_rank", ">", 0], ["active", "=", true], ["vat", "!=", false]];
  if (companyId) domain.push(["company_id", "=", Number(companyId)]);

  const partners = await executeKw(
    "res.partner",
    "search_read",
    [domain],
    { fields: ["id", "name", "vat", "company_id", "create_date"], limit: 0 }
  );

  const porClave = new Map();
  for (const p of partners) {
    const ruc = (p.vat || "").trim();
    const nombre = (p.name || "").trim().toUpperCase();
    if (!ruc || !nombre) continue;
    const compId = p.company_id ? p.company_id[0] : null;
    const compNombre = p.company_id ? p.company_id[1] : null;
    const clave = `${ruc}|||${nombre}|||${compId}`;
    if (!porClave.has(clave)) {
      porClave.set(clave, { ruc, nombre: p.name, company_id: compId, company_nombre: compNombre, partners: [] });
    }
    porClave.get(clave).partners.push({
      odoo_id: p.id,
      fecha_creacion: p.create_date ? p.create_date.slice(0, 10) : null,
    });
  }

  return [...porClave.values()]
    .filter((g) => g.partners.length > 1)
    .map((g) => ({
      ...g,
      // Sugerencia débil, NO una fusión — igual criterio documentado que en
      // auditoriaClientes.duplicados_en_odoo. Acá se usa el partner con
      // `fecha_creacion` más ANTIGUA (no `customer_rank`, que no aplica a
      // proveedores) como aproximación de "el registro original".
      partner_con_mas_historial: g.partners.reduce((mas_viejo, p) => {
        if (!p.fecha_creacion) return mas_viejo;
        if (!mas_viejo.fecha_creacion || p.fecha_creacion < mas_viejo.fecha_creacion) return p;
        return mas_viejo;
      }).odoo_id,
    }));
}

const DESCRIPCION_SIN_MOVIMIENTO =
  "Proveedores activos en Odoo (res.partner.active=true, supplier_rank>0) sin ninguna factura de proveedor posted (account.move, move_type in_invoice/in_refund) registrada en más de umbral_dias_inactividad días, o que nunca tuvieron una — candidatos a archivar, requiere revisión humana.";

async function auditarSinMovimientoProveedores(companyId, umbralDias) {
  const domainPartners = [["supplier_rank", ">", 0], ["active", "=", true]];
  if (companyId) domainPartners.push(["company_id", "=", Number(companyId)]);

  const [partners, facturas] = await Promise.all([
    executeKw("res.partner", "search_read", [domainPartners], { fields: ["id", "name", "vat", "company_id"], limit: 0 }),
    executeKw(
      "account.move",
      "search_read",
      [[["move_type", "in", ["in_invoice", "in_refund"]], ["state", "=", "posted"]]],
      { fields: ["partner_id", "invoice_date"], limit: 0 }
    ),
  ]);

  const ultimaPorPartner = new Map();
  for (const f of facturas) {
    if (!f.partner_id || !f.invoice_date) continue;
    const id = f.partner_id[0];
    const actual = ultimaPorPartner.get(id);
    if (!actual || f.invoice_date > actual) ultimaPorPartner.set(id, f.invoice_date);
  }

  const hoy = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const candidatos = [];
  for (const p of partners) {
    const ultima = ultimaPorPartner.get(p.id) || null;
    const dias = ultima ? Math.round((hoy - new Date(`${ultima}T00:00:00Z`)) / 86400000) : null;
    if (dias === null || dias > umbralDias) {
      candidatos.push({
        odoo_id: p.id,
        nombre: p.name,
        ruc: p.vat || null,
        company_id: p.company_id ? p.company_id[0] : null,
        ultima_factura: ultima,
        dias_desde_ultima: dias,
        nunca_tuvo_factura: dias === null,
      });
    }
  }
  candidatos.sort((a, b) => (b.dias_desde_ultima ?? 999999) - (a.dias_desde_ultima ?? 999999));
  return candidatos;
}

async function auditoriaProveedores({
  categoria,
  company_id,
  umbral_dias_inactividad = UMBRAL_DIAS_INACTIVIDAD_DEFAULT,
  offset = 0,
  limite = LIMITE_DEFAULT,
  formato_salida = "json",
}) {
  if (categoria === "duplicados") {
    const duplicados = await auditarDuplicadosProveedores(company_id);
    if (formato_salida === "resumen_por_tipo") {
      return { categoria, company_id: company_id || null, descripcion: DESCRIPCION_DUPLICADOS, total: duplicados.length };
    }
    return { categoria, company_id: company_id || null, descripcion: DESCRIPCION_DUPLICADOS, ...paginar(duplicados, offset, limite) };
  }

  if (categoria === "sin_movimiento") {
    const candidatos = await auditarSinMovimientoProveedores(company_id, umbral_dias_inactividad);
    const base = { descripcion: DESCRIPCION_SIN_MOVIMIENTO, umbral_dias_inactividad };
    if (formato_salida === "resumen_por_tipo") {
      return { categoria, company_id: company_id || null, ...base, total: candidatos.length };
    }
    return { categoria, company_id: company_id || null, ...base, ...paginar(candidatos, offset, limite) };
  }

  // Sin categoría: resumen de las 2, con muestra chica de cada una.
  const [duplicados, sinMovimiento] = await Promise.all([
    auditarDuplicadosProveedores(company_id),
    auditarSinMovimientoProveedores(company_id, umbral_dias_inactividad),
  ]);
  return {
    nota: "Resumen de las 2 categorías con muestra chica (5) de cada una. Para el listado completo, volver a llamar pasando `categoria`.",
    company_id: company_id || null,
    duplicados: { descripcion: DESCRIPCION_DUPLICADOS, total: duplicados.length, items: duplicados.slice(0, MUESTRA_RESUMEN) },
    sin_movimiento: {
      descripcion: DESCRIPCION_SIN_MOVIMIENTO,
      umbral_dias_inactividad,
      total: sinMovimiento.length,
      items: sinMovimiento.slice(0, MUESTRA_RESUMEN),
    },
  };
}

module.exports = { auditoriaProveedores, inputSchema, CATEGORIAS_VALIDAS };
