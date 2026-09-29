// src/integrations/aquaPremiumNe.js
// Cliente JSON-RPC mínimo para la segunda instancia de Odoo (Odoo Online,
// aqua-premium-ne.odoo.com) — instancia SEPARADA de COTTSA (la que ya
// sincronizamos en ventas_mv). Ahí se registran ventas de las rutas "OK"
// (113/131/132) que NO se facturan formalmente al SRI — quedan como
// pos.order (Punto de Venta), no sale.order (ese módulo no está instalado
// en esa instancia). Ver ventasRutaOk.js para el contexto de negocio
// completo y la investigación previa (TODO.md).
//
// XML-RPC (el estándar del API de Odoo) funciona igual en Odoo Online, pero
// JSON-RPC es equivalente y evita agregar una dependencia XML-RPC nueva al
// proyecto — Node ya trae `fetch` nativo.
//
// IMPORTANTE — esto es una llamada de RED EN VIVO a un sistema externo cada
// vez que se invoca la tool, sin caché ni sincronización propia (decisión
// explícita de Alberto para esta fase: "no investigues el rastro técnico
// del liquidador por ahora... eso queda para una fase de limpieza
// posterior" — construir una sync real con tabla propia en ventas_mv sería
// prematuro antes de que él valide que los números tienen sentido). Por
// eso los errores de red/autenticación se propagan explícitos (nunca se
// tragan silenciosamente ni se devuelven como "0 resultados") — un gerente
// no debe leer "$0 en aqua-premium-ne" cuando en realidad la instancia no
// respondió.
require("dotenv").config();

const URL_BASE = process.env.AQUA_PREMIUM_NE_URL;
const DB = process.env.AQUA_PREMIUM_NE_DB;
const LOGIN = process.env.AQUA_PREMIUM_NE_LOGIN;
const API_KEY = process.env.AQUA_PREMIUM_NE_API_KEY;

const TIMEOUT_MS = 20_000;

let uidCacheado = null;

function configurada() {
  return !!(URL_BASE && DB && LOGIN && API_KEY);
}

async function llamarJsonRpc(service, method, args) {
  if (!configurada()) {
    throw new Error(
      "aqua-premium-ne no está configurada (faltan AQUA_PREMIUM_NE_URL/DB/LOGIN/API_KEY en .env)"
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let respuesta;
  try {
    respuesta = await fetch(`${URL_BASE}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id: Date.now(),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`aqua-premium-ne no respondió en ${TIMEOUT_MS / 1000}s (timeout)`);
    }
    throw new Error(`aqua-premium-ne: error de red — ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const cuerpo = await respuesta.json();
  if (cuerpo.error) {
    // Odoo devuelve 200 OK con un campo `error` incluso para fallos de
    // autenticación/permisos — no basta con chequear el status HTTP.
    const mensaje = cuerpo.error.data?.message || cuerpo.error.message || JSON.stringify(cuerpo.error);
    throw new Error(`aqua-premium-ne (${service}.${method}): ${mensaje}`);
  }
  return cuerpo.result;
}

async function obtenerUid() {
  if (uidCacheado) return uidCacheado;
  const uid = await llamarJsonRpc("common", "authenticate", [DB, LOGIN, API_KEY, {}]);
  if (!uid) {
    throw new Error("aqua-premium-ne: autenticación rechazada (uid vacío) — revisar LOGIN/API_KEY");
  }
  uidCacheado = uid;
  return uid;
}

async function executeKw(modelo, metodo, args, kwargs = {}) {
  const uid = await obtenerUid();
  return llamarJsonRpc("object", "execute_kw", [DB, uid, API_KEY, modelo, metodo, args, kwargs]);
}

module.exports = { executeKw, configurada };
