// src/tools/auditoriaClientes.js
// Auditoría de calidad de datos de clientes — FASE 1, SOLO DIAGNÓSTICO.
// Cruza MobilVendor (Postgres, ya sincronizado) y Odoo corporativo
// (grupoaqua.odoo.com, la MISMA instancia de facturasProveedores — ver
// src/integrations/odooContabilidad.js) para señalar problemas de calidad
// de datos. Pedido explícito de Alberto: esta fase NUNCA escribe ni
// corrige nada — solo lista, para revisión humana. Canal automático y
// corrección de coordenadas quedan para una Fase 2 futura, NO construida
// acá.
//
// ============================================================
// FASE 1b (2026-10-01) — ampliación pedida por el usuario sobre la Fase 1
// ya en producción: filtro por compañía, paginación sin tope de 500,
// nuevos subtipos de coordenadas, contexto por registro (última compra,
// ruta, grupo, etc.), y mejoras sustanciales a duplicados (equivalencia
// cédula/RUC, nombre normalizado, señales de teléfono/pin compartido).
// Sigue siendo SOLO LECTURA — ningún cambio de esta ampliación escribe
// nada, ni en Postgres ni en Odoo.
// ============================================================
//
// Hallazgos nuevos de esta ampliación (investigados en vivo antes de
// construir, no asumidos):
//
// - `clientes.company_id` (MobilVendor) YA coincide 1:1 con el id de
//   `res.company` en Odoo (1=GRUPOAQUA, 2=AQUASUPPLY, 3=COTTSA, 4=IIBC,
//   5=DISTRINTER — confirmado con los mismos 5 ids ya validados en
//   facturasProveedores) Y además trae `descripcion_company` (el nombre)
//   directo en la misma tabla — `listar_companias` NO necesita tocar
//   Odoo en absoluto, sale 100% de Postgres. 2,340 clientes (de 20,431)
//   tienen `company_id` NULL — se reportan como su propio bucket.
// - `pg_trgm` (función `similarity()`) y `unaccent` YA están instalados
//   en esta base (confirmado — `unaccent` ya se usa en ventasCliente.js
//   como fallback de sugerencias) — se reutilizan para nombre
//   normalizado y las señales de similitud de nombre, sin agregar
//   dependencias nuevas.
// - `codigo_cliente` tiene exactamente 3 patrones reales (confirmado con
//   datos): NUMERICO (20,136 — MobilVendor nativo), 'GA...' (233), y
//   'CL...' (151) — usado para `origen_codigo` en el detalle de
//   duplicados.
// - FORMATO_INVALIDO (coordenada no numérica/con coma/con texto): la
//   columna real (`direcciones_clientes.latitud_direccion_cliente` y
//   `longitud_direccion_cliente`) es `NUMERIC(15,8)` — Postgres RECHAZA
//   cualquier valor no numérico al insertar, así que este tipo de
//   problema NO PUEDE EXISTIR en los datos ya almacenados (si algún día
//   llegó un valor con coma/texto, o bien se cayó el insert de esa fila,
//   o bien nunca se guardó ahí). Se implementa el chequeo de todos modos
//   (defensivo, por si algún día cambia el tipo de columna o aparece otra
//   fuente de coordenadas en texto) pero HOY siempre da 0 — no es un bug
//   de este código, es una imposibilidad estructural del esquema actual.
// - BAJA_PRECISION (menos de 4 decimales): la columna NUMERIC(15,8) rellena
//   con ceros hasta la escala declarada — un valor originalmente cargado
//   con 1 decimal ("-2.2") se guarda como "-2.20000000", indistinguible en
//   el texto crudo de un GPS real que terminara en .20000000 por
//   coincidencia. No se puede recuperar la precisión ORIGINAL de una
//   columna de escala fija — se usa como proxy la cantidad de dígitos
//   decimales SIGNIFICATIVOS después de recortar los ceros finales (ej.
//   "-2.20000000" → "2" → 1 decimal significativo → BAJA_PRECISION).
//   Es una aproximación razonable, documentada, no una medición exacta.
const { z } = require("zod");
const { pool } = require("../db");
const { executeKw } = require("../integrations/odooContabilidad");
const { CASE_GRUPO_ORDENES, CASE_GRUPO_FACTURAS } = require("../sql/clasificacion");

const LIMITE_DEFAULT = 50;
const LIMITE_MAX = 2000;
const MUESTRA_RESUMEN = 5;
const UMBRAL_DIAS_INACTIVIDAD_DEFAULT = 365;
const UMBRAL_CADENA_GRANDE = 8; // más de 8 nombres distintos bajo un mismo RUC = cadena conocida, se excluye del listado (no del conteo)
const UMBRAL_SIMILITUD_NOMBRE = 0.85;
const UMBRAL_TELEFONO_DIGITOS_MIN = 7; // menos que esto es demasiado genérico para ser una señal confiable

// Rango válido AMPLIADO (incluye Galápagos) — antes de esta ampliación la
// caja era solo Ecuador continental. `en_galapagos` se marca aparte,
// informativo, no como problema.
const LAT_MIN = -5.5, LAT_MAX = 1.5;
const LON_MIN = -92.5, LON_MAX = -75.0;
const GALAPAGOS_LAT_MIN = -1.5, GALAPAGOS_LAT_MAX = 0.7;
const GALAPAGOS_LON_MIN = -92.0, GALAPAGOS_LON_MAX = -89.0;

const RUCS_GENERICOS = ["", "9999999999", "9999999999999"];

const CATEGORIAS_VALIDAS = [
  "direcciones_incompletas",
  "coordenadas",
  "duplicados",
  "sin_canal",
  "activos_sin_consumo",
];

const TIPOS_PROBLEMA_COORDENADAS = [
  "NULA",
  "SOLO_LATITUD",
  "SOLO_LONGITUD",
  "CERO_CERO",
  "LAT_LON_INVERTIDAS",
  "LAT_IGUAL_LON",
  "FORMATO_INVALIDO",
  "BAJA_PRECISION",
  "FUERA_RANGO_ECUADOR",
  "PIN_POR_DEFECTO",
];

const inputSchema = {
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  umbral_dias_inactividad: z.number().int().min(30).max(3650).default(UMBRAL_DIAS_INACTIVIDAD_DEFAULT),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
  offset: z.number().int().min(0).default(0),
  formato_salida: z.enum(["json", "resumen_por_tipo"]).default("json"),
  company_id: z.string().optional(),
  listar_companias: z.boolean().optional(),
  tipo_problema: z.enum(TIPOS_PROBLEMA_COORDENADAS).optional(),
  solo_activos_dias: z.number().int().min(1).max(3650).optional(),
  incluir_cadenas: z.boolean().optional(),
};

function nombreCliente(row) {
  return (row.nombre_comercial_cliente || row.nombre_cliente || "").replace(/\s+/g, " ").trim() || null;
}

// customer_code sale de `codigo_cliente` en clientes; documentos usan la
// misma columna. Mismo criterio que codigo_cliente para "activo" abajo.

// ============================================================
// Filtro de compañía — mismo patrón `($N::text IS NULL OR ...)` que ya
// usa el resto del proyecto para filtros opcionales (nunca concatenación
// de texto de usuario dentro del SQL).
// ============================================================
function origenCodigo(codigo) {
  if (!codigo) return "DESCONOCIDO";
  if (/^GA/i.test(codigo)) return "GA";
  if (/^CL/i.test(codigo)) return "CL";
  if (/^[0-9]+$/.test(codigo)) return "NUMERICO";
  return "OTRO";
}

// ============================================================
// Estado en Odoo (res.partner.active) — reportado 2026-10-01 (Kenny Navas,
// vía Slack): ninguna categoría de esta tool fuera de `activos_sin_consumo`
// distinguía archivados de activos, pese a que la lista de `coordenadas`
// sospechosas también alimenta `auditoriaParadasFlota`. Confirmado antes de
// corregir: `direcciones_incompletas`, `coordenadas`, `duplicados` (las 7
// señales) y `sin_canal` NO tocaban Odoo en absoluto — `grep` de
// `fetchOdooActivoPorRuc`/`res.partner` en el código ANTES de este cambio
// solo aparecía en `activos_sin_consumo`.
//
// Pedido explícito: NO excluir archivados (esta sigue siendo Fase 1,
// diagnóstico puro) — separar el conteo activo/archivado por categoría,
// mismo criterio que ya usa `activos_sin_consumo`. `activoOdooPorRuc` se
// trae UNA sola vez por llamada a `auditoriaClientes()` (antes se hubiera
// llamado 2 veces en el resumen sin categoría: acá + adentro de
// activos_sin_consumo) y se pasa a cada categoría que la necesite.
function clasificarActivoOdoo(ruc, activoOdooPorRuc) {
  if (!ruc) return "SIN_RUC";
  if (!activoOdooPorRuc.has(ruc)) return "SIN_MATCH_ODOO";
  return activoOdooPorRuc.get(ruc) ? "ACTIVO" : "ARCHIVADO";
}

function porEstadoOdoo(items, obtenerRuc, activoOdooPorRuc) {
  const conteo = { ACTIVO: 0, ARCHIVADO: 0, SIN_MATCH_ODOO: 0, SIN_RUC: 0 };
  for (const it of items) {
    const estado = clasificarActivoOdoo(obtenerRuc(it), activoOdooPorRuc);
    conteo[estado]++;
  }
  return conteo;
}

// ============================================================
// listar_companias — 100% Postgres, no toca Odoo (ver hallazgo arriba).
// ============================================================
async function listarCompanias() {
  const { rows } = await pool.query(`
    SELECT company_id, descripcion_company, COUNT(*) AS num_clientes
    FROM clientes
    GROUP BY company_id, descripcion_company
    ORDER BY num_clientes DESC;
  `);
  return rows.map((r) => ({
    company_id: r.company_id,
    nombre: r.descripcion_company || null,
    num_clientes: Number(r.num_clientes),
  }));
}

// ============================================================
// Enriquecimiento de contexto (coordenadas y duplicados): última compra,
// ruta + grupo del documento más reciente real (mismo patrón que
// clientesSinVisita.js — SIN el ajuste especial de PREVENTA de esa tool,
// esto es una auditoría general, no específica de preventa), ventas de
// los últimos 12 meses, y campos propios de `clientes`.
// ============================================================
const SQL_ULTIMA_RUTA_GRUPO = `
  SELECT DISTINCT ON (customer_code) customer_code, seller_code, grupo
  FROM (
    SELECT o.customer_code, o.seller_code, o.fecha_creacion AS fecha, (${CASE_GRUPO_ORDENES}) AS grupo
    FROM ordenes o
    WHERE o.origen_sistema = 'MOBILVENDOR' AND o.status = 2 AND o.customer_code = ANY($1::text[])

    UNION ALL

    SELECT f.customer_code, f.seller_code, f.fecha_creacion AS fecha, (${CASE_GRUPO_FACTURAS}) AS grupo
    FROM facturas f
    WHERE f.status = 2 AND f.customer_code = ANY($1::text[])
  ) x
  WHERE seller_code IS NOT NULL AND seller_code <> ''
  ORDER BY customer_code, fecha DESC;
`;

const SQL_ULTIMA_COMPRA_FILTRADA = `
  SELECT customer_code, MAX(fecha) AS ultima FROM (
    SELECT o.customer_code, o.fecha_creacion AS fecha FROM ordenes o WHERE o.status = 2 AND o.customer_code = ANY($1::text[])
    UNION ALL
    SELECT f.customer_code, f.fecha_creacion AS fecha FROM facturas f WHERE f.status = 2 AND f.tipo_movimiento = 'out_invoice' AND f.customer_code = ANY($1::text[])
  ) x
  GROUP BY customer_code;
`;

const SQL_VENTAS_12M = `
  SELECT customer_code, SUM(total) AS ventas_12m FROM (
    SELECT o.customer_code, dd.total AS total
    FROM ordenes o JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2 AND o.customer_code = ANY($1::text[]) AND o.fecha_creacion >= $2

    UNION ALL

    SELECT f.customer_code, CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total ELSE dd.total END AS total
    FROM facturas f JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE f.status = 2 AND f.customer_code = ANY($1::text[]) AND f.fecha_creacion >= $2
  ) x
  GROUP BY customer_code;
`;

// Devuelve Map(codigo_cliente -> contexto). `codigos` puede venir con
// duplicados (varios grupos de duplicados comparten códigos) — se
// deduplica antes de consultar. `activoOdooPorRuc` es opcional — cuando se
// pasa, cada registro trae `activo_odoo` (ver clasificarActivoOdoo).
async function enriquecerClientes(codigos, activoOdooPorRuc) {
  const unicos = [...new Set(codigos.filter(Boolean))];
  const mapa = new Map();
  if (unicos.length === 0) return mapa;

  const doceAtras = new Date();
  doceAtras.setFullYear(doceAtras.getFullYear() - 1);
  const doceAtrasTs = `${doceAtras.toISOString().slice(0, 10)} 00:00:00`;
  const hoy = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

  const [clientesRes, rutaGrupoRes, ventasRes, ultimaRes] = await Promise.all([
    pool.query(
      `SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente, telefono_cliente, ciudad_cliente,
              fecha_creacion_cliente, company_id, TRIM(identificacion_cliente) AS ruc
       FROM clientes WHERE codigo_cliente = ANY($1::text[])`,
      [unicos]
    ),
    pool.query(SQL_ULTIMA_RUTA_GRUPO, [unicos]),
    pool.query(SQL_VENTAS_12M, [unicos, doceAtrasTs]),
    pool.query(SQL_ULTIMA_COMPRA_FILTRADA, [unicos]),
  ]);

  const rutaGrupoPorCodigo = new Map(rutaGrupoRes.rows.map((r) => [r.customer_code, r]));
  const ventasPorCodigo = new Map(ventasRes.rows.map((r) => [r.customer_code, Number(r.ventas_12m) || 0]));
  const ultimaPorCodigo = new Map(ultimaRes.rows.map((r) => [r.customer_code, r.ultima]));

  for (const c of clientesRes.rows) {
    const rg = rutaGrupoPorCodigo.get(c.codigo_cliente);
    const ultimaRaw = ultimaPorCodigo.get(c.codigo_cliente) || null;
    const ultimaDia = ultimaRaw ? new Date(`${new Date(ultimaRaw).toISOString().slice(0, 10)}T00:00:00Z`) : null;
    const dias = ultimaDia ? Math.round((hoy - ultimaDia) / 86400000) : null;

    mapa.set(c.codigo_cliente, {
      codigo_cliente: c.codigo_cliente,
      nombre_cliente: nombreCliente(c),
      company_id: c.company_id,
      telefono: c.telefono_cliente || null,
      ciudad: c.ciudad_cliente || null,
      fecha_creacion: c.fecha_creacion_cliente ? new Date(c.fecha_creacion_cliente).toISOString().slice(0, 10) : null,
      ruta: rg?.seller_code || null,
      grupo: rg?.grupo || null,
      ventas_12m: Number((ventasPorCodigo.get(c.codigo_cliente) || 0).toFixed(2)),
      ultima_compra: ultimaDia ? ultimaDia.toISOString().slice(0, 10) : null,
      dias_desde_ultima: dias,
      origen_codigo: origenCodigo(c.codigo_cliente),
      ...(activoOdooPorRuc ? { activo_odoo: clasificarActivoOdoo(c.ruc, activoOdooPorRuc) } : {}),
    });
  }
  return mapa;
}

// ============================================================
// 1) Direcciones incompletas
// ============================================================
function sqlDireccionesIncompletas() {
  return `
    SELECT dc.codigo_cliente, dc.codigo_direccion_cliente, dc.descripcion_direccion_cliente,
           dc.referencia_direccion_cliente, dc.telefono_direccion_cliente,
           c.nombre_cliente, c.nombre_comercial_cliente, c.company_id, TRIM(c.identificacion_cliente) AS ruc
    FROM direcciones_clientes dc
    JOIN clientes c ON c.codigo_cliente = dc.codigo_cliente
    WHERE dc.estado_direccion_cliente = 1
      AND (dc.calle1_direccion_cliente IS NULL OR TRIM(dc.calle1_direccion_cliente) = '')
      AND (c.direccion_cliente IS NULL OR TRIM(c.direccion_cliente) = '')
      AND ($1::text IS NULL OR c.company_id = $1)
    ORDER BY dc.codigo_cliente;
  `;
}

async function auditarDireccionesIncompletas(companyId, offset, limite, formatoSalida, activoOdooPorRuc) {
  const { rows } = await pool.query(sqlDireccionesIncompletas(), [companyId || null]);
  if (formatoSalida === "resumen_por_tipo") {
    return { total: rows.length, por_estado_odoo: porEstadoOdoo(rows, (r) => r.ruc, activoOdooPorRuc) };
  }
  const items = rows.map((r) => ({
    codigo_cliente: r.codigo_cliente,
    nombre_cliente: nombreCliente(r),
    company_id: r.company_id,
    activo_odoo: clasificarActivoOdoo(r.ruc, activoOdooPorRuc),
    codigo_direccion: r.codigo_direccion_cliente,
    descripcion_direccion: r.descripcion_direccion_cliente || null,
    campos_faltantes: [
      "calle1",
      ...(!r.referencia_direccion_cliente || !r.referencia_direccion_cliente.trim() ? ["referencia"] : []),
      ...(!r.telefono_direccion_cliente || !r.telefono_direccion_cliente.trim() ? ["telefono"] : []),
    ],
  }));
  return { ...paginar(items, offset, limite), por_estado_odoo: porEstadoOdoo(rows, (r) => r.ruc, activoOdooPorRuc) };
}

// ============================================================
// 2) Coordenadas mal puestas — subtipos ampliados
// ============================================================
function sqlDireccionesCoord() {
  return `
    SELECT dc.codigo_cliente, dc.codigo_direccion_cliente,
           dc.latitud_direccion_cliente::text AS lat_texto, dc.longitud_direccion_cliente::text AS lon_texto,
           c.nombre_cliente, c.nombre_comercial_cliente, c.company_id, TRIM(c.identificacion_cliente) AS ruc
    FROM direcciones_clientes dc
    JOIN clientes c ON c.codigo_cliente = dc.codigo_cliente
    WHERE dc.estado_direccion_cliente = 1
      AND ($1::text IS NULL OR c.company_id = $1);
  `;
}

// Decimales SIGNIFICATIVOS (recortando ceros finales) — ver nota grande
// del header sobre por qué no se puede medir la precisión ORIGINAL real.
function decimalesSignificativos(textoDecimal) {
  if (!textoDecimal) return 0;
  const sinCerosFinales = textoDecimal.replace(/0+$/, "");
  return sinCerosFinales.length;
}

// `latTexto`/`lonTexto` son el texto crudo tal cual sale de Postgres (para
// poder detectar FORMATO_INVALIDO de forma defensiva — ver header). Cuando
// vienen de la columna NUMERIC actual, siempre son null o un número válido.
function clasificarCoordenada(latTexto, lonTexto) {
  const latVacia = latTexto === null || latTexto === undefined || String(latTexto).trim() === "";
  const lonVacia = lonTexto === null || lonTexto === undefined || String(lonTexto).trim() === "";

  if (latVacia && lonVacia) return { problema: "NULA" };
  if (latVacia) return { problema: "SOLO_LONGITUD" };
  if (lonVacia) return { problema: "SOLO_LATITUD" };

  // FORMATO_INVALIDO: defensivo — ver nota del header, hoy nunca ocurre
  // porque la columna es NUMERIC (Postgres ya rechazaría el insert).
  const formatoValido = /^-?\d+(\.\d+)?$/.test(String(latTexto).trim()) && /^-?\d+(\.\d+)?$/.test(String(lonTexto).trim());
  if (!formatoValido) return { problema: "FORMATO_INVALIDO" };

  const lat = Number(latTexto);
  const lon = Number(lonTexto);

  if (lat === 0 && lon === 0) return { problema: "CERO_CERO" };
  if (lat === lon) return { problema: "LAT_IGUAL_LON" };
  // Invertidas: lat cae en el rango típico de longitud de Ecuador y
  // viceversa — señal de columnas cruzadas al cargar el dato.
  if (lat >= LON_MIN && lat <= LON_MAX && lon >= LAT_MIN && lon <= LAT_MAX) return { problema: "LAT_LON_INVERTIDAS" };

  const enGalapagos = lat >= GALAPAGOS_LAT_MIN && lat <= GALAPAGOS_LAT_MAX && lon >= GALAPAGOS_LON_MIN && lon <= GALAPAGOS_LON_MAX;
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) return { problema: "FUERA_RANGO_ECUADOR", en_galapagos: false };

  const decimalesLat = decimalesSignificativos(String(latTexto).split(".")[1] || "");
  const decimalesLon = decimalesSignificativos(String(lonTexto).split(".")[1] || "");
  if (decimalesLat < 4 || decimalesLon < 4) return { problema: "BAJA_PRECISION", en_galapagos: enGalapagos };

  return { problema: null, en_galapagos: enGalapagos };
}

async function auditarCoordenadas(companyId, tipoProblema, offset, limite, formatoSalida, soloActivosDias, activoOdooPorRuc) {
  const { rows } = await pool.query(sqlDireccionesCoord(), [companyId || null]);

  // Pines por defecto: misma coordenada EXACTA repetida en muchos clientes
  // distintos (excluye null/formato inválido/(0,0), ya cubiertos aparte).
  const porCoordenada = new Map();
  for (const r of rows) {
    if (r.lat_texto === null || r.lon_texto === null) continue;
    const lat = Number(r.lat_texto), lon = Number(r.lon_texto);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const key = `${lat},${lon}`;
    if (!porCoordenada.has(key)) porCoordenada.set(key, new Set());
    porCoordenada.get(key).add(r.codigo_cliente);
  }
  const pinesPorDefecto = new Set([...porCoordenada.entries()].filter(([, codigos]) => codigos.size > 5).map(([key]) => key));

  let candidatos = [];
  for (const r of rows) {
    const clasif = clasificarCoordenada(r.lat_texto, r.lon_texto);
    let problema = clasif.problema;
    const lat = r.lat_texto === null ? null : Number(r.lat_texto);
    const lon = r.lon_texto === null ? null : Number(r.lon_texto);
    if (!problema && lat !== null && lon !== null && pinesPorDefecto.has(`${lat},${lon}`)) problema = "PIN_POR_DEFECTO";
    if (!problema) continue;
    candidatos.push({
      codigo_cliente: r.codigo_cliente,
      nombre_cliente: nombreCliente(r),
      company_id: r.company_id,
      ruc: r.ruc,
      codigo_direccion: r.codigo_direccion_cliente,
      problema,
      latitud: lat,
      longitud: lon,
      ...(clasif.en_galapagos !== undefined ? { en_galapagos: clasif.en_galapagos } : {}),
      ...(problema === "PIN_POR_DEFECTO" ? { clientes_con_mismo_pin: porCoordenada.get(`${lat},${lon}`).size } : {}),
    });
  }

  if (tipoProblema) candidatos = candidatos.filter((c) => c.problema === tipoProblema);

  if (formatoSalida === "resumen_por_tipo") {
    const conteos = {};
    for (const c of candidatos) conteos[c.problema] = (conteos[c.problema] || 0) + 1;
    return { total: candidatos.length, por_tipo: conteos, por_estado_odoo: porEstadoOdoo(candidatos, (c) => c.ruc, activoOdooPorRuc) };
  }

  const contexto = await enriquecerClientes(candidatos.map((c) => c.codigo_cliente), activoOdooPorRuc);
  let items = candidatos.map((c) => {
    const { ruc, ...resto } = c;
    return { ...resto, ...(contexto.get(c.codigo_cliente) || {}) };
  });

  if (soloActivosDias) {
    items = items.filter((i) => i.dias_desde_ultima !== null && i.dias_desde_ultima !== undefined && i.dias_desde_ultima <= soloActivosDias);
  }
  items.sort((a, b) => (b.ventas_12m || 0) - (a.ventas_12m || 0));

  // `items` ya trae `activo_odoo` calculado por `enriquecerClientes` — se
  // cuenta directo por ese campo, sin volver a clasificar por RUC.
  const conteoOdoo = { ACTIVO: 0, ARCHIVADO: 0, SIN_MATCH_ODOO: 0, SIN_RUC: 0 };
  for (const it of items) conteoOdoo[it.activo_odoo || "SIN_RUC"]++;

  return { ...paginar(items, offset, limite), por_estado_odoo: conteoOdoo };
}

// ============================================================
// 3) Duplicados — señales múltiples
// ============================================================
function sqlDuplicadosFuerte() {
  return `
    SELECT array_agg(codigo_cliente ORDER BY codigo_cliente) AS codigos,
           identificacion_cliente, company_id, nombre_cliente
    FROM clientes
    WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
      AND ($1::text IS NULL OR company_id = $1)
    GROUP BY identificacion_cliente, company_id, nombre_cliente
    HAVING COUNT(*) > 1
    ORDER BY identificacion_cliente;
  `;
}

// Nombre normalizado: unaccent + mayúsculas + sin puntuación + sin sufijos
// societarios comunes (S.A./S.A.S./CIA LTDA/C.A.) + espacios recortados.
function sqlNombreNormalizado(alias) {
  return `
    TRIM(REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            UPPER(unaccent(COALESCE(${alias}.nombre_cliente, ''))),
            '[\\.,]', '', 'g'
          ),
          '\\y(SAS|SA|CIA LTDA|CIALTDA|CA|CIA)\\y', '', 'g'
        ),
        '[^A-Z0-9 ]', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    ))
  `;
}

function sqlDuplicadosDebil() {
  return `
    SELECT TRIM(identificacion_cliente) AS ruc,
           array_agg(DISTINCT codigo_cliente) AS codigos,
           array_agg(DISTINCT nombre_cliente) AS nombres,
           COUNT(DISTINCT nombre_cliente) AS num_nombres_distintos,
           COUNT(DISTINCT ${sqlNombreNormalizado("clientes")}) AS num_nombres_normalizados_distintos,
           MAX(company_id) AS company_id_muestra
    FROM clientes
    WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
      AND ($1::text IS NULL OR company_id = $1)
    GROUP BY TRIM(identificacion_cliente)
    HAVING COUNT(DISTINCT nombre_cliente) > 1
    ORDER BY num_nombres_distintos DESC;
  `;
}

// Equivalencia cédula (10 dígitos) <-> RUC (esos mismos 10 + "001") — un
// cliente cargado con cédula en un código y RUC en otro no comparte RUC
// exacto, así que el chequeo de arriba nunca lo agarra.
function sqlEquivalenciaCedulaRuc() {
  return `
    WITH base AS (
      SELECT codigo_cliente, TRIM(identificacion_cliente) AS id, nombre_cliente, company_id
      FROM clientes
      WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
        AND (LENGTH(TRIM(identificacion_cliente)) = 10 OR (LENGTH(TRIM(identificacion_cliente)) = 13 AND TRIM(identificacion_cliente) LIKE '%001'))
        AND ($1::text IS NULL OR company_id = $1)
    ), clave AS (
      SELECT *, CASE WHEN LENGTH(id) = 13 THEN LEFT(id, 10) ELSE id END AS clave10
      FROM base
    )
    SELECT clave10,
           array_agg(DISTINCT id) AS identificaciones,
           array_agg(DISTINCT codigo_cliente ORDER BY codigo_cliente) AS codigos,
           array_agg(DISTINCT nombre_cliente) AS nombres
    FROM clave
    GROUP BY clave10
    HAVING COUNT(DISTINCT id) > 1
    ORDER BY clave10;
  `;
}

// Mismo teléfono (normalizado: solo dígitos, sin 0/593 de prefijo) + RUC
// distinto + nombre con similitud > UMBRAL_SIMILITUD_NOMBRE.
function sqlMismoTelefono() {
  return `
    WITH tel_norm AS (
      SELECT codigo_cliente, nombre_cliente, TRIM(identificacion_cliente) AS ruc, company_id,
        CASE
          WHEN REGEXP_REPLACE(telefono_cliente, '\\D', '', 'g') LIKE '593%' THEN SUBSTRING(REGEXP_REPLACE(telefono_cliente, '\\D', '', 'g') FROM 4)
          WHEN REGEXP_REPLACE(telefono_cliente, '\\D', '', 'g') LIKE '0%' THEN SUBSTRING(REGEXP_REPLACE(telefono_cliente, '\\D', '', 'g') FROM 2)
          ELSE REGEXP_REPLACE(telefono_cliente, '\\D', '', 'g')
        END AS tel_clave
      FROM clientes
      WHERE telefono_cliente IS NOT NULL AND TRIM(telefono_cliente) <> ''
        AND ($1::text IS NULL OR company_id = $1)
    )
    SELECT a.codigo_cliente AS codigo_a, b.codigo_cliente AS codigo_b,
           a.nombre_cliente AS nombre_a, b.nombre_cliente AS nombre_b,
           a.ruc AS ruc_a, b.ruc AS ruc_b, a.tel_clave,
           similarity(a.nombre_cliente, b.nombre_cliente) AS similitud
    FROM tel_norm a
    JOIN tel_norm b ON a.tel_clave = b.tel_clave AND a.codigo_cliente < b.codigo_cliente AND a.ruc IS DISTINCT FROM b.ruc
    WHERE LENGTH(a.tel_clave) >= $2 AND similarity(a.nombre_cliente, b.nombre_cliente) > $3
    ORDER BY similitud DESC;
  `;
}

// Mismo pin EXACTO (lat/lon idénticos, no nulo, no (0,0), no pin-por-defecto
// de > 5 clientes — ese ya lo cubre PIN_POR_DEFECTO en coordenadas) + RUC
// distinto + nombre similar.
function sqlMismoPin() {
  return `
    WITH coords AS (
      SELECT dc.codigo_cliente, dc.latitud_direccion_cliente AS lat, dc.longitud_direccion_cliente AS lon,
             c.nombre_cliente, TRIM(c.identificacion_cliente) AS ruc, c.company_id
      FROM direcciones_clientes dc JOIN clientes c ON c.codigo_cliente = dc.codigo_cliente
      WHERE dc.estado_direccion_cliente = 1
        AND dc.latitud_direccion_cliente IS NOT NULL AND dc.longitud_direccion_cliente IS NOT NULL
        AND NOT (dc.latitud_direccion_cliente = 0 AND dc.longitud_direccion_cliente = 0)
        AND ($1::text IS NULL OR c.company_id = $1)
    ), conteo AS (
      SELECT lat, lon, COUNT(DISTINCT codigo_cliente) AS n FROM coords GROUP BY lat, lon
    )
    SELECT a.codigo_cliente AS codigo_a, b.codigo_cliente AS codigo_b,
           a.nombre_cliente AS nombre_a, b.nombre_cliente AS nombre_b,
           a.ruc AS ruc_a, b.ruc AS ruc_b, a.lat, a.lon,
           similarity(a.nombre_cliente, b.nombre_cliente) AS similitud
    FROM coords a
    JOIN coords b ON a.lat = b.lat AND a.lon = b.lon AND a.codigo_cliente < b.codigo_cliente AND a.ruc IS DISTINCT FROM b.ruc
    JOIN conteo ct ON ct.lat = a.lat AND ct.lon = a.lon
    WHERE ct.n <= 5 AND similarity(a.nombre_cliente, b.nombre_cliente) > $2
    ORDER BY similitud DESC;
  `;
}

function sqlNombresProblematicos() {
  return `
    SELECT codigo_cliente, nombre_cliente, company_id, TRIM(identificacion_cliente) AS ruc
    FROM clientes
    WHERE ($1::text IS NULL OR company_id = $1)
      AND (nombre_cliente IS NULL OR nombre_cliente <> TRIM(nombre_cliente) OR nombre_cliente ~ E'[\\n\\r]')
    ORDER BY codigo_cliente;
  `;
}

// `totalReal` permite reportar un total distinto del largo de `items` —
// necesario para senal_debil, donde `items` ya excluye cadenas grandes del
// LISTADO pero `total` debe seguir contando el universo genuino completo
// (mismo principio que ya usaba el código original, ver
// `cadenas_grandes_excluidas_del_listado`). `hay_mas` se calcula SIEMPRE
// contra `items.length` (lo efectivamente paginable), no contra
// `totalReal` — si no, con cadenas grandes excluidas podría decir
// "hay_mas=true" cuando en realidad no queda nada más para listar (el
// resto del total son grupos excluidos, no una página siguiente real).
function paginar(items, offset, limite, totalReal) {
  const total = totalReal !== undefined ? totalReal : items.length;
  const pagina = items.slice(offset, offset + limite);
  return { total, offset, limite, hay_mas: offset + pagina.length < items.length, items: pagina };
}

// Arma el detalle enriquecido por código para un grupo de duplicados,
// usando el mapa de contexto ya calculado (evita N+1 queries).
function detalleCodigos(codigos, contexto) {
  const detalle = codigos.map((cod) => contexto.get(cod)).filter(Boolean);
  let sugerenciaMaestro = null;
  if (detalle.length > 0) {
    sugerenciaMaestro = detalle.reduce((mejor, d) => ((d.ventas_12m || 0) > (mejor.ventas_12m || 0) ? d : mejor)).codigo_cliente;
  }
  return { detalle, sugerencia_maestro: sugerenciaMaestro };
}

// Cuenta por estado Odoo a nivel de CÓDIGO (no de grupo) — un grupo puede
// mezclar códigos activos y archivados, así que la señal útil es cuántos
// códigos individuales caen en cada estado, igual que en coordenadas.
function porEstadoOdooCodigos(gruposODocs, obtenerCodigos, contexto) {
  const conteo = { ACTIVO: 0, ARCHIVADO: 0, SIN_MATCH_ODOO: 0, SIN_RUC: 0 };
  const codigosVistos = new Set();
  for (const item of gruposODocs) {
    for (const cod of obtenerCodigos(item)) {
      if (codigosVistos.has(cod)) continue;
      codigosVistos.add(cod);
      const estado = contexto.get(cod)?.activo_odoo || "SIN_RUC";
      conteo[estado]++;
    }
  }
  return conteo;
}

async function auditarDuplicados(companyId, offset, limite, formatoSalida, incluirCadenas, activoOdooPorRuc) {
  const [fuerteRes, debilRes, equivRes, telRes, pinRes, nombresProbRes] = await Promise.all([
    pool.query(sqlDuplicadosFuerte(), [companyId || null]),
    pool.query(sqlDuplicadosDebil(), [companyId || null]),
    pool.query(sqlEquivalenciaCedulaRuc(), [companyId || null]),
    pool.query(sqlMismoTelefono(), [companyId || null, UMBRAL_TELEFONO_DIGITOS_MIN, UMBRAL_SIMILITUD_NOMBRE]),
    pool.query(sqlMismoPin(), [companyId || null, UMBRAL_SIMILITUD_NOMBRE]),
    pool.query(sqlNombresProblematicos(), [companyId || null]),
  ]);

  // Divide debil en senal_debil (nombres normalizados SIGUEN distintos) vs
  // senal_fuerte_normalizada (normalizados coinciden — ej. "S.A" vs "S.A.").
  const debilFiltrado = debilRes.rows.filter((r) => !RUCS_GENERICOS.includes(r.ruc));
  const fuerteNormalizadaGrupos = debilFiltrado.filter((r) => Number(r.num_nombres_normalizados_distintos) === 1);
  const debilGenuino = debilFiltrado.filter((r) => Number(r.num_nombres_normalizados_distintos) > 1);
  const cadenasGrandesExcluidas = debilGenuino.filter((r) => r.num_nombres_distintos > UMBRAL_CADENA_GRANDE).length;
  const debilParaListar = incluirCadenas ? debilGenuino : debilGenuino.filter((r) => r.num_nombres_distintos <= UMBRAL_CADENA_GRANDE);

  // Agrupa pares (teléfono/pin) en grupos por clave — un mismo código puede
  // aparecer en varios pares si comparte teléfono con 3+ personas.
  function agruparPares(pares, claveCampo) {
    const grupos = new Map();
    for (const p of pares) {
      const key = p[claveCampo];
      if (!grupos.has(key)) grupos.set(key, { clave: key, codigos: new Set(), pares: [] });
      const g = grupos.get(key);
      g.codigos.add(p.codigo_a);
      g.codigos.add(p.codigo_b);
      g.pares.push({ codigo_a: p.codigo_a, codigo_b: p.codigo_b, similitud: Number(p.similitud.toFixed(3)) });
    }
    return [...grupos.values()].map((g) => ({ ...g, codigos: [...g.codigos] }));
  }
  const gruposTelefono = agruparPares(telRes.rows, "tel_clave");
  const gruposPin = agruparPares(pinRes.rows.map((r) => ({ ...r, pin_clave: `${r.lat},${r.lon}` })), "pin_clave");

  // Todos los códigos que van a necesitar contexto, de una sola vez.
  const todosCodigos = [
    ...fuerteRes.rows.flatMap((r) => r.codigos),
    ...fuerteNormalizadaGrupos.flatMap((r) => r.codigos),
    ...debilParaListar.flatMap((r) => r.codigos),
    ...equivRes.rows.flatMap((r) => r.codigos),
    ...gruposTelefono.flatMap((g) => g.codigos),
    ...gruposPin.flatMap((g) => g.codigos),
  ];
  const contexto = await enriquecerClientes(todosCodigos, activoOdooPorRuc);

  function ventasMaxGrupo(codigos) {
    return codigos.reduce((max, cod) => Math.max(max, contexto.get(cod)?.ventas_12m || 0), 0);
  }

  const senalFuerteItems = fuerteRes.rows
    .map((r) => ({ identificacion: r.identificacion_cliente, nombre: r.nombre_cliente, company_id: r.company_id, codigos: r.codigos, ventas_12m_max: ventasMaxGrupo(r.codigos) }))
    .sort((a, b) => b.ventas_12m_max - a.ventas_12m_max);

  const senalFuerteNormalizadaItems = fuerteNormalizadaGrupos
    .map((r) => ({ identificacion: r.ruc, nombres: r.nombres, company_id: r.company_id_muestra, codigos: r.codigos, ventas_12m_max: ventasMaxGrupo(r.codigos) }))
    .sort((a, b) => b.ventas_12m_max - a.ventas_12m_max);

  const senalDebilItems = debilParaListar
    .map((r) => ({ identificacion: r.ruc, nombres: r.nombres, company_id: r.company_id_muestra, codigos: r.codigos, num_nombres_distintos: r.num_nombres_distintos, ventas_12m_max: ventasMaxGrupo(r.codigos) }))
    .sort((a, b) => b.ventas_12m_max - a.ventas_12m_max);

  const equivalenciaItems = equivRes.rows
    .map((r) => ({ clave_10_digitos: r.clave10, identificaciones: r.identificaciones, nombres: r.nombres, codigos: r.codigos, ventas_12m_max: ventasMaxGrupo(r.codigos) }))
    .sort((a, b) => b.ventas_12m_max - a.ventas_12m_max);

  const telefonoItems = gruposTelefono
    .map((g) => ({ telefono_normalizado: g.clave, codigos: g.codigos, pares: g.pares, ventas_12m_max: ventasMaxGrupo(g.codigos) }))
    .sort((a, b) => b.ventas_12m_max - a.ventas_12m_max);

  const pinItems = gruposPin
    .map((g) => ({ pin: g.clave, codigos: g.codigos, pares: g.pares, ventas_12m_max: ventasMaxGrupo(g.codigos) }))
    .sort((a, b) => b.ventas_12m_max - a.ventas_12m_max);

  if (formatoSalida === "resumen_por_tipo") {
    return {
      senal_fuerte: { total: senalFuerteItems.length, por_estado_odoo: porEstadoOdooCodigos(senalFuerteItems, (i) => i.codigos, contexto) },
      senal_fuerte_normalizada: { total: senalFuerteNormalizadaItems.length, por_estado_odoo: porEstadoOdooCodigos(senalFuerteNormalizadaItems, (i) => i.codigos, contexto) },
      senal_debil: {
        total: debilGenuino.length,
        cadenas_grandes_excluidas_del_listado: incluirCadenas ? 0 : cadenasGrandesExcluidas,
        por_estado_odoo: porEstadoOdooCodigos(senalDebilItems, (i) => i.codigos, contexto),
      },
      equivalencia_cedula_ruc: { total: equivalenciaItems.length, por_estado_odoo: porEstadoOdooCodigos(equivalenciaItems, (i) => i.codigos, contexto) },
      mismo_telefono: { total: telefonoItems.length, por_estado_odoo: porEstadoOdooCodigos(telefonoItems, (i) => i.codigos, contexto) },
      mismo_pin: { total: pinItems.length, por_estado_odoo: porEstadoOdooCodigos(pinItems, (i) => i.codigos, contexto) },
      nombres_problematicos: { total: nombresProbRes.rows.length, por_estado_odoo: porEstadoOdoo(nombresProbRes.rows, (r) => r.ruc, activoOdooPorRuc) },
    };
  }

  function conDetalle(items, totalReal) {
    const pagina = paginar(items, offset, limite, totalReal);
    return { ...pagina, items: pagina.items.map((it) => ({ ...it, ...detalleCodigos(it.codigos, contexto) })) };
  }

  return {
    senal_fuerte: {
      descripcion: "Mismo RUC+company_id+nombre EXACTO en 2+ codigo_cliente — duplicado real de maestro.",
      por_estado_odoo: porEstadoOdooCodigos(senalFuerteItems, (i) => i.codigos, contexto),
      ...conDetalle(senalFuerteItems),
    },
    senal_fuerte_normalizada: {
      descripcion: "Mismo RUC, nombres EXACTOS distintos pero IDÉNTICOS tras normalizar (mayúsculas, sin tildes/puntuación, sin sufijo societario) — ej. 'S.A' vs 'S.A.'. Tan confiable como senal_fuerte.",
      por_estado_odoo: porEstadoOdooCodigos(senalFuerteNormalizadaItems, (i) => i.codigos, contexto),
      ...conDetalle(senalFuerteNormalizadaItems),
    },
    senal_debil: {
      descripcion: `Mismo RUC, nombres DISTINTOS incluso normalizados — puede ser duplicado de verdad o sucursales legítimas (ej. cadenas de tiendas) de la misma empresa. Requiere revisión caso por caso. Se excluyen del LISTADO (no del total) grupos con más de ${UMBRAL_CADENA_GRANDE} nombres distintos salvo que se pida incluir_cadenas=true.`,
      cadenas_grandes_excluidas_del_listado: incluirCadenas ? 0 : cadenasGrandesExcluidas,
      por_estado_odoo: porEstadoOdooCodigos(senalDebilItems, (i) => i.codigos, contexto),
      ...conDetalle(senalDebilItems, debilGenuino.length),
    },
    equivalencia_cedula_ruc: {
      descripcion: "Mismo número base (10 dígitos) pero uno registrado como cédula y otro como RUC (los mismos 10 + '001') bajo codigo_cliente distintos — el chequeo de RUC exacto nunca los agarra porque el valor crudo difiere.",
      por_estado_odoo: porEstadoOdooCodigos(equivalenciaItems, (i) => i.codigos, contexto),
      ...conDetalle(equivalenciaItems),
    },
    mismo_telefono: {
      descripcion: `Mismo teléfono (normalizado, ≥${UMBRAL_TELEFONO_DIGITOS_MIN} dígitos) bajo RUC distinto, con nombre con similitud > ${UMBRAL_SIMILITUD_NOMBRE}.`,
      por_estado_odoo: porEstadoOdooCodigos(telefonoItems, (i) => i.codigos, contexto),
      ...conDetalle(telefonoItems),
    },
    mismo_pin: {
      descripcion: `Misma coordenada EXACTA (no nula, no (0,0), no pin-por-defecto de >5 clientes — ver categoria=coordenadas) bajo RUC distinto, con nombre con similitud > ${UMBRAL_SIMILITUD_NOMBRE}.`,
      por_estado_odoo: porEstadoOdooCodigos(pinItems, (i) => i.codigos, contexto),
      ...conDetalle(pinItems),
    },
    nombres_problematicos: {
      descripcion: "Clientes con nombre_cliente nulo, o con espacios/saltos de línea al inicio o final (antes de cualquier normalización).",
      por_estado_odoo: porEstadoOdoo(nombresProbRes.rows, (r) => r.ruc, activoOdooPorRuc),
      ...paginar(
        nombresProbRes.rows.map((r) => ({
          codigo_cliente: r.codigo_cliente,
          nombre_cliente_crudo: r.nombre_cliente,
          company_id: r.company_id,
          activo_odoo: clasificarActivoOdoo(r.ruc, activoOdooPorRuc),
        })),
        offset,
        limite
      ),
    },
  };
}

// ============================================================
// 4) Sin canal asignado (MobilVendor-only — ver punto 3 de la investigación: Odoo no tiene un equivalente poblado)
// ============================================================
function sqlSinCanal() {
  return `
    SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente, codigo_subcanal, company_id, TRIM(identificacion_cliente) AS ruc
    FROM clientes
    WHERE codigo_tipo_negocio IS NULL
      AND ($1::text IS NULL OR company_id = $1)
    ORDER BY codigo_cliente;
  `;
}

async function auditarSinCanal(companyId, offset, limite, formatoSalida, activoOdooPorRuc) {
  const { rows } = await pool.query(sqlSinCanal(), [companyId || null]);
  if (formatoSalida === "resumen_por_tipo") {
    return { total: rows.length, por_estado_odoo: porEstadoOdoo(rows, (r) => r.ruc, activoOdooPorRuc) };
  }
  const items = rows.map((r) => ({
    codigo_cliente: r.codigo_cliente,
    nombre_cliente: nombreCliente(r),
    company_id: r.company_id,
    activo_odoo: clasificarActivoOdoo(r.ruc, activoOdooPorRuc),
    sin_subcanal_tambien: r.codigo_subcanal === null,
  }));
  return { ...paginar(items, offset, limite), por_estado_odoo: porEstadoOdoo(rows, (r) => r.ruc, activoOdooPorRuc) };
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

function sqlClientesConRuc() {
  return `
    SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente, TRIM(identificacion_cliente) AS ruc, company_id
    FROM clientes
    WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
      AND ($1::text IS NULL OR company_id = $1);
  `;
}

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

async function auditarActivosSinConsumo(companyId, umbralDias, offset, limite, formatoSalida, activoOdooPorRuc) {
  const [ultimaRes, clientesRes] = await Promise.all([
    pool.query(SQL_ULTIMA_COMPRA_GLOBAL),
    pool.query(sqlClientesConRuc(), [companyId || null]),
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
        company_id: c.company_id,
        ultima_compra: ultimaDia ? ultimaDia.toISOString().slice(0, 10) : null,
        dias_desde_ultima: dias,
        nunca_compro: dias === null,
      });
    }
  }
  candidatos.sort((a, b) => (b.dias_desde_ultima ?? 999999) - (a.dias_desde_ultima ?? 999999));

  const base = {
    descripcion: "Clientes marcados 'activo' en Odoo (res.partner.active=true, la única señal confiable encontrada) sin ninguna compra registrada en más de umbral_dias_inactividad días, o que nunca compraron — candidatos a archivar, requiere revisión humana.",
    umbral_dias_inactividad: umbralDias,
    sin_señal_confiable_de_activo: sinMatchOdoo,
  };
  if (formatoSalida === "resumen_por_tipo") return { ...base, total: candidatos.length };
  return { ...base, ...paginar(candidatos, offset, limite) };
}

async function auditoriaClientes({
  categoria,
  umbral_dias_inactividad = UMBRAL_DIAS_INACTIVIDAD_DEFAULT,
  limite = LIMITE_DEFAULT,
  offset = 0,
  formato_salida = "json",
  company_id,
  listar_companias,
  tipo_problema,
  solo_activos_dias,
  incluir_cadenas,
}) {
  if (listar_companias) {
    return { companias: await listarCompanias() };
  }

  // `activoOdooPorRuc` se trae UNA sola vez por llamada (ver comentario
  // grande sobre el reporte de Kenny Navas, 2026-10-01) y se reutiliza en
  // las 5 categorías — antes solo `activos_sin_consumo` la pedía.
  const activoOdooPorRuc = await fetchOdooActivoPorRuc();

  if (categoria) {
    let resultado;
    if (categoria === "direcciones_incompletas") resultado = await auditarDireccionesIncompletas(company_id, offset, limite, formato_salida, activoOdooPorRuc);
    else if (categoria === "coordenadas") resultado = await auditarCoordenadas(company_id, tipo_problema, offset, limite, formato_salida, solo_activos_dias, activoOdooPorRuc);
    else if (categoria === "duplicados") resultado = await auditarDuplicados(company_id, offset, limite, formato_salida, incluir_cadenas, activoOdooPorRuc);
    else if (categoria === "sin_canal") resultado = await auditarSinCanal(company_id, offset, limite, formato_salida, activoOdooPorRuc);
    else if (categoria === "activos_sin_consumo") resultado = await auditarActivosSinConsumo(company_id, umbral_dias_inactividad, offset, limite, formato_salida, activoOdooPorRuc);
    return { categoria, company_id: company_id || null, ...resultado };
  }

  // Sin categoría: resumen de las 5, con una muestra chica de cada una
  // (MUESTRA_RESUMEN, no `limite` — para pedir el detalle completo de una
  // categoría, se debe pasar `categoria` explícito).
  const [direcciones, coordenadas, duplicados, sinCanal, activosSinConsumo] = await Promise.all([
    auditarDireccionesIncompletas(company_id, 0, MUESTRA_RESUMEN, "json", activoOdooPorRuc),
    auditarCoordenadas(company_id, tipo_problema, 0, MUESTRA_RESUMEN, "json", solo_activos_dias, activoOdooPorRuc),
    auditarDuplicados(company_id, 0, MUESTRA_RESUMEN, "json", incluir_cadenas, activoOdooPorRuc),
    auditarSinCanal(company_id, 0, MUESTRA_RESUMEN, "json", activoOdooPorRuc),
    auditarActivosSinConsumo(company_id, umbral_dias_inactividad, 0, MUESTRA_RESUMEN, "json", activoOdooPorRuc),
  ]);

  return {
    nota: "Resumen de las 5 categorías con muestra chica (5) de cada una. Para el listado completo de una categoría (hasta `limite`, con `offset`), volver a llamar pasando `categoria`.",
    company_id: company_id || null,
    direcciones_incompletas: direcciones,
    coordenadas: coordenadas,
    duplicados,
    sin_canal: sinCanal,
    activos_sin_consumo: activosSinConsumo,
  };
}

module.exports = { auditoriaClientes, inputSchema, CATEGORIAS_VALIDAS, TIPOS_PROBLEMA_COORDENADAS };
