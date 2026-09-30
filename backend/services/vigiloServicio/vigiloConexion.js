// services/vigiloServicio/vigiloConexion.js
// Cliente REST de Vigilo/SeamTrack (https://b2b.vigiloo.net/api) — tracking
// GPS de flota, cuenta cia@aqua.com.ec. Investigado en vivo antes de
// construir nada (ver TODO.md):
//
// - Autenticación: NO hay Basic Auth ni token separado — el `accountId`
//   (GUID) como query param en cada request YA es la credencial completa.
//   Confirmado con `GET /api/Check?accountId=...` -> 200 `true` sin ningún
//   header de auth.
// - Rate limit real, confirmado con la propia API: 1 llamada cada 15
//   segundos, GLOBAL (no por endpoint) — mensaje explícito "Quota exceeded.
//   Limit maximum 1 call every 15 seconds" (HTTP 429). Por eso este cliente
//   serializa TODAS las llamadas por una cola interna con throttle, nunca
//   paralelo — con ~34 vehículos una corrida de sync completa toma ~9
//   minutos, inviable para una tool MCP bajo demanda (de ahí el diseño de
//   sync programado en vez de consulta en vivo, como facturasProveedores).
// - Sin paginación documentada en los endpoints de lista — devuelven el
//   set completo ("LISTA COMPLETA" en la doc de Vigilo).
require("dotenv").config();
const axios = require("axios");

const VIGILO_BASE_URL = "https://b2b.vigiloo.net/api";
const { VIGILO_ACCOUNT_ID } = process.env;

// Margen sobre los 15s documentados — evita pisar el límite por variación
// de latencia de red entre el reloj de Vigilo y el nuestro.
const RATE_LIMIT_MS = 15500;

let colaLlamadas = Promise.resolve();

function encolar(fn) {
  const resultado = colaLlamadas.then(fn, fn);
  colaLlamadas = resultado
    .catch(() => {}) // no romper la cola si esta llamada específica falla
    .then(() => new Promise((r) => setTimeout(r, RATE_LIMIT_MS)));
  return resultado;
}

async function llamar(path, params) {
  if (!VIGILO_ACCOUNT_ID) {
    throw new Error("VIGILO_ACCOUNT_ID no está configurado en backend/.env — no se puede llamar a Vigilo.");
  }
  return encolar(async () => {
    const { data } = await axios.get(`${VIGILO_BASE_URL}/${path}`, {
      params: { accountId: VIGILO_ACCOUNT_ID, ...params },
      timeout: 30000,
    });
    return data;
  });
}

// GET /api/Check?accountId={} — valida que el accountId es válido. Devuelve
// literalmente `true`/`false` (no un objeto), confirmado en vivo.
async function check() {
  return llamar("Check", {});
}

// GET /api/TrackONLINE?accountId={} — snapshot en vivo de TODA la flota
// (posición actual + actividad reciente). Se usa SOLO para refrescar el
// roster de vehículos (tag/targetId/grupo/placa) en cada sync — nunca para
// leer paradas históricas, eso es TargetRouteQry.
async function trackOnline() {
  return llamar("TrackONLINE", {});
}

// GET /api/TargetRouteQry?accountId&targetId&fromDate&toDate&includePositions&includeActivities
// Historial real de un vehículo en un rango de fechas — CON includeActivities=true
// ya devuelve los tramos "Ruta"/"Parada" calculados por Vigilo (OnRouteTime/
// OnStopTime por tramo), no hace falta reconstruirlos a mano desde
// posiciones crudas (confirmado en vivo, descartada la alternativa de
// TargetStatusRouteActivityBreaks — esa es solo snapshot en vivo, sin
// parámetro de fecha en absoluto, no sirve para histórico).
async function targetRouteQry(targetId, fromDate, toDate) {
  return llamar("TargetRouteQry", {
    targetId,
    fromDate,
    toDate,
    includePositions: false,
    includeActivities: true,
  });
}

module.exports = { check, trackOnline, targetRouteQry };
