// src/sql/clasificacion.js
// Fuente única de la clasificación por grupo de ruta (seller_code/route_code),
// portada originalmente del patrón en
// backend/controllers/controllerBotellones/botellonesController.js (objeto
// GRUPOS + el SQL de obtenerGrupoBotellon), generalizada a TODAS las
// categorías de producto — el backend original la usa solo para BOTELLÓN.
//
// OJO: "portada del patrón del backend" NO significa "ya validado" — el
// criterio de EMPRESAS que traía el backend original (`seller_code ILIKE
// 'E%'` en facturas) tenía un bug real (ver corrección 2026-09-08 más abajo)
// que se heredó acá tal cual. `botellonesController.js` y
// `ventasController.js` tienen el MISMO bug (y uno de los dos, un bug propio
// adicional de doble conteo) sin corregir todavía — ver TODO.md, esta rama
// corrige solo mcp-server.
//
// Son fragmentos de texto SQL ESTÁTICOS (constantes de código, no vienen de
// input de usuario) — el ruta/grupo/fechas que sí vienen del usuario siempre
// se pasan como parámetros $1, $2, ... en cada tool, nunca concatenados aquí.

// CORRECCIÓN 2026-09-29 (bug real reportado por el usuario, encontrado
// durante el trabajo de automatización del cuadro de liquidación): las
// rutas "OK" (113/131/132/132.1 — manejadas de forma completa y aparte en
// ventasRutaOk.js, que combina COTTSA + aqua-premium-ne) tienen
// `seller_code` = 'RUTA 113'/'RUTA 131'/'RUTA 132'/'RUTA 132.1' —
// empiezan con 'R' de "RUTA", así que el patrón `ILIKE 'R%'` de abajo
// (pensado para rutas rurales genuinas R1-R6/R1.2) las clasificaba sin
// querer como RURAL. Confirmado con datos reales: rutas rurales genuinas
// suman ~$289K, mientras que estas 4 rutas mal clasificadas ahí suman
// ~$2.72M — es decir, ~90% de lo que salía bajo grupo=RURAL antes de este
// fix en realidad no era rural. Decisión explícita de Alberto: grupo
// PROPIO ('RUTA_COMBINADA'), no excluirlas del todo — quedan visibles en
// las tools de grupo igual que los demás grupos, separadas de RURAL. Para
// el desglose completo (incluyendo aqua-premium-ne) seguir usando
// ventasRutaOk.js — este grupo acá solo refleja lo que ya está en
// `ordenes`/`facturas` (COTTSA), igual que cualquier otro grupo.
const SELLER_CODES_RUTA_COMBINADA_SQL = "('RUTA 113', 'RUTA 131', 'RUTA 132', 'RUTA 132.1')";

// Usado en la rama de `ordenes` (alias o). Los callers de esta rama SIEMPRE
// filtran `o.origen_sistema = 'MOBILVENDOR'` en su propio WHERE (ver
// ventasPorGrupo.js/resumenDiario.js/topProductos.js/clientesPorGrupo.js) —
// por eso EMPRESAS puede usar seller_code E% directo acá sin chequear origen
// dentro del CASE: nunca va a evaluar una fila de Odoo.
//
// CORRECCIÓN 2026-09-08: EMPRESAS no tenía rama acá — MobilVendor SÍ genera
// órdenes reales bajo seller_code E1-E10/EA1 (clientes de contado del canal
// Empresas), pero nunca se clasificaban (quedaban excluidas por
// FILTRO_ORDENES_GRUPO_VALIDO). Ver hallazgo completo en TODO.md
// ("bug real: grupo='EMPRESAS' en facturas matchea el equipo equivocado").
// NOTA: `ordenes` nunca ha tenido filas reales con estos seller_code
// (COTTSA solo los registra en `facturas`, confirmado con datos reales al
// construir ventasRutaOk.js) — la rama de 'RUTA_COMBINADA' se agrega igual
// acá por completitud/defensivo, no porque haya un caso real hoy.
const CASE_GRUPO_ORDENES = `
  CASE
    WHEN o.seller_code IN ${SELLER_CODES_RUTA_COMBINADA_SQL} THEN 'RUTA_COMBINADA'
    WHEN o.seller_code ILIKE 'M%'  THEN 'MAYORISTA'
    WHEN o.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
    WHEN o.seller_code ILIKE 'T%'  AND o.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
    WHEN o.seller_code ILIKE 'R%'  THEN 'RURAL'
    WHEN o.seller_code ILIKE 'E%'  THEN 'EMPRESAS'
    WHEN o.seller_code = '148399'  THEN 'TELEVENTA_VIP'
  END
`;

// Solo estos seller_code de `ordenes` tienen grupo conocido (ver comentario arriba).
const FILTRO_ORDENES_GRUPO_VALIDO = `
  (
    o.seller_code IN ${SELLER_CODES_RUTA_COMBINADA_SQL}
    OR o.seller_code ILIKE 'M%'
    OR o.seller_code ILIKE 'TV%'
    OR (o.seller_code ILIKE 'T%' AND o.seller_code NOT ILIKE 'TV%')
    OR o.seller_code ILIKE 'R%'
    OR o.seller_code ILIKE 'E%'
    OR o.seller_code = '148399'
  )
`;

// Usado en la rama de `facturas` (alias f). A diferencia de la rama `ordenes`,
// ACÁ SÍ conviven filas de origen ODOO y MOBILVENDOR sin filtrar por
// origen_sistema en el WHERE del caller — por eso EMPRESAS necesita
// distinguir el origen DENTRO del CASE (ver corrección de abajo).
// 'OTROS' es un catch-all deliberado (facturas que no calzan ningún canal
// conocido) — nunca se expone como grupo válido hacia afuera.
//
// CORRECCIÓN 2026-09-08: `f.seller_code ILIKE 'E%'` NUNCA matcheaba las
// facturas reales del equipo Odoo "Empresas" — esas tienen `seller_code`
// NULO (`equipo_ventas_nombre='Empresas'` es el campo real). En cambio SÍ
// matcheaba, por error, el equipo Odoo "Ventas" (seller_code E1-E10/EA1/EQ1
// — un equipo totalmente distinto, sin relación con Empresas). El criterio
// correcto son 2 fuentes separadas por origen: Odoo por `equipo_ventas_nombre`
// (NUNCA por seller_code — ese campo no sirve para identificar el equipo en
// facturas Odoo) + MobilVendor por `seller_code ILIKE 'E%'` (ahí sí es el
// criterio correcto, `equipo_ventas_nombre` no sirve del lado MobilVendor:
// siempre viene 'Ventas' o vacío, no refleja el equipo real). Confirmado con
// datos reales — ver TODO.md para los conteos completos (586 clientes Odoo +
// 154 MobilVendor-facturas + 15 MobilVendor-ordenes, 617 tras excluir
// códigos genéricos).
//
// CORRECCIÓN 2026-09-29 (pedido del usuario, investigación de suscripciones/
// venta web): las facturas del equipo Odoo "Domicilio" (`equipo_ventas_nombre
// = 'Domicilio'`, distinto del grupo DOMICILIO de seller_code A1-TA2 de
// arriba) caían en 'OTROS' — invisibles. Confirmado con datos reales
// (`clientes.codigo_tipo_negocio = 'DM-01'` = "DOMICILIO" en el catálogo
// real, mismo patrón que '29'=VIP): 91% de este bucket son suscripciones de
// agua a domicilio con débito recurrente (persona natural, ~$20.99/mes) —
// venta real de DOMICILIO, no un canal aparte. SOLO en `facturas`, nunca en
// `CASE_GRUPO_ORDENES`: 1 orden de suscripción genera hasta 21 facturas
// mensuales (ejemplo real: orden $20.99 → 21 facturas por $440.79) — sumar
// también la orden sería doble conteo del mismo contrato. 100% origen Odoo
// (0 casos MobilVendor), sin riesgo de colisión de seller_code con la rama
// de arriba. Investigación completa (incluida la venta "Website" que SÍ se
// descartó por ser el mismo documento ya contado vía `ordenes` — ver
// TODO.md) en TODO.md.
const CASE_GRUPO_FACTURAS = `
  CASE
    WHEN f.seller_code IN ('A1','A2','A3','A4.1','A5','A6','A7','TA2') THEN 'DOMICILIO'
    WHEN f.equipo_ventas_nombre = 'Domicilio' THEN 'DOMICILIO'
    WHEN f.seller_code IN ${SELLER_CODES_RUTA_COMBINADA_SQL} THEN 'RUTA_COMBINADA'
    WHEN f.seller_code ILIKE 'M%' THEN 'MAYORISTA'
    WHEN f.equipo_ventas_nombre = 'Empresas' THEN 'EMPRESAS'
    WHEN f.origen_sistema = 'MOBILVENDOR' AND f.seller_code ILIKE 'E%' THEN 'EMPRESAS'
    WHEN f.seller_code ILIKE 'R%' THEN 'RURAL'
    WHEN f.seller_code ILIKE 'TV%' THEN 'TIENDAS_VIP'
    WHEN f.seller_code ILIKE 'T%' AND f.seller_code NOT ILIKE 'TV%' THEN 'TIENDAS'
    WHEN f.codigo_tipo_negocio = '29' THEN 'VIP'
    WHEN f.seller_code = 'U1' THEN 'QUITO'
    ELSE 'OTROS'
  END
`;

// Suma con signo para `facturas`: las notas de crédito (tipo_movimiento =
// 'out_refund') se RESTAN en vez de excluirse, igual que en
// botellonesController.signedSumFactura.
const signedCol = (aliasFactura, aliasDetalle, campo) =>
  `CASE WHEN ${aliasFactura}.tipo_movimiento = 'out_refund' THEN -${aliasDetalle}.${campo} ELSE ${aliasDetalle}.${campo} END`;

// Grupos válidos que se exponen hacia las tools (excluye 'OTROS' y NULL).
// 'PREVENTA' es distinto a los demás: no encaja en el CASE de arriba (ese es
// el patrón de botellonesController.js) — tiene su propia clasificación y
// hasta su propio status válido, ver FILTRO_PREVENTA_SELLER más abajo.
const GRUPOS_VALIDOS = [
  "MAYORISTA",
  "TIENDAS_VIP",
  "TIENDAS",
  "RURAL",
  "RUTA_COMBINADA",
  "TELEVENTA_VIP",
  "DOMICILIO",
  "EMPRESAS",
  "VIP",
  "QUITO",
  "PREVENTA",
];

// Categorías de producto reales (detalle_documento.descripcion_categoria),
// confirmadas contra datos reales — se excluyen los "All / ..." genéricos de
// Odoo (sin valor de negocio, son un catch-all de sincronización).
const CATEGORIAS_VALIDAS = [
  "BOTELLÓN",
  "DESCARTABLE",
  "HIELO",
  "CAFÉ",
  "PLUS",
  "SUSCRIPCION",
  "PT-DISTRINTER",
  "PT-COTTSA",
  "PT-IIBC",
  "SERVICIOS",
  "GASTOS GENERALES",
];

// ============================================================
// PREVENTA — portado de ventasController.calcularKPIsMes, la función que
// genera el ranking real que ve un gerente en el dashboard (confirmado
// palabra por palabra contra un cuadro real de agosto 2026, ruta por ruta).
//
// OJO: una versión anterior de este archivo usaba la lógica de
// "RANKING RUTAS R (R%/PVR%)" (obtenerRankingRutasDescartable) para
// PREVENTA — eso fue un ERROR: esa función es sobre una migración de
// nomenclatura de rutas rurales (R% pasando a llamarse PVR%), NO sobre
// PREVENTA.
//
// CORRECCIÓN 2026-08-31: la exclusión de 'PVR%' que tenía este filtro
// también era un error — PVR3/PVR4/PVR5 SÍ son rutas de preventa reales
// (confirmado con un Excel real de "guías terminadas" de MobilVendor,
// producto BOTELLON VERDE PET, julio 2026: 14 documentos de PVR3/4/5 con
// venta real). Se quitó la exclusión.
//
// CORRECCIÓN 2026-08-31 (la importante): `o.status = 5` significa
// "facturado/cerrado administrativamente", NO "efectivamente entregado".
// Una orden puede llegar a status=5 sin que nunca se haya despachado una
// guía física — MobilVendor la factura igual. El campo real de "¿se
// entregó de verdad?" es la GUÍA DE ENTREGA (objeto `waybill`, separado
// del status de la orden), con su propio `waybill.status`. Confirmado
// empíricamente cruzando un Excel real de guías "Terminated" (82
// documentos, producto BOTELLON VERDE PET, julio 2026) contra la base:
// 0 documentos faltantes, pero 33 "de más" con status=5 — 31 de esos 33
// NO tenían guía asociada en absoluto (`waybill_status IS NULL`), y los
// otros 2 tenían `waybill_status` distinto de "3" (probable desfase
// temporal entre el Excel y la consulta). Regla confirmada para guías
// tipo ruta (`GUT#.#-######`/`GUR#-######`, botellón/reparto individual):
// `waybill_status = '3'` = guía terminada/entregada.
//
// CORRECCIÓN 2026-09-01: esa regla NO generaliza a DESCARTABLE. Las guías
// de productos empaquetados/livianos usan un esquema de código distinto
// (`GU######` puro, sin sufijo de ruta — varios artículos/documentos
// consolidados en una sola guía, ej. 5 invoices reales bajo `GU000458`)
// donde el significado de `waybill_status` NO es el mismo: confirmado con
// 5 documentos reales marcados "Terminated" en un Excel de guías de
// MobilVendor (agosto 2026, productos DESCARTABLE) que tenían
// `waybill_status = '0'` — el mismo valor que para rutas de botellón
// significa "Shipping" (no entregado). Probar "tiene guía asociada, sin
// mirar el status" contra ambos casos reales de agosto confirmó que la
// regla correcta depende de la categoría:
//   - DESCARTABLE: `waybill_code IS NOT NULL` (sin filtrar por status) →
//     $252,889.93 vs. real $252,960.52 (0.03% de diferencia).
//   - BOTELLÓN: mismo criterio da $1,504.44 vs. real $1,288.76 (+17%,
//     igual de mal que sin ningún filtro de guía) — para botellón SÍ hace
//     falta `waybill_status = '3'`, tener guía no alcanza porque casi
//     cualquier pedido consigue una guía rápido, esté o no realmente
//     entregada.
// Categorías no probadas contra un Excel real (HIELO, CAFÉ, PLUS, PT-*,
// SUSCRIPCION, SERVICIOS, GASTOS GENERALES) caen en la rama estricta
// (`waybill_status = '3'`) por default — más conservadora, sin evidencia
// propia todavía.
//
// Filtro de ruta: PV%/PREVENTA%/TELEVENTA% (ya no excluye PVR%).
// Además: o.type = 2, o.status = 5, el filtro de guía condicional de
// arriba, dd.codigo_categoria = '7' (DESCARTABLE) por default — el propio
// código fuente original comenta que sin el filtro de categoría se
// inflaba cada ruta con líneas no-descartable/anticipos/envíos. Por eso,
// a diferencia de los demás grupos, PREVENTA solo acepta `categoria`
// distinta a DESCARTABLE como filtro EXTRA explícito (ver
// ventasPorGrupo.js/topProductos.js), no como reemplazo del default.
// Fecha: o.fecha_entrega (no fecha_creacion). Solo `ordenes`, sin `facturas`
// ni rama de pedido web (igual que la función original).
// ============================================================
const CATEGORIA_PREVENTA = "DESCARTABLE";

// `categoriaParam` es el placeholder posicional ($3, $4, ...) que cada
// query ya usa para su propio filtro de categoría — se reutiliza acá para
// que el criterio de guía dependa del MISMO valor que el caller pase,
// sin agregar un parámetro nuevo.
const FILTRO_PREVENTA_SELLER = (categoriaParam) => `
  (o.seller_code ILIKE 'PV%' OR o.seller_code ILIKE 'PREVENTA%' OR o.seller_code ILIKE 'TELEVENTA%')
  AND (
    (${categoriaParam} = 'DESCARTABLE' AND o.waybill_code IS NOT NULL)
    OR
    (${categoriaParam} <> 'DESCARTABLE' AND o.waybill_status = '3')
  )
`;

// Códigos de cliente placeholder/genéricos, no clientes reales — contaminan
// cualquier clasificación por seller_code si no se excluyen explícitamente.
// '8' = "Consumidor final" (venta de mostrador anónima, identificación dummy
// 9999999999999 en `clientes`, visto con facturas/órdenes bajo seller_code de
// prácticamente todos los canales: A*, D*, E*, H5, M99, PT02, R*, T*, TA2,
// TV*, U2, V*). '9' = "FALTANTE" (dato faltante, misma identificación dummy).
// Confirmado con datos reales (2026-09-08): son los ÚNICOS 2 códigos con esa
// identificación dummy o ese nombre en toda la tabla `clientes` — no hay más.
// Afecta a TODOS los grupos que clasifican por seller_code, no solo uno —
// visto con impacto real en DOMICILIO ($37,191.31, el más grave con
// diferencia), TIENDAS, RURAL, MAYORISTA, TIENDAS_VIP, EMPRESAS, QUITO y
// PREVENTA (este último vía FILTRO_PREVENTA_SELLER, no CASE_GRUPO_*).
const CODIGOS_CLIENTE_GENERICOS = ["8", "9"];

// `aliasCustomerCode` = el nombre calificado de la columna en cada query
// (ej. "o.customer_code", "f.customer_code") — mismo patrón que
// FILTRO_PREVENTA_SELLER, sin agregar un parámetro posicional nuevo porque
// los códigos son constantes de código, no vienen de input de usuario.
const FILTRO_CLIENTE_VALIDO = (aliasCustomerCode) =>
  `${aliasCustomerCode} NOT IN ('${CODIGOS_CLIENTE_GENERICOS.join("', '")}')`;

// ============================================================
// Condición de pago (CONTADO/CREDITO) — investigado 2026-09-15/16. Alberto
// corrigió la vieja asunción "contado=MobilVendor / crédito=Odoo": esa
// correlación solo aplica a cómo factura EMPRESAS específicamente, no es
// una regla general del sistema — hay clientes de VIP y de HIELO en
// MobilVendor que sí son de crédito (confirmado con datos reales: VIP
// tipo_negocio=29 tiene 136 contado vs 54 crédito; TELEVENTA_VIP 146 vs 51;
// compradores de HIELO vía MobilVendor 489 vs 104).
//
// Se investigaron los campos reales de la BD (no solo la documentación del
// API — `ordenes.payment_term_id/nombre` está documentado ahí pero 0%
// poblado en MobilVendor; no existe tabla `customer_policies` sincronizada)
// y se encontraron 2 señales utilizables, de confiabilidad MUY distinta:
//
//  1. TRANSACCIONAL (solo `facturas`, `tipo_movimiento='out_invoice'`,
//     ambos orígenes) — `fecha_vencimiento` es un campo propio del
//     documento (no un cálculo nuestro): comparado contra `fecha_creacion`,
//     0-1 día de diferencia = pagado de inmediato (CONTADO), más de eso =
//     plazo real de crédito (se ve limpio agrupado en
//     14/15/29/30/44/45/58-62/91/92 días — variantes de 15/30/45/60/90 con
//     redondeo). 98.9% completa en facturas MOBILVENDOR out_invoice, 100%
//     en ODOO out_invoice (mismo patrón limpio en ambos orígenes,
//     confirmado con datos reales). Es la señal MÁS confiable porque es del
//     documento real, no una condición "actual" del cliente aplicada
//     retroactivamente — PERO NO aplica a notas de crédito (`out_refund`,
//     exclusivas de ODOO): su propia `fecha_vencimiento` NO es confiable
//     ahí (ver comentario de `CONDICION_PAGO_FACTURA` más abajo, caso
//     verificado con datos reales), así que esos documentos también caen en
//     el fallback (2).
//  2. `clientes.metodo_pago_cliente` (fallback — usado en `ordenes`, que no
//     trae `fecha_vencimiento` propia, 0% poblado en MobilVendor; en el
//     ~1.1% de `facturas out_invoice` sin fecha_vencimiento; y en TODAS las
//     notas de crédito `out_refund`, ver punto 1): validado contra la señal
//     transaccional — 100% de los clientes con TODAS sus facturas
//     out_invoice MV en patrón contado tienen literalmente 'Pago Inmediato'
//     acá (0 excepciones sobre 11,225 clientes), 96.7% de los clientes 100%
//     crédito (por out_invoice) tienen un texto de plazo consistente ('30
//     días', '45 Días', etc.), y 91.8% de las notas de crédito de esos
//     mismos clientes 100%-crédito también clasifican correctamente como
//     CREDITO acá (contra solo 25.5% si se usara la fecha_vencimiento
//     propia del refund). 100% completo en clientes con al menos una
//     transacción MobilVendor real (los códigos numéricos sucios que
//     existen en esta columna, ej. '13'/'4' — probablemente IDs de Odoo sin
//     resolver — son siempre de clientes SIN ninguna transacción
//     MobilVendor, fuera del universo relevante acá). Es un campo de
//     CLIENTE, no de documento — usarlo asume que la condición ACTUAL del
//     cliente valía también en el momento de ese documento específico
//     (mismo tipo de riesgo ya documentado para
//     `codigo_usuario_asignado_cliente` con rutas), por eso nunca se usa si
//     la señal transaccional (1) está disponible y es confiable para ese
//     documento.
//
// NOTA sobre la ETIQUETA de fuente expuesta hacia afuera (fuente_condicion,
// CORRECCIÓN 2026-09-16): aunque las notas de crédito usan el MISMO fallback
// de cliente (2) que `ordenes`, se reportan bajo una tercera etiqueta,
// `NOTA_CREDITO`, no `METODO_PAGO_CLIENTE` — un renglón CREDITO/
// METODO_PAGO_CLIENTE con dólares negativos en un canal que factura por
// `facturas` (no por `ordenes`) es ilegible sin conocer este detalle interno
// (así se reportó, verificando la tool en vivo: VIP julio 2026 con
// -$112,011.11/-1,363 unidades en ese bucket, 194 documentos, 100% notas de
// crédito confirmado con datos reales, 0 órdenes). La CLASIFICACIÓN
// (CONTADO/CREDITO) no cambia por esto, solo la etiqueta de fuente.
//
// Rechazados: `tiene_credito_cliente` (booleano) — 40.7% de los clientes
// con 100% de facturas reales en patrón contado están marcados TRUE,
// contradice la transacción real. `condicion_pago_cliente` — peor
// completitud (73.2% vs 76% general de metodo_pago_cliente) y menos
// consistente.
//
// Cada tool que use esto debe exponer, por registro, qué señal se usó
// (fuente_condicion: 'TRANSACCIONAL' o 'METODO_PAGO_CLIENTE') — así un
// patrón raro de discrepancia se puede rastrear a su origen sin rehacer la
// investigación.
//
// `aliasCliente` = alias calificado de `clientes` en el JOIN del caller
// (SIEMPRE debe ser un LEFT JOIN — no hay FK que garantice que todo
// customer_code de ordenes/facturas tenga fila en clientes; con LEFT JOIN
// un cliente faltante degrada a SIN_DATO en vez de perder silenciosamente
// el documento de la suma).
const CONDICION_PAGO_CLIENTE = (aliasCliente) => `
  CASE
    WHEN ${aliasCliente}.metodo_pago_cliente ILIKE 'pago inmediato' THEN 'CONTADO'
    WHEN ${aliasCliente}.metodo_pago_cliente IS NOT NULL AND ${aliasCliente}.metodo_pago_cliente <> '' THEN 'CREDITO'
    ELSE 'SIN_DATO'
  END
`;

const FUENTE_CONDICION_PAGO_CLIENTE = "'METODO_PAGO_CLIENTE'";

// `aliasFactura` = alias calificado de `facturas` en la query del caller.
// Usa la señal transaccional cuando existe `fecha_vencimiento` Y el
// documento es `tipo_movimiento = 'out_invoice'`; si no, cae al fallback de
// cliente — mismo criterio, sin duplicar la lógica.
//
// CORRECCIÓN (mismo día, antes de mergear): las notas de crédito
// (`out_refund`, exclusivas de ODOO — no hay ninguna en MobilVendor) NO
// tienen una `fecha_vencimiento` confiable como señal de condición de pago
// — verificado con datos reales: de los clientes cuyo 100% de facturas
// `out_invoice` son CREDITO (plazo real confirmado), el 74.5% de SUS PROPIAS
// notas de crédito muestran `fecha_vencimiento` = mismo día que
// `fecha_creacion` (patrón "CONTADO"), contradiciendo la condición real del
// cliente — es un artefacto de cómo se emite la nota de crédito (parece
// fijarse igual a la fecha de emisión por convención), no una señal real de
// esa transacción. En cambio, `metodo_pago_cliente` sí clasifica
// correctamente el 91.8% de esos mismos refunds como CREDITO. Por eso la
// señal transaccional SOLO se confía en `out_invoice` — cualquier otro
// `tipo_movimiento` (`out_refund`, o vacío) usa el fallback de cliente.
const CONDICION_PAGO_FACTURA = (aliasFactura, aliasCliente) => `
  CASE
    WHEN ${aliasFactura}.tipo_movimiento = 'out_invoice'
         AND ${aliasFactura}.fecha_vencimiento IS NOT NULL
         AND ROUND(EXTRACT(EPOCH FROM (${aliasFactura}.fecha_vencimiento - ${aliasFactura}.fecha_creacion))/86400) <= 1
      THEN 'CONTADO'
    WHEN ${aliasFactura}.tipo_movimiento = 'out_invoice'
         AND ${aliasFactura}.fecha_vencimiento IS NOT NULL
      THEN 'CREDITO'
    ELSE (${CONDICION_PAGO_CLIENTE(aliasCliente)})
  END
`;

// CORRECCIÓN 2026-09-16 (reportada por el usuario tras verificar la tool en
// vivo — VIP julio 2026 mostraba un renglón CREDITO/METODO_PAGO_CLIENTE con
// -$112,011.11 y -1,363 unidades, sin explicación en la descripción de la
// tool): esos 194 documentos son 100% notas de crédito (confirmado con
// datos reales — 0 órdenes en ese bucket), correctas contablemente (restan
// venta) pero mal etiquetadas — la descripción de la tool decía que
// METODO_PAGO_CLIENTE era el fallback EXCLUSIVO de `ordenes`, y una nota de
// crédito de `facturas` cayendo ahí (aunque por la razón correcta, ver
// comentario de CONDICION_PAGO_FACTURA arriba) no coincidía con eso. Se
// separa en su propia fuente `NOTA_CREDITO` — value de la CLASIFICACIÓN
// (CONTADO/CREDITO) no cambia, sigue viniendo del fallback de cliente vía
// CONDICION_PAGO_FACTURA (ya validado: 91.8% de aciertos) — solo cambia la
// ETIQUETA de fuente, para que el desglose sea legible sin conocer el
// detalle interno de por qué cae ahí.
const FUENTE_CONDICION_PAGO_FACTURA = (aliasFactura) => `
  CASE
    WHEN ${aliasFactura}.tipo_movimiento = 'out_invoice' AND ${aliasFactura}.fecha_vencimiento IS NOT NULL
      THEN 'TRANSACCIONAL'
    WHEN ${aliasFactura}.tipo_movimiento = 'out_refund'
      THEN 'NOTA_CREDITO'
    ELSE 'METODO_PAGO_CLIENTE'
  END
`;

module.exports = {
  CASE_GRUPO_ORDENES,
  FILTRO_ORDENES_GRUPO_VALIDO,
  CASE_GRUPO_FACTURAS,
  signedCol,
  GRUPOS_VALIDOS,
  CATEGORIAS_VALIDAS,
  FILTRO_PREVENTA_SELLER,
  CATEGORIA_PREVENTA,
  CODIGOS_CLIENTE_GENERICOS,
  FILTRO_CLIENTE_VALIDO,
  CONDICION_PAGO_CLIENTE,
  FUENTE_CONDICION_PAGO_CLIENTE,
  CONDICION_PAGO_FACTURA,
  FUENTE_CONDICION_PAGO_FACTURA,
};
