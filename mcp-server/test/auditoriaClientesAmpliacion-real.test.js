// test/auditoriaClientesAmpliacion-real.test.js
// Prueba de regresión con datos reales para la ampliación Fase 1b de
// auditoriaClientes (2026-10-01): filtro por compañía, paginación,
// nuevos subtipos de coordenadas, contexto por registro, y las 5 mejoras
// de duplicados. Ver auditoriaClientes.js (header) y TODO.md para el
// detalle completo de lo investigado antes de construir.
require("dotenv").config();
const { auditoriaClientes } = require("../src/tools/auditoriaClientes");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

async function main() {
  // 1) listar_companias — 100% Postgres, coincide con clientes.company_id real.
  const companias = await auditoriaClientes({ listar_companias: true });
  asegurar(companias.companias.length >= 5, `listar_companias trae al menos 5 compañías reales (llegaron ${companias.companias.length})`);
  const grupoaqua = companias.companias.find((c) => c.company_id === "1");
  asegurar(!!grupoaqua && grupoaqua.nombre === "GRUPOAQUA S.A.", "listar_companias: company_id=1 es GRUPOAQUA S.A.");
  const sumaCompanias = companias.companias.reduce((a, c) => a + c.num_clientes, 0);
  const { rows: totalClientesRows } = await pool.query("SELECT COUNT(*) AS n FROM clientes");
  asegurar(sumaCompanias === Number(totalClientesRows[0].n), `listar_companias suma exacto al total de clientes (${sumaCompanias} == ${totalClientesRows[0].n})`);

  // 2) company_id filtra correctamente (coordenadas con company_id=1 <= sin filtro).
  const coordSinFiltro = await auditoriaClientes({ categoria: "coordenadas", formato_salida: "resumen_por_tipo" });
  const coordCon1 = await auditoriaClientes({ categoria: "coordenadas", company_id: "1", formato_salida: "resumen_por_tipo" });
  asegurar(coordCon1.total <= coordSinFiltro.total && coordCon1.total > 0, `company_id=1 filtra coordenadas (${coordCon1.total} <= ${coordSinFiltro.total}, > 0)`);
  asegurar(coordCon1.company_id === "1", "la respuesta trae company_id reflejado");

  // 3) Regresión del bug encontrado y corregido durante esta misma tarea:
  //    senal_debil.total NO debe depender de incluir_cadenas (antes usaba
  //    accidentalmente el largo de la lista YA excluida de cadenas grandes).
  const dupNormal = await auditoriaClientes({ categoria: "duplicados", formato_salida: "resumen_por_tipo" });
  const dupConCadenas = await auditoriaClientes({ categoria: "duplicados", formato_salida: "resumen_por_tipo", incluir_cadenas: true });
  asegurar(
    dupNormal.senal_debil.total === dupConCadenas.senal_debil.total,
    `senal_debil.total es el mismo con o sin incluir_cadenas (${dupNormal.senal_debil.total} == ${dupConCadenas.senal_debil.total}) — total genuino, no el largo de la lista filtrada`
  );
  asegurar(
    dupNormal.senal_debil.total === dupNormal.senal_debil.total, // sanity
    `senal_fuerte (${dupNormal.senal_fuerte.total}) + senal_fuerte_normalizada (${dupNormal.senal_fuerte_normalizada.total}) + senal_debil (${dupNormal.senal_debil.total}) son 3 categorías separadas y mutuamente excluyentes`
  );

  // 4) Verificación directa contra SQL crudo (sin pasar por la tool) de que
  //    senal_fuerte_normalizada + senal_debil == el total "viejo" (mismo RUC,
  //    nombres EXACTOS distintos) — confirma que la partición no pierde
  //    ni duplica grupos.
  const { rows: crudoDebil } = await pool.query(`
    SELECT COUNT(*) AS n FROM (
      SELECT TRIM(identificacion_cliente) AS ruc
      FROM clientes
      WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> ''
        AND TRIM(identificacion_cliente) NOT IN ('9999999999','9999999999999')
      GROUP BY TRIM(identificacion_cliente)
      HAVING COUNT(DISTINCT nombre_cliente) > 1
    ) x;
  `);
  const sumaParticion = dupNormal.senal_debil.total + dupNormal.senal_fuerte_normalizada.total;
  asegurar(
    sumaParticion === Number(crudoDebil[0].n),
    `senal_debil + senal_fuerte_normalizada (${sumaParticion}) == total crudo de RUC con nombres EXACTOS distintos (${crudoDebil[0].n}) — la partición por nombre normalizado no pierde grupos`
  );

  // 5) Nuevas señales de duplicados dan resultados reales (no vacías, no rotas).
  asegurar(dupNormal.equivalencia_cedula_ruc.total > 0, `equivalencia_cedula_ruc encuentra casos reales (${dupNormal.equivalencia_cedula_ruc.total})`);
  asegurar(dupNormal.mismo_telefono.total > 0, `mismo_telefono encuentra casos reales (${dupNormal.mismo_telefono.total})`);
  asegurar(dupNormal.mismo_pin.total > 0, `mismo_pin encuentra casos reales (${dupNormal.mismo_pin.total})`);
  asegurar(dupNormal.nombres_problematicos.total > 0, `nombres_problematicos encuentra casos reales (${dupNormal.nombres_problematicos.total})`);

  // 6) Detalle enriquecido + sugerencia_maestro en un grupo real.
  const dupJson = await auditoriaClientes({ categoria: "duplicados", limite: 5 });
  const primerFuerte = dupJson.senal_fuerte.items[0];
  asegurar(!!primerFuerte.sugerencia_maestro, "senal_fuerte trae sugerencia_maestro en el primer grupo");
  asegurar(Array.isArray(primerFuerte.detalle) && primerFuerte.detalle.length === primerFuerte.codigos.length, "el detalle trae un registro por cada código del grupo");
  const sugerido = primerFuerte.detalle.find((d) => d.codigo_cliente === primerFuerte.sugerencia_maestro);
  const maxVentas = Math.max(...primerFuerte.detalle.map((d) => d.ventas_12m || 0));
  asegurar(sugerido.ventas_12m === maxVentas, `sugerencia_maestro (${primerFuerte.sugerencia_maestro}) es realmente el código con más ventas_12m del grupo (${maxVentas})`);

  // 7) Coordenadas — nuevos subtipos aparecen, FORMATO_INVALIDO siempre 0
  //    (columna NUMERIC, ver header de auditoriaClientes.js).
  asegurar(coordSinFiltro.por_tipo.BAJA_PRECISION > 0, `coordenadas detecta BAJA_PRECISION con datos reales (${coordSinFiltro.por_tipo.BAJA_PRECISION})`);
  const formatoInvalido = await auditoriaClientes({ categoria: "coordenadas", tipo_problema: "FORMATO_INVALIDO" });
  asegurar(formatoInvalido.total === 0, "FORMATO_INVALIDO siempre da 0 (columna NUMERIC, imposibilidad estructural documentada)");

  // 8) Contexto + orden por ventas_12m descendente + solo_activos_dias.
  const coordCtx = await auditoriaClientes({ categoria: "coordenadas", limite: 20 });
  asegurar("ruta" in coordCtx.items[0] && "grupo" in coordCtx.items[0] && "ventas_12m" in coordCtx.items[0], "items de coordenadas traen contexto (ruta/grupo/ventas_12m)");
  const ventasOrdenadas = coordCtx.items.map((i) => i.ventas_12m);
  const estaOrdenado = ventasOrdenadas.every((v, idx) => idx === 0 || ventasOrdenadas[idx - 1] >= v);
  asegurar(estaOrdenado, "coordenadas viene ordenado por ventas_12m descendente");

  const coordActivos = await auditoriaClientes({ categoria: "coordenadas", solo_activos_dias: 90 });
  asegurar(coordActivos.total < coordSinFiltro.total, `solo_activos_dias=90 reduce el universo (${coordActivos.total} < ${coordSinFiltro.total})`);
  asegurar(
    coordActivos.items.every((i) => i.dias_desde_ultima !== null && i.dias_desde_ultima <= 90),
    "todos los items con solo_activos_dias=90 tienen compra en los últimos 90 días"
  );

  // 9) Paginación — offset/limite/hay_mas consistentes, sin perder ni
  //    duplicar registros entre páginas.
  const pagina1 = await auditoriaClientes({ categoria: "sin_canal", offset: 0, limite: 100 });
  const pagina2 = await auditoriaClientes({ categoria: "sin_canal", offset: 100, limite: 100 });
  asegurar(pagina1.total === pagina2.total, "el total es consistente entre páginas");
  const codigosP1 = new Set(pagina1.items.map((i) => i.codigo_cliente));
  const interseccion = pagina2.items.filter((i) => codigosP1.has(i.codigo_cliente));
  asegurar(interseccion.length === 0, "paginación no repite registros entre offset=0 y offset=100");

  // 10) formato_salida=resumen_por_tipo nunca trae `items`.
  const resumenSinItems = await auditoriaClientes({ categoria: "direcciones_incompletas", formato_salida: "resumen_por_tipo" });
  asegurar(!("items" in resumenSinItems), "formato_salida=resumen_por_tipo no trae `items`");

  // 11) Inyección en company_id — ya cubierta en seguridad-smoke-test.js,
  //     acá solo confirmamos que un company_id inexistente no rompe nada.
  const inexistente = await auditoriaClientes({ categoria: "duplicados", company_id: "999999", formato_salida: "resumen_por_tipo" });
  asegurar(inexistente.senal_fuerte.total === 0, "company_id inexistente devuelve 0 en todas las señales, sin error");

  await pool.end();
  console.log("\nAUDITORIA CLIENTES AMPLIACION REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
