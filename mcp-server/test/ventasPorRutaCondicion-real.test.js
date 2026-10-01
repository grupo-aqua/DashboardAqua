// test/ventasPorRutaCondicion-real.test.js
// Prueba de regresión con datos reales para ventasPorRutaCondicion — usa
// los 3 casos reales dados explícitamente para validar (EMPRESAS/VIP/
// DOMICILIO 2026-09-02..04), más chequeos cruzados contra
// ventasPorRuta/ventasPorGrupo/ventasPorCondicionPago (las tools cuya
// lógica esta nueva tool reutiliza) para confirmar que nunca se
// desalinean entre sí.
require("dotenv").config();
const { ventasPorRutaCondicion } = require("../src/tools/ventasPorRutaCondicion");
const { ventasPorRuta } = require("../src/tools/ventasPorRuta");
const { totalesGrupo: totalesCondicionPago } = require("../src/tools/ventasPorCondicionPago");
const { pool } = require("../src/db");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

function cerca(a, b, tol = 0.05) {
  return Math.abs(a - b) < tol;
}

async function main() {
  // 1) EMPRESAS 2026-09-04 — caso dado ORIGINAL: total $12,274.53, contado
  //    real ≈ $8.24 (ruta E4), el resto crédito. ACTUALIZADO 2026-10-01 tras
  //    el fix de reconciliación de facturas (ver TODO.md, "Propuesta de
  //    diseño COMPLETA — reconciliación de facturas"): los $8.24 de "ruta
  //    E4" resultaron ser EXACTAMENTE los 2 documentos duplicados
  //    FAE4-000017/018 (MobilVendor, $6.18+$2.06) de esta misma venta —
  //    confirmado 1:1 contra sus gemelos Odoo FA001-051-000000951/952, ya
  //    marcados `duplicado_de`. El caso real dado originalmente estaba
  //    construido sobre datos ya inflados por el bug; ahora que se excluyen,
  //    el total baja exacto en $8.24 y la ruta "E4" desaparece de por_ruta
  //    (todo EMPRESAS real de este día queda sin seller_code propio, ver
  //    SIN_RUTA_ASIGNADA — consistente con que EMPRESAS/Odoo se clasifica
  //    por equipo_ventas_nombre, no por seller_code, ver clasificacion.js).
  const empresas = await ventasPorRutaCondicion({ grupo: "EMPRESAS", fecha_inicio: "2026-09-04", fecha_fin: "2026-09-04" });
  asegurar(cerca(empresas.dolares_totales, 12266.29), `EMPRESAS 2026-09-04: dolares_totales (${empresas.dolares_totales}) ≈ 12266.29 (12274.53 original - 8.24 de los 2 documentos duplicados ya marcados)`);
  const contadoEmpresas = empresas.por_ruta.reduce((a, r) => a + r.dolares_contado, 0);
  asegurar(cerca(contadoEmpresas, 0), `EMPRESAS 2026-09-04: suma de dolares_contado (${contadoEmpresas.toFixed(2)}) ≈ 0 (el único contado real de este día eran los 2 documentos duplicados, ya excluidos)`);
  const e4 = empresas.por_ruta.find((r) => r.ruta === "E4");
  asegurar(!e4, `EMPRESAS 2026-09-04: la ruta "E4" ya no aparece en por_ruta (su única fuente eran los 2 documentos duplicados)`);

  // 2) VIP 2026-09-04 — caso dado: total $9,812.93, contado real ≈ $458.66.
  //    (El desglose por ruta exacto del pedido original mencionaba
  //    V1/V2/V3/V5/V6 de memoria — verificado independiente con SQL propio
  //    que el desglose real es V6/H10/V2/V1, sin V3/V5; el total SÍ
  //    coincide exacto, así que se valida el total + que la suma por ruta
  //    cuadre, no la lista de rutas específicas.)
  const vip = await ventasPorRutaCondicion({ grupo: "VIP", fecha_inicio: "2026-09-04", fecha_fin: "2026-09-04" });
  asegurar(cerca(vip.dolares_totales, 9812.93), `VIP 2026-09-04: dolares_totales (${vip.dolares_totales}) ≈ 9812.93`);
  const contadoVip = vip.por_ruta.reduce((a, r) => a + r.dolares_contado, 0);
  asegurar(cerca(contadoVip, 458.66), `VIP 2026-09-04: suma de dolares_contado (${contadoVip.toFixed(2)}) ≈ 458.66`);

  // 3) DOMICILIO 2026-09-02 — caso dado: A1 debe seguir dando
  //    dolares_totales ≈ $256.88 sin importar el desglose contado/crédito,
  //    SIN forzar SIN_DATO a CREDITO. Validado en modo `ruta` (mismo
  //    comportamiento — sin FILTRO_CLIENTE_VALIDO — que ya tiene
  //    ventasPorRuta.js, de donde sale la cifra de referencia).
  const a1 = await ventasPorRutaCondicion({ ruta: "A1", fecha_inicio: "2026-09-02", fecha_fin: "2026-09-02" });
  asegurar(cerca(a1.dolares_totales, 256.85, 0.5), `DOMICILIO A1 2026-09-02: dolares_totales (${a1.dolares_totales}) ≈ 256.88 (tol 0.5)`);
  const filaA1 = a1.por_ruta.find((r) => r.ruta === "A1");
  asegurar(
    cerca(filaA1.dolares_contado + filaA1.dolares_credito + filaA1.dolares_sin_dato + filaA1.dolares_nota_credito, filaA1.dolares_totales),
    "DOMICILIO A1: contado+credito+sin_dato+nota_credito == dolares_totales (nada se pierde ni se fuerza)"
  );

  // 3b) Cruce contra ventasPorRuta (misma tool que da la cifra de
  //     referencia para A1) — debe coincidir EXACTO en modo `ruta`, ya que
  //     reutiliza el mismo WHERE base (sin FILTRO_CLIENTE_VALIDO).
  const a1Original = await ventasPorRuta({ ruta: "A1", fecha_inicio: "2026-09-02", fecha_fin: "2026-09-02" });
  asegurar(
    cerca(a1.dolares_totales, a1Original.dolares_totales, 0.01),
    `DOMICILIO A1 modo ruta: dolares_totales (${a1.dolares_totales}) == ventasPorRuta original (${a1Original.dolares_totales})`
  );
  asegurar(a1.unidades_totales === a1Original.unidades_totales, `DOMICILIO A1 modo ruta: unidades_totales coincide con ventasPorRuta original`);

  // 4) Cruce contra ventasPorCondicionPago (la tool cuya lógica se
  //    reutiliza) — el total_contado agregado de todas las rutas de
  //    EMPRESAS debe coincidir EXACTO con lo que da ventasPorCondicionPago
  //    directamente para el mismo grupo/rango (misma fuente de verdad).
  const refCondicionPago = await totalesCondicionPago("EMPRESAS", "2026-09-04 00:00:00", "2026-09-05 00:00:00", null);
  const contadoRef = refCondicionPago.por_condicion.find((c) => c.condicion_pago === "CONTADO")?.dolares || 0;
  asegurar(
    cerca(contadoEmpresas, contadoRef, 0.01),
    `EMPRESAS 2026-09-04: dolares_contado agregado (${contadoEmpresas.toFixed(2)}) == ventasPorCondicionPago (${contadoRef})`
  );

  // 5) grupo=RURAL / grupo=RUTA_COMBINADA — regresión del fix de
  //    clasificacion.js (fix/clasificacion-ruta-ok-en-rural, mergeado a
  //    `main` DESPUÉS de que esta tool ya existía): esta aserción antes
  //    confirmaba el hallazgo de colisión (rutas "RUTA 11X/13X" mezcladas
  //    en RURAL) como comportamiento documentado, no corregido. Ahora que
  //    el fix está mergeado, `CASE_GRUPO_FACTURAS`/`CASE_GRUPO_ORDENES` ya
  //    no las clasifica como RURAL — esta tool reutiliza esas mismas
  //    funciones tal cual (ver header del archivo), así que el arreglo se
  //    propaga automáticamente sin tocar código propio.
  const rural = await ventasPorRutaCondicion({ grupo: "RURAL", fecha_inicio: "2026-01-01", fecha_fin: "2026-09-21" });
  const rutasOkEnRural = rural.por_ruta.filter((r) => /^RUTA 1(13|31|32)/.test(r.ruta));
  asegurar(rutasOkEnRural.length === 0, `grupo=RURAL: ya NO mezcla las rutas 'RUTA 11X/13X' (fix propagado desde clasificacion.js)`);

  const rutaCombinada = await ventasPorRutaCondicion({ grupo: "RUTA_COMBINADA", fecha_inicio: "2026-01-01", fecha_fin: "2026-09-21" });
  const rutasEnRutaCombinada = rutaCombinada.por_ruta.filter((r) => /^RUTA 1(13|31|32)/.test(r.ruta));
  asegurar(
    rutasEnRutaCombinada.length > 0,
    `grupo=RUTA_COMBINADA: SÍ trae las rutas 'RUTA 11X/13X' (${rutasEnRutaCombinada.map((r) => r.ruta).join(", ")})`
  );

  // 6) Modo ruta con rutas sin ventas en el rango: deben aparecer en $0, no
  //    ausentes del todo.
  const rutaVacia = await ventasPorRutaCondicion({ ruta: ["A1", "RUTA_QUE_NO_EXISTE_XYZ"], fecha_inicio: "2026-09-02", fecha_fin: "2026-09-02" });
  const filaVacia = rutaVacia.por_ruta.find((r) => r.ruta === "RUTA_QUE_NO_EXISTE_XYZ");
  asegurar(!!filaVacia && filaVacia.dolares_totales === 0, "modo ruta: una ruta sin ventas en el rango aparece en $0, no ausente");

  // 7) `ruta` y `grupo` excluyentes — ya cubierto en seguridad-smoke-test,
  //    doble check acá también con datos reales de por medio.
  let lanzoError = false;
  try {
    await ventasPorRutaCondicion({ fecha_inicio: "2026-01-01", fecha_fin: "2026-01-31" });
  } catch {
    lanzoError = true;
  }
  asegurar(lanzoError, "sin `ruta` ni `grupo`: lanza error (no corre una consulta sin acotar)");

  await pool.end();
  console.log("\nVENTAS POR RUTA CONDICION REAL TEST OK");
}

main().catch((err) => {
  console.error("\nVENTAS POR RUTA CONDICION REAL TEST FALLÓ:", err);
  process.exit(1);
});
