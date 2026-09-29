// test/seguridad-smoke-test.js
// Confirma que un intento de inyección SQL en `ruta` es rechazado por la
// regex de zod ANTES de tocar la base, y que si por algún motivo llegara a
// la query, los parámetros posicionales de pg lo tratan como texto literal
// (nunca como SQL ejecutable).
require("dotenv").config();
const { z } = require("zod");
const { ventasPorRuta, inputSchema } = require("../src/tools/ventasPorRuta");
const { ventasPorGrupo, totalesGrupo, totalesPreventa, inputSchema: inputSchemaGrupo } = require("../src/tools/ventasPorGrupo");
const { ventasCliente } = require("../src/tools/ventasCliente");
const { clientesPorGrupo, inputSchema: inputSchemaClientesPorGrupo } = require("../src/tools/clientesPorGrupo");
const { inputSchema: inputSchemaClientesInactivos } = require("../src/tools/clientesInactivos");
const { clientesSinConsumo, inputSchema: inputSchemaClientesSinConsumo } = require("../src/tools/clientesSinConsumo");
const { clientesSinVisita, inputSchema: inputSchemaClientesSinVisita } = require("../src/tools/clientesSinVisita");
const { clientesVisitadosSinVenta, inputSchema: inputSchemaClientesVisitadosSinVenta } = require("../src/tools/clientesVisitadosSinVenta");
const {
  totalesGrupo: totalesGrupoCondicionPago,
  totalesPreventa: totalesPreventaCondicionPago,
  inputSchema: inputSchemaVentasPorCondicionPago,
} = require("../src/tools/ventasPorCondicionPago");
const { backlogPrevendedores, inputSchema: inputSchemaBacklogPrevendedores } = require("../src/tools/backlogPrevendedores");
const { inputSchema: inputSchemaVentasRutaOk, RUTAS_OK_VALIDAS } = require("../src/tools/ventasRutaOk");
const { pool } = require("../src/db");

async function main() {
  const payload = "T2'; DROP TABLE ordenes; --";

  // 1) La regex de zod debe rechazar el payload antes de llegar a la query.
  const schema = z.object(inputSchema);
  const parseo = schema.safeParse({ ruta: payload, fecha_inicio: "2026-01-01", fecha_fin: "2026-01-31" });
  if (parseo.success) throw new Error("FALLO: zod aceptó un payload de inyección");
  console.log("OK: zod rechazó el payload de inyección en `ruta` ->", parseo.error.issues[0].message);

  // 2) Aunque alguien se salte la validación de zod, pg debe tratarlo como
  //    texto literal (parámetro posicional), no como SQL. No debe lanzar
  //    error de sintaxis ni afectar la tabla.
  const resultado = await ventasPorRuta({ ruta: payload, fecha_inicio: "2026-01-01", fecha_fin: "2026-01-31" });
  console.log("OK: la query no lanzó error de sintaxis, se ejecutó como texto literal ->", JSON.stringify(resultado));

  const { rows } = await pool.query("SELECT to_regclass('ordenes') AS existe");
  if (!rows[0].existe) throw new Error("FALLO: la tabla ordenes ya no existe (inyección exitosa)");
  console.log("OK: la tabla `ordenes` sigue existiendo intacta.");

  // 2b) Regresión: códigos de ruta REALES con espacio ("RUTA 113"/"POS RUTA
  //     131" de COTTSA, "TELEVENTA 1", "PREVENTA VIP 1") deben pasar la
  //     validación — la regex original no incluía espacio y los rechazaba
  //     con "código de ruta inválido" pese a ser rutas legítimas.
  for (const rutaValida of ["RUTA 113", "POS RUTA 131", "TELEVENTA 1", "PREVENTA VIP 1"]) {
    const parseoValido = schema.safeParse({ ruta: rutaValida, fecha_inicio: "2026-01-01", fecha_fin: "2026-01-31" });
    if (!parseoValido.success) throw new Error(`FALLO: zod rechazó una ruta real válida "${rutaValida}" -> ${parseoValido.error.issues[0].message}`);
  }
  console.log("OK: zod acepta códigos de ruta reales con espacio (RUTA 113, POS RUTA 131, TELEVENTA 1, PREVENTA VIP 1).");

  // 3) Nuevos parámetros de ventasPorGrupo (categoria, grupo=PREVENTA):
  //    ambos son enums cerrados de zod — un payload de inyección ni siquiera
  //    matchea un valor válido del enum, se rechaza antes de la query.
  const payloadCategoria = "DESCARTABLE'; DROP TABLE detalle_documento; --";
  const schemaGrupo = z.object(inputSchemaGrupo);
  const parseoCategoria = schemaGrupo.safeParse({
    grupo: "MAYORISTA",
    categoria: payloadCategoria,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoCategoria.success) throw new Error("FALLO: zod aceptó un payload de inyección en `categoria`");
  console.log("OK: zod rechazó el payload de inyección en `categoria` ->", parseoCategoria.error.issues[0].message);

  // 4) Aunque alguien se salte zod y llame la función interna directo con el
  //    payload como `categoria` (bypaseando el enum), pg debe seguir
  //    tratándolo como texto literal — se usa como parámetro posicional
  //    ($4/$3) en ambas queries (la genérica y la de PREVENTA).
  const resultadoCategoria = await totalesGrupo("MAYORISTA", "2026-01-01 00:00:00", "2026-01-31 00:00:00", payloadCategoria);
  console.log("OK: totalesGrupo con categoria maliciosa no lanzó error de sintaxis ->", JSON.stringify(resultadoCategoria.totales));

  const resultadoPreventa = await totalesPreventa("2026-01-01 00:00:00", "2026-01-31 00:00:00", payloadCategoria);
  console.log("OK: totalesPreventa con categoria maliciosa no lanzó error de sintaxis ->", JSON.stringify(resultadoPreventa.totales));

  const { rows: rowsDD } = await pool.query("SELECT to_regclass('detalle_documento') AS existe");
  if (!rowsDD[0].existe) throw new Error("FALLO: la tabla detalle_documento ya no existe (inyección exitosa)");
  console.log("OK: la tabla `detalle_documento` sigue existiendo intacta.");

  // 5) ventasCliente: `nombre_cliente` es un string libre (no un enum
  //    cerrado como los de arriba) validado solo por largo mínimo — así que
  //    un payload de inyección SÍ pasa zod y llega hasta la query ILIKE.
  //    Ahí es donde el parámetro posicional de pg debe protegerlo de verdad.
  const payloadNombre = "JAVIER'; DROP TABLE clientes; --";
  const resultadoCliente = await ventasCliente({
    nombre_cliente: payloadNombre,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  console.log("OK: ventasCliente con nombre_cliente malicioso no lanzó error de sintaxis ->", JSON.stringify(resultadoCliente));
  if (resultadoCliente.encontrado !== false || resultadoCliente.motivo !== "sin_coincidencias_cliente") {
    throw new Error("FALLO: se esperaba sin_coincidencias_cliente (nadie se llama así), llegó algo distinto");
  }
  // El mismo payload también llega, en texto crudo (sin el wrapping %...%
  // de ILIKE), al fallback de sugerencias por similitud (pg_trgm) — debe
  // seguir sin lanzar error de sintaxis y sin generar sugerencias (no se
  // parece a ningún nombre real).
  if (!Array.isArray(resultadoCliente.sugerencias) || resultadoCliente.sugerencias.length !== 0) {
    throw new Error("FALLO: se esperaba sugerencias vacío para un payload de inyección sin parecido real");
  }
  console.log("OK: el fallback de sugerencias (pg_trgm) con el mismo payload no lanzó error de sintaxis y no sugirió nada.");

  const { rows: rowsClientes } = await pool.query("SELECT to_regclass('clientes') AS existe");
  if (!rowsClientes[0].existe) throw new Error("FALLO: la tabla clientes ya no existe (inyección exitosa)");
  console.log("OK: la tabla `clientes` sigue existiendo intacta.");

  // 6) `producto` (nuevo, mismo patrón que nombre_cliente): string libre,
  //    llega a la query ILIKE contra `productos`.
  const payloadProducto = "PACK'; DROP TABLE productos; --";
  // Nombre completo y específico (no solo "...JAVIER") porque desde el fix
  // de búsqueda fuzzy ya existe otro cliente real que también matchea el
  // nombre corto ("...JAVIER-CASA DE RETIROS") y el test necesita resolver
  // a UN solo cliente antes de llegar al payload de `producto`.
  const resultadoProducto = await ventasCliente({
    nombre_cliente: "UNIDAD EDUCATIVA PARTICULAR JAVIER-CASA DE RETIROS",
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
    producto: payloadProducto,
  });
  console.log("OK: ventasCliente con producto malicioso no lanzó error de sintaxis ->", JSON.stringify(resultadoProducto));
  if (resultadoProducto.encontrado !== false || resultadoProducto.motivo !== "sin_coincidencias_producto") {
    throw new Error("FALLO: se esperaba sin_coincidencias_producto, llegó algo distinto");
  }

  const { rows: rowsProductos } = await pool.query("SELECT to_regclass('productos') AS existe");
  if (!rowsProductos[0].existe) throw new Error("FALLO: la tabla productos ya no existe (inyección exitosa)");
  console.log("OK: la tabla `productos` sigue existiendo intacta.");

  // 7) `codigo_cliente` (nuevo, array de texto libre): va a la query como
  //    `= ANY($1::text[])` — un payload de inyección dentro del array debe
  //    tratarse como texto literal (no matchea ningún código real) sin
  //    lanzar error de sintaxis ni afectar la tabla.
  const payloadCodigoCliente = "110470'; DROP TABLE clientes; --";
  const resultadoCodigoCliente = await ventasCliente({
    codigo_cliente: [payloadCodigoCliente],
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  console.log("OK: ventasCliente con codigo_cliente malicioso no lanzó error de sintaxis ->", JSON.stringify(resultadoCodigoCliente));
  if (resultadoCodigoCliente.encontrado !== false || resultadoCodigoCliente.motivo !== "codigo_cliente_no_encontrado") {
    throw new Error("FALLO: se esperaba codigo_cliente_no_encontrado, llegó algo distinto");
  }

  const { rows: rowsClientes2 } = await pool.query("SELECT to_regclass('clientes') AS existe");
  if (!rowsClientes2[0].existe) throw new Error("FALLO: la tabla clientes ya no existe (inyección exitosa vía codigo_cliente)");
  console.log("OK: la tabla `clientes` sigue existiendo intacta (payload vía codigo_cliente).");

  // 8) clientesPorGrupo (nuevo): `grupo`/`categoria` son enums cerrados de
  //    zod (igual que en ventasPorGrupo) — un payload de inyección no
  //    matchea ningún valor válido, se rechaza antes de la query.
  const schemaClientesPorGrupo = z.object(inputSchemaClientesPorGrupo);
  const parseoClientesPorGrupo = schemaClientesPorGrupo.safeParse({
    grupo: payloadCategoria, // reusa el payload de inyección del punto 3
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoClientesPorGrupo.success) throw new Error("FALLO: zod aceptó un payload de inyección en `grupo` de clientesPorGrupo");
  console.log("OK: zod rechazó el payload de inyección en `grupo` de clientesPorGrupo ->", parseoClientesPorGrupo.error.issues[0].message);

  // Aunque alguien se salte zod y llame la función interna directo, `fecha_inicio`
  // va como parámetro posicional a Postgres (cast a timestamp) — un payload de
  // inyección ahí no ejecuta SQL, solo falla el cast (error controlado, no daño).
  const payloadFecha = "2026-01-01'; DROP TABLE clientes; --";
  let fallaEsperada = false;
  try {
    await clientesPorGrupo({ grupo: "MAYORISTA", fecha_inicio: payloadFecha, fecha_fin: "2026-01-31" });
  } catch (e) {
    fallaEsperada = /invalid input syntax/i.test(e.message);
  }
  if (!fallaEsperada) throw new Error("FALLO: se esperaba un error de cast de Postgres (invalid input syntax), no inyección exitosa ni otro error");
  console.log("OK: clientesPorGrupo con fecha_inicio maliciosa falló por cast de tipo (parámetro posicional), no por inyección.");

  const { rows: rowsClientes3 } = await pool.query("SELECT to_regclass('clientes') AS existe");
  if (!rowsClientes3[0].existe) throw new Error("FALLO: la tabla clientes ya no existe (inyección exitosa vía clientesPorGrupo)");
  console.log("OK: la tabla `clientes` sigue existiendo intacta (payload vía clientesPorGrupo).");

  // 9) Regresión: clientesInactivos tenía el MISMO bug de espacio que ventasPorRuta
  //    (rechazaba TELEVENTA 1/PREVENTA VIP 1/RUTA 113 — encontrado cuando un reporte
  //    real a gerencia omitió esas rutas por completo, sin aviso).
  const schemaClientesInactivos = z.object(inputSchemaClientesInactivos);
  for (const rutaValida of ["RUTA 113", "POS RUTA 131", "TELEVENTA 1", "PREVENTA VIP 1"]) {
    const parseoValido = schemaClientesInactivos.safeParse({ ruta: rutaValida });
    if (!parseoValido.success) throw new Error(`FALLO: zod rechazó una ruta real válida "${rutaValida}" en clientesInactivos -> ${parseoValido.error.issues[0].message}`);
  }
  console.log("OK: clientesInactivos acepta códigos de ruta reales con espacio (RUTA 113, POS RUTA 131, TELEVENTA 1, PREVENTA VIP 1).");

  // 10) clientesSinConsumo (nuevo): `grupo`/`categoria` son enums cerrados de
  //     zod, igual que clientesPorGrupo — y PREVENTA está explícitamente
  //     excluido del enum de `grupo` (no soportado, tiene su propio
  //     mecanismo de clasificación).
  const schemaClientesSinConsumo = z.object(inputSchemaClientesSinConsumo);
  const parseoSinConsumo = schemaClientesSinConsumo.safeParse({
    grupo: payloadCategoria,
    categoria: "BOTELLÓN",
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoSinConsumo.success) throw new Error("FALLO: zod aceptó un payload de inyección en `grupo` de clientesSinConsumo");
  console.log("OK: zod rechazó el payload de inyección en `grupo` de clientesSinConsumo ->", parseoSinConsumo.error.issues[0].message);

  const parseoSinConsumoPreventa = schemaClientesSinConsumo.safeParse({
    grupo: "PREVENTA",
    categoria: "DESCARTABLE",
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (!parseoSinConsumoPreventa.success) throw new Error("FALLO: zod rechazó grupo=PREVENTA en clientesSinConsumo (sí está soportado)");
  console.log("OK: zod acepta grupo=PREVENTA en clientesSinConsumo.");

  const payloadFechaSinConsumo = "2026-01-01'; DROP TABLE clientes; --";
  let fallaEsperadaSinConsumo = false;
  try {
    await clientesSinConsumo({ grupo: "EMPRESAS", categoria: "BOTELLÓN", fecha_inicio: payloadFechaSinConsumo, fecha_fin: "2026-01-31", limite: 300 });
  } catch (e) {
    fallaEsperadaSinConsumo = /invalid input syntax/i.test(e.message);
  }
  if (!fallaEsperadaSinConsumo) throw new Error("FALLO: se esperaba un error de cast de Postgres en clientesSinConsumo, no inyección exitosa ni otro error");
  console.log("OK: clientesSinConsumo con fecha_inicio maliciosa falló por cast de tipo (parámetro posicional), no por inyección.");

  const { rows: rowsClientes4 } = await pool.query("SELECT to_regclass('clientes') AS existe");
  if (!rowsClientes4[0].existe) throw new Error("FALLO: la tabla clientes ya no existe (inyección exitosa vía clientesSinConsumo)");
  console.log("OK: la tabla `clientes` sigue existiendo intacta (payload vía clientesSinConsumo).");

  // 11) clientesSinVisita (nuevo): `grupo` es enum cerrado de zod, igual que
  //     el resto — incluye PREVENTA (soportado desde el inicio acá, a
  //     diferencia de la primera versión de clientesSinConsumo).
  const schemaClientesSinVisita = z.object(inputSchemaClientesSinVisita);
  const parseoSinVisita = schemaClientesSinVisita.safeParse({
    grupo: payloadCategoria,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoSinVisita.success) throw new Error("FALLO: zod aceptó un payload de inyección en `grupo` de clientesSinVisita");
  console.log("OK: zod rechazó el payload de inyección en `grupo` de clientesSinVisita ->", parseoSinVisita.error.issues[0].message);

  // A diferencia de clientesPorGrupo/clientesSinConsumo, acá fecha_inicio/
  // fecha_fin NUNCA se pasan a una query SQL (solo aritmética de fechas en
  // JS) — no hay superficie de inyección en esos parámetros en esta tool.
  // Un payload malicioso debe fallar de forma controlada (error de fecha
  // inválida en JS), no ejecutar SQL ni devolver datos.
  const payloadFechaSinVisita = "2026-01-01'; DROP TABLE clientes; --";
  let fallaEsperadaSinVisita = false;
  try {
    await clientesSinVisita({ grupo: "EMPRESAS", fecha_inicio: payloadFechaSinVisita, fecha_fin: "2026-01-31", limite: 300 });
  } catch (e) {
    fallaEsperadaSinVisita = /invalid time value|invalid date/i.test(e.message);
  }
  if (!fallaEsperadaSinVisita) throw new Error("FALLO: se esperaba un error controlado de fecha inválida en clientesSinVisita, no inyección exitosa ni otro error");
  console.log("OK: clientesSinVisita con fecha_inicio maliciosa falló de forma controlada (fecha inválida en JS, no toca SQL) — no hay superficie de inyección en fecha_inicio/fecha_fin en esta tool.");

  const { rows: rowsClientes5 } = await pool.query("SELECT to_regclass('clientes') AS existe");
  if (!rowsClientes5[0].existe) throw new Error("FALLO: la tabla clientes ya no existe (inyección exitosa vía clientesSinVisita)");
  console.log("OK: la tabla `clientes` sigue existiendo intacta (payload vía clientesSinVisita).");

  // 12) clientesSinVisita — nuevo parámetro `ruta` (mismo patrón que
  //     ventasPorRuta: RUTA_RE con espacio, string o array).
  const schemaClientesSinVisitaRuta = z.object(inputSchemaClientesSinVisita);
  const parseoRutaInyeccion = schemaClientesSinVisitaRuta.safeParse({
    grupo: "TIENDAS_VIP",
    ruta: "T2'; DROP TABLE ordenes; --",
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoRutaInyeccion.success) throw new Error("FALLO: zod aceptó un payload de inyección en `ruta` de clientesSinVisita");
  console.log("OK: zod rechazó el payload de inyección en `ruta` de clientesSinVisita ->", parseoRutaInyeccion.error.issues[0].message);

  const parseoRutaConEspacio = schemaClientesSinVisitaRuta.safeParse({
    grupo: "PREVENTA",
    ruta: ["TELEVENTA 1", "RUTA 113"],
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (!parseoRutaConEspacio.success) throw new Error("FALLO: zod rechazó rutas reales con espacio en clientesSinVisita");
  console.log("OK: clientesSinVisita acepta array de rutas reales con espacio (TELEVENTA 1, RUTA 113).");

  // 13) clientesVisitadosSinVenta (nuevo): `grupo`/`categoria` son enums
  //     cerrados de zod, igual que clientesSinConsumo.
  const schemaVisitadosSinVenta = z.object(inputSchemaClientesVisitadosSinVenta);
  const parseoVisitadosInyeccion = schemaVisitadosSinVenta.safeParse({
    grupo: payloadCategoria,
    categoria: "BOTELLÓN",
    fecha_inicio: "2026-08-01",
    fecha_fin: "2026-08-31",
  });
  if (parseoVisitadosInyeccion.success) throw new Error("FALLO: zod aceptó un payload de inyección en `grupo` de clientesVisitadosSinVenta");
  console.log("OK: zod rechazó el payload de inyección en `grupo` de clientesVisitadosSinVenta ->", parseoVisitadosInyeccion.error.issues[0].message);

  // Igual que clientesSinVisita: fechaSoloDia(fecha_inicio) corre ANTES de
  // cualquier query SQL (para la advertencia de cobertura temporal), así
  // que un payload malicioso falla en JS (fecha inválida) sin llegar nunca
  // a tocar Postgres — no hay superficie de inyección efectiva acá tampoco,
  // aunque fecha_inicio SÍ se use como parámetro posicional más adelante en
  // el código si llegara a pasar ese punto.
  const payloadFechaVisitados = "2026-08-01'; DROP TABLE clientes; --";
  let fallaEsperadaVisitados = false;
  try {
    await clientesVisitadosSinVenta({ grupo: "EMPRESAS", categoria: "BOTELLÓN", fecha_inicio: payloadFechaVisitados, fecha_fin: "2026-08-31", limite: 300 });
  } catch (e) {
    fallaEsperadaVisitados = /invalid time value|invalid date/i.test(e.message);
  }
  if (!fallaEsperadaVisitados) throw new Error("FALLO: se esperaba un error controlado de fecha inválida en clientesVisitadosSinVenta, no inyección exitosa ni otro error");
  console.log("OK: clientesVisitadosSinVenta con fecha_inicio maliciosa falló de forma controlada (fecha inválida en JS, antes de tocar SQL).");

  const { rows: rowsClientes6 } = await pool.query("SELECT to_regclass('clientes') AS existe");
  if (!rowsClientes6[0].existe) throw new Error("FALLO: la tabla clientes ya no existe (inyección exitosa vía clientesVisitadosSinVenta)");
  console.log("OK: la tabla `clientes` sigue existiendo intacta (payload vía clientesVisitadosSinVenta).");

  // 14) ventasPorCondicionPago (nuevo): `grupo`/`categoria` son los mismos
  //     enums cerrados que ventasPorGrupo — un payload de inyección ni
  //     siquiera matchea un valor válido del enum, se rechaza antes de la
  //     query.
  const schemaCondicionPago = z.object(inputSchemaVentasPorCondicionPago);
  const parseoCondicionPagoInyeccion = schemaCondicionPago.safeParse({
    grupo: payloadCategoria,
    fecha_inicio: "2026-07-01",
    fecha_fin: "2026-07-31",
  });
  if (parseoCondicionPagoInyeccion.success) throw new Error("FALLO: zod aceptó un payload de inyección en `grupo` de ventasPorCondicionPago");
  console.log("OK: zod rechazó el payload de inyección en `grupo` de ventasPorCondicionPago ->", parseoCondicionPagoInyeccion.error.issues[0].message);

  // Igual que ventasPorGrupo (mismo patrón de query, mismos parámetros
  // posicionales): aunque alguien se salte zod y llame la función interna
  // directo con `categoria` maliciosa, pg debe seguir tratándola como texto
  // literal ($4 en ambas queries, la genérica y la de PREVENTA) — no debe
  // lanzar error de sintaxis ni afectar la tabla.
  const resultadoCondicionPagoCategoria = await totalesGrupoCondicionPago(
    "MAYORISTA",
    "2026-01-01 00:00:00",
    "2026-01-31 00:00:00",
    payloadCategoria
  );
  console.log(
    "OK: totalesGrupo (ventasPorCondicionPago) con categoria maliciosa no lanzó error de sintaxis ->",
    JSON.stringify(resultadoCondicionPagoCategoria.totales)
  );

  const resultadoCondicionPagoPreventa = await totalesPreventaCondicionPago(
    "2026-01-01 00:00:00",
    "2026-01-31 00:00:00",
    payloadCategoria
  );
  console.log(
    "OK: totalesPreventa (ventasPorCondicionPago) con categoria maliciosa no lanzó error de sintaxis ->",
    JSON.stringify(resultadoCondicionPagoPreventa.totales)
  );

  const { rows: rowsDD2 } = await pool.query("SELECT to_regclass('detalle_documento') AS existe");
  if (!rowsDD2[0].existe) throw new Error("FALLO: la tabla detalle_documento ya no existe (inyección exitosa vía ventasPorCondicionPago)");
  console.log("OK: la tabla `detalle_documento` sigue existiendo intacta (payload vía ventasPorCondicionPago).");

  // 15) backlogPrevendedores (nuevo): `ruta` es el mismo patrón string/array
  //     que ventasPorRuta/clientesSinVisita — un payload de inyección debe
  //     rechazarse por la regex de zod antes de tocar la query.
  const schemaBacklogPrevendedores = z.object(inputSchemaBacklogPrevendedores);
  const parseoBacklogRutaInyeccion = schemaBacklogPrevendedores.safeParse({
    ruta: payload,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoBacklogRutaInyeccion.success) throw new Error("FALLO: zod aceptó un payload de inyección en `ruta` de backlogPrevendedores");
  console.log("OK: zod rechazó el payload de inyección en `ruta` de backlogPrevendedores ->", parseoBacklogRutaInyeccion.error.issues[0].message);

  const parseoBacklogRutaConEspacio = schemaBacklogPrevendedores.safeParse({
    ruta: ["TELEVENTA 1", "RUTA 113"],
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (!parseoBacklogRutaConEspacio.success) throw new Error("FALLO: zod rechazó rutas reales con espacio en backlogPrevendedores");
  console.log("OK: backlogPrevendedores acepta array de rutas reales con espacio (TELEVENTA 1, RUTA 113).");

  // Aunque alguien se salte zod y llame la función interna directo con el
  // payload como `ruta` (bypaseando la regex), pg debe seguir tratándolo
  // como texto literal ($1::text[] posicional) — no debe lanzar error de
  // sintaxis ni afectar la tabla.
  const resultadoBacklogInyeccion = await backlogPrevendedores({
    ruta: payload,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
    ventana_dias_factura_cliente: 30,
  });
  console.log(
    "OK: backlogPrevendedores con ruta maliciosa no lanzó error de sintaxis ->",
    JSON.stringify({ total_ordenes: resultadoBacklogInyeccion.total_ordenes })
  );

  const { rows: rowsOrdenes2 } = await pool.query("SELECT to_regclass('ordenes') AS existe");
  if (!rowsOrdenes2[0].existe) throw new Error("FALLO: la tabla ordenes ya no existe (inyección exitosa vía backlogPrevendedores)");
  console.log("OK: la tabla `ordenes` sigue existiendo intacta (payload vía backlogPrevendedores).");

  // 16) ventasRutaOk (nuevo): a diferencia de las demás tools, `ruta` NO es
  //     texto libre validado por regex — es z.enum(['113','131','132']),
  //     así que un payload de inyección se rechaza directo por no ser uno
  //     de esos 3 valores literales, sin necesidad de probar el bypass a
  //     nivel de query (`ruta` solo indexa un objeto de configuración fijo
  //     en JS — RUTAS_OK — nunca se concatena ni se pasa a SQL).
  const schemaVentasRutaOk = z.object(inputSchemaVentasRutaOk);
  const parseoVentasRutaOkInyeccion = schemaVentasRutaOk.safeParse({
    ruta: payload,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (parseoVentasRutaOkInyeccion.success) throw new Error("FALLO: zod aceptó un payload de inyección en `ruta` de ventasRutaOk");
  console.log("OK: zod rechazó el payload de inyección en `ruta` de ventasRutaOk ->", parseoVentasRutaOkInyeccion.error.issues[0].message);

  const parseoVentasRutaOkArray = schemaVentasRutaOk.safeParse({
    ruta: RUTAS_OK_VALIDAS,
    fecha_inicio: "2026-01-01",
    fecha_fin: "2026-01-31",
  });
  if (!parseoVentasRutaOkArray.success) throw new Error("FALLO: zod rechazó el array de rutas OK válidas (113/131/132) en ventasRutaOk");
  console.log("OK: ventasRutaOk acepta el array de las 3 rutas OK válidas.");

  await pool.end();
  console.log("\nSEGURIDAD SMOKE TEST OK");
}

main().catch((err) => {
  console.error("SEGURIDAD SMOKE TEST FALLÓ:", err);
  process.exit(1);
});
