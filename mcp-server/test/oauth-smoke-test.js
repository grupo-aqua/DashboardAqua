// test/oauth-smoke-test.js
// Prueba de punta a punta del flujo OAuth (paso 2), en 3 partes:
//
//  A) Rechazo de cuentas fuera de dominio: llama la función REAL de
//     decisión (validarPayloadGoogle) con payloads sintéticos. No se puede
//     forjar la firma de un id_token real de Google sin credenciales reales
//     de Google Cloud (que este entorno no tiene) — pero la regla de rechazo
//     en sí es la misma que corre en producción, así que probarla
//     directamente con payloads controlados es una prueba fiel, no un mock
//     de lógica aparte.
//
//  B) El resto del ciclo OAuth (registro dinámico de cliente, /authorize
//     redirigiendo a Google con PKCE, /token, expiración del access token,
//     refresh + rotación) se prueba de punta a punta por HTTP real contra
//     el servidor real. El único paso que no se puede reproducir sin una
//     cuenta de Google real es la llamada de red a Google; para llegar al
//     punto exacto donde el callback ya validó el login+dominio, se llama
//     directamente memoria.emitirCodigo(...) — la MISMA función que
//     src/auth/googleCallbackRoute.js invoca tras un login válido. Todo lo
//     que pasa después (PKCE, /token, expiración, refresh, /mcp) es 100%
//     el código real, sin mocks.
require("dotenv").config();
process.env.PORT = "8799";
process.env.MCP_ISSUER_URL = "http://localhost:8799";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { validarPayloadGoogle, AccesoDenegadoError } = require("../src/auth/google");
const memoria = require("../src/auth/memoria");

const BASE = process.env.MCP_ISSUER_URL;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

async function main() {
  console.log("=== Parte A: rechazo explícito de cuentas fuera de dominio ===");

  const casosRechazo = [
    { payload: { email: "intruso@gmail.com", email_verified: true, hd: "gmail.com" }, motivo: "cuenta @gmail.com normal (hd distinto)" },
    { payload: { email: "empleado@empresa-competidora.com", email_verified: true, hd: "empresa-competidora.com" }, motivo: "Workspace de OTRA empresa" },
    { payload: { email: "sin-verificar@aqua.com.ec", email_verified: false, hd: "aqua.com.ec" }, motivo: "dominio correcto pero email_verified=false" },
    { payload: { email: "sin-hd@aqua.com.ec", email_verified: true, hd: undefined }, motivo: "cuenta personal sin claim hd" },
  ];
  for (const caso of casosRechazo) {
    let rechazado = false;
    try {
      validarPayloadGoogle(caso.payload);
    } catch (err) {
      rechazado = err instanceof AccesoDenegadoError;
    }
    asegurar(rechazado, `rechazada: ${caso.motivo}`);
  }

  const aceptado = validarPayloadGoogle({ email: "gerente@aqua.com.ec", email_verified: true, hd: "aqua.com.ec" });
  asegurar(aceptado.email === "gerente@aqua.com.ec", "cuenta @aqua.com.ec con hd correcto SÍ se acepta");

  console.log("\n=== Levantando el servidor real (paso 2 completo) ===");
  require("../src/server");
  await esperar(800);

  console.log("\n=== Parte B: ciclo OAuth completo por HTTP real ===");

  const registerRes = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:9999/callback"],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "smoke-test-client",
    }),
  });
  const client = await registerRes.json();
  asegurar(registerRes.status === 201 && client.client_id && client.client_secret, "POST /register devolvió client_id + client_secret");

  const { verifier, challenge } = pkcePair();
  const authorizeUrl = new URL(`${BASE}/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", client.redirect_uris[0]);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "estado-original-de-claude");

  const authRes = await fetch(authorizeUrl, { redirect: "manual" });
  const location = authRes.headers.get("location");
  asegurar(!!location && location.startsWith("https://accounts.google.com"), "GET /authorize redirige a accounts.google.com");
  const googleUrl = new URL(location);
  asegurar((googleUrl.searchParams.get("scope") || "").includes("email"), "el redirect a Google pide scope email/openid");
  const pendienteId = googleUrl.searchParams.get("state");

  // Punto exacto donde retomamos: "Google ya aprobó, el dominio ya se
  // validó" — mismo código que dispara googleCallbackRoute.js tras un login real.
  const pendiente = memoria.tomarPendiente(pendienteId);
  asegurar(!!pendiente && pendiente.codeChallenge === challenge, "el pendiente guardado por /authorize conserva el codeChallenge del cliente original");
  const nuestroCode = memoria.emitirCodigo({
    clientId: pendiente.clientId,
    codeChallenge: pendiente.codeChallenge,
    email: "gerente@aqua.com.ec",
  });

  const tokenRes = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: nuestroCode,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: client.redirect_uris[0],
    }),
  });
  const tokens = await tokenRes.json();
  asegurar(tokenRes.ok && !!tokens.access_token && !!tokens.refresh_token, "POST /token (authorization_code + PKCE) emitió access_token y refresh_token");
  asegurar(tokens.expires_in <= 3600, `access_token con expiración corta (expires_in=${tokens.expires_in}s)`);

  const mcpRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "1.0" } },
    }),
  });
  asegurar(mcpRes.status < 400, `POST /mcp con access_token válido -> status ${mcpRes.status}`);

  console.log("\n=== Parte C: expiración del access token ===");
  const tokenExpirado = jwt.sign(
    { clientId: client.client_id, email: "gerente@aqua.com.ec", scope: "ventas:read" },
    process.env.MCP_JWT_SECRET,
    { expiresIn: -10, issuer: "aqua-mcp-server" }
  );
  const mcpExpRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokenExpirado}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  asegurar(mcpExpRes.status === 401, `un access_token ya expirado es rechazado con 401 (status recibido: ${mcpExpRes.status})`);

  const mcpSinToken = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  asegurar(mcpSinToken.status === 401, "una request a /mcp sin Authorization también se rechaza con 401");

  console.log("\n=== Parte D: refresh token con rotación ===");
  const refreshRes = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }),
  });
  const refrescado = await refreshRes.json();
  asegurar(refreshRes.ok && !!refrescado.access_token, "grant_type=refresh_token emite un access_token nuevo");
  asegurar(refrescado.access_token !== tokens.access_token, "el access_token nuevo es distinto del original");
  asegurar(refrescado.refresh_token !== tokens.refresh_token, "el refresh_token ROTÓ (no se reutiliza el mismo)");

  const reusoRes = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token, // el viejo, ya rotado
      client_id: client.client_id,
      client_secret: client.client_secret,
    }),
  });
  asegurar(!reusoRes.ok, `reusar el refresh_token viejo (ya rotado) falla -> status ${reusoRes.status}`);

  const nuevoAccessFunciona = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${refrescado.access_token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test-2", version: "1.0" } },
    }),
  });
  asegurar(nuevoAccessFunciona.status < 400, `el access_token emitido por el refresh funciona contra /mcp (status ${nuevoAccessFunciona.status})`);

  console.log("\n=== Parte E: protocolo MCP completo (Client oficial del SDK) con el token vigente ===");
  const mcpClient = new Client({ name: "oauth-smoke-test-client", version: "0.1.0" });
  const mcpTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${refrescado.access_token}` } },
  });
  await mcpClient.connect(mcpTransport);
  const { tools } = await mcpClient.listTools();
  asegurar(tools.length === 15, `listTools() con Bearer token devuelve las 15 tools (llegaron ${tools.length})`);
  const resultadoTool = await mcpClient.callTool({
    name: "resumenDiario",
    arguments: { fecha: new Date(Date.now() - 86400000).toISOString().slice(0, 10) },
  });
  asegurar(!!resultadoTool.content?.[0]?.text, "callTool(resumenDiario) autenticado devuelve datos");

  console.log("\nOAUTH SMOKE TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nOAUTH SMOKE TEST FALLÓ:", err);
  process.exit(1);
});
