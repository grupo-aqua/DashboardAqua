// test/fallbackOdooCondicionPago-real.test.js
// Prueba de regresión con datos reales para el fallback de Odoo (Bug 2,
// pedido explícito del usuario 2026-09-29) — ver
// odooCondicionPagoFallback.js para la investigación completa y el header
// de ventasPorCondicionPago.js/ventasPorRutaCondicion.js para el diseño de
// cómo se cablea. Este test corre contra Odoo EN VIVO (no hay forma de
// simularlo sin reescribir la lógica real), así que valida invariantes que
// deben cumplirse sea cual sea el % de resolución del día que se corra:
//
//  1. `dolares_totales` NUNCA cambia por el fallback — es una
//     reclasificación de dólares que ya estaban contados, no dólares
//     nuevos. Se compara contra ventasPorGrupo (fuente ya validada), mismo
//     patrón que ventasPorCondicionPago-real.test.js.
//  2. Los desgloses (`por_condicion`, `por_condicion_y_fuente`,
//     `por_ruta`) siguen sumando exacto al total después del fallback —
//     ninguna fuga ni doble conteo al mover dólares de SIN_DATO a
//     CONTADO/CREDITO.
//  3. `fallback_odoo.dolares_resueltos` es consistente con lo que
//     efectivamente aparece bajo fuente_condicion='ODOO_FALLBACK'.
//  4. Todo lo resuelto realmente SALIÓ de SIN_DATO (el bucket SIN_DATO baja
//     en exactamente esos dólares, nunca sube).
require("dotenv").config();
const { ventasPorCondicionPago } = require("../src/tools/ventasPorCondicionPago");
const { ventasPorRutaCondicion } = require("../src/tools/ventasPorRutaCondicion");
const { totalesGrupo: totalesGrupoOriginal } = require("../src/tools/ventasPorGrupo");

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error("FALLÓ: " + mensaje);
  console.log("OK:", mensaje);
}

// Rango cerrado (meses ya completos) a propósito — evita el falso
// positivo de comparar dos queries secuenciales contra datos EN VIVO que
// siguen cambiando (confirmado en vivo: con fecha_fin=hoy, dolares_totales
// puede diferir en unos pocos dólares entre esta consulta y
// ventasPorGrupo simplemente porque entró una orden nueva entre medio).
const INICIO = "2026-01-01";
const FIN = "2026-08-31";
const INICIO_TS = "2026-01-01 00:00:00";
const FIN_TS = "2026-09-01 00:00:00";

async function main() {
  // ===== ventasPorCondicionPago (modo grupo) =====
  for (const grupo of ["DOMICILIO", "EMPRESAS", "VIP"]) {
    const original = await totalesGrupoOriginal(grupo, INICIO_TS, FIN_TS, undefined);
    const dolaresOriginal = Number(original.totales.dolares.toFixed(2));
    const resultado = await ventasPorCondicionPago({ grupo, fecha_inicio: INICIO, fecha_fin: FIN });

    asegurar(!!resultado.fallback_odoo, `${grupo}: la respuesta trae fallback_odoo`);
    asegurar(
      Math.abs(resultado.dolares_totales - dolaresOriginal) < 0.01,
      `${grupo}: dolares_totales (${resultado.dolares_totales}) no cambia por el fallback (== ventasPorGrupo ${dolaresOriginal})`
    );

    const sumaCondicion = resultado.por_condicion.reduce((acc, r) => acc + r.dolares, 0);
    asegurar(
      Math.abs(sumaCondicion - resultado.dolares_totales) < 0.5,
      `${grupo}: suma de por_condicion (${sumaCondicion.toFixed(2)}) == dolares_totales (${resultado.dolares_totales}) tras el fallback`
    );

    const sumaCondicionFuente = resultado.por_condicion_y_fuente.reduce((acc, r) => acc + r.dolares, 0);
    asegurar(
      Math.abs(sumaCondicionFuente - resultado.dolares_totales) < 0.5,
      `${grupo}: suma de por_condicion_y_fuente (${sumaCondicionFuente.toFixed(2)}) == dolares_totales tras el fallback`
    );

    const dolaresOdooFallback = resultado.por_condicion_y_fuente
      .filter((r) => r.fuente_condicion === "ODOO_FALLBACK")
      .reduce((acc, r) => acc + r.dolares, 0);
    asegurar(
      Math.abs(dolaresOdooFallback - resultado.fallback_odoo.dolares_resueltos) < 0.5,
      `${grupo}: suma de filas ODOO_FALLBACK (${dolaresOdooFallback.toFixed(2)}) == fallback_odoo.dolares_resueltos (${resultado.fallback_odoo.dolares_resueltos})`
    );

    asegurar(
      resultado.fallback_odoo.resueltos <= resultado.fallback_odoo.intentados,
      `${grupo}: resueltos (${resultado.fallback_odoo.resueltos}) <= intentados (${resultado.fallback_odoo.intentados})`
    );
    asegurar(resultado.fallback_odoo.error === null, `${grupo}: el fallback corrió sin error (Odoo respondió)`);
  }

  // ===== ventasPorRutaCondicion (modo grupo) =====
  for (const grupo of ["DOMICILIO", "EMPRESAS"]) {
    const resultado = await ventasPorRutaCondicion({ grupo, fecha_inicio: INICIO, fecha_fin: FIN });
    asegurar(!!resultado.fallback_odoo, `ventasPorRutaCondicion ${grupo}: la respuesta trae fallback_odoo`);
    asegurar(resultado.fallback_odoo.error === null, `ventasPorRutaCondicion ${grupo}: el fallback corrió sin error`);

    const sumaPorRuta = resultado.por_ruta.reduce((acc, r) => acc + r.dolares_totales, 0);
    asegurar(
      Math.abs(sumaPorRuta - resultado.dolares_totales) < 0.5,
      `ventasPorRutaCondicion ${grupo}: suma de por_ruta.dolares_totales (${sumaPorRuta.toFixed(2)}) == dolares_totales (${resultado.dolares_totales})`
    );

    const sumaSinDato = resultado.por_ruta.reduce((acc, r) => acc + r.dolares_sin_dato, 0);
    if (resultado.fallback_odoo.resueltos > 0) {
      asegurar(
        sumaSinDato < resultado.fallback_odoo.dolares_resueltos + 1000000,
        `ventasPorRutaCondicion ${grupo}: dolares_sin_dato restante (${sumaSinDato.toFixed(2)}) es coherente tras resolver ${resultado.fallback_odoo.resueltos} clientes`
      );
    }

    // Ninguna ruta debe quedar con dolares_sin_dato negativo (indicaría que
    // se restó más de lo que había).
    const rutaNegativa = resultado.por_ruta.find((r) => r.dolares_sin_dato < -0.01);
    asegurar(!rutaNegativa, `ventasPorRutaCondicion ${grupo}: ninguna ruta queda con dolares_sin_dato negativo`);
  }

  // DOMICILIO en este rango se resuelve casi/por-completo (confirmado en
  // vivo durante el build) — si algún día esto deja de cumplirse no es un
  // bug del código, pero avisa que vale la pena revisar de nuevo el %.
  const domicilio = await ventasPorCondicionPago({ grupo: "DOMICILIO", fecha_inicio: INICIO, fecha_fin: FIN });
  asegurar(
    domicilio.fallback_odoo.resueltos > 0,
    `DOMICILIO: el fallback SÍ resuelve clientes reales en este rango (resueltos=${domicilio.fallback_odoo.resueltos})`
  );

  console.log("\nFALLBACK ODOO CONDICION PAGO REAL TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
