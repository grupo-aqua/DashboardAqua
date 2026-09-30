// scripts/syncVigilo.js
// Prueba/disparo manual de la sincronización de paradas de flota (Vigilo).
// Uso:  node scripts/syncVigilo.js
//
// Requiere que el backend ya se haya arrancado al menos una vez (para que
// el bootstrap haya creado vigilo_vehiculos / vigilo_tramos_ruta vía
// 000_schema.sql) y que VIGILO_ACCOUNT_ID esté en backend/.env.
//
// Corre el ciclo completo (roster + ~34 vehículos a 15s cada uno) — toma
// ~9 minutos, mismo tiempo que el cron de las 23:00.
"use strict";

require("dotenv").config();

const { sincronizarParadasFlota } = require("../services/vigiloServicio/sincronizacionVigiloService");

(async () => {
  try {
    console.log("🚚 Iniciando sync de paradas de flota (Vigilo)...");
    const resultado = await sincronizarParadasFlota();
    console.log("\n📊 RESULTADO:", JSON.stringify(resultado, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Falló el sync de Vigilo:", err.message);
    process.exit(1);
  }
})();
