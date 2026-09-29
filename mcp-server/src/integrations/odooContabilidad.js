// src/integrations/odooContabilidad.js
// Cliente JSON-RPC mínimo para el Odoo corporativo multi-compañía
// (grupoaqua.odoo.com) — la MISMA instancia que ya usa
// backend/services/odooServicio (sync de ventas COTTSA), NO la instancia
// separada aqua-premium-ne (ver aquaPremiumNe.js). Se reutilizan las mismas
// credenciales que backend/.env (ODOO_URL/DB/USER/API_KEY), copiadas acá
// bajo ODOO_CONTABILIDAD_* porque son dos .env independientes — si backend
// rota la API key hay que actualizarla acá también.
//
// Se usa JSON-RPC (no XML-RPC, que es lo que usa el backend vía el paquete
// `xmlrpc`) para no agregar esa dependencia a mcp-server — Node ya trae
// `fetch`. Es el mismo patrón exacto que aquaPremiumNe.js.
//
// Esta API key YA tenía acceso confirmado (probado en vivo antes de
// construir facturasProveedores.js) a res.company y a account.move con
// move_type in_invoice/in_refund (facturas de PROVEEDOR) en las 5
// compañías — no es una key de solo lectura dedicada/limitada, es la misma
// cuenta general (cia@aqua.com.ec) que ya usa todo el sync del backend. Ver
// TODO.md para la nota completa sobre este trade-off (no bloqueante, mismo
// límite de confianza que backend/.env).
//
// IMPORTANTE — llamada de RED EN VIVO cada vez que se invoca la tool, sin
// caché ni sincronización propia (mismo criterio que aqua-premium-ne: sería
// prematuro construir una sync/tabla nueva antes de validar que el enfoque
// tiene sentido). Los errores de red/autenticación se propagan explícitos,
// nunca se devuelven como "0 resultados" silencioso.
require("dotenv").config();

const URL_BASE = process.env.ODOO_CONTABILIDAD_URL;
const DB = process.env.ODOO_CONTABILIDAD_DB;
const LOGIN = process.env.ODOO_CONTABILIDAD_USER;
const API_KEY = process.env.ODOO_CONTABILIDAD_API_KEY;

const TIMEOUT_MS = 20_000;

let uidCacheado = null;

function configurada() {
  return !!(URL_BASE && DB && LOGIN && API_KEY);
}

async function llamarJsonRpc(service, method, args) {
  if (!configurada()) {
    throw new Error(
      "Odoo contabilidad no está configurado (faltan ODOO_CONTABILIDAD_URL/DB/USER/API_KEY en .env)"
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
      throw new Error(`Odoo contabilidad no respondió en ${TIMEOUT_MS / 1000}s (timeout)`);
    }
    throw new Error(`Odoo contabilidad: error de red — ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const cuerpo = await respuesta.json();
  if (cuerpo.error) {
    // Odoo devuelve 200 OK con un campo `error` incluso para fallos de
    // autenticación/permisos — no basta con chequear el status HTTP.
    const mensaje = cuerpo.error.data?.message || cuerpo.error.message || JSON.stringify(cuerpo.error);
    throw new Error(`Odoo contabilidad (${service}.${method}): ${mensaje}`);
  }
  return cuerpo.result;
}

async function obtenerUid() {
  if (uidCacheado) return uidCacheado;
  const uid = await llamarJsonRpc("common", "authenticate", [DB, LOGIN, API_KEY, {}]);
  if (!uid) {
    throw new Error("Odoo contabilidad: autenticación rechazada (uid vacío) — revisar USER/API_KEY");
  }
  uidCacheado = uid;
  return uid;
}

async function executeKw(modelo, metodo, args, kwargs = {}) {
  const uid = await obtenerUid();
  return llamarJsonRpc("object", "execute_kw", [DB, uid, API_KEY, modelo, metodo, args, kwargs]);
}

module.exports = { executeKw, configurada };
