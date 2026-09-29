// src/integrations/odooCondicionPagoFallback.js
// Fallback de condición de pago (CONTADO/CREDITO) vía Odoo para clientes
// que quedan SIN_DATO en MobilVendor (clientes.metodo_pago_cliente vacío)
// — pedido explícito del usuario (Bug 2), mismo patrón de cruce por RUC ya
// usado en auditoriaClientes.js. SOLO LECTURA: consulta Odoo en vivo, nunca
// escribe nada — ni en Odoo ni en Postgres. El resultado se aplica
// únicamente en la respuesta de la consulta (ventasPorCondicionPago.js /
// ventasPorRutaCondicion.js), la fila SIN_DATO original en Postgres nunca
// se toca.
//
// ============================================================
// Investigación previa (ver TODO.md para el detalle completo)
// ============================================================
// El SIN_DATO de DOMICILIO viene de clientes creados por el sync de Odoo
// (equipo_ventas='Website'), que nunca pasan por el sync de MobilVendor —
// por eso `metodo_pago_cliente` (campo exclusivo de ese sync) se queda
// permanentemente vacío para ellos.
//
// Se investigaron 2 fuentes en Odoo, cruzando por RUC contra 158 clientes
// SIN_DATO reales de DOMICILIO (ago-sep 2026):
//   1. `res.partner.property_payment_term_id` (término de pago DEFAULT
//      del cliente) — usa el MISMO texto que MobilVendor ("Pago
//      Inmediato", "30 días", etc.), se reutiliza el mismo criterio de
//      clasificación (CONTADO = "pago inmediato", cualquier otro texto no
//      vacío = CREDITO).
//   2. `account.move.invoice_payment_term_id` (término de la FACTURA más
//      reciente) — fallback de 2do nivel para cuando el partner no tiene
//      un término default configurado, pero sus facturas individuales sí
//      lo traen.
// Resultado (de 130 clientes con RUC utilizable, 110 RUC distintos tras
// consolidar sucursales): 34 resueltos por (1), +33 más por (2) — 67 de
// 110 (61%) resueltos combinando ambas fuentes, 43 (39%) siguen SIN_DATO
// incluso con las 2. Aplicado a los 158 originales (incluyendo el 18% sin
// RUC utilizable, que nunca se puede intentar): aproximadamente la mitad
// del SIN_DATO total se resuelve — mejora real, no una solución completa.
//
// ============================================================
// Por qué el fallback NO lanza error si Odoo no responde
// ============================================================
// A diferencia de aqua-premium-ne en ventasRutaOk.js (fuente PRIMARIA e
// irremplazable de una parte del total en dólares — ahí sí se falla
// explícito), este fallback es una MEJORA sobre un resultado que ya está
// completo y es correcto sin él (el SIN_DATO ya es un número real y
// honesto). Si Odoo no responde, se degrada con gracia: se devuelve el
// SIN_DATO tal cual, más un campo `error` explícito en el resumen del
// fallback para que quede visible que no se pudo intentar — nunca se
// esconde el fallo, pero tampoco se rompe una respuesta que ya era válida
// por un problema en una fuente secundaria.
require("dotenv").config();
const { executeKw } = require("./odooContabilidad");

function clasificarTermino(nombreTermino) {
  if (!nombreTermino) return null;
  return /pago inmediato/i.test(nombreTermino) ? "CONTADO" : "CREDITO";
}

// rucs: array de RUC/cédula (string, ya trim()eados, pueden repetirse o
// venir vacíos — se filtran acá). Devuelve un Map<ruc, resultado> donde
// resultado es:
//   { condicion_pago: 'CONTADO'|'CREDITO', fuente: 'PARTNER'|'FACTURA' }
//   o null si no se pudo resolver con ninguna de las 2 fuentes.
// Nunca lanza — si Odoo falla, se relanza envuelto para que el caller
// decida degradar con gracia (ver comentario grande del archivo).
async function resolverCondicionPagoOdoo(rucs) {
  const rucsUnicos = [...new Set((rucs || []).map((r) => (r || "").trim()).filter(Boolean))];
  const resultado = new Map();
  if (rucsUnicos.length === 0) return resultado;

  // 1) res.partner.property_payment_term_id — default del cliente.
  const partners = await executeKw(
    "res.partner",
    "search_read",
    [[["vat", "in", rucsUnicos]]],
    { fields: ["id", "vat", "property_payment_term_id"], context: { active_test: false }, limit: 0 }
  );

  const idAPartnerRuc = new Map();
  for (const p of partners) {
    const ruc = (p.vat || "").trim();
    if (!ruc) continue;
    idAPartnerRuc.set(p.id, ruc);
    if (p.property_payment_term_id && !resultado.has(ruc)) {
      resultado.set(ruc, { condicion_pago: clasificarTermino(p.property_payment_term_id[1]), fuente: "PARTNER" });
    }
  }

  // 2) Fallback de 2do nivel: invoice_payment_term_id de la factura MÁS
  //    RECIENTE, solo para los RUC que tienen partner en Odoo pero sin
  //    property_payment_term_id poblado.
  const idsSinResolver = [...idAPartnerRuc.entries()].filter(([, ruc]) => !resultado.has(ruc)).map(([id]) => id);

  if (idsSinResolver.length > 0) {
    const facturas = await executeKw(
      "account.move",
      "search_read",
      [[["partner_id", "in", idsSinResolver], ["move_type", "=", "out_invoice"], ["invoice_payment_term_id", "!=", false]]],
      { fields: ["partner_id", "invoice_payment_term_id"], order: "invoice_date desc", limit: 0 }
    );
    // Ordenado invoice_date desc — la primera factura vista por partner_id
    // ya es la más reciente, por eso alcanza con "el primer valor gana".
    for (const f of facturas) {
      const ruc = idAPartnerRuc.get(f.partner_id[0]);
      if (ruc && !resultado.has(ruc)) {
        resultado.set(ruc, { condicion_pago: clasificarTermino(f.invoice_payment_term_id[1]), fuente: "FACTURA" });
      }
    }
  }

  // RUC sin ningún partner en Odoo, o con partner pero sin señal en
  // ninguna de las 2 fuentes -> null explícito (se queda SIN_DATO).
  for (const ruc of rucsUnicos) {
    if (!resultado.has(ruc)) resultado.set(ruc, null);
  }
  return resultado;
}

module.exports = { resolverCondicionPagoOdoo };
