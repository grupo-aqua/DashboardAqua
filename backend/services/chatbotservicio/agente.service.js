// services/chatbotservicio/agente.service.js
// ════════════════════════════════════════════════════════════════════════════
// AGENTE IA PREMIUM — Grupo Aqua ERP
// Motor agéntico con Claude (tool-use). A diferencia del texto→SQL "a ciegas",
// este agente:
//   1) Conoce el GLOSARIO de negocio (canales, descartable, preventa, etc.)
//   2) Puede EJECUTAR SQL de exploración (SELECT DISTINCT...) para descubrir los
//      valores reales antes de responder, en lugar de adivinar.
//   3) Se AUTOCORRIGE: si una consulta sale vacía, vuelve a intentar/explorar.
//   4) PREGUNTA al usuario cuando la petición es ambigua (conversacional).
//   5) Genera reportes PDF/Excel a partir del último resultado.
// ════════════════════════════════════════════════════════════════════════════

const { anthropic, CLAUDE_MODEL } = require("./claude.client");
const { ejecutarSQL } = require("./query.service");
const { validarSQL, aplicarLimite } = require("../../utils/sqlValidator");
const { construirConfigReporte, generarPDF, generarExcel } = require("./reporte.service");

require("dotenv").config();

// Máximo de iteraciones del bucle agéntico (cada una = 1 llamada a Claude)
const MAX_PASOS = 12;
// Máximo de filas que se devuelven al modelo por consulta (para no saturar el contexto)
const MAX_FILAS_CONTEXTO = 60;

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT: esquema + glosario de negocio + reglas
// ─────────────────────────────────────────────────────────────────────────────
function construirSystem(rol, sellerCode) {
  const fechaHoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });

  const filtroVendedor =
    rol === "VENDEDOR" && sellerCode
      ? `\n## RESTRICCIÓN DE ROL (OBLIGATORIA)
Eres un usuario VENDEDOR con seller_code = '${sellerCode}'. TODAS tus consultas DEBEN filtrar por ese vendedor:
- facturas:           AND f.seller_code = '${sellerCode}'
- ordenes:            AND o.seller_code = '${sellerCode}'
- historial_visitas:  AND hv.codigo_usuario = '${sellerCode}'
Nunca muestres datos de otros vendedores.`
      : `\n## ROL: ADMIN — acceso a todos los datos, sin restricción de vendedor.`;

  return `Eres el ANALISTA DE NEGOCIOS IA de Grupo Aqua (agua, botellón, hielo, descartable). Eres profesional, preciso y conversacional. Tu trabajo es responder preguntas comerciales consultando la base de datos PostgreSQL en tiempo real mediante la herramienta ejecutar_sql.

FECHA DE HOY: ${fechaHoy} (zona America/Guayaquil). "hoy"=CURRENT_DATE, "este mes"=DATE_TRUNC('month', CURRENT_DATE).
${filtroVendedor}

## CÓMO TRABAJAS (MUY IMPORTANTE)
1. NUNCA inventes cifras ni nombres. Todo dato viene de ejecutar_sql sobre la base real.
2. Tienes acceso a TODA la base de datos. Si no conoces una tabla o columna, descúbrela con explorar_esquema (lista tablas; con 'tabla' lista columnas). No te limites al esquema resumido: explora lo que necesites.
3. Si NO estás seguro de qué significa un término del usuario o qué valores existen, PRIMERO EXPLORA (explorar_esquema y/o SELECT DISTINCT). Luego responde con certeza.
4. Si una consulta devuelve 0 filas, NO concluyas de inmediato "no hay datos": revisa supuestos, explora valores reales y reintenta. Solo afirma que no hay datos si tras explorar lo confirmas.
5. VERIFICA antes de afirmar: si un número parece raro o el usuario lo cuestiona, vuelve a consultar y contrasta. Es mejor tardar un paso más que dar un dato incorrecto.
6. Si la petición es AMBIGUA o falta un dato clave (cliente, período, canal, producto), PREGUNTA al usuario de forma breve y clara en vez de adivinar. Termina tu turno con la pregunta. Es preferible preguntar a equivocarse.
7. NO mezcles temas de mensajes anteriores salvo que el usuario claramente continúe el mismo tema.
8. Responde SIEMPRE en español, tono conversacional y profesional, formato hispano para números (1.250,50). No muestres SQL ni nombres técnicos de columnas en la respuesta final, salvo que el usuario lo pida.
9. Para tablas/listados usa formato claro (lista o tabla markdown). Para un único valor, una frase directa. Ofrece un siguiente paso útil cuando aplique.

## GLOSARIO DE NEGOCIO (CRÍTICO — así define Grupo Aqua sus canales)
Los CANALES de venta se identifican por el prefijo del route_code o seller_code:
- DOMICILIO  → facturas/ordenes con route_code ILIKE 'A%'  (rutas A1, A2, A3, A4.1, A5, A6, A7...)
- EMPRESAS   → seller_code ILIKE 'E%'
- MAYORISTA  → seller_code ILIKE 'M%'
- QUITO      → seller_code = 'U1'
- RUTA_COMBINADA → seller_code IN ('RUTA 113','RUTA 131','RUTA 132','RUTA 132.1') — rutas "OK", canal propio, DISTINTO de RURAL aunque el código empiece con 'R' de "RUTA". Para el detalle completo (incluye una segunda fuente externa, aqua-premium-ne) usar la tool ventasRutaOk, no este canal genérico.
- RURAL      → seller_code ILIKE 'R%' Y NO empieza con 'RUTA ' (si no, se cuentan sin querer las 4 rutas de RUTA_COMBINADA — corregido 2026-09-29, antes ese error inflaba RURAL ~10x)
- TIENDAS    → seller_code ILIKE 'T%' AND seller_code NOT ILIKE 'TV%'
- TIENDAS_VIP→ seller_code ILIKE 'TV%'
- VIP        → seller_code ILIKE 'V%'  (en contexto botellón también codigo_tipo_negocio = '29')
- PREVENTA   → tabla ordenes: o.type = 2 AND o.status = 5 AND (o.seller_code ILIKE 'PV%' OR ILIKE 'TELEVENTA%') AND o.seller_code NOT ILIKE 'PVR%'; usar o.fecha_entrega para el período.
"Rutas de domicilio" = las rutas A. Para listarlas: SELECT DISTINCT route_code FROM facturas WHERE route_code ILIKE 'A%' ORDER BY 1.

PROMOCIONES (CRÍTICO — "promos vendidas por prendedor"):
- Lo que un prendedor/vendedor VENDIÓ en promoción sale de las LÍNEAS DE VENTA, no de la definición. En detalle_documento (d) cada línea trae d.promo_code y d.promo_action_code (NULL si la línea no tuvo promo) y d.descuento_linea (monto descontado). El vendedor y la fecha vienen de la cabecera: facturas (f.seller_code, f.fecha_creacion) para d.documento_code=f.code, u ordenes (o.seller_code, o.fecha_creacion) para d.documento_code=o.code. Usa COALESCE(f.seller_code,o.seller_code) y COALESCE(f.fecha_creacion,o.fecha_creacion) con un LEFT JOIN a ambas.
- "promo más vendida/usada" → agrupa por d.promo_code donde d.promo_code IS NOT NULL; métricas: COUNT(DISTINCT d.documento_code) AS veces, SUM(d.cantidad) AS unidades, SUM(d.total) AS monto, SUM(d.descuento_linea) AS descuento. Ordena por veces o unidades.
- "qué promo vendió el prendedor X" → lo mismo + filtro COALESCE(f.seller_code,o.seller_code) = 'X'.
- El NOMBRE legible de la promo está en el maestro promos (p): p.code = d.promo_code → p.description. Tablas de definición/reglas: promos (p), promo_conditions (pc), promo_actions (pa), todas ligadas por promo_code. NO uses users_in_promos (el web-service no la expone; está vacía).

PRODUCTOS / CATEGORÍAS:
- DESCARTABLE / "no retornable" = NO es un nombre de producto; es la CATEGORÍA dd.codigo_categoria = '7'. NUNCA buscar descripcion ILIKE '%DESCARTABLE%'.
- BOTELLÓN: productos de botellón; buscar UPPER(d.descripcion) LIKE '%BOTELL%'. Agua/galón: '%GALON%'.
- HIELO (CRÍTICO): NO uses descripcion LIKE '%HIELO%' ni SUM(f.total) (eso sobrecuenta). El hielo se mide por VENDEDOR y categoría: facturas con (f.seller_code ILIKE 'H%' OR f.seller_code IN ('10','h3')) AND f.status='2' AND dd.descripcion_categoria='HIELO', sumando dd.total y dd.cantidad (las del seller '10' se RESTAN). Eso es solo la parte MobilVendor; el total "empresa" además suma órdenes Odoo (campania_id=5 DISTRINTER y campania_id=1 GA, status 2, categoría hielo). Para el TOTAL de hielo del mes confía en el dato que ya entrega el sistema; aquí úsalo para desgloses (por vendedor, por cliente) con el filtro de arriba.

## TOTALES Y AGREGACIONES
- "total de ventas" / "cuánto vendió" / "monto" → SIEMPRE COALESCE(SUM(f.total), 0)  (f.total = total con IVA; NUNCA f.subtotal, NUNCA SUM(d.total) como total de factura).
- unidades → COALESCE(SUM(d.cantidad), 0). Saldo → SUM(f.saldo_pendiente).
- NO filtres por f.status salvo que el usuario lo pida ("activas", "confirmadas"); filtrar excluye facturas válidas.

## ESQUEMA (tablas y columnas principales; usa los alias indicados)
facturas (f): code, type, status, fecha_creacion, fecha_vencimiento, customer_code, customer_address_code, route_code, seller_code, total, subtotal, iva, discount, estado_pago('not_paid'|'partial'|'paid'), saldo_pendiente, moneda
ordenes (o): code, type, status, fecha_creacion, fecha_entrega, customer_code, route_code, seller_code, total, subtotal, iva, margen, margen_porcentaje
detalle_documento (d): documento_code, codigo_producto, descripcion, producto_nombre, producto_categoria, cantidad, total, subtotal, precio, descuento_linea, codigo_categoria, descripcion_categoria, promo_code, promo_action_code
promos (p): code, description, type, status, start_date, end_date, priority, min_sale, max_sale, payment_method · promo_conditions (pc): promo_code, condition, object, list, quantity_condition, quantity1, quantity2, amount1, amount2 · promo_actions (pa): promo_code, action, discount, discount_type, price_value, gift, gift_base, articles
clientes (c): codigo_cliente, nombre_cliente, nombre_comercial_cliente, codigo_tipo_negocio, saldo_cliente, tiene_credito_cliente, estado_cliente(int), vendedor_asignado_cliente, ciudad_cliente, telefono_cliente, latitud_cliente, longitud_cliente
rutas (r): codigo, descripcion, tipo(int), estado(int)
productos (p): codigo_producto, nombre_producto, codigo_categoria
historial_visitas (hv): fecha_visita, codigo_usuario, codigo_ruta, codigo_cliente, accion, comentario, monto, nombre_cliente, nombre_usuario
metas_preventas (mp): codigo_ruta, anio, mes, meta_unidades, meta_dolares
app_users (u): usuario, rol, rutas_asignadas
vw_clientes_analisis (vca): codigo_cliente, nombre_cliente, seller_code, tipo_negocio, total_ventas, total_unidades, ultima_compra, dias_sin_comprar, estado_cliente('ACTIVO'|'RIESGO'|'INACTIVO'|'SIN COMPRAS'), ticket_promedio

JOINS: f.code=d.documento_code · f.customer_code=c.codigo_cliente · o.code=d.documento_code · d.codigo_producto=p.codigo_producto · hv.codigo_cliente=c.codigo_cliente · mp.codigo_ruta=r.codigo
Búsqueda de cliente por nombre: SIEMPRE ILIKE en (c.nombre_cliente OR c.nombre_comercial_cliente). Nunca '='.

## FECHAS (patrón seguro: >= inicio AND < inicio_siguiente; NUNCA BETWEEN con fin de mes manual)
"marzo 2026" → DATE(col) >= '2026-03-01' AND DATE(col) < '2026-04-01"
"este mes"   → DATE(col) >= DATE_TRUNC('month', CURRENT_DATE) AND DATE(col) < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'

## REPORTES
Si el usuario pide un reporte/exportar en PDF o Excel: primero obtén los datos con ejecutar_sql, y luego llama a generar_reporte con el formato y un título descriptivo. No describas toda la tabla en texto si vas a generar el archivo; confirma brevemente.

Trabaja paso a paso: explora si hace falta, ejecuta la consulta correcta, y entrega una respuesta clara y profesional.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Definición de herramientas (tool-use)
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "ejecutar_sql",
    description:
      "Ejecuta una consulta SELECT de solo lectura en PostgreSQL y devuelve las filas. Úsalo para explorar valores (SELECT DISTINCT...) y para responder. Solo SELECT; prohibido INSERT/UPDATE/DELETE/DROP/ALTER.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Consulta SELECT válida para PostgreSQL." },
        motivo: { type: "string", description: "Breve: qué buscas con esta consulta (ej: 'explorar rutas A', 'ventas del cliente X')." },
      },
      required: ["sql"],
    },
  },
  {
    name: "explorar_esquema",
    description:
      "Inspecciona la estructura REAL de la base de datos. Sin parámetro: lista todas las tablas. Con 'tabla': lista las columnas y tipos de esa tabla. Úsalo cuando no estés seguro de qué tabla/columna usar, antes de escribir el SQL.",
    input_schema: {
      type: "object",
      properties: {
        tabla: { type: "string", description: "Nombre exacto de la tabla a inspeccionar. Omitir para listar todas las tablas." },
      },
    },
  },
  {
    name: "generar_reporte",
    description:
      "Genera un archivo descargable (PDF o Excel) a partir del resultado de la ÚLTIMA consulta ejecutada con ejecutar_sql. Llámalo solo cuando el usuario pida un reporte/exportación.",
    input_schema: {
      type: "object",
      properties: {
        formato: { type: "string", enum: ["pdf", "excel"], description: "Formato del archivo." },
        titulo: { type: "string", description: "Título descriptivo del reporte (ej: 'Comparativo Rutas A — Marzo vs Abril 2026')." },
      },
      required: ["formato", "titulo"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Ejecutor del agente
//   pregunta:  texto del usuario
//   opts:      { rol, sellerCode, historial }  (historial = [{role, content}])
//   return:    { texto, archivo|null, datos|null }
// ─────────────────────────────────────────────────────────────────────────────
async function responderAgente(pregunta, { rol, sellerCode, historial = [] } = {}) {
  const system = construirSystem(rol, sellerCode);

  // Sanea historial al formato Claude (user/assistant, empieza por user)
  const histLimpio = (historial || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content != null)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  while (histLimpio.length > 0 && histLimpio[0].role === "assistant") histLimpio.shift();

  const messages = [...histLimpio, { role: "user", content: pregunta }];

  let ultimosDatos = null; // datos de la última consulta (para reportes)
  let archivo = null;      // info del archivo generado, si aplica

  for (let paso = 0; paso < MAX_PASOS; paso++) {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      thinking: { type: "adaptive" },      // razona en profundidad cuando hace falta
      output_config: { effort: "medium" }, // equilibrio velocidad/calidad (más ágil que "high")
      system,
      tools: TOOLS,
      messages,
    });

    // Guardar el turno del asistente (incluye bloques tool_use)
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      const texto = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return { texto: texto || "No pude generar una respuesta.", archivo, datos: ultimosDatos };
    }

    // Ejecutar todas las herramientas solicitadas en este turno
    const toolResults = [];
    for (const bloque of resp.content) {
      if (bloque.type !== "tool_use") continue;

      if (bloque.name === "ejecutar_sql") {
        const r = await ejecutarHerramientaSQL(bloque.input);
        if (r.ok) ultimosDatos = r.datos;
        toolResults.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: r.contenido,
          ...(r.ok ? {} : { is_error: true }),
        });
      } else if (bloque.name === "explorar_esquema") {
        const r = await ejecutarHerramientaEsquema(bloque.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: r.contenido,
        });
      } else if (bloque.name === "generar_reporte") {
        const r = await ejecutarHerramientaReporte(bloque.input, ultimosDatos);
        if (r.archivo) archivo = r.archivo;
        toolResults.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: r.contenido,
          ...(r.archivo ? {} : { is_error: true }),
        });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: `Herramienta desconocida: ${bloque.name}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Si se agotaron los pasos sin respuesta final
  return {
    texto: "La consulta resultó demasiado compleja. ¿Puedes reformularla o acotar el período/cliente?",
    archivo,
    datos: ultimosDatos,
  };
}

// ── Herramienta: ejecutar_sql ───────────────────────────────────────────────
async function ejecutarHerramientaSQL({ sql }) {
  try {
    if (!sql || typeof sql !== "string") {
      return { ok: false, contenido: "Error: no se recibió SQL." };
    }
    if (!validarSQL(sql)) {
      return { ok: false, contenido: "Error: la consulta no es un SELECT válido o contiene operaciones prohibidas." };
    }
    const sqlLimitado = aplicarLimite(sql, 1000);
    const datos = await ejecutarSQL(sqlLimitado);

    if (!datos || datos.length === 0) {
      return { ok: true, datos: [], contenido: "La consulta se ejecutó correctamente pero devolvió 0 filas." };
    }

    const recorte = datos.slice(0, MAX_FILAS_CONTEXTO);
    const nota =
      datos.length > MAX_FILAS_CONTEXTO
        ? `\n(Se muestran ${MAX_FILAS_CONTEXTO} de ${datos.length} filas. El reporte, si lo generas, incluirá todas.)`
        : "";
    return {
      ok: true,
      datos, // guardamos TODAS para el reporte
      contenido: `Filas: ${datos.length}\n${JSON.stringify(recorte)}${nota}`,
    };
  } catch (err) {
    const msg = err?.parent?.message || err?.message || "error desconocido";
    // Devolver el error al modelo para que se autocorrija
    return { ok: false, contenido: `Error ejecutando la consulta: ${msg}. Revisa nombres de columnas/tablas y reintenta.` };
  }
}

// ── Herramienta: explorar_esquema (introspección de la BD) ───────────────────
async function ejecutarHerramientaEsquema({ tabla } = {}) {
  try {
    if (tabla) {
      const t = String(tabla).replace(/[^a-zA-Z0-9_]/g, "");
      const cols = await ejecutarSQL(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='${t}' ORDER BY ordinal_position`
      );
      if (!cols.length) {
        return { contenido: `La tabla "${t}" no existe (o no tiene columnas). Usa explorar_esquema sin parámetro para ver las tablas disponibles.` };
      }
      return { contenido: `Columnas de ${t}:\n` + cols.map((c) => `- ${c.column_name} (${c.data_type})`).join("\n") };
    }
    const tbls = await ejecutarSQL(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    );
    return { contenido: `Tablas en la base de datos:\n` + tbls.map((r) => r.table_name).join(", ") };
  } catch (err) {
    return { contenido: `Error explorando el esquema: ${err.message}` };
  }
}

// ── Herramienta: generar_reporte ─────────────────────────────────────────────
async function ejecutarHerramientaReporte({ formato, titulo }, ultimosDatos) {
  try {
    if (!ultimosDatos || ultimosDatos.length === 0) {
      return { contenido: "No hay datos de una consulta previa para exportar. Ejecuta primero ejecutar_sql." };
    }
    const fmt = formato === "excel" ? "excel" : "pdf";
    const config = construirConfigReporte("generico", ultimosDatos, "Sistema");
    if (titulo) config.titulo = titulo;

    const buffer = fmt === "excel" ? await generarExcel(config) : await generarPDF(config);
    const archivo = { buffer, formato: fmt, titulo: config.titulo, totalRegistros: ultimosDatos.length };
    return { archivo, contenido: `Reporte ${fmt.toUpperCase()} "${config.titulo}" generado con ${ultimosDatos.length} registros.` };
  } catch (err) {
    return { contenido: `Error generando el reporte: ${err.message}` };
  }
}

module.exports = { responderAgente };
