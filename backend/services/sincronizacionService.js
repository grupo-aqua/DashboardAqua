// services/sincronizacionService.js
"use strict";

require("dotenv").config();

const axios      = require("axios");
const axiosRetry = require("axios-retry").default ?? require("axios-retry");
const fs         = require("fs");
const path       = require("path");

const sequelize = require("../db");
const {
  Clientes,
  TipoNegocio,
    Subcanal, //  AGREGAR
  ClienteUsuarioVenta,
  Factura,
  Orden,
  DetalleDocumento,
  SincronizacionVenta,
  Producto,
  Promo,
  PromoCondicion,
  PromoAccion,
  UsuarioEnPromo,
  PromoLineaVenta,
} = require("../models");

const DireccionCliente = require("../models/DireccionCliente");
const { API_URL }             = require("../config/config");
const { obtenerSesionActual, forzarSesionNueva } = require("../utils/apiCliente");
const { sanitizeCoordinate } = require("../utils/sanitizeCoordinate");

// ================================================================
// CONFIGURACIÓN DE AXIOS CON RETRY AUTOMÁTICO
// ================================================================
axiosRetry(axios, {
  retries      : 3,
  retryDelay   : axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    err.code === "ECONNABORTED" ||
    (err.response?.status >= 500),
  onRetry: (retryCount, err) =>
    console.warn(`⚠️  Reintento ${retryCount} para MobilVendor: ${err.message}`),
});

// ================================================================
// CONSTANTES
// ================================================================
const ECUADOR_TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const API_PAGE_LIMIT        = 1000;
const LOG_FILE              = path.join(__dirname, "errores_sync.txt");
const COMPANY_ID            = 1;
const COMPANY_DESC          = "GRUPOAQUA S.A.";

// ================================================================
// HELPERS DE FECHA
// ================================================================
const parseUnixToEcuador = (value) => {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000 - ECUADOR_TZ_OFFSET_MS);
};

// ================================================================
// HELPERS GENERALES
// ================================================================
const toNumber = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

const inferTipoRuta = (codigo = "") => {
  const c = (codigo || "").toUpperCase();
  if (c.startsWith("PV"))  return "PREVENTA";
  if (c.includes("TELE"))  return "TELEVENTA";
  if (c.includes("VIP"))   return "VIP";
  return null;
};

const normalizeCode = (v) => {
  if (v == null && v !== 0) return null;
  const s = String(v).trim().replace(/^0+/, "");
  return s.length ? s : null;
};

// ================================================================
// DEADLOCK DE POSTGRES (código 40P01) — MobilVendor y Odoo sincronizan en
// PARALELO (Promise.allSettled en sincronizacionController) y ambos escriben
// a la misma tabla `productos`: MobilVendor un producto a la vez dentro de la
// transacción de cada documento, Odoo con un bulkCreate masivo por chunk.
// Sin coordinación de orden entre ambos, dos escrituras concurrentes sobre
// los mismos códigos de producto en orden distinto pueden formar un ciclo de
// locks y Postgres aborta una de las dos transacciones (40P01). Antes de este
// fix ese error simplemente se registraba y el documento se perdía en
// silencio (ver TODO.md, hallazgo del backfill 2025 — PDPV8-001710).
//
// Mitigación en dos capas:
//   1) orden consistente de locks: dedupDetails() ordena por article_code
//      antes de upsertear productos (ver abajo), y el lado Odoo hace lo mismo
//      con su bulkCreate — así, si dos transacciones concurrentes necesitan
//      los mismos 2+ productos, siempre intentan tomarlos en el mismo orden
//      y el ciclo de locks deja de poder formarse.
//   2) red de seguridad: un deadlock SIEMPRE es posible en Postgres bajo
//      concurrencia real (no se puede garantizar al 100% solo con orden de
//      locks, ej. si además compite con `clientes`/`direcciones_cliente`) —
//      por eso el documento completo se reintenta con backoff ante 40P01,
//      en vez de darlo por perdido al primer intento.
// ================================================================
const esDeadlockPostgres = (err) =>
  err?.parent?.code === "40P01" || err?.original?.code === "40P01";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function conReintentoDeadlock(fn, { intentos = 3, baseMs = 200 } = {}) {
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (err) {
      if (!esDeadlockPostgres(err) || intento === intentos) throw err;
      const backoff = baseMs * intento + Math.floor(Math.random() * baseMs);
      console.warn(`⚠️  Deadlock de Postgres (40P01), reintento ${intento}/${intentos - 1} en ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

// --- Helpers para promociones -------------------------------------------
// Número nullable (a diferencia de toNumber, no fuerza 0 cuando es inválido).
const toNumOrNull = (val) => {
  if (val == null || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

// Bandera 0/1 tolerante con "0"/"1", true/false, 0/1; null si no aplica.
const toBit = (val) => {
  if (val === true  || val === 1 || val === "1") return 1;
  if (val === false || val === 0 || val === "0") return 0;
  return null;
};

// Fecha flexible: acepta unix (segundos) o cadena ISO/fecha; null si inválida.
const parseFlexibleDate = (val) => {
  if (val == null || val === "") return null;
  const n = Number(val);
  if (Number.isFinite(n) && n > 100_000) return parseUnixToEcuador(n);
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Normaliza campos "lista" (business_types, articles, brands, ...) a algo
// almacenable en JSONB: array, objeto, JSON serializado o CSV → array.
const toJsonList = (val) => {
  if (val == null || val === "") return null;
  if (Array.isArray(val) || typeof val === "object") return val;
  const s = String(val).trim();
  if (!s) return null;
  if (s.startsWith("[") || s.startsWith("{")) {
    try { return JSON.parse(s); } catch { /* sigue abajo */ }
  }
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
};

// ================================================================
// LOGGING DE ERRORES
// ================================================================
const flushErrorLog = (errores) => {
  if (!errores.length) return;
  const timestamp = new Date().toISOString();
  const separator = "─".repeat(60);
  const content   = errores
    .map(({ code, error }) =>
      `\n${separator}\n[${timestamp}] Documento: ${code}\n${JSON.stringify(error, null, 2)}`
    )
    .join("\n");

  try {
    fs.appendFileSync(LOG_FILE, content, "utf8");
    console.log(`📝 ${errores.length} error(es) guardado(s) en errores_sync.txt`);
  } catch (err) {
    console.error("❌ No se pudo escribir el archivo de log:", err.message);
  }
};

// ================================================================
// CLASE: SyncProgress
// ================================================================
// FASE 1 (MobilVendor + Odoo en paralelo): el % es el PROMEDIO de las fracciones
// de ambas fuentes → 0%→75%. Así la barra avanza mientras cualquiera trabaje y
// solo llega a 75% cuando ambas terminan (luego Direcciones 75→95, Promos 95→100).
function aplicarProgresoFase1(s) {
  if (!s) return;
  const pct = Math.round((((s.mvFrac || 0) + (s.odooFrac || 0)) / 2) * 75);
  // Escribe el OBJETIVO real; el valor mostrado lo sube suave el controller.
  s.percentObjetivo = Math.max(s.percentObjetivo || 0, pct);
}

class SyncProgress {
  // from/to = rango global de % que ocupa esta fase (por defecto MobilVendor 5→70).
  // fase1Source = 'mvFrac'|'odooFrac' → modo FASE 1 combinada (promedio de ambas).
  constructor(state, from = 5, to = 70, fase1Source = null) {
    this._s = state;
    this._from = from;
    this._to = to;
    this._fase1 = fase1Source;
  }

  start(startDate, endDate) {
    if (!this._s) return;
    // No reseteamos `percent`/`running`: el controller los gestiona globalmente
    // (varias fases comparten el mismo syncState). Resetear aquí haría que la
    // barra "retroceda" al iniciar cada fase.
    Object.assign(this._s, {
      startDate,
      endDate,
      error: null,
    });
  }

  updatePage(page, totalPages) {
    if (!this._s || !totalPages) return;
    // Modo FASE 1 combinada: guardamos la fracción de esta fuente y el % global
    // es el promedio de ambas fuentes (MobilVendor + Odoo).
    if (this._fase1) {
      this._s[this._fase1] = page / totalPages;
      aplicarProgresoFase1(this._s);
      return;
    }
    const pct = this._from + Math.round((page / totalPages) * (this._to - this._from));
    // Escribe el OBJETIVO real; el valor mostrado sube suave (controller). Monótono.
    this._s.percentObjetivo = Math.max(this._s.percentObjetivo || 0, pct);
  }

  finish(error = null) {
    if (!this._s) return;
    // No marcar running=false ni finishedAt aquí.
    // El controller se encarga cuando TODOS los procesos terminan.
    if (error) {
      this._s.error = error;
    }
  }
}

// ================================================================
// CLASE: SyncStats
// ================================================================
class SyncStats {
  headers  = 0;
  details  = 0;
  facturas = 0;
  ordenes  = 0;
  errores  = 0;

  toMessage() {
    return (
      `Facturas:${this.facturas} ` +
      `Órdenes:${this.ordenes} ` +
      `Errores:${this.errores}`
    );
  }

  print() {
    console.log("\n====================================");
    console.log("✅ SINCRONIZACIÓN COMPLETA");
    console.log(`   → Cabeceras : ${this.headers}`);
    console.log(`   → Detalles  : ${this.details}`);
    console.log(`   → Facturas  : ${this.facturas}`);
    console.log(`   → Órdenes   : ${this.ordenes}`);
    console.log(`   → Errores   : ${this.errores}`);
    console.log("====================================\n");
  }
}

// ================================================================
// PROCESADORES POR ENTIDAD
// ================================================================

async function syncTipoNegocio(doc, transaction) {
  const codigo = doc.business_type_code || null;
  if (!codigo) return;

  await TipoNegocio.upsert(
    {
      codigo,
      descripcion        : doc.business_type_description || codigo,
      estado             : 1,
      fecha_creacion     : new Date(),
      fecha_actualizacion: new Date(),
    },
    { transaction, conflictFields: ["codigo"] }
  );
}



async function syncTipoNegocio(doc, transaction) {
  const codigo = doc.business_type_code || null;
  if (!codigo) return;

  await TipoNegocio.upsert(
    {
      codigo,
      descripcion        : doc.business_type_description || codigo,
      estado             : 1,
      fecha_creacion     : new Date(),
      fecha_actualizacion: new Date(),
    },
    { transaction, conflictFields: ["codigo"] }
  );
}

//  NUEVO: SUBCANAL
async function syncSubcanal(doc, transaction) {
  const codigo = doc.subchannel_code || null;
  if (!codigo) return;

  await Subcanal.upsert(
    {
      codigo_subcanal      : codigo,
      descripcion_subcanal : doc.subchannel_description || codigo,
      estado               : 1,
      fecha_creacion       : new Date(),
      fecha_actualizacion  : new Date(),
    },
    {
      transaction,
      conflictFields: ["codigo_subcanal"]
    }
  );
}

async function syncCliente(doc, customerCode, transaction) {
  if (!customerCode) return;

  await Clientes.upsert(
    {
      codigo_cliente                  : customerCode,
      company_id                      : COMPANY_ID,
      descripcion_company             : COMPANY_DESC,
      tipo_identificacion_cliente     : doc.customer_identity_type     || null,
      identificacion_cliente          : doc.customer_identity          || null,
      nombre_cliente                  : doc.customer_name              || null,
      nombre_comercial_cliente        : doc.company_name || doc.customer_name || null,
      contacto_cliente                : doc.contact                    || null,
      codigo_tipo_negocio             : doc.business_type_code         || null,
      codigo_subcanal                 : doc.subchannel_code            || null,
      codigo_moneda_cliente           : doc.currency_code              || "USD",
      codigo_lista_precio_cliente     : doc.price_list_code            || null,
      metodo_pago_cliente             : doc.payment_method_description || null,
      codigo_grupo_cliente            : doc.customer_group_code        || null,
      descuento_cliente               : doc.discount_p                 || 0,
      objetivo_venta_cliente          : doc.goal_per_sale              || null,
      saldo_cliente                   : doc.balance                    || 0,
      tiene_credito_cliente           : doc.has_credit === "1",
      tiene_documentos_cliente        : doc.has_documents === "1",
      estado_cliente                  : doc.status                     || 0,
      estado_proceso_cliente          : doc.process_status             || 0,
      nacionalidad_cliente            : doc.nationality                || null,
      codigo_usuario_asignado_cliente : doc.user_code                  || null,
      fecha_creacion_cliente          : parseUnixToEcuador(doc.create_date) || new Date(),
      fecha_actualizacion_cliente     : parseUnixToEcuador(doc.store_date)  || new Date(),
    },
    { transaction, conflictFields: ["codigo_cliente"] }
  );
}

// `estado_ubicacion_direccion_cliente` es integer en Postgres, pero para
// ciertas direcciones (ej. 277494 "DHARMA BEACH(NO USAR)", 284316 "CANTA Y
// NO LLORES(NO USAR)" — ambas marcadas "NO USAR" en su propia descripción,
// aparentemente obsoletas en MobilVendor) `geo_area_code` llega como el
// string literal "UNKNOWN". Sin sanear, Postgres rechaza el INSERT completo
// (error 22P02) — y como syncDireccionCliente corre dentro de la MISMA
// transacción que el documento (orden/factura + detalle), el rollback se
// llevaba el documento entero, no solo la dirección. Ver TODO.md, "Bug
// diferido: estado_ubicacion_direccion_cliente tumba el documento completo".
function sanearEstadoUbicacion(geoAreaCode) {
  const valor = geoAreaCode || 3; // default histórico cuando no viene el campo
  const n = Number(valor);
  return Number.isInteger(n) ? n : null; // "UNKNOWN" (u otro no-entero) → null, no tumba el insert
}

/**
 * CORREGIDO: SQL nativo para garantizar ON CONFLICT sobre
 * el constraint real (codigo_cliente, codigo_direccion_cliente).
 * Sequelize ignora conflictFields en upsert con esta versión del driver.
 */
async function syncDireccionCliente(doc, customerCode, transaction) {
  if (!customerCode) return;

  const codigoDireccion = doc.customer_address_code || null;
  if (!codigoDireccion) return;

  // CORREGIDO: truncar zipcode a 20 chars para respetar VARCHAR(20)
  const zipcode = doc.zipcode
    ? String(doc.zipcode).substring(0, 20)
    : null;

  await sequelize.query(
    `INSERT INTO direcciones_clientes (
        codigo_cliente,
        codigo_direccion_cliente,
        descripcion_direccion_cliente,
        calle1_direccion_cliente,
        bloque_direccion_cliente,
        calle2_direccion_cliente,
        referencia_direccion_cliente,
        codigo_postal_direccion_cliente,
        telefono_direccion_cliente,
        fax_direccion_cliente,
        email_direccion_cliente,
        latitud_direccion_cliente,
        longitud_direccion_cliente,
        fecha_ultima_visita_direccion_cliente,
        estado_direccion_cliente,
        estado_ubicacion_direccion_cliente,
        fecha_creacion_direccion_cliente,
        fecha_actualizacion_direccion_cliente
      ) VALUES (
        :codigo_cliente,
        :codigo_direccion_cliente,
        :descripcion,
        :calle1,
        :bloque,
        :calle2,
        :referencia,
        :zip,
        :telefono,
        :fax,
        :email,
        :latitud,
        :longitud,
        :fecha_ultima_visita,
        :estado,
        :estado_ubicacion,
        :fecha_creacion,
        :fecha_actualizacion
      )
      ON CONFLICT (codigo_cliente, codigo_direccion_cliente)
      DO UPDATE SET
        descripcion_direccion_cliente         = COALESCE(EXCLUDED.descripcion_direccion_cliente, direcciones_clientes.descripcion_direccion_cliente),
        calle1_direccion_cliente              = COALESCE(EXCLUDED.calle1_direccion_cliente, direcciones_clientes.calle1_direccion_cliente),
        bloque_direccion_cliente              = COALESCE(EXCLUDED.bloque_direccion_cliente, direcciones_clientes.bloque_direccion_cliente),
        calle2_direccion_cliente              = COALESCE(EXCLUDED.calle2_direccion_cliente, direcciones_clientes.calle2_direccion_cliente),
        referencia_direccion_cliente          = COALESCE(EXCLUDED.referencia_direccion_cliente, direcciones_clientes.referencia_direccion_cliente),
        codigo_postal_direccion_cliente       = COALESCE(EXCLUDED.codigo_postal_direccion_cliente, direcciones_clientes.codigo_postal_direccion_cliente),
        telefono_direccion_cliente            = COALESCE(EXCLUDED.telefono_direccion_cliente, direcciones_clientes.telefono_direccion_cliente),
        fax_direccion_cliente                 = COALESCE(EXCLUDED.fax_direccion_cliente, direcciones_clientes.fax_direccion_cliente),
        email_direccion_cliente               = COALESCE(EXCLUDED.email_direccion_cliente, direcciones_clientes.email_direccion_cliente),
        latitud_direccion_cliente             = COALESCE(EXCLUDED.latitud_direccion_cliente, direcciones_clientes.latitud_direccion_cliente),
        longitud_direccion_cliente            = COALESCE(EXCLUDED.longitud_direccion_cliente, direcciones_clientes.longitud_direccion_cliente),
        fecha_ultima_visita_direccion_cliente = COALESCE(EXCLUDED.fecha_ultima_visita_direccion_cliente, direcciones_clientes.fecha_ultima_visita_direccion_cliente),
        estado_direccion_cliente              = EXCLUDED.estado_direccion_cliente,
        estado_ubicacion_direccion_cliente    = EXCLUDED.estado_ubicacion_direccion_cliente,
        fecha_actualizacion_direccion_cliente = EXCLUDED.fecha_actualizacion_direccion_cliente`,
    {
      replacements: {
        codigo_cliente          : String(customerCode),
        codigo_direccion_cliente: String(codigoDireccion),
        descripcion             : (doc.address_description && doc.address_description !== "delivery" && doc.address_description !== "other")
                                    ? doc.address_description : null,
        calle1                  : doc.street1              || null,
        bloque                  : doc.block                || null,
        calle2                  : doc.street2              || null,
        referencia              : doc.reference            || null,
        zip                     : zipcode,
        telefono                : doc.phone                || null,
        fax                     : doc.fax                  || null,
        email                   : doc.email                || null,
        latitud                 : sanitizeCoordinate(doc.address_lat, "lat"),
        longitud                : sanitizeCoordinate(doc.address_lon, "lon"),
        fecha_ultima_visita     : parseUnixToEcuador(doc.last_visit_date) || null,
        estado                  : doc.location_status  || 1,
        estado_ubicacion        : sanearEstadoUbicacion(doc.geo_area_code),
        fecha_creacion          : parseUnixToEcuador(doc.create_date) || new Date(),
        fecha_actualizacion     : parseUnixToEcuador(doc.store_date)  || new Date(),
      },
      transaction,
      type: sequelize.QueryTypes.INSERT,
    }
  );
}

// ================================================================
// SINCRONIZACIÓN DE DIRECCIONES DESDE customer_addresses
// ================================================================
/**
 * Consulta directamente el endpoint customer_addresses de MobilVendor
 * para obtener descripción, latitud y longitud correctas.
 */
const sincronizarDirecciones = async (syncState = null) => {
  console.log("\n====================================");
  console.log("🚀 SINCRONIZACIÓN DE DIRECCIONES (customer_addresses)");
  console.log("====================================\n");

  const progress = new SyncProgress(syncState, 75, 95); // Direcciones: 75% → 95%
  progress.start("direcciones", "completo");

  try {
    const session_id = await obtenerSesionActual();
    if (!session_id) throw new Error("No hay sesión activa con MobilVendor.");
    console.log(`🔐 Sesión MobilVendor OK: ${session_id}`);

    let totalPages  = 1;
    let currentPage = 1;
    let totalProcessed = 0;
    let totalErrors    = 0;

    while (currentPage <= totalPages) {
      console.log(`\n📦 PÁGINA ${currentPage} / ${totalPages}`);
      progress.updatePage(currentPage, totalPages);

      const { data } = await axios.post(
        API_URL,
        {
          session_id,
          action: "get",
          schema: "customer_addresses",
          page  : currentPage,
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 120_000,
        }
      );

      const records = data.records || [];
      totalPages    = data.pages   || totalPages;

      console.log(`   → Registros: ${records.length} | Páginas: ${totalPages}`);

      if (!records.length) {
        console.log("🏁 Sin más registros — finalizando.");
        break;
      }

      for (const addr of records) {
        const customerCode    = addr.customer_code || null;
        const codigoDireccion = addr.code          || null;

        if (!customerCode || !codigoDireccion) continue;

        const zipcode = addr.zipcode
          ? String(addr.zipcode).substring(0, 20)
          : null;

        try {
          const [, rowCount] = await sequelize.query(
            `UPDATE direcciones_clientes SET
                descripcion_direccion_cliente         = :descripcion,
                calle1_direccion_cliente              = COALESCE(:calle1, calle1_direccion_cliente),
                bloque_direccion_cliente              = COALESCE(:bloque, bloque_direccion_cliente),
                calle2_direccion_cliente              = COALESCE(:calle2, calle2_direccion_cliente),
                referencia_direccion_cliente          = COALESCE(:referencia, referencia_direccion_cliente),
                codigo_postal_direccion_cliente       = COALESCE(:zip, codigo_postal_direccion_cliente),
                telefono_direccion_cliente            = COALESCE(:telefono, telefono_direccion_cliente),
                fax_direccion_cliente                 = COALESCE(:fax, fax_direccion_cliente),
                email_direccion_cliente               = COALESCE(:email, email_direccion_cliente),
                latitud_direccion_cliente             = COALESCE(:latitud, latitud_direccion_cliente),
                longitud_direccion_cliente            = COALESCE(:longitud, longitud_direccion_cliente),
                fecha_ultima_visita_direccion_cliente = COALESCE(:fecha_ultima_visita, fecha_ultima_visita_direccion_cliente),
                fecha_actualizacion_direccion_cliente = :fecha_actualizacion
              WHERE codigo_cliente = :codigo_cliente
                AND codigo_direccion_cliente = :codigo_direccion_cliente`,
            {
              replacements: {
                codigo_cliente          : String(customerCode),
                codigo_direccion_cliente: String(codigoDireccion),
                descripcion             : addr.description        || null,
                calle1                  : addr.street1            || null,
                bloque                  : addr.block              || null,
                calle2                  : addr.street2            || null,
                referencia              : addr.reference          || null,
                zip                     : zipcode,
                telefono                : addr.phone              || null,
                fax                     : addr.fax                || null,
                email                   : addr.email              || null,
                latitud                 : sanitizeCoordinate(addr.lat, "lat"),
                longitud                : sanitizeCoordinate(addr.lon, "lon"),
                fecha_ultima_visita     : parseUnixToEcuador(addr.last_visit_date) || null,
                fecha_actualizacion     : parseUnixToEcuador(addr.u) || new Date(),
              },
              type: sequelize.QueryTypes.UPDATE,
            }
          );
          if (rowCount > 0) totalProcessed++;
        } catch (err) {
          totalErrors++;
          if (totalErrors <= 5) {
            console.error(`❌ Error dirección ${codigoDireccion} (cliente ${customerCode}): ${err.message}`);
          }
        }
      }

      currentPage++;
    }

    console.log("\n====================================");
    console.log("✅ SINCRONIZACIÓN DE DIRECCIONES COMPLETA");
    console.log(`   → Procesadas : ${totalProcessed}`);
    console.log(`   → Errores    : ${totalErrors}`);
    console.log("====================================\n");

    progress.finish();
    return { totalProcessed, totalErrors };

  } catch (err) {
    console.error("\n❌ ERROR SINCRONIZACIÓN DIRECCIONES:", err.message);
    progress.finish(err.message);
    throw err;
  }
};

async function syncDocumento(doc, code, transaction) {
  const type   = Number(doc.type);
  const status = Number(doc.status);

  const customerCode = doc.customer_code  || null;
  const routeCode    = doc.route?.code || doc.route_code || null;
  const sellerCode   = String(doc.seller_code || doc.user_code || "").trim() || null;

  // DEBUG TEMPORAL — ver campos de fecha cuando create_date falta
  if (!doc.create_date || Number(doc.create_date) <= 0) {
    console.log(`[DEBUG fechas] code=${doc.code} | create_date=${doc.create_date} | store_date=${doc.store_date} | dispatch_date=${doc.dispatch_date} | date=${doc.date} | document_date=${doc.document_date} | order_date=${doc.order_date}`);
  }
  const creationDate = parseUnixToEcuador(doc.create_date || doc.store_date);
  const dispatchDate =
    parseUnixToEcuador(doc.dispatch_date) ||
    parseUnixToEcuador(doc.create_date)   ||
    parseUnixToEcuador(doc.store_date);

  const basePayload = {
    code,
    type,
    status,
    fecha_creacion : creationDate,
    fecha_entrega  : dispatchDate,
    customer_code  : customerCode,
    route_code     : routeCode,
    seller_code    : sellerCode,
    total          : toNumber(doc.total),
    subtotal       : toNumber(doc.subtotal),
    iva            : toNumber(doc.iva),
    discount       : toNumber(doc.discount),
  };

  if (type === 1) {
    const mobilvendorInternalId = doc.id != null ? String(doc.id).trim() || null : null;

    // Reconciliación MobilVendor↔Odoo (ver TODO.md, "Propuesta de diseño
    // COMPLETA — reconciliación de facturas") — Tier 1, determinístico.
    // `doc.id` es el id INTERNO de MobilVendor (confirmado en vivo contra su
    // API — distinto de `code`, que puede cambiar de valor para el MISMO
    // documento real entre una sincronización y otra). Si ya existe una fila
    // con este mismo `mobilvendor_internal_id` bajo OTRO `code`, es el mismo
    // documento visto antes con un código distinto — no crear una fila
    // nueva: se marca la fila VIEJA como duplicado_de la que se está
    // escribiendo ahora (la sincronización más reciente gana). No se
    // reutiliza una fila que ya esté marcada como duplicado de otra
    // (evita encadenar duplicados). OJO orden: el `UPDATE ... duplicado_de`
    // va DESPUÉS del upsert de abajo, no antes — `duplicado_de` tiene FK
    // hacia `facturas(code)`, así que el code nuevo debe existir primero
    // (confirmado con un caso real: el orden inverso rompe la FK).
    let filaPrevia = null;
    if (mobilvendorInternalId) {
      [filaPrevia] = await sequelize.query(
        `SELECT code FROM facturas
         WHERE mobilvendor_internal_id = :internalId
           AND code <> :code
           AND duplicado_de IS NULL
         LIMIT 1`,
        {
          replacements: { internalId: mobilvendorInternalId, code },
          transaction,
          type: sequelize.QueryTypes.SELECT,
        }
      );
    }

    await Factura.upsert(
      {
        ...basePayload,
        origen_sistema      : "MOBILVENDOR",
        company_id         : COMPANY_ID,
        descripcion_company : COMPANY_DESC,
        mobilvendor_internal_id: mobilvendorInternalId,
        customer_address_code:
          doc.customer_address_code   ||
          doc.customer_address_code_2 ||
          doc.customer_address        ||
          doc.customer_address_id     ||
          doc.delivery_address_code   ||
          doc.customer_address_code_1 ||
          null,
      },
      { transaction }
    );

    if (filaPrevia) {
      await sequelize.query(
        `UPDATE facturas SET duplicado_de = :codeNuevo WHERE code = :codeViejo`,
        {
          replacements: { codeNuevo: code, codeViejo: filaPrevia.code },
          transaction,
          type: sequelize.QueryTypes.UPDATE,
        }
      );
    }

    return "factura";
  }

  if (type === 2) {
    await Orden.upsert(
      {
        ...basePayload,
        origen_sistema: "MOBILVENDOR",
        campania_id         : COMPANY_ID,        // → 1
        descripcion_company : COMPANY_DESC,      // → "GRUPOAQUA S.A."

        //  NUEVOS CAMPOS
        codigo_subcanal: doc.subchannel_code || null,
        codigo_tipo_negocio: doc.business_type_code || null,
      },
      { transaction }
    );

    // Guía de entrega — objeto separado del status de la orden. NO se
    // escribe con el upsert de arriba (que pisaría sin condición en cada
    // resync) — se aplica con COALESCE en una query aparte para que un
    // resync NUNCA reemplace un waybill_status ya capturado. Motivo: el
    // código de guía es reutilizable (mismo GUT#/GUR# se reasigna a un
    // despacho posterior con el tiempo), así que su `status` "en vivo"
    // consultado semanas/meses después de la entrega real puede reflejar
    // ese despacho posterior, no el original — cada resync (backfill,
    // correcciones puntuales) pisaba ese valor con el estado de HOY,
    // degradando datos que antes eran correctos. Ver TODO.md, "waybill_status
    // se sobreescribe en cada resync". `doc.waybill` es null/false cuando la
    // orden nunca llegó a despacharse (facturada pero sin guía generada) —
    // en ese caso la query es un no-op (COALESCE con NULL no cambia nada).
    await sequelize.query(
      `UPDATE ordenes
         SET waybill_code   = COALESCE(waybill_code, :waybill_code),
             waybill_status = COALESCE(waybill_status, :waybill_status)
       WHERE code = :code`,
      {
        replacements: {
          code,
          waybill_code  : doc.waybill?.code || null,
          waybill_status: doc.waybill ? String(doc.waybill.status) : null,
        },
        transaction,
        type: sequelize.QueryTypes.UPDATE,
      }
    );

    return "orden";
  }

  return null;
}

async function syncClienteUsuario(doc, code, customerCode, transaction) {
  const routeCode  = doc.route?.code || doc.route_code || null;
  const sellerCode = String(doc.seller_code || doc.user_code || "").trim() || null;

  if (!customerCode || !sellerCode) return;

  const creationDate = parseUnixToEcuador(doc.create_date || doc.store_date);

  await ClienteUsuarioVenta.upsert(
    {
      codigo_cliente          : customerCode,
      seller_code             : sellerCode,
      ruta_code               : routeCode || null,
      tipo_atencion           : inferTipoRuta(routeCode),
      ultima_atencion         : creationDate,
      codigo_direccion_cliente: doc.customer_address_code || "DEFAULT",
    },
  { 
    transaction, 
    conflictFields: ["codigo_cliente", "seller_code", "codigo_direccion_cliente"] 
  });
}

function deduplicateDetails(detallesDoc) {
  const map = new Map();

  for (const d of detallesDoc) {
    if (!d.article_code) {
      console.warn("⚠️  Detalle sin article_code ignorado.");
      continue;
    }

    // La promo forma parte de la identidad de la línea: dos líneas del mismo
    // artículo con promos distintas (o una con promo y otra sin) NO se fusionan,
    // para no perder la trazabilidad de qué promo se vendió.
    const key = `${d.article_code}|${d.promo_code || ""}|${d.promo_action_code || ""}`;

    if (map.has(key)) {
      const existing    = map.get(key);
      existing.quantity = toNumber(existing.quantity) + toNumber(d.quantity);
      existing.subtotal = toNumber(existing.subtotal) + toNumber(d.subtotal);
      existing.total    = toNumber(existing.total)    + toNumber(d.total);
      existing.discount = toNumber(existing.discount) + toNumber(d.discount);
      console.log(`🔀 Detalle duplicado fusionado: ${key} (+${d.quantity} uds)`);
    } else {
      map.set(key, { ...d });
    }
  }

  return [...map.values()];
}

async function syncDetalle(detalle, documentCode, transaction) {
  // --- Producto ---
  if (detalle.article_code) {
    await Producto.upsert(
      {
        codigo_producto        : detalle.article_code,
        nombre_producto        : detalle.article_description || "SIN NOMBRE",
        nombre_alterno         : detalle.article_alias           || null,
        codigo_barras          : detalle.article_barcode          || null,
        codigo_marca           : detalle.article_brand_code       || null,
        codigo_categoria       : detalle.article_category_code    || null,
        codigo_familia         : detalle.article_family_code      || null,
        codigo_unidad_medida   : detalle.unit_code                || null,
        codigo_tipo_inventario : detalle.article_inv_type_code    || null,
        costo                  : toNumber(detalle.cost),
        estado                 : 1,
        tipo_producto          : toNumber(detalle.article_type),
        origen_sistema         : "MOBILVENDOR",

      },
      { transaction }
    );
  }

  // --- Detalle del documento ---
  // Ya se hizo destroy antes del loop, siempre es INSERT puro — no hay conflicto posible
  await DetalleDocumento.create(
    {
      documento_code       : documentCode,
      codigo_producto      : detalle.article_code        || "SIN-CODIGO",
      descripcion          : detalle.article_description || "",
      cantidad             : toNumber(detalle.quantity),
      precio               : toNumber(detalle.price),
      descuento_linea      : toNumber(detalle.discount),
      subtotal             : toNumber(detalle.subtotal),
      total                : toNumber(detalle.total),
      iva                  : toNumber(detalle.iva),
      unit_alias           : detalle.unit_alias                    || null,
      barcode              : detalle.barcode                       || null,
      codigo_categoria     : detalle.article_category_code         || null,
      descripcion_categoria: detalle.article_category_description  || null,
      // Promoción aplicada en la línea (puede venir null si no hubo promo)
      promo_code           : detalle.promo_code        || null,
      promo_action_code    : detalle.promo_action_code || null,
    },
    { transaction }
  );
}

// ================================================================
// LÍNEAS DE VENTA CON PROMOCIÓN (tabla aislada de Odoo)
// ================================================================
// Escribe promo_lineas_venta con las líneas del documento que llevan promo.
// SOLO la escribe MobilVendor; Odoo nunca la toca → las promos de las facturas
// (cuyo número fiscal comparten con Odoo) no se pierden. Desnormaliza vendedor,
// fecha y tipo para que el reporte no dependa de facturas/ordenes (que Odoo
// reescribe). Reemplazo completo por documento (destroy + insert) idempotente.
async function syncPromoLineasVenta(doc, code, tipoDoc, dedupDetails) {
  const conPromo = dedupDetails.filter(
    (d) => d.promo_code && String(d.promo_code).trim() !== ""
  );

  const tipo =
    tipoDoc === "factura" ? "FACTURA" : tipoDoc === "orden" ? "ORDEN" : "—";
  const sellerCode = String(doc.seller_code || doc.user_code || "").trim() || null;
  const fecha = parseUnixToEcuador(doc.create_date || doc.store_date);

  // Transacción PROPIA (independiente de la del documento). El destroy siempre
  // corre para limpiar promos viejas del doc aunque ahora ya no tenga; el insert
  // solo si hay líneas con promo.
  const t = await sequelize.transaction();
  try {
    await PromoLineaVenta.destroy({ where: { documento_code: code }, transaction: t });

    if (conPromo.length) {
      await PromoLineaVenta.bulkCreate(
        conPromo.map((d) => ({
          documento_code   : code,
          tipo,
          seller_code      : sellerCode,
          fecha,
          codigo_producto  : d.article_code || "SIN-CODIGO",
          descripcion      : d.article_description || "",
          unidad           : (d.unit_alias && String(d.unit_alias).trim()) || "UNI",
          cantidad         : toNumber(d.quantity),
          precio           : toNumber(d.price),
          descuento_linea  : toNumber(d.discount),
          subtotal         : toNumber(d.subtotal),
          total            : toNumber(d.total),
          iva              : toNumber(d.iva),
          promo_code       : String(d.promo_code).trim(),
          promo_action_code:
            (d.promo_action_code && String(d.promo_action_code).trim()) || null,
        })),
        { transaction: t }
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ================================================================
// PROCESADOR DE UN DOCUMENTO COMPLETO
// ================================================================
async function procesarDocumento(doc, detallesPorDocumento, stats) {
  const rawCode = doc.code;
  const code    = normalizeCode(rawCode);

  if (!code) {
    console.warn(`⚠️  Cabecera ignorada por código inválido: ${rawCode}`);
    return;
  }

  const customerCode = doc.customer_code || null;

  console.log(`\n🔄 Documento ${code} | tipo=${doc.type} | cliente=${customerCode}`);

  const t = await sequelize.transaction();

  // Declarados fuera del try para reutilizarlos en la escritura (aislada) de
  // promo_lineas_venta, que corre DESPUÉS del commit del documento.
  let tipoDoc = null;
  let dedupDetails = [];

  try {
    await syncTipoNegocio(doc, t);
    await syncSubcanal(doc, t); //  AQUÍ

    await syncCliente(doc, customerCode, t);
    await syncDireccionCliente(doc, customerCode, t);

    tipoDoc = await syncDocumento(doc, code, t);
    if (tipoDoc === "factura") stats.facturas++;
    else if (tipoDoc === "orden") stats.ordenes++;

    await syncClienteUsuario(doc, code, customerCode, t);

    // Destroy + create dentro de la misma transacción — rollback seguro
    await DetalleDocumento.destroy({ where: { documento_code: code }, transaction: t });

    const rawDetails = detallesPorDocumento.get(code) || [];
    dedupDetails = deduplicateDetails(rawDetails);

    // Orden consistente por codigo_producto ascendente (string, sin locale)
    // antes de upsertear productos — ver comentario de conReintentoDeadlock
    // arriba. El lado Odoo (upsertProductosBatch en sincronizacionOdooService.js)
    // ordena su bulkCreate con el MISMO criterio para que ambos tomen los
    // locks de `productos` siempre en el mismo orden.
    const detallesParaUpsert = [...dedupDetails].sort((a, b) => {
      const ca = String(a.article_code || "");
      const cb = String(b.article_code || "");
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });

    for (const detalle of detallesParaUpsert) {
      await syncDetalle(detalle, code, t);
    }

    await t.commit();
    console.log(`   ✅ ${code} confirmado (${dedupDetails.length} detalles)`);

  } catch (err) {
    await t.rollback();
    throw err;
  }

  // Tabla aislada de promos (Odoo no la toca). FUERA de la transacción del
  // documento y con su propio try/catch: si algo falla aquí, NUNCA afecta el
  // guardado de la factura/orden ni su detalle → otros dashboards intactos.
  try {
    await syncPromoLineasVenta(doc, code, tipoDoc, dedupDetails);
  } catch (errPromo) {
    console.error(`⚠️  promo_lineas_venta ${code}: ${errPromo.message}`);
  }
}

// ================================================================
// SERVICIO PRINCIPAL
// ================================================================
const sincronizarVentasRango = async (startDate, endDate, syncState = null) => {
  console.log("\n====================================");
  console.log(`🚀 SINCRONIZACIÓN ${startDate} → ${endDate}`);
  console.log("====================================\n");

  const progress = new SyncProgress(syncState, 0, 0, "mvFrac"); // MobilVendor: aporta a FASE 1 (0→75% combinado con Odoo)
  const stats    = new SyncStats();
  const erroresPorDocumento = [];

  progress.start(startDate, endDate);

  let syncRow;
  try {
    syncRow = await SincronizacionVenta.create({
      desde_date     : startDate,
      hasta_date     : endDate,
      estado         : "EN_PROCESO",
      total_registros: 0,
      mensaje        : null,
    });
  } catch (err) {
    console.error("❌ Error creando registro de sincronización:", err.message);
    progress.finish(err.message);
    throw err;
  }

  const idSync = syncRow.id_sync;
  console.log(`📝 Sync ID: ${idSync}`);

  try {
    let session_id = await obtenerSesionActual();
    if (!session_id) throw new Error("No hay sesión activa con MobilVendor.");
    console.log(`🔐 Sesión MobilVendor OK: ${session_id}`);

    let totalPages  = 1;
    let currentPage = 1;
    // MobilVendor responde 200 OK con headers:[] ante una sesión cacheada
    // que quedó inválida server-side — NO es un error que el axios/try-catch
    // detecte, y puede pasar en CUALQUIER página, no solo la primera (la
    // sesión puede morir a mitad de la paginación, no solo antes de
    // empezar — confirmado con datos reales: días con totalPages=15-17
    // donde solo llegaban 1-2 páginas reales antes de cortar en silencio).
    // Toda página vacía dentro de [currentPage <= totalPages] es sospechosa
    // — el propio bucle garantiza que, al entrar, currentPage siempre está
    // dentro del rango que la API ya dijo que tenía datos (o es la
    // página 1, con el valor por defecto) — así que se fuerza un re-login y
    // se reintenta la MISMA página una vez antes de aceptarla como el fin
    // real de la paginación. El reintento es por-página (no una sola vez
    // por corrida completa): si la sesión vuelve a morir más adelante en el
    // mismo rango, se reintenta de nuevo ahí también.
    let reintentoPaginaActual = false;

    while (currentPage <= totalPages) {
      console.log(`\n📦 PÁGINA ${currentPage} / ${totalPages}`);
      progress.updatePage(currentPage, totalPages);

      const { data } = await axios.post(
        API_URL,
        {
          session_id,
          action: "getInvoices",
          filter: {
            process_status: "0,1,2,3,4,5",
            type          : "1,2",
            status        : "0,1,2,5,10",
            start_date    : startDate,
            end_date      : endDate,
            limit         : API_PAGE_LIMIT,
            page          : currentPage,
          },
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 120_000,
        }
      );

      const headers = data.invoices || data.headers || [];
      const details = data.details  || [];
      const totalPagesRespuesta = data.pages || totalPages;

      if (headers.length === 0 && !reintentoPaginaActual) {
        reintentoPaginaActual = true;
        const avisoSesion = `Página ${currentPage}/${totalPages} sin cabeceras — posible sesión de MobilVendor inválida (falso 200 OK vacío). Forzando re-login y reintentando la misma página.`;
        console.warn(`⚠️  ${avisoSesion}`);
        // Registro DURABLE (no solo log de consola, que rota) — para que un
        // hueco de sesión, resuelto o no, siempre quede auditable en
        // errores_sync.txt y en el Err:N persistido, nunca en silencio.
        erroresPorDocumento.push({ code: `SESION_SOSPECHOSA_${startDate}_${endDate}_pag${currentPage}`, error: { message: avisoSesion } });
        stats.errores++;
        session_id = await forzarSesionNueva();
        if (!session_id) throw new Error("No se pudo obtener sesión nueva de MobilVendor tras el reintento.");
        continue; // reintenta la MISMA página con sesión nueva, sin avanzar
      }

      reintentoPaginaActual = false; // esta página ya se resolvió — habilita reintento para la próxima si hiciera falta
      totalPages = totalPagesRespuesta;

      console.log(`   → Cabeceras: ${headers.length} | Detalles: ${details.length} | Páginas: ${totalPages}`);

      if (!headers.length) {
        console.log("🏁 Sin más cabeceras (confirmado tras reintento) — finalizando paginación.");
        break;
      }

      stats.headers += headers.length;
      stats.details += details.length;

      const detallesPorDocumento = new Map();

      for (const d of details) {
        const rawCode = d.invoice_code || d.document_code || d.code;
        const docCode = normalizeCode(rawCode);

        if (!docCode) {
          console.warn(`⚠️  Detalle ignorado, código inválido: ${rawCode}`);
          continue;
        }

        if (!detallesPorDocumento.has(docCode)) detallesPorDocumento.set(docCode, []);
        detallesPorDocumento.get(docCode).push(d);
      }

      for (const doc of headers) {
        const code = normalizeCode(doc.code);

        try {
          await conReintentoDeadlock(() => procesarDocumento(doc, detallesPorDocumento, stats));
        } catch (errDoc) {
          stats.errores++;
          const errorEntry = {
            code : code ?? doc.code,
            error: {
              message: errDoc.message,
              stack  : errDoc.stack,
              details: errDoc.errors || errDoc.parent || null,
            },
          };
          erroresPorDocumento.push(errorEntry);
          // Detalle legible: si es ValidationError de Sequelize, mostrar campo(s)
          // que fallan (ej. "value too long for column..."), no solo "Validation error".
          const detalleErr = Array.isArray(errDoc.errors) && errDoc.errors.length
            ? errDoc.errors.map(e => `${e.path}=${JSON.stringify(e.value)} (${e.message})`).join("; ")
            : (errDoc.parent?.message || errDoc.original?.message || "");
          console.error(`❌ ERROR documento ${code}: ${errDoc.message}${detalleErr ? " → " + detalleErr : ""}`);
        }
      }

      currentPage++;
    }

    flushErrorLog(erroresPorDocumento);

    await SincronizacionVenta.update(
      {
        estado         : "SUCCESS",
        total_registros: stats.headers,
        mensaje        : (stats.toMessage() || "").substring(0, 100),
      },
      { where: { id_sync: idSync } }
    );

    stats.print();
    progress.finish();

    return { idSync, stats, erroresPorDocumento };

  } catch (err) {
    console.error("\n❌ ERROR GLOBAL DE SINCRONIZACIÓN:");
    console.error("Mensaje:", err.message);
    console.error("Stack:",   err.stack);

    await SincronizacionVenta.update(
      { estado: "FAILED", mensaje: (err.message || "").substring(0, 100) },
      { where: { id_sync: idSync } }
    ).catch(() => {});

    progress.finish(err.message);
    throw err;
  }
};

// ================================================================
// SINCRONIZACIÓN DE PROMOCIONES (promos + condiciones + acciones + usuarios)
// ================================================================
/**
 * Descarga por completo un schema de MobilVendor (action "get", paginado)
 * y devuelve todos sus registros acumulados.
 */
async function fetchSchemaCompleto(session_id, schema) {
  const all = [];
  let page       = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const { data } = await axios.post(
      API_URL,
      { session_id, action: "get", schema, page },
      { headers: { "Content-Type": "application/json" }, timeout: 120_000 }
    );

    const records = data.records || [];
    totalPages    = data.pages   || totalPages;

    if (!records.length) break;
    all.push(...records);
    page++;
  }

  console.log(`   → ${schema}: ${all.length} registro(s)`);
  return all;
}

/**
 * Sincroniza el módulo de promociones de MobilVendor:
 *   promos → promo_conditions → promo_actions → users_in_promos
 *
 * Estrategia (snapshot transaccional):
 *   1. upsert de cada promo (preserva la PK code).
 *   2. condiciones y acciones se refrescan por completo (DELETE + insert),
 *      solo para promos existentes (respeta la FK).
 *   3. users_in_promos se upserta por (promo_code, user_code) → idempotente.
 *
 * Toda la carga corre dentro de UNA transacción: si algo falla, rollback total.
 */
const sincronizarPromociones = async (syncState = null) => {
  console.log("\n====================================");
  console.log("🚀 SINCRONIZACIÓN DE PROMOCIONES");
  console.log("====================================\n");

  const progress = new SyncProgress(syncState);
  progress.start("promociones", "completo");

  try {
    const session_id = await obtenerSesionActual();
    if (!session_id) throw new Error("No hay sesión activa con MobilVendor.");
    console.log(`🔐 Sesión MobilVendor OK: ${session_id}`);

    // ── 1. Descargar los 4 schemas ────────────────────────────────
    console.log("📦 Descargando schemas de promociones...");
    const [promos, condiciones, acciones, usuarios] = await Promise.all([
      fetchSchemaCompleto(session_id, "promos"),
      fetchSchemaCompleto(session_id, "promo_conditions"),
      fetchSchemaCompleto(session_id, "promo_actions"),
      fetchSchemaCompleto(session_id, "users_in_promos"),
    ]);

    if (!promos.length) {
      console.log("🏁 MobilVendor no devolvió promociones — nada que sincronizar.");
      progress.finish();
      return { promos: 0, condiciones: 0, acciones: 0, usuarios: 0 };
    }

    const t = await sequelize.transaction();

    try {
      // ── 2. Maestro de promos (upsert) ──────────────────────────
      const codigosValidos = new Set();

      for (const p of promos) {
        const code = p.code != null ? String(p.code).trim() : null;
        if (!code) continue;
        codigosValidos.add(code);

        await Promo.upsert(
          {
            code,
            description        : p.description    || null,
            type               : p.type           || null,
            status             : p.status          || null,
            start_date         : parseFlexibleDate(p.start_date),
            end_date           : parseFlexibleDate(p.end_date),
            priority           : toNumOrNull(p.priority),
            cyclical           : toBit(p.cyclical),
            min_sale           : toNumOrNull(p.min_sale),
            max_sale           : toNumOrNull(p.max_sale),
            payment_method     : p.payment_method || null,
            business_types     : toJsonList(p.business_types),
            customers          : toJsonList(p.customers),
            payload            : p,
            fecha_actualizacion: new Date(),
          },
          { transaction: t, conflictFields: ["code"] }
        );
      }

      // ── 3. Condiciones (refresco total) ────────────────────────
      await PromoCondicion.destroy({ where: {}, transaction: t });
      const filasCondiciones = condiciones
        .filter((c) => codigosValidos.has(String(c.promo_code || "").trim()))
        .map((c) => ({
          promo_code        : String(c.promo_code).trim(),
          condition         : c.condition          || null,
          amount_condition  : c.amount_condition   || null,
          amount1           : toNumOrNull(c.amount1),
          amount2           : toNumOrNull(c.amount2),
          quantity_condition: c.quantity_condition || null,
          quantity1         : toNumOrNull(c.quantity1),
          quantity2         : toNumOrNull(c.quantity2),
          object            : c.object             || null,
          code              : c.code               || null,
          list              : c.list               || null,
          unit_code         : c.unit_code          || null,
          payload           : c,
        }));
      if (filasCondiciones.length) {
        await PromoCondicion.bulkCreate(filasCondiciones, { transaction: t });
      }

      // ── 4. Acciones (refresco total) ───────────────────────────
      await PromoAccion.destroy({ where: {}, transaction: t });
      const filasAcciones = acciones
        .filter((a) => codigosValidos.has(String(a.promo_code || "").trim()))
        .map((a) => ({
          promo_code   : String(a.promo_code).trim(),
          action       : a.action        || null,
          discount     : toNumOrNull(a.discount),
          discount_type: a.discount_type || null,
          price_value  : toNumOrNull(a.price_value),
          gift         : a.gift      != null ? String(a.gift)      : null,
          gift_base    : a.gift_base != null ? String(a.gift_base) : null,
          stepped      : toBit(a.stepped),
          articles     : toJsonList(a.articles),
          brands       : toJsonList(a.brands),
          categories   : toJsonList(a.categories),
          families     : toJsonList(a.families),
          payload      : a,
        }));
      if (filasAcciones.length) {
        await PromoAccion.bulkCreate(filasAcciones, { transaction: t });
      }

      // ── 5. Asignación por vendedor (upsert idempotente) ────────
      let upsertsUsuarios = 0;
      for (const u of usuarios) {
        const promoCode = String(u.promo_code || "").trim();
        const userCode  = String(u.user_code  || "").trim();
        if (!promoCode || !userCode || !codigosValidos.has(promoCode)) continue;

        await UsuarioEnPromo.upsert(
          {
            promo_code           : promoCode,
            user_code            : userCode,
            status               : u.status || null,
            inventory            : toNumOrNull(u.inventory),
            inventory_amount     : toNumOrNull(u.inventory_amount),
            inventory_used       : toNumOrNull(u.inventory_used),
            inventory_amount_used: toNumOrNull(u.inventory_amount_used),
            payload              : u,
            fecha_actualizacion  : new Date(),
          },
          { transaction: t, conflictFields: ["promo_code", "user_code"] }
        );
        upsertsUsuarios++;
      }

      await t.commit();

      const resumen = {
        promos     : codigosValidos.size,
        condiciones: filasCondiciones.length,
        acciones   : filasAcciones.length,
        usuarios   : upsertsUsuarios,
      };

      console.log("\n====================================");
      console.log("✅ SINCRONIZACIÓN DE PROMOCIONES COMPLETA");
      console.log(`   → Promos      : ${resumen.promos}`);
      console.log(`   → Condiciones : ${resumen.condiciones}`);
      console.log(`   → Acciones    : ${resumen.acciones}`);
      console.log(`   → Asignaciones: ${resumen.usuarios}`);
      console.log("====================================\n");

      progress.finish();
      return resumen;

    } catch (err) {
      await t.rollback();
      throw err;
    }

  } catch (err) {
    console.error("\n❌ ERROR SINCRONIZACIÓN PROMOCIONES:", err.message);
    progress.finish(err.message);
    throw err;
  }
};

// ================================================================
// EXPORTS
// ================================================================
module.exports = { sincronizarVentasRango, sincronizarDirecciones, sincronizarPromociones };