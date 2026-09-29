// src/tools/auditoriaClientes.js
// Auditoría de calidad de datos de clientes — FASE 1, SOLO DIAGNÓSTICO.
// Cruza MobilVendor (Postgres, ya sincronizado) y Odoo corporativo
// (grupoaqua.odoo.com, la MISMA instancia de facturasProveedores — ver
// src/integrations/odooContabilidad.js) para señalar 5 problemas de
// calidad de datos. Pedido explícito de Alberto: esta fase NUNCA escribe
// ni corrige nada — solo lista, para revisión humana. Canal automático y
// corrección de coordenadas quedan para una Fase 2 futura, NO construida
// acá.
//
// ============================================================
// Las 4 confirmaciones pedidas antes de construir (investigadas con datos
// reales, no asumidas — ver TODO.md para el detalle completo)
// ============================================================
// 1) Campos de `direcciones_clientes` — 19 columnas (calle1/calle2/bloque/
//    referencia/telefono/fax/email/codigo_postal/lat/lon/fecha_ultima_visita/
//    estado/estado_ubicacion). "Dirección incompleta" = SIN `calle1_direccion_cliente`
//    Y SIN el fallback `clientes.direccion_cliente` (220 casos reales,
//    confirmado) — se eligió `calle1` porque es el campo que TODO el resto
//    del codebase ya usa como dirección real (`COALESCE(dc.calle1_direccion_cliente,
//    c.direccion_cliente)`, patrón repetido en botellonesController/
//    cotsaController/etc.), no un criterio inventado para esta tool.
//    `referencia`/`telefono` faltantes son comunes (17%/27% de las
//    direcciones) — se exponen como `campos_faltantes` informativo por
//    fila, NO como criterio de "incompleta" (dispararían demasiado ruido).
// 2) El cliente/partner SÍ vive en la MISMA instancia Odoo que
//    facturasProveedores (grupoaqua.odoo.com/grupoaqua-16-0-9234323,
//    mismas credenciales ODOO_CONTABILIDAD_*) — confirmado con
//    `common.authenticate` en vivo. PERO: `clientes.id_odoo` (el FK
//    "oficial") está poblado en solo 84 de 20,431 clientes (0.4% —
//    confirmado, nunca se escribe en ningún flujo de sync de este repo,
//    corresponde a un mecanismo aparte de "enviar a Odoo" para un
//    subconjunto chico, ligado a `estado='ENVIADO_ODOO'`, 86 casos). Para
//    cruzar el resto hay que hacerlo por RUC (`identificacion_cliente` ↔
//    `res.partner.vat`), igual que se hizo para aqua-premium-ne — 983
//    partners activos en Odoo (de 12,301 con VAT) no tienen NINGUNA fila
//    en `clientes` por RUC, un hueco de cobertura real que se reporta
//    aparte (no es parte de las 5 categorías pedidas, es contexto).
// 3) "Activo" y "canal" — investigado campo por campo, con datos reales:
//    - `clientes.estado_cliente` (int) NO es un flag de actividad — es el
//      `status` del ÚLTIMO documento (orden/factura) sincronizado para ese
//      cliente, reescrito sin protección en cada sync (`syncCliente` usa
//      `doc.status`, que es el status de la ORDEN/FACTURA, no del
//      cliente). Confirmado con la distribución real: toma los mismos
//      valores (0/1/2/3/4/5) que `ordenes.status` — NO es binario
//      activo/inactivo. Inutilizable para esta auditoría.
//    - `clientes.estado` (varchar) está vacío en 20,345 de 20,431 — el
//      único valor real es "ENVIADO_ODOO" (86 casos, ver arriba). No es
//      un flag de actividad tampoco.
//    - `clientes.estado_proceso_cliente` es constante en 0 para TODOS —
//      campo muerto (mismo patrón que `process_status` ya encontrado en
//      MobilVendor en otras entidades esta sesión).
//    - `res.partner.active` (Odoo, campo NATIVO, no custom) SÍ es un
//      flag real y masivamente usado: de 23,282 partners con
//      `customer_rank>0`, 8,587 (37%) están archivados (`active=False`)
//      — es la única señal de "activo/archivado" confiable a la que
//      tenemos acceso. Se probaron además 3 campos custom de Odoo que
//      sonaban prometedores (`x_studio_tipo_cliente`, `x_studio_activos`,
//      `channel_ids`) — los 3 están casi vacíos (0 / 2,926 / 174 de
//      23,282 poblados) y `x_studio_activos` resultó ser un código de
//      bodega ("RB600"), no un booleano — descartados.
//    - "Canal": SOLO vive de forma confiable en MobilVendor
//      (`clientes.codigo_tipo_negocio`, sourced de `business_type_code`).
//      Confirmado que Odoo NO tiene un equivalente poblado — se revisó
//      `res.partner.category_id`/`channel_ids`/`x_studio_tipo_cliente`,
//      los 3 vacíos o casi vacíos (ver arriba). Por eso "sin canal" en
//      esta tool es un check MobilVendor-only, documentado así en vez de
//      simular un cruce con Odoo que no existe.
// 4) Clave de duplicados: `identificacion_cliente` (RUC/cédula). Formato:
//    mayoría longitud 10 (cédula) o 13 (RUC) — 20,258 de 20,308 valores no
//    vacíos (99.75%), sin problema sistemático de ceros a la izquierda
//    (confirmado por distribución de longitudes). SÍ hay ~49 registros con
//    longitud atípica (1/5/6/7/8/9/11/12/14/15/21) — ruido real, se reporta
//    aparte. CRÍTICO (conecta con el TODO "Auditoría de RUCs duplicados"
//    ya existente): un RUC repetido NO siempre es un duplicado real — se
//    confirmó con datos reales que RUCs como el de TIA o MINI MARKET se
//    repiten 100-466 veces entre SUCURSALES legítimas con nombres
//    DISTINTOS (mismo RUC corporativo, muchos puntos de venta — patrón ya
//    confirmado y explícitamente NO auditado en el TODO existente). Por
//    eso esta tool separa 2 señales, tal como pidió Alberto: señal FUERTE
//    = mismo RUC + mismo `company_id` + nombre EXACTO (el mismo criterio
//    ya validado y usado en `clientesSinConsumo`) — eso sí es sólido, no
//    ambigüedad de negocio. Señal DÉBIL = mismo RUC, nombres DISTINTOS —
//    se excluyen del listado (no del conteo) los grupos con más de
//    `UMBRAL_CADENA_GRANDE` nombres distintos (cadenas grandes conocidas,
//    ruido) y se documenta cuántos se excluyeron.
//
// ============================================================
// Reglas de fase 1 (no negociables, pedido explícito de Alberto)
// ============================================================
// - Sin escritura: esta tool NUNCA hace UPDATE/INSERT/DELETE, ni en
//   Postgres ni en Odoo — solo SELECT/search_read.
// - Duplicados: nunca fusión automática, siempre lista para revisión.
// - Coordenadas: nunca geocodificación, solo señalar.
// - Canal automático y corrección de coordenadas: Fase 2, NO construida.
const { z } = require("zod");
const { pool } = require("../db");
const { executeKw } = require("../integrations/odooContabilidad");

const LIMITE_DEFAULT = 50;
const LIMITE_MAX = 500;
const MUESTRA_RESUMEN = 5;
const UMBRAL_DIAS_INACTIVIDAD_DEFAULT = 365;
const UMBRAL_CADENA_GRANDE = 8; // más de 8 nombres distintos bajo un mismo RUC = cadena conocida, se excluye del listado (no del conteo)

// Bounding box de Ecuador CONTINENTAL (no incluye Galápagos, ~-91 a -89 de
// longitud — el negocio no tiene clientes ahí; si algún día los hubiera,
// esta caja los marcaría "fuera de rango" incorrectamente, documentado a
// propósito en vez de ampliar la caja sin evidencia real de necesidad).
const LAT_MIN = -5.5, LAT_MAX = 2.0;
const LON_MIN = -81.5, LON_MAX = -75.0;

const RUCS_GENERICOS = ["", "9999999999", "9999999999999"];

const CATEGORIAS_VALIDAS = [
  "direcciones_incompletas",
  "coordenadas",
  "duplicados",
  "sin_canal",
  "activos_sin_consumo",
];

const inputSchema = {
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  umbral_dias_inactividad: z.number().int().min(30).max(3650).default(UMBRAL_DIAS_INACTIVIDAD_DEFAULT),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
};

function nombreCliente(row) {
  return (row.nombre_comercial_cliente || row.nombre_cliente || "").replace(/\s+/g, " ").trim() || null;
}

// ============================================================
// 1) Direcciones incompletas
// ============================================================
const SQL_DIRECCIONES_INCOMPLETAS = `
  SELECT dc.codigo_cliente, dc.codigo_direccion_cliente, dc.descripcion_direccion_cliente,
         dc.referencia_direccion_cliente, dc.telefono_direccion_cliente,
         c.nombre_cliente, c.nombre_comercial_cliente
  FROM direcciones_clientes dc
  JOIN clientes c ON c.codigo_cliente = dc.codigo_cliente
  WHERE dc.estado_direccion_cliente = 1
    AND (dc.calle1_direccion_cliente IS NULL OR TRIM(dc.calle1_direccion_cliente) = '')
    AND (c.direccion_cliente IS NULL OR TRIM(c.direccion_cliente) = '')
  ORDER BY dc.codigo_cliente;
`;

async function auditarDireccionesIncompletas(limite) {
  const { rows } = await pool.query(SQL_DIRECCIONES_INCOMPLETAS);
  const items = rows.map((r) => ({
    codigo_cliente: r.codigo_cliente,
    nombre_cliente: nombreCliente(r),
    codigo_direccion: r.codigo_direccion_cliente,
    descripcion_direccion: r.descripcion_direccion_cliente || null,
    campos_faltantes: [
      "calle1",
      ...(!r.referencia_direccion_cliente || !r.referencia_direccion_cliente.trim() ? ["referencia"] : []),
      ...(!r.telefono_direccion_cliente || !r.telefono_direccion_cliente.trim() ? ["telefono"] : []),
    ],
  }));
  return { total: items.length, items: items.slice(0, limite) };
}

// ============================================================
// 2) Coordenadas mal puestas
// ============================================================
const SQL_DIRECCIONES_COORD = `
  SELECT dc.codigo_cliente, dc.codigo_direccion_cliente, dc.latitud_direccion_cliente, dc.longitud_direccion_cliente,
         c.nombre_cliente, c.nombre_comercial_cliente
  FROM direcciones_clientes dc
  JOIN clientes c ON c.codigo_cliente = dc.codigo_cliente
  WHERE dc.estado_direccion_cliente = 1;
`;

function clasificarCoordenada(lat, lon) {
  if (lat === null || lon === null) return "NULA";
  if (Number(lat) === 0 && Number(lon) === 0) return "CERO_CERO";
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) return "FUERA_RANGO_ECUADOR";
  return null;
}

async function auditarCoordenadas(limite) {
  const { rows } = await pool.query(SQL_DIRECCIONES_COORD);

  // Pines por defecto: misma coordenada EXACTA repetida en muchos clientes
  // distintos (excluye null y (0,0), ya cubiertos aparte).
  const porCoordenada = new Map();
  for (const r of rows) {
    const lat = r.latitud_direccion_cliente === null ? null : Number(r.latitud_direccion_cliente);
    const lon = r.longitud_direccion_cliente === null ? null : Number(r.longitud_direccion_cliente);
    if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const key = `${lat},${lon}`;
    if (!porCoordenada.has(key)) porCoordenada.set(key, new Set());
    porCoordenada.get(key).add(r.codigo_cliente);
  }
  const pinesPorDefecto = new Set([...porCoordenada.entries()].filter(([, codigos]) => codigos.size > 5).map(([key]) => key));

  const items = [];
  for (const r of rows) {
    const lat = r.latitud_direccion_cliente === null ? null : Number(r.latitud_direccion_cliente);
    const lon = r.longitud_direccion_cliente === null ? null : Number(r.longitud_direccion_cliente);
    let problema = clasificarCoordenada(lat, lon);
    if (!problema && lat !== null && lon !== null && pinesPorDefecto.has(`${lat},${lon}`)) problema = "PIN_POR_DEFECTO";
    if (!problema) continue;
    items.push({
      codigo_cliente: r.codigo_cliente,
      nombre_cliente: nombreCliente(r),
      codigo_direccion: r.codigo_direccion_cliente,
      problema,
      latitud: lat,
      longitud: lon,
      ...(problema === "PIN_POR_DEFECTO" ? { clientes_con_mismo_pin: porCoordenada.get(`${lat},${lon}`).size } : {}),
    });
  }
  return { total: items.length, items: items.slice(0, limite) };
}

// ============================================================
// 3) Duplicados — señal fuerte (RUC+company+nombre exacto) y débil (RUC compartido, nombre distinto)
// ============================================================
const SQL_DUPLICADOS_FUERTE = `
  SELECT array_agg(codigo_cliente ORDER BY codigo_cliente) AS codigos,
         identificacion_cliente, company_id, nombre_cliente
  FROM clientes
  WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
  GROUP BY identificacion_cliente, company_id, nombre_cliente
  HAVING COUNT(*) > 1
  ORDER BY identificacion_cliente;
`;

const SQL_DUPLICADOS_DEBIL = `
  SELECT TRIM(identificacion_cliente) AS ruc,
         array_agg(DISTINCT codigo_cliente) AS codigos,
         array_agg(DISTINCT nombre_cliente) AS nombres,
         COUNT(DISTINCT nombre_cliente) AS num_nombres_distintos
  FROM clientes
  WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
  GROUP BY TRIM(identificacion_cliente)
  HAVING COUNT(DISTINCT nombre_cliente) > 1
  ORDER BY num_nombres_distintos DESC;
`;

async function auditarDuplicados(limite) {
  const [fuerte, debil] = await Promise.all([pool.query(SQL_DUPLICADOS_FUERTE), pool.query(SQL_DUPLICADOS_DEBIL)]);

  const senalFuerte = fuerte.rows.map((r) => ({
    identificacion: r.identificacion_cliente,
    nombre: r.nombre_cliente,
    company_id: r.company_id,
    codigos: r.codigos,
  }));

  const debilFiltrado = debil.rows.filter((r) => !RUCS_GENERICOS.includes(r.ruc));
  const cadenasGrandesExcluidas = debilFiltrado.filter((r) => r.num_nombres_distintos > UMBRAL_CADENA_GRANDE).length;
  const senalDebil = debilFiltrado
    .filter((r) => r.num_nombres_distintos <= UMBRAL_CADENA_GRANDE)
    .map((r) => ({ identificacion: r.ruc, nombres: r.nombres, codigos: r.codigos, num_nombres_distintos: r.num_nombres_distintos }));

  return {
    senal_fuerte: { descripcion: "Mismo RUC+company_id+nombre EXACTO en 2+ codigo_cliente — duplicado real de maestro.", total: senalFuerte.length, items: senalFuerte.slice(0, limite) },
    senal_debil: {
      descripcion: `Mismo RUC, nombres DISTINTOS — puede ser duplicado de verdad o sucursales legítimas (ej. cadenas de tiendas) de la misma empresa. Requiere revisión caso por caso, no es señal sólida por sí sola. Se excluyen del LISTADO (no del total) grupos con más de ${UMBRAL_CADENA_GRANDE} nombres distintos (casi siempre cadenas grandes conocidas) — ver \`cadenas_grandes_excluidas_del_listado\`.`,
      total: debilFiltrado.length,
      cadenas_grandes_excluidas_del_listado: cadenasGrandesExcluidas,
      items: senalDebil.slice(0, limite),
    },
  };
}

// ============================================================
// 4) Sin canal asignado (MobilVendor-only — ver punto 3 de la investigación: Odoo no tiene un equivalente poblado)
// ============================================================
const SQL_SIN_CANAL = `
  SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente, codigo_subcanal
  FROM clientes
  WHERE codigo_tipo_negocio IS NULL
  ORDER BY codigo_cliente;
`;

async function auditarSinCanal(limite) {
  const { rows } = await pool.query(SQL_SIN_CANAL);
  const items = rows.map((r) => ({
    codigo_cliente: r.codigo_cliente,
    nombre_cliente: nombreCliente(r),
    sin_subcanal_tambien: r.codigo_subcanal === null,
  }));
  return { total: items.length, items: items.slice(0, limite) };
}

// ============================================================
// 5) Clientes "activos" (Odoo, res.partner.active) sin consumo en > umbral días
// ============================================================
const SQL_ULTIMA_COMPRA_GLOBAL = `
  SELECT customer_code, MAX(fecha) AS ultima FROM (
    SELECT o.customer_code, o.fecha_creacion AS fecha FROM ordenes o WHERE o.status = 2
    UNION ALL
    SELECT f.customer_code, f.fecha_creacion AS fecha FROM facturas f WHERE f.status = 2 AND f.tipo_movimiento = 'out_invoice'
  ) x
  GROUP BY customer_code;
`;

const SQL_CLIENTES_CON_RUC = `
  SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente, TRIM(identificacion_cliente) AS ruc
  FROM clientes
  WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> '';
`;

async function fetchOdooActivoPorRuc() {
  const partners = await executeKw(
    "res.partner",
    "search_read",
    [[["customer_rank", ">", 0], ["vat", "!=", false]]],
    { fields: ["vat", "active"], context: { active_test: false }, limit: 0 }
  );
  const map = new Map();
  for (const p of partners) {
    const ruc = (p.vat || "").trim();
    if (!ruc) continue;
    // Si el mismo RUC aparece en más de un partner con estados distintos
    // (raro pero posible), basta con que UNO esté activo para considerar
    // "activo en Odoo" — es una señal de "¿existe todavía en algún lado
    // como activo?", no de unicidad de partner.
    map.set(ruc, map.get(ruc) || p.active);
  }
  return map;
}

async function auditarActivosSinConsumo(umbralDias, limite) {
  const [ultimaRes, clientesRes, activoOdooPorRuc] = await Promise.all([
    pool.query(SQL_ULTIMA_COMPRA_GLOBAL),
    pool.query(SQL_CLIENTES_CON_RUC),
    fetchOdooActivoPorRuc(),
  ]);

  const mapUltima = new Map(ultimaRes.rows.map((r) => [r.customer_code, r.ultima]));
  const hoy = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

  let sinMatchOdoo = 0;
  const candidatos = [];
  for (const c of clientesRes.rows) {
    const activoOdoo = activoOdooPorRuc.has(c.ruc) ? activoOdooPorRuc.get(c.ruc) : null;
    if (activoOdoo === null) {
      sinMatchOdoo++;
      continue; // sin señal confiable de "activo" para este cliente — no se incluye en candidatos, no se asume nada.
    }
    if (!activoOdoo) continue; // ya archivado en Odoo, no es "activo sin consumo" (ya está resuelto).

    const ultimaRaw = mapUltima.get(c.codigo_cliente) || null;
    const ultimaDia = ultimaRaw ? new Date(`${new Date(ultimaRaw).toISOString().slice(0, 10)}T00:00:00Z`) : null;
    const dias = ultimaDia ? Math.round((hoy - ultimaDia) / 86400000) : null;

    if (dias === null || dias > umbralDias) {
      candidatos.push({
        codigo_cliente: c.codigo_cliente,
        nombre_cliente: nombreCliente(c),
        ultima_compra: ultimaDia ? ultimaDia.toISOString().slice(0, 10) : null,
        dias_desde_ultima: dias,
        nunca_compro: dias === null,
      });
    }
  }
  candidatos.sort((a, b) => (b.dias_desde_ultima ?? 999999) - (a.dias_desde_ultima ?? 999999));

  return {
    descripcion: "Clientes marcados 'activo' en Odoo (res.partner.active=true, la única señal confiable encontrada) sin ninguna compra registrada en más de umbral_dias_inactividad días, o que nunca compraron — candidatos a archivar, requiere revisión humana.",
    umbral_dias_inactividad: umbralDias,
    sin_señal_confiable_de_activo: sinMatchOdoo,
    total: candidatos.length,
    items: candidatos.slice(0, limite),
  };
}

async function auditoriaClientes({ categoria, umbral_dias_inactividad = UMBRAL_DIAS_INACTIVIDAD_DEFAULT, limite = LIMITE_DEFAULT }) {
  if (categoria) {
    let resultado;
    if (categoria === "direcciones_incompletas") resultado = await auditarDireccionesIncompletas(limite);
    else if (categoria === "coordenadas") resultado = await auditarCoordenadas(limite);
    else if (categoria === "duplicados") resultado = await auditarDuplicados(limite);
    else if (categoria === "sin_canal") resultado = await auditarSinCanal(limite);
    else if (categoria === "activos_sin_consumo") resultado = await auditarActivosSinConsumo(umbral_dias_inactividad, limite);
    return { categoria, ...resultado };
  }

  // Sin categoría: resumen de las 5, con una muestra chica de cada una
  // (MUESTRA_RESUMEN, no `limite` — para pedir el detalle completo de una
  // categoría, se debe pasar `categoria` explícito).
  const [direcciones, coordenadas, duplicados, sinCanal, activosSinConsumo] = await Promise.all([
    auditarDireccionesIncompletas(MUESTRA_RESUMEN),
    auditarCoordenadas(MUESTRA_RESUMEN),
    auditarDuplicados(MUESTRA_RESUMEN),
    auditarSinCanal(MUESTRA_RESUMEN),
    auditarActivosSinConsumo(umbral_dias_inactividad, MUESTRA_RESUMEN),
  ]);

  return {
    nota: "Resumen de las 5 categorías con muestra chica (5) de cada una. Para el listado completo de una categoría (hasta `limite`), volver a llamar pasando `categoria`.",
    direcciones_incompletas: direcciones,
    coordenadas: coordenadas,
    duplicados,
    sin_canal: sinCanal,
    activos_sin_consumo: activosSinConsumo,
  };
}

module.exports = { auditoriaClientes, inputSchema, CATEGORIAS_VALIDAS };
