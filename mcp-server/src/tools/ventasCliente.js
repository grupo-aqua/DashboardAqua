// src/tools/ventasCliente.js
// Historial de ventas de un cliente específico, buscado por nombre parcial
// (el usuario no escribe el nombre exacto tal cual está en la base).
// Filtros opcionales combinables (AND) por categoría de producto y/o por
// un producto específico (también buscado por nombre parcial).
//
// Caso multi-compañía: una misma entidad (mismo identificacion_cliente/RUC,
// mismo nombre) puede existir varias veces en `clientes` con distinto
// codigo_cliente porque está facturada desde distintas compañías del grupo
// (company_id/descripcion_company — GRUPOAQUA S.A., DISTRINTER, IIBC, etc.).
// Cuando la búsqueda por nombre cae en ese caso, no se trata como una
// ambigüedad genérica: se informa explícitamente (`es_multicompania`) para
// que el asistente pueda preguntar en términos de negocio ("¿las tres
// compañías o solo una?") en vez de un código sin contexto. La respuesta
// puede entonces repetirse pasando `codigo_cliente` (uno o varios) para
// pedir el consolidado o una compañía puntual sin volver a resolver el
// nombre.
//
// Nombres incompletos/con errores: la búsqueda por nombre normaliza tildes
// y mayúsculas con unaccent() (sin umbral, no es difusa). Si aun así da
// cero resultados (typo, palabra faltante), corre un fallback de similitud
// (pg_trgm) y devuelve una lista de `sugerencias` — nunca se autoselecciona
// ninguna, es solo un "¿quisiste decir...?" para que el asistente confirme.
//
// ============================================================
// `solo_notas_credito` (agregado 2026-09-16) — pedido real: un gerente
// necesita ver las notas de crédito de un cliente como movimientos propios
// (fecha, código, monto, comentario), no enterradas dentro del neto de
// `por_direccion`/`por_mes`/`por_compania`/`total` — que YA restan las
// notas de las ventas brutas (correcto, no se toca: ver `tipo_movimiento =
// 'out_refund'` en SQL_HISTORIAL, CASE que resta con signo). Caso real que
// motivó esto: CORPORACIÓN EL ROSADO, dirección "CD COMISARIATO"
// (codigo_direccion 113138 del codigo_cliente 110470), rango 2026-01-01 a
// 2026-09-16 — el neto normal muestra esa dirección en -$316,261.45 (~180
// notas de crédito de ese período acumuladas contra ventas normales), sin
// forma de ver cada nota por separado.
//
// Reutiliza la MISMA resolución de cliente (nombre parcial, desambiguación,
// multicompañía) que el resto de la tool — solo cambia qué se consulta
// después de resolver el cliente. `categoria`/`producto` no aplican en este
// modo (una nota de crédito es un documento completo, no tiene sentido
// filtrarla por línea de producto para este reporte) — si se pasan junto
// con `solo_notas_credito: true`, se ignoran silenciosamente, documentado
// acá y en el inputSchema para que no sea una sorpresa.
//
// Signo del monto: se muestra el monto CRUDO del documento (`facturas.total`,
// que se guarda POSITIVO — confirmado con datos reales), NO el signo negado
// que usa SQL_HISTORIAL para netear contra ventas. Es una decisión
// deliberada: este reporte está AISLADO de las ventas (no hay nada que
// netear acá), así que un monto positivo = "esto es lo que se acreditó",
// más claro para leer que un negativo fuera de contexto de netting.
// ============================================================
const { z } = require("zod");
const { pool } = require("../db");
const { finExclusivo, diffDias } = require("../util/fechas");
const { CATEGORIAS_VALIDAS } = require("../sql/clasificacion");

const MAX_RANGO_DIAS = 800; // "los últimos meses" puede ser un rango largo
const MAX_CANDIDATOS = 20;
const MIN_LARGO_NOMBRE = 3;
const MAX_CODIGOS_CLIENTE = 10;
const UMBRAL_SIMILITUD_SUGERENCIA = 0.3;
const MAX_SUGERENCIAS = 5;

const inputSchema = {
  nombre_cliente: z.string().min(MIN_LARGO_NOMBRE, `mínimo ${MIN_LARGO_NOMBRE} caracteres`).optional(),
  codigo_cliente: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_CODIGOS_CLIENTE, `máximo ${MAX_CODIGOS_CLIENTE} códigos por consulta`)
    .optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoria: z.enum(CATEGORIAS_VALIDAS).optional(),
  producto: z.string().min(MIN_LARGO_NOMBRE, `mínimo ${MIN_LARGO_NOMBRE} caracteres`).optional(),
  // Ver comentario grande del archivo. Ignora categoria/producto si vienen
  // junto con esto (documentado, no es un error).
  solo_notas_credito: z.boolean().optional(),
};

// Escapa los caracteres especiales de LIKE/ILIKE (% y _) que el usuario
// pudiera escribir sin querer usarlos como wildcard — el patrón sigue yendo
// como parámetro de pg ($1), esto es corrección de resultados, no el
// mecanismo de seguridad contra inyección.
function escaparComodinesLike(texto) {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// unaccent(...) ILIKE unaccent($1): normaliza tildes/mayúsculas en ambos
// lados de la comparación — es corrección exacta, no búsqueda difusa (sin
// umbral, sin falsos positivos posibles).
const SQL_BUSCAR_CLIENTE = `
  SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente,
         identificacion_cliente, company_id, descripcion_company
  FROM clientes
  WHERE unaccent(nombre_cliente) ILIKE unaccent($1) OR unaccent(nombre_comercial_cliente) ILIKE unaccent($1)
  ORDER BY nombre_cliente
  LIMIT ${MAX_CANDIDATOS + 1};
`;

// Fallback de similitud (pg_trgm) — SOLO se corre cuando la búsqueda exacta
// de arriba da cero resultados. $1 = texto crudo (NO el patrón %...% de
// ILIKE, similarity() no es un wildcard match), $2 = umbral, $3 = tope.
// Es una sugerencia "¿quisiste decir...?", nunca se autoselecciona.
const SQL_SUGERENCIAS_CLIENTE = `
  SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente,
         GREATEST(similarity(unaccent(nombre_cliente), unaccent($1)),
                  similarity(unaccent(nombre_comercial_cliente), unaccent($1))) AS similitud
  FROM clientes
  WHERE similarity(unaccent(nombre_cliente), unaccent($1)) > $2
     OR similarity(unaccent(nombre_comercial_cliente), unaccent($1)) > $2
  ORDER BY similitud DESC
  LIMIT $3;
`;

// $1 = lista de codigo_cliente (uno o varios, ya resueltos o pedidos directo)
const SQL_CLIENTES_POR_CODIGO = `
  SELECT codigo_cliente, nombre_cliente, nombre_comercial_cliente,
         identificacion_cliente, company_id, descripcion_company
  FROM clientes
  WHERE codigo_cliente = ANY($1::text[]);
`;

const SQL_BUSCAR_PRODUCTO = `
  SELECT codigo_producto, nombre_producto
  FROM productos
  WHERE nombre_producto ILIKE $1
  ORDER BY nombre_producto
  LIMIT ${MAX_CANDIDATOS + 1};
`;

// $1 = lista de codigo_cliente (uno o varios), $2 = inicio (timestamp),
// $3 = fin exclusivo (timestamp), $4 = categoria (o NULL), $5 = codigo_producto (o NULL)
//
// `facturas_dedup` — ver TODO.md (bug reportado por Kenny Navas,
// 2026-10-01, caso MUÑOZ TABAREZ): confirmado con datos reales que
// `facturas` tiene documentos DUPLICADOS para la misma venta real — mismo
// `customer_code`+mismo día+mismo `total` EXACTO, un código con
// `tipo_movimiento` poblado (ej. 'FA001-106-000000142') y un "gemelo" con
// `tipo_movimiento` vacío (ej. 'FAM6-000135'), ambos sumándose como si
// fueran 2 ventas. NO se puede excluir por prefijo de código a ciegas:
// confirmado que ~11 de 37 documentos con ese patrón NO tienen gemelo —
// son la ÚNICA representación real de esa venta, excluirlos borraría
// ingresos reales. Por eso el descarte es CONSCIENTE DEL GEMELO: una fila
// con `tipo_movimiento` vacío se descarta SOLO cuando existe otra fila del
// mismo cliente/día/monto con `tipo_movimiento` poblado — nunca a ciegas.
// Causa de fondo (por qué el sync crea el segundo documento) queda
// pendiente de investigar aparte, ver TODO.md — este fix ataca el
// síntoma con evidencia real, no la causa de sync.
const SQL_HISTORIAL = `
  WITH facturas_dedup AS (
    SELECT f.*
    FROM facturas f
    WHERE f.status = 2
      AND f.customer_code = ANY($1::text[])
      AND f.fecha_creacion >= $2
      AND f.fecha_creacion <  $3
      AND NOT (
        (f.tipo_movimiento IS NULL OR f.tipo_movimiento = '')
        AND EXISTS (
          SELECT 1 FROM facturas g
          WHERE g.customer_code = f.customer_code
            AND g.fecha_creacion::date = f.fecha_creacion::date
            AND g.total = f.total
            AND g.status = 2
            AND g.tipo_movimiento IS NOT NULL AND g.tipo_movimiento <> ''
            AND g.code <> f.code
        )
      )
  ),
  base AS (
    SELECT
      o.fecha_creacion AS fecha,
      o.customer_code AS codigo_cliente_fila,
      o.customer_address_code AS direccion_code,
      dd.codigo_producto AS producto_code,
      dd.descripcion AS producto_descripcion,
      dd.cantidad AS unidades,
      dd.total    AS dolares,
      o.code      AS doc_code
    FROM ordenes o
    JOIN detalle_documento dd ON dd.documento_code = o.code
    WHERE o.status = 2
      AND o.origen_sistema = 'MOBILVENDOR'
      AND o.customer_code = ANY($1::text[])
      AND o.fecha_creacion >= $2
      AND o.fecha_creacion <  $3
      AND ($4::text IS NULL OR dd.descripcion_categoria = $4)
      AND ($5::text IS NULL OR dd.codigo_producto = $5)

    UNION ALL

    SELECT
      f.fecha_creacion AS fecha,
      f.customer_code AS codigo_cliente_fila,
      f.customer_address_code AS direccion_code,
      dd.codigo_producto AS producto_code,
      dd.descripcion AS producto_descripcion,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.cantidad ELSE dd.cantidad END AS unidades,
      CASE WHEN f.tipo_movimiento = 'out_refund' THEN -dd.total    ELSE dd.total    END AS dolares,
      f.code AS doc_code
    FROM facturas_dedup f
    JOIN detalle_documento dd ON dd.documento_code = f.code
    WHERE ($4::text IS NULL OR dd.descripcion_categoria = $4)
      AND ($5::text IS NULL OR dd.codigo_producto = $5)
  )
  SELECT
    to_char(date_trunc('month', fecha), 'YYYY-MM') AS mes,
    codigo_cliente_fila,
    direccion_code,
    producto_code,
    producto_descripcion,
    SUM(unidades) AS unidades,
    SUM(dolares)  AS dolares,
    COUNT(DISTINCT doc_code) AS num_documentos
  FROM base
  GROUP BY mes, codigo_cliente_fila, direccion_code, producto_code, producto_descripcion
  ORDER BY mes;
`;

// $1 = lista de codigo_cliente (puede ser más de uno en el caso multi-compañía)
const SQL_DIRECCIONES = `
  SELECT codigo_direccion_cliente, descripcion_direccion_cliente, calle1_direccion_cliente
  FROM direcciones_clientes
  WHERE codigo_cliente = ANY($1::text[])
    AND codigo_direccion_cliente = ANY($2::text[]);
`;

const SQL_NOMBRES_PRODUCTOS = `
  SELECT codigo_producto, nombre_producto
  FROM productos
  WHERE codigo_producto = ANY($1::text[]);
`;

// Notas de crédito puras — ver comentario grande del archivo. A nivel de
// DOCUMENTO (no de línea de detalle_documento, a diferencia de
// SQL_HISTORIAL): una nota de crédito es un movimiento completo, no algo
// que tenga sentido filtrar por producto. `status = 2` = posteada
// (mismo filtro que la rama `facturas` de SQL_HISTORIAL). $1 = lista de
// codigo_cliente, $2 = inicio (timestamp), $3 = fin exclusivo (timestamp).
const SQL_NOTAS_CREDITO = `
  SELECT
    f.code AS codigo,
    f.customer_code AS codigo_cliente_fila,
    f.customer_address_code AS direccion_code,
    f.fecha_creacion AS fecha,
    f.total AS dolares,
    f.notes AS comentario_crudo
  FROM facturas f
  WHERE f.tipo_movimiento = 'out_refund'
    AND f.status = 2
    AND f.customer_code = ANY($1::text[])
    AND f.fecha_creacion >= $2
    AND f.fecha_creacion <  $3
  ORDER BY f.fecha_creacion DESC;
`;

// `facturas.notes` trae HTML crudo (ej. "<p>\nHIPERMARKET VIA DAULE\n...\n</p>")
// — limpieza de presentación, no una decisión de negocio: quita tags,
// decodifica las 2 entidades reales encontradas en los datos (&nbsp;/&amp;
// — confirmado con datos reales, no hay más) y colapsa espacios/saltos de
// línea para que el comentario sea legible.
function limpiarComentarioNota(notasCrudas) {
  if (!notasCrudas) return null;
  const texto = notasCrudas
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return texto.length > 0 ? texto : null;
}

async function buscarSugerenciasCliente(textoCrudo) {
  const { rows } = await pool.query(SQL_SUGERENCIAS_CLIENTE, [
    textoCrudo,
    UMBRAL_SIMILITUD_SUGERENCIA,
    MAX_SUGERENCIAS,
  ]);
  return rows.map((r) => ({
    codigo_cliente: r.codigo_cliente,
    nombre_cliente: r.nombre_cliente,
    nombre_comercial_cliente: r.nombre_comercial_cliente,
    similitud: Number(r.similitud.toFixed(2)),
  }));
}

async function buscarUno(sql, patron, camposCandidato) {
  const { rows } = await pool.query(sql, [patron]);
  if (rows.length === 0) return { estado: "sin_coincidencias", candidatos: [] };
  if (rows.length > 1) {
    return {
      estado: "coincidencias_multiples",
      candidatos: rows.slice(0, MAX_CANDIDATOS).map((r) => {
        const c = {};
        camposCandidato.forEach((campo) => (c[campo] = r[campo]));
        return c;
      }),
      truncado: rows.length > MAX_CANDIDATOS,
    };
  }
  return { estado: "resuelto", fila: rows[0] };
}

async function ventasCliente({
  nombre_cliente,
  codigo_cliente,
  fecha_inicio,
  fecha_fin,
  categoria,
  producto,
  solo_notas_credito,
}) {
  const largoDias = diffDias(fecha_inicio, fecha_fin);
  if (largoDias < 0) throw new Error("fecha_inicio no puede ser posterior a fecha_fin");
  if (largoDias > MAX_RANGO_DIAS) throw new Error(`rango máximo permitido: ${MAX_RANGO_DIAS} días`);
  if (!nombre_cliente && !(codigo_cliente && codigo_cliente.length > 0)) {
    throw new Error("se requiere nombre_cliente o codigo_cliente");
  }

  // 1) Resolver cliente(s). Si viene `codigo_cliente` explícito (típicamente
  //    una llamada de seguimiento tras un resultado es_multicompania), se usa
  //    directo y no se vuelve a resolver por nombre.
  let clientesResueltos;
  let codigosNoEncontrados = [];

  if (codigo_cliente && codigo_cliente.length > 0) {
    const { rows } = await pool.query(SQL_CLIENTES_POR_CODIGO, [codigo_cliente]);
    if (rows.length === 0) {
      return { encontrado: false, motivo: "codigo_cliente_no_encontrado", codigos_solicitados: codigo_cliente };
    }
    clientesResueltos = rows;
    codigosNoEncontrados = codigo_cliente.filter((c) => !rows.some((r) => r.codigo_cliente === c));
  } else {
    const patronCliente = `%${escaparComodinesLike(nombre_cliente)}%`;
    const resultCliente = await buscarUno(SQL_BUSCAR_CLIENTE, patronCliente, [
      "codigo_cliente",
      "nombre_cliente",
      "nombre_comercial_cliente",
      "identificacion_cliente",
      "company_id",
      "descripcion_company",
    ]);
    if (resultCliente.estado === "sin_coincidencias") {
      const sugerencias = await buscarSugerenciasCliente(nombre_cliente);
      return { encontrado: false, motivo: "sin_coincidencias_cliente", candidatos: [], sugerencias };
    }
    if (resultCliente.estado === "coincidencias_multiples") {
      const candidatos = resultCliente.candidatos;
      const identificacionesUnicas = new Set(candidatos.map((c) => c.identificacion_cliente).filter(Boolean));
      const nombresUnicos = new Set(candidatos.map((c) => c.nombre_cliente));
      // Multi-compañía real: es la MISMA entidad (mismo RUC/cédula y mismo
      // nombre), solo facturada desde distintas compañías del grupo — no
      // clientes distintos que coinciden de nombre por casualidad.
      const esMismaEntidad =
        !resultCliente.truncado &&
        candidatos.every((c) => c.identificacion_cliente) &&
        identificacionesUnicas.size === 1 &&
        nombresUnicos.size === 1;

      if (esMismaEntidad) {
        return {
          encontrado: false,
          motivo: "cliente_multicompania",
          es_multicompania: true,
          cliente: {
            nombre_cliente: candidatos[0].nombre_cliente,
            nombre_comercial_cliente: candidatos[0].nombre_comercial_cliente,
            identificacion_cliente: candidatos[0].identificacion_cliente,
          },
          companias: candidatos.map((c) => ({
            codigo_cliente: c.codigo_cliente,
            company_id: c.company_id,
            descripcion_company: c.descripcion_company,
          })),
        };
      }

      return {
        encontrado: false,
        motivo: "coincidencias_multiples_cliente",
        candidatos: candidatos.map(({ codigo_cliente: cc, nombre_cliente: nc, nombre_comercial_cliente: ncc }) => ({
          codigo_cliente: cc,
          nombre_cliente: nc,
          nombre_comercial_cliente: ncc,
        })),
        candidatos_truncados: resultCliente.truncado,
      };
    }
    clientesResueltos = [resultCliente.fila];
  }

  // Forma resumida del/los cliente(s) resuelto(s), reutilizada en las
  // respuestas de error de abajo y en el resultado final.
  const clienteInfoResumen =
    clientesResueltos.length === 1
      ? {
          codigo_cliente: clientesResueltos[0].codigo_cliente,
          nombre_cliente: clientesResueltos[0].nombre_cliente,
          nombre_comercial_cliente: clientesResueltos[0].nombre_comercial_cliente,
        }
      : {
          nombre_cliente: clientesResueltos[0].nombre_cliente,
          nombre_comercial_cliente: clientesResueltos[0].nombre_comercial_cliente,
          es_multicompania: true,
          companias: clientesResueltos.map((c) => ({
            codigo_cliente: c.codigo_cliente,
            company_id: c.company_id,
            descripcion_company: c.descripcion_company,
          })),
        };

  // 1.5) Modo notas de crédito puras — corta el flujo normal acá, antes de
  //      resolver producto/categoria (no aplican, ver comentario grande del
  //      archivo). Reutiliza codigosClientes/inicioTs/finTs más abajo, pero
  //      como este modo termina la función, se calculan localmente para no
  //      adelantar código que el flujo normal no necesita.
  if (solo_notas_credito) {
    const codigosClientesNotas = clientesResueltos.map((c) => c.codigo_cliente);
    const inicioTsNotas = `${fecha_inicio} 00:00:00`;
    const finTsNotas = `${finExclusivo(fecha_fin)} 00:00:00`;

    const { rows: filasNotas } = await pool.query(SQL_NOTAS_CREDITO, [
      codigosClientesNotas,
      inicioTsNotas,
      finTsNotas,
    ]);

    const direccionesCodigosNotas = [
      ...new Set(filasNotas.map((f) => f.direccion_code).filter(Boolean)),
    ];
    let descripcionesPorCodigoNotas = {};
    if (direccionesCodigosNotas.length > 0) {
      const { rows: direccionesNotas } = await pool.query(SQL_DIRECCIONES, [
        codigosClientesNotas,
        direccionesCodigosNotas,
      ]);
      descripcionesPorCodigoNotas = Object.fromEntries(
        direccionesNotas.map((d) => [
          d.codigo_direccion_cliente,
          d.descripcion_direccion_cliente || d.calle1_direccion_cliente || null,
        ])
      );
    }

    const notasCredito = filasNotas.map((f) => ({
      codigo: f.codigo,
      fecha: f.fecha.toISOString().slice(0, 10),
      ...(clientesResueltos.length > 1 ? { codigo_cliente: f.codigo_cliente_fila } : {}),
      codigo_direccion: f.direccion_code || null,
      descripcion_direccion: f.direccion_code ? descripcionesPorCodigoNotas[f.direccion_code] || null : null,
      dolares: Number(f.dolares) || 0,
      comentario: limpiarComentarioNota(f.comentario_crudo),
    }));

    const dolaresTotalNotas = notasCredito.reduce((acc, n) => acc + n.dolares, 0);

    const resultadoNotas = {
      encontrado: true,
      cliente: clienteInfoResumen,
      solo_notas_credito: true,
      rango: { fecha_inicio, fecha_fin },
      total_notas_credito: {
        dolares: Number(dolaresTotalNotas.toFixed(2)),
        num_notas: notasCredito.length,
      },
      notas_credito: notasCredito,
    };

    // por_compania: mismo criterio que el flujo normal — siempre que se
    // consulte más de un codigo_cliente, para que el total nunca se
    // entregue sin su desglose auditable.
    if (clientesResueltos.length > 1) {
      const porCompaniaNotasMap = new Map();
      for (const n of notasCredito) {
        const actual = porCompaniaNotasMap.get(n.codigo_cliente) || { dolares: 0, num_notas: 0 };
        actual.dolares += n.dolares;
        actual.num_notas += 1;
        porCompaniaNotasMap.set(n.codigo_cliente, actual);
      }
      resultadoNotas.por_compania = clientesResueltos
        .map((c) => {
          const v = porCompaniaNotasMap.get(c.codigo_cliente) || { dolares: 0, num_notas: 0 };
          return {
            codigo_cliente: c.codigo_cliente,
            company_id: c.company_id,
            descripcion_company: c.descripcion_company,
            dolares: Number(v.dolares.toFixed(2)),
            num_notas: v.num_notas,
          };
        })
        .sort((a, b) => b.dolares - a.dolares);
    }
    if (codigosNoEncontrados.length > 0) resultadoNotas.codigos_no_encontrados = codigosNoEncontrados;

    return resultadoNotas;
  }

  // 2) Resolver producto, solo si se pidió.
  let productoResuelto = null;
  if (producto) {
    const patronProducto = `%${escaparComodinesLike(producto)}%`;
    const resultProducto = await buscarUno(SQL_BUSCAR_PRODUCTO, patronProducto, ["codigo_producto", "nombre_producto"]);
    if (resultProducto.estado === "sin_coincidencias") {
      return {
        encontrado: false,
        motivo: "sin_coincidencias_producto",
        cliente: clienteInfoResumen,
        candidatos_producto: [],
      };
    }
    if (resultProducto.estado === "coincidencias_multiples") {
      return {
        encontrado: false,
        motivo: "coincidencias_multiples_producto",
        cliente: clienteInfoResumen,
        candidatos_producto: resultProducto.candidatos,
        candidatos_producto_truncados: resultProducto.truncado,
      };
    }
    productoResuelto = resultProducto.fila;
  }

  // 3) Historial de ventas, con categoria/producto como filtros opcionales.
  //    codigosClientes puede tener más de un elemento (consolidado
  //    multi-compañía); SQL_HISTORIAL filtra con ANY(...) y devuelve también
  //    el codigo_cliente de cada fila para poder desglosar por compañía.
  const codigosClientes = clientesResueltos.map((c) => c.codigo_cliente);
  const inicioTs = `${fecha_inicio} 00:00:00`;
  const finTs = `${finExclusivo(fecha_fin)} 00:00:00`;
  const categoriaParam = categoria || null;
  const productoParam = productoResuelto ? productoResuelto.codigo_producto : null;

  const { rows: filas } = await pool.query(SQL_HISTORIAL, [
    codigosClientes,
    inicioTs,
    finTs,
    categoriaParam,
    productoParam,
  ]);

  const porMesMap = new Map();
  const porDireccionMap = new Map();
  const porProductoMap = new Map();
  const porCompaniaMap = new Map();
  let dolaresTotales = 0;
  let unidadesTotales = 0;
  let numDocumentosTotal = 0;

  for (const f of filas) {
    const dolares = Number(f.dolares) || 0;
    const unidades = Number(f.unidades) || 0;
    const numDocumentos = Number(f.num_documentos) || 0;
    dolaresTotales += dolares;
    unidadesTotales += unidades;
    numDocumentosTotal += numDocumentos;

    const mesActual = porMesMap.get(f.mes) || { dolares: 0, unidades: 0 };
    mesActual.dolares += dolares;
    mesActual.unidades += unidades;
    porMesMap.set(f.mes, mesActual);

    const direccionKey = f.direccion_code || "SIN_DIRECCION";
    const dirActual = porDireccionMap.get(direccionKey) || { dolares: 0, unidades: 0 };
    dirActual.dolares += dolares;
    dirActual.unidades += unidades;
    porDireccionMap.set(direccionKey, dirActual);

    const productoKey = f.producto_code || "SIN_PRODUCTO";
    const prodActual = porProductoMap.get(productoKey) || {
      dolares: 0,
      unidades: 0,
      descripcion: f.producto_descripcion || null,
    };
    prodActual.dolares += dolares;
    prodActual.unidades += unidades;
    porProductoMap.set(productoKey, prodActual);

    const companiaActual = porCompaniaMap.get(f.codigo_cliente_fila) || { dolares: 0, unidades: 0, num_documentos: 0 };
    companiaActual.dolares += dolares;
    companiaActual.unidades += unidades;
    companiaActual.num_documentos += numDocumentos;
    porCompaniaMap.set(f.codigo_cliente_fila, companiaActual);
  }

  const direccionesCodigos = [...porDireccionMap.keys()].filter((k) => k !== "SIN_DIRECCION");
  let descripcionesPorCodigo = {};
  if (direccionesCodigos.length > 0) {
    const { rows: direcciones } = await pool.query(SQL_DIRECCIONES, [codigosClientes, direccionesCodigos]);
    descripcionesPorCodigo = Object.fromEntries(
      direcciones.map((d) => [
        d.codigo_direccion_cliente,
        d.descripcion_direccion_cliente || d.calle1_direccion_cliente || null,
      ])
    );
  }

  // por_producto solo se calcula si hay un filtro aplicado (categoria o
  // producto) — sin filtro, el historial completo podría tener decenas de
  // productos distintos y no aporta a la pregunta original.
  let porProducto;
  if (categoriaParam || productoParam) {
    const productosCodigos = [...porProductoMap.keys()].filter((k) => k !== "SIN_PRODUCTO");
    let nombresCanonicos = {};
    if (productosCodigos.length > 0) {
      const { rows: productosRows } = await pool.query(SQL_NOMBRES_PRODUCTOS, [productosCodigos]);
      nombresCanonicos = Object.fromEntries(productosRows.map((p) => [p.codigo_producto, p.nombre_producto]));
    }
    porProducto = [...porProductoMap.entries()]
      .map(([codigo, v]) => ({
        codigo_producto: codigo === "SIN_PRODUCTO" ? null : codigo,
        descripcion: codigo === "SIN_PRODUCTO" ? null : nombresCanonicos[codigo] || v.descripcion,
        dolares: Number(v.dolares.toFixed(2)),
        unidades: v.unidades,
      }))
      .sort((a, b) => b.dolares - a.dolares);
  }

  // por_compania: SIEMPRE que se consulta más de un codigo_cliente a la vez
  // (consolidado multi-compañía), para que el total nunca se entregue como
  // un número ciego — siempre auditable contra su desglose.
  let porCompania;
  if (clientesResueltos.length > 1) {
    porCompania = clientesResueltos
      .map((c) => {
        const v = porCompaniaMap.get(c.codigo_cliente) || { dolares: 0, unidades: 0, num_documentos: 0 };
        return {
          codigo_cliente: c.codigo_cliente,
          company_id: c.company_id,
          descripcion_company: c.descripcion_company,
          dolares: Number(v.dolares.toFixed(2)),
          unidades: v.unidades,
          num_documentos: v.num_documentos,
        };
      })
      .sort((a, b) => b.dolares - a.dolares);
  }

  const resultado = {
    encontrado: true,
    cliente: clienteInfoResumen,
    filtros: {
      categoria: categoriaParam,
      producto: productoResuelto
        ? { codigo_producto: productoResuelto.codigo_producto, nombre_producto: productoResuelto.nombre_producto }
        : null,
    },
    rango: { fecha_inicio, fecha_fin },
    total: {
      dolares: Number(dolaresTotales.toFixed(2)),
      unidades: unidadesTotales,
      num_documentos: numDocumentosTotal,
    },
    por_mes: [...porMesMap.entries()]
      .map(([mes, v]) => ({ mes, dolares: Number(v.dolares.toFixed(2)), unidades: v.unidades }))
      .sort((a, b) => a.mes.localeCompare(b.mes)),
    por_direccion: [...porDireccionMap.entries()]
      .map(([codigo, v]) => ({
        codigo_direccion: codigo === "SIN_DIRECCION" ? null : codigo,
        descripcion: codigo === "SIN_DIRECCION" ? null : descripcionesPorCodigo[codigo] || null,
        dolares: Number(v.dolares.toFixed(2)),
        unidades: v.unidades,
      }))
      .sort((a, b) => b.dolares - a.dolares),
  };
  if (porProducto) resultado.por_producto = porProducto;
  if (porCompania) resultado.por_compania = porCompania;
  if (codigosNoEncontrados.length > 0) resultado.codigos_no_encontrados = codigosNoEncontrados;

  return resultado;
}

module.exports = { ventasCliente, inputSchema };
