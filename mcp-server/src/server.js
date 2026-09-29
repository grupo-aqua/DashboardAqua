// src/server.js
// Servidor MCP remoto de solo lectura sobre ventas (MobilVendor + Odoo, ya
// sincronizadas en Postgres). El transporte de las tools sigue el patrón de
// sesión del ejemplo oficial del SDK
// (@modelcontextprotocol/sdk/dist/cjs/examples/server/simpleStreamableHttp.js).
// La autorización (paso 2) usa el router OAuth oficial del SDK
// (server/auth/router.js) + un OAuthServerProvider propio (./auth/provider.js)
// que delega el login real a Google y valida el dominio (hd).
require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");

const { provider } = require("./auth/provider");
const googleCallbackRoute = require("./auth/googleCallbackRoute");

const { ventasPorRuta, inputSchema: schemaVentasPorRuta } = require("./tools/ventasPorRuta");
const { ventasPorGrupo, inputSchema: schemaVentasPorGrupo } = require("./tools/ventasPorGrupo");
const { resumenDiario, inputSchema: schemaResumenDiario } = require("./tools/resumenDiario");
const { topProductos, inputSchema: schemaTopProductos } = require("./tools/topProductos");
const { clientesInactivos, inputSchema: schemaClientesInactivos } = require("./tools/clientesInactivos");
const { proyeccionMensual, inputSchema: schemaProyeccionMensual } = require("./tools/proyeccionMensual");
const { ventasCliente, inputSchema: schemaVentasCliente } = require("./tools/ventasCliente");
const { clientesPorGrupo, inputSchema: schemaClientesPorGrupo } = require("./tools/clientesPorGrupo");
const { clientesSinConsumo, inputSchema: schemaClientesSinConsumo } = require("./tools/clientesSinConsumo");
const { clientesSinVisita, inputSchema: schemaClientesSinVisita } = require("./tools/clientesSinVisita");
const { clientesVisitadosSinVenta, inputSchema: schemaClientesVisitadosSinVenta } = require("./tools/clientesVisitadosSinVenta");
const { ventasPorCondicionPago, inputSchema: schemaVentasPorCondicionPago } = require("./tools/ventasPorCondicionPago");
const { backlogPrevendedores, inputSchema: schemaBacklogPrevendedores } = require("./tools/backlogPrevendedores");
const { ventasRutaOk, inputSchema: schemaVentasRutaOk } = require("./tools/ventasRutaOk");
const { facturasProveedores, inputSchema: schemaFacturasProveedores } = require("./tools/facturasProveedores");

function resultadoTexto(objeto) {
  return { content: [{ type: "text", text: JSON.stringify(objeto, null, 2) }] };
}

function crearServer() {
  const server = new McpServer({ name: "aqua-ventas-mcp", version: "0.1.0" });

  server.registerTool(
    "ventasPorRuta",
    {
      description:
        "Ventas totales (unidades y dólares) de una ruta/vendedor (o un subconjunto de rutas, pasando un array) en un rango de fechas, desglosado por categoría de producto y, si se pidió más de una ruta, por ruta.",
      inputSchema: schemaVentasPorRuta,
    },
    async (args) => resultadoTexto(await ventasPorRuta(args))
  );

  server.registerTool(
    "ventasPorGrupo",
    {
      description:
        "Ventas totales de un grupo de canal (MAYORISTA, TIENDAS, TIENDAS_VIP, RURAL, DOMICILIO, EMPRESAS, VIP, QUITO, PREVENTA) en un rango de fechas, con categoría de producto opcional (BOTELLÓN, DESCARTABLE, HIELO, CAFÉ, PLUS, SUSCRIPCION, PT-DISTRINTER, PT-COTTSA, PT-IIBC, SERVICIOS, GASTOS GENERALES), desglosado por ruta, con comparación vs. el periodo anterior de igual duración. Para PREVENTA, si no se especifica categoría se usa DESCARTABLE por default (coincide con el ranking oficial del dashboard); se puede pedir otra categoría (ej. BOTELLÓN) para ver qué más venden esas rutas fuera del ranking oficial.",
      inputSchema: schemaVentasPorGrupo,
    },
    async (args) => resultadoTexto(await ventasPorGrupo(args))
  );

  server.registerTool(
    "resumenDiario",
    {
      description:
        "Resumen de ventas de un día específico: total, desglose por grupo, top rutas, y una bandera posible_hueco_sync que avisa si el conteo de documentos del día es anormalmente bajo vs. el mismo día de la semana en semanas anteriores (posible problema de sincronización, no necesariamente una caída real de ventas).",
      inputSchema: schemaResumenDiario,
    },
    async (args) => resultadoTexto(await resumenDiario(args))
  );

  server.registerTool(
    "topProductos",
    {
      description:
        "Ranking de productos más vendidos (por dólares) en un rango de fechas. Grupo y categoría opcionales para acotar (mismos valores que ventasPorGrupo) — ej. productos de PREVENTA en categoría DESCARTABLE. Para PREVENTA, si no se especifica categoría se usa DESCARTABLE por default.",
      inputSchema: schemaTopProductos,
    },
    async (args) => resultadoTexto(await topProductos(args))
  );

  server.registerTool(
    "clientesInactivos",
    {
      description:
        "Clientes de una ruta que compraron en el pasado reciente pero no en los últimos 15 días (ventanas de comparación fijas, no decididas por el modelo). NO usar para rutas de PREVENTA (PV*/PVR*/TELEVENTA*/PREVENTA VIP*) — no aplica el filtro validado de esas rutas y da un resultado que parece válido pero no lo es (confirmado: 0 coincidencias contra clientesPorGrupo para las mismas rutas). Para PREVENTA, usar clientesPorGrupo con por_mes:true y comparar los meses que corresponda.",
      inputSchema: schemaClientesInactivos,
    },
    async (args) => resultadoTexto(await clientesInactivos(args))
  );

  server.registerTool(
    "proyeccionMensual",
    {
      description:
        "Proyección de venta mensual (run-rate) con la misma fórmula y días hábiles que ya usa el dashboard (excluye domingos y feriados nacionales). Por defecto proyecta el mes en curso, la empresa completa; acepta año/mes, grupo y categoría opcionales para acotar. Un mes ya cerrado devuelve el real sin proyectar.",
      inputSchema: schemaProyeccionMensual,
    },
    async (args) => resultadoTexto(await proyeccionMensual(args))
  );

  server.registerTool(
    "ventasCliente",
    {
      description:
        "Historial de ventas de un cliente específico buscado por nombre parcial (no hace falta el nombre exacto; tolera tildes/mayúsculas). Si hay más de una coincidencia de cliente o de producto, devuelve la lista de candidatos para elegir, no asume ninguno. Si el nombre no matchea ningún cliente (typo o palabra faltante), devuelve sugerencias por similitud ('¿quisiste decir...?', nunca elegidas automáticamente). Caso especial: si el nombre resuelve a la MISMA entidad facturada desde varias compañías del grupo (mismo RUC/nombre, distinto codigo_cliente), devuelve es_multicompania=true con la lista de compañías — para pedir el consolidado o una compañía puntual, repetir la llamada con el parámetro codigo_cliente (uno o varios códigos de esa lista), sin necesidad de volver a pasar nombre_cliente; la respuesta con más de un codigo_cliente siempre incluye por_compania junto al total. Con el cliente resuelto, devuelve el total y el desglose por mes/dirección de entrega en el rango de fechas; acepta categoría de producto y/o nombre parcial de producto (también con desambiguación) como filtros combinables — ej. 'cuánto le vendió DESCARTABLE al Colegio Javier' o 'cuánto compró tal producto tal cliente'. IMPORTANTE: el total/por_mes/por_direccion/por_compania siempre netean las notas de crédito contra las ventas (correcto, es el neto real) — para ver las notas de crédito como movimientos propios en vez de un número neteado, usar solo_notas_credito=true: devuelve cada nota (fecha, código, dirección, monto CRUDO positivo, comentario si existe) más total_notas_credito, reutilizando la misma resolución de cliente/multicompañía; categoria/producto se ignoran en este modo (una nota de crédito es un documento completo, no se filtra por línea de producto).",
      inputSchema: schemaVentasCliente,
    },
    async (args) => resultadoTexto(await ventasCliente(args))
  );

  server.registerTool(
    "clientesPorGrupo",
    {
      description:
        "Listado de CLIENTES (no rutas) que compraron dentro de un grupo de canal y, opcionalmente, una categoría de producto, en un rango de fechas — para preguntas tipo 'dame los clientes de MAYORISTA que compraron BOTELLÓN estos 3 meses'. Devuelve cada cliente con su total (unidades, dólares, documentos) en el rango, ordenado de mayor a menor. Con por_mes=true, cada cliente además trae su propio desglose mes a mes — útil para comparar entre meses, ej. 'clientes que compraron en julio pero no en agosto': pedir el rango jul-ago con por_mes=true y filtrar los clientes cuyo mes de julio tenga dólares>0 y no tengan una entrada de agosto (o la tengan en 0). limite acota cuántos clientes se devuelven (default 300, tope 1000), siempre ordenados por dólares descendente — total_clientes indica cuántos hubo en total aunque se haya recortado la lista.",
      inputSchema: schemaClientesPorGrupo,
    },
    async (args) => resultadoTexto(await clientesPorGrupo(args))
  );

  server.registerTool(
    "clientesSinConsumo",
    {
      description:
        "Universo COMPLETO de clientes de un grupo de canal (no solo quienes compraron), incluido PREVENTA, que NO compraron una categoría de producto puntual en un rango de fechas — para reportes recurrentes tipo 'clientes de EMPRESAS sin compra de BOTELLÓN esta semana'. Cada cliente devuelto trae ultima_compra y dias_desde_ultima (calculados por fecha calendario, no por timestamp — no varían por la hora del día) y una clasificacion: CONSUMO_CERO (compró esa categoría antes, no en el rango pedido), NUNCA_COMPRO_<categoria> (tiene facturación formal pero nunca compró esa categoría), o SIN_FACTURACION_FORMAL (aparece en el grupo pero no tiene ningún documento posteado — un caso raro, hay que revisarlo aparte, no tratarlo como cliente inactivo normal; para PREVENTA esta clasificación nunca aparece, el universo de PREVENTA ya exige un despacho real). IMPORTANTE: el universo no tiene límite de tiempo (un cliente cuenta como del grupo aunque su única evidencia sea de hace más de un año) — un cliente puede salir 'sin consumo' de este grupo mientras en realidad es comprador activo de esa misma categoría en OTRA ruta (caso real confirmado: cliente con 1 factura TIENDAS_VIP de hace 532 días, comprando BOTELLÓN cada pocos días bajo TIENDAS normal). Por eso cada cliente trae venta_reciente_otra_ruta (null si no aplica, o {ruta, fecha} si su compra más reciente de esa categoría fue en otra ruta más reciente que en la pedida) — no cambia la clasificación, es una señal para no tratarlo como cliente inactivo real; con_venta_reciente_otra_ruta en la respuesta cuenta cuántos del listado están en ese caso. No implementado para PREVENTA todavía. Los clientes duplicados en el maestro (mismo RUC+compañía+nombre exacto bajo 2 códigos) se consolidan automáticamente en una sola fila (código combinado 'codigoA+codigoB'), quedándose con la fecha de última compra más reciente. limite acota cuántos clientes se devuelven (default 300, tope 1000), siempre ordenados con los más atrasados primero — sin_consumo_total indica cuántos hubo en total aunque se haya recortado la lista.",
      inputSchema: schemaClientesSinConsumo,
    },
    async (args) => resultadoTexto(await clientesSinConsumo(args))
  );

  server.registerTool(
    "clientesSinVisita",
    {
      description:
        "Universo COMPLETO de clientes de un grupo de canal (incluido PREVENTA) sin una visita reciente registrada — para reportes en vivo tipo '¿qué clientes de esta ruta no se han visitado?'. IMPORTANTE: la fuente (fecha_ultima_visita_direccion_cliente) es un PUNTERO a la visita más reciente conocida a HOY, no un historial de visitas — sirve para preguntar '¿quién no tiene visita reciente, ahora mismo?', pero NO para reconstruir retroactivamente si un cliente fue visitado en una semana pasada ya superada por visitas más nuevas; si se pide un fecha_fin que no es reciente, la respuesta trae un campo advertencia explicándolo. Un cliente con varias direcciones/sucursales cuenta como visitado si CUALQUIERA de sus direcciones tiene visita reciente (se toma la más reciente entre todas). Los duplicados de maestro (mismo RUC+compañía+nombre exacto bajo 2 códigos) se consolidan automáticamente igual que en clientesSinConsumo. Cada cliente sin visita trae clasificacion: SIN_VISITA_NUNCA (nunca se registró una visita — típico de clientes servidos solo por Odoo, sin ruta física, ej. cuentas corporativas grandes de EMPRESAS) o SIN_VISITA_RECIENTE (tuvo visita antes de fecha_inicio, no desde entonces). ruta (opcional, una ruta o array — mismo patrón que ventasPorRuta) acota a rutas específicas; la ruta de cada cliente se deriva de su documento más reciente real, no de ningún campo 'asignado' del maestro (investigado: esos campos van desactualizados hasta 34-54% de las veces). agrupar_por ('ruta' o 'vendedor', son el MISMO dato — no existe nombre de persona por vendedor en los datos, solo código) cambia la respuesta de lista de clientes a un resumen por ruta: total_clientes, visitados, sin_visitar, pct_cobertura, ordenado con la peor cobertura primero. limite acota cuántos clientes o rutas se devuelven (default 300, tope 1000).",
      inputSchema: schemaClientesSinVisita,
    },
    async (args) => resultadoTexto(await clientesSinVisita(args))
  );

  server.registerTool(
    "clientesVisitadosSinVenta",
    {
      description:
        "Clientes con VISITA CONFIRMADA (check-in explícito visit_start/visit_end en historial_visitas) que no tuvieron venta de una categoría en ese mismo rango — el cruce más fuerte de 'visita sin venta': no es una inferencia, el check-in existe. ⚠️ ES UNA MUESTRA, NO EL UNIVERSO COMPLETO — historial_visitas tiene adopción muy baja (la mayoría de vendedores no usa el botón de check-in), así que un resultado chico o vacío NO significa que casi nadie fue visitado sin vender, significa que pocos registraron el check-in en ese período; el campo cobertura.clientes_con_checkin_confirmado_en_rango muestra el tamaño real de la muestra. Para el universo completo de cobertura de visitas usar clientesSinVisita en su lugar. El corte de datos de historial_visitas se mueve (no es una fecha fija) — esta tool lo consulta en vivo en cada llamada; si el rango pedido queda parcial o totalmente después del último dato disponible, la respuesta trae advertencia_cobertura_temporal explicándolo en vez de devolver una lista vacía sin avisar. Cada cliente trae clasificacion igual que clientesSinConsumo (CONSUMO_CERO / NUNCA_COMPRO_<categoria> / SIN_FACTURACION_FORMAL) más la fecha de la visita confirmada, y venta_reciente_otra_ruta (null, o {ruta, fecha} si su compra más reciente de esa categoría fue en OTRA ruta más reciente que la pedida — caso real confirmado, no cambia la clasificación pero avisa que el cliente sigue activo, solo que en otra ruta; con_venta_reciente_otra_ruta cuenta cuántos del listado están así). limite acota cuántos clientes se devuelven (default 300, tope 1000).",
      inputSchema: schemaClientesVisitadosSinVenta,
    },
    async (args) => resultadoTexto(await clientesVisitadosSinVenta(args))
  );

  server.registerTool(
    "ventasPorCondicionPago",
    {
      description:
        "Ventas de un grupo de canal (mismos grupos que ventasPorGrupo, incluido PREVENTA) desglosadas por condición de pago real del documento/cliente: CONTADO o CREDITO — NUNCA usa origen_sistema como proxy (esa correlación 'contado=MobilVendor/crédito=Odoo' solo aplicaba a cómo factura EMPRESAS, no es una regla general: hay clientes VIP e HIELO en MobilVendor que sí son de crédito). Enfoque híbrido: en `facturas` (documentos out_invoice) la condición sale de una señal TRANSACCIONAL propia del documento (fecha_vencimiento vs fecha_creacion — 0-1 día=CONTADO, más días=CREDITO, validado contra datos reales); en `ordenes` (incluida PREVENTA, que nunca genera factura propia) se usa como fallback la condición actual del cliente (metodo_pago_cliente) porque no existe una señal transaccional equivalente ahí; las notas de crédito (out_refund, exclusivas de Odoo) TAMBIÉN usan ese mismo fallback de cliente porque su propia fecha_vencimiento no es confiable (verificado con datos reales), pero se etiquetan aparte (NOTA_CREDITO) para no confundirse con órdenes reales — un canal facturado por `facturas` (ej. VIP) puede así mostrar un renglón CREDITO/NOTA_CREDITO con dólares negativos, que es correcto contablemente (resta venta), no un error. Cada fila de por_condicion_y_fuente trae fuente_condicion ('TRANSACCIONAL', 'METODO_PAGO_CLIENTE' o 'NOTA_CREDITO') para poder rastrear de dónde sale cada dato sin rehacer la investigación. categoría de producto opcional (mismos valores que ventasPorGrupo); para PREVENTA si no se especifica se usa DESCARTABLE por default, igual que ventasPorGrupo.",
      inputSchema: schemaVentasPorCondicionPago,
    },
    async (args) => resultadoTexto(await ventasPorCondicionPago(args))
  );

  server.registerTool(
    "backlogPrevendedores",
    {
      description:
        "Backlog de un prevendedor o ruta D (D1...D20, identificados por su seller_code de ordenes, ej. T5/T6/TV2 — mismo parámetro `ruta` array-capable que ventasPorRuta/clientesSinVisita): cuántas órdenes creó en un rango de fechas, cuántas siguen pendientes (status=2) y cuántas ya avanzaron (cualquier otro status). IMPORTANTE — investigado a fondo antes de construir: NO existe ningún vínculo confiable en los datos entre una orden puntual y la factura que la cubre (se probaron todos los campos de referencia posibles y coincidencia cliente+fecha+producto, ninguno funciona — ver TODO.md). Por eso el criterio de 'pendiente vs avanzada' es el status de la propia orden (2=pendiente, 3/4/5/10=avanzada), NO una confirmación de facturación real. cruce_factura_cliente es una señal adicional exploratoria (si el cliente tiene alguna factura, de cualquier canal, dentro de ventana_dias_factura_cliente días después de la orden) — es una corroboración a nivel CLIENTE, no una confirmación de que ESA orden específica se facturó. advertencia_status_desactualizado avisa cuando el rango incluye órdenes de hace más de ~14 días: el cron solo re-sincroniza los últimos 10 días, así que el status de órdenes más viejas puede estar desactualizado (pendientes ahí puede estar sobreestimado).",
      inputSchema: schemaBacklogPrevendedores,
    },
    async (args) => resultadoTexto(await backlogPrevendedores(args))
  );

  server.registerTool(
    "ventasRutaOk",
    {
      description:
        "Ventas combinadas de las rutas 'OK' (113, 131, 132 — 132 incluye 'RUTA 132' y 'RUTA 132.1' de COTTSA) en un rango de fechas: total_combinado + desglose por_cliente (identificado por RUC, consolidando ambas fuentes) + por_fuente (COTTSA facturado vs. aqua-premium-ne no facturado). FASE ACTUAL (instrucción explícita de Alberto, no cambiar sin confirmar con él): son los totales CRUDOS de cada sistema, sin ningún intento de deduplicar entre las dos fuentes — existe un riesgo de doble conteo detectado y documentado en TODO.md (COTTSA ya factura bajo estos mismos seller_code) que Alberto va a verificar manualmente antes de pedir una fase de limpieza. aqua-premium-ne (la fuente no facturada) se consulta EN VIVO a un Odoo externo en cada llamada — si no responde, la tool falla explícitamente en vez de mostrar $0. IMPORTANTE: aqua-premium-ne no tiene ninguna venta registrada para estas 3 rutas después del 2026-06-09 (confirmado, no es un bug) — la respuesta trae advertencia_aqua_premium_ne cuando el rango pedido cae después de esa fecha, para no leer un $0 de esa fuente como 'no hubo ventas OK'. ruta acepta un código ('113'/'131'/'132') o un array de varios; por defecto (sin especificar) trae las 3 combinadas con desglose por_ruta.",
      inputSchema: schemaVentasRutaOk,
    },
    async (args) => resultadoTexto(await ventasRutaOk(args))
  );

  server.registerTool(
    "facturasProveedores",
    {
      description:
        "Facturas y notas de crédito DE PROVEEDOR (compras, no ventas) en las 5 compañías del grupo — GRUPOAQUA, AQUASUPPLY, COTTSA, IIBC, DISTRINTER, todas en la misma instancia Odoo corporativa multi-compañía. `compania` acepta un alias o un array (default: las 5). `tipo_documento` ('FACTURA'/'NOTA_CREDITO') opcional para acotar; sin especificar trae ambos. Devuelve `documentos` crudos (compañía, proveedor+RUC, número de documento, referencia, tipo, fecha_factura, fecha_vencimiento, moneda, monto_total, monto_pagado, saldo_pendiente, estado, estado_pago, journal) limitados por `limite` (default 300, tope 1000, ordenados por fecha descendente) — más `total_general`, `por_compania`, `por_compania_y_mes` y `por_journal` (agregados en Odoo, no limitados por `limite`) y `por_proveedor` (top N según `top_n_proveedores`, default 20). IMPORTANTE: esta tool NO decide qué es 'gasto' ni filtra por devengado/pagado — expone estado y estado_pago crudos para que ese criterio se aplique después de leer el resultado. Único filtro fijo: se excluyen documentos state='cancel' (no son transacciones reales, Odoo mismo los excluye de sus propios reportes) — 'draft' y 'posted' SÍ se incluyen ambos, visibles vía `estado`. Consulta EN VIVO a Odoo en cada llamada (sin sincronización propia) — si Odoo no responde, falla explícito en vez de mostrar $0.",
      inputSchema: schemaFacturasProveedores,
    },
    async (args) => resultadoTexto(await facturasProveedores(args))
  );

  return server;
}

const app = express();
app.use(express.json());

const issuerUrl = new URL(process.env.MCP_ISSUER_URL);
const resourceServerUrl = new URL("/mcp", issuerUrl);

// Instala /authorize, /token, /register, /revoke y los .well-known de
// metadata OAuth — todo generado por el SDK a partir de nuestro provider.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: ["ventas:read"],
  })
);

// El paso intermedio del navegador (vuelta de Google) no es parte del
// protocolo OAuth que ve Claude — es interno entre nuestro /authorize y
// nuestro propio código de autorización.
app.use(googleCallbackRoute);

const exigirBearerToken = requireBearerAuth({
  verifier: provider,
  requiredScopes: ["ventas:read"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
});

// sessionId -> transport ya conectado a un McpServer.
const transports = {};

async function mcpPostHandler(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  try {
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) delete transports[sid];
      };

      const server = crearServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else if (sessionId) {
      // Incidente 2026-09-22 (ver TODO.md): `sessionId` viene en el header
      // pero no está en `transports` — pasa en cada redeploy de mcp_server
      // (el registro vive SOLO en memoria del proceso, se pierde entero en
      // cada restart; confirmado que no es serializable — WebStandardStreamableHTTPServerTransport
      // guarda streams HTTP vivos, no datos). El SDK documenta EXPLÍCITAMENTE
      // este caso como 404 + código JSON-RPC -32001 "Session not found"
      // (ver node_modules/@modelcontextprotocol/sdk .../server/webStandardStreamableHttp.js,
      // comentario de la clase) — antes acá se devolvía 400/-32000 genérico,
      // copiado tal cual del ejemplo oficial del SDK (que no sigue la
      // convención documentada por su propia clase interna). Algunos
      // clientes se recuperan solos con cualquier código de error (heurística
      // ciega, ya funcionaba); otros (reportado con Cowork/claude.ai) solo
      // reinicializan si ven la señal EXACTA que el spec define — por eso
      // hacía falta este código específico, no solo "cualquier 4xx".
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    } else {
      // Sin sessionId Y no es un initialize válido — genuinamente un
      // request malformado, no el caso de sesión perdida de arriba. Mismo
      // código que siempre (sin cambios).
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error manejando request MCP:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

async function mcpGetHandler(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

async function mcpDeleteHandler(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.post("/mcp", exigirBearerToken, mcpPostHandler);
app.get("/mcp", exigirBearerToken, mcpGetHandler);
app.delete("/mcp", exigirBearerToken, mcpDeleteHandler);

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log(`aqua-mcp-server escuchando en :${PORT} (OAuth con Google, dominio=${process.env.ALLOWED_HD})`);
});
