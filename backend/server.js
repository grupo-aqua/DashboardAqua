require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

// ======================================================
// 🌐 CORS (LOCAL + PRODUCCIÓN)
// ======================================================
const allowedOrigins = [
  "https://dashboard.aqua.com.ec",
  "https://api.aqua.com.ec",
  "http://localhost:5173",
  "http://localhost:3000"
];

app.use(cors({
  origin: (origin, callback) => {
    // Permite Postman, cron, jobs internos
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "5mb" }));

// ======================================================
// 🔐 AUTH
// ======================================================
app.use("/api/login", require("./routes/login/loginRoutes"));
app.use("/api/usuarios", require("./routes/login/usuariosRoutes"));


// ======================================================
// 📦 PREVENTAS
// ======================================================
app.use("/api/sync", require("./routes/rutasPreventas/sincronizacionRoutes"));
app.use("/api/ventas", require("./routes/rutasPreventas/ventasRoutes"));
app.use("/api/ventas", require("./routes/rutasPreventas/detallePreventaRoutes"));
app.use("/api/metas", require("./routes/rutasPreventas/metasRoutes"));
app.use("/api/promos", require("./routes/rutasPromos/promosRoutes"));

// ======================================================
//  BOTELLONES
// ======================================================
app.use("/api/botellones", require("./routes/rutasBotellones/rutasBotellones"));
app.use("/api/botellones", require("./routes/rutasBotellones/detalleBotellonesRoutes"));
app.use("/api/metas-botellon", require("./routes/rutasBotellones/metasBotellonRoutes"));

// ======================================================
//  HIELO
// ======================================================
app.use("/api/hielo", require("./routes/rutasHielo/rutasHielo"));

// ======================================================
//  PLUS ELECTROLYTES
// ======================================================
app.use("/api/plus", require("./routes/rutasPlus/rutasPlus"));


// ======================================================
//  VISITAS RUTAS
// ======================================================
app.use("/api/visitas", require("./routes/rutasVisitas/visitasRoutes"));

const dashboardClientesRoutes = require("./routes/rutasClientes/dashboardClientes.routes");
app.use("/api/dashboard-clientes", dashboardClientesRoutes);


// ======================================================
//  bot
// ======================================================
app.use("/api/bot", require("./routes/rutasbotinteligente/chat.routes"));


// ======================================================
//  ODOO
// ======================================================
app.use("/api/odoo", require("./routes/rutasOdoo/odooRoutes"));


// ======================================================
//  COTTSA
// ======================================================
app.use("/api/COTTSA", require("./routes/rutasCotsa/cotsaRoutes"));


// ======================================================
//  CONSOLIDADO
// ======================================================
app.use("/api/consolidado", require("./routes/rutasConsolidado/consolidadoRoutes"));

// ======================================================
//  VENTAS POR RUTA (consumido por icl-backend — cuadre, liquidación)
// ======================================================
app.use("/api/ventas-por-ruta", require("./routes/rutasVentasPorRuta/ventasPorRutaRoutes"));

// ======================================================
//  CAFÉ — IIBC S.A.
// ======================================================
app.use("/api/cafe", require("./routes/rutasCafe/cafeRoutes"));

// ======================================================
//  GERENCIA EJECUTIVA
// ======================================================
app.use("/api/gerencia", require("./routes/rutasGerencia/gerenciaRoutes"));

// ======================================================
// HEALTHCHECK
// ======================================================
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ======================================================
// ⏰ CRON — Sincronización automática 12:00 AM y 12:00 PM
// ======================================================
require('./cron/tareasCron');

// ======================================================
// 🚀 START SERVER
// ======================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`✅ API escuchando en puerto ${PORT}`);

  // 1) Esquema completo idempotente (tablas, vista, triggers, índices) desde
  //    backend/sql/. Seguro de re-ejecutar en cada arranque/deploy.
  try {
    const runStartupSql = require("./utils/runStartupSql");
    await runStartupSql();
  } catch (err) {
    console.error("⚠ Error en runStartupSql:", err.message);
  }

  // 2) Crea automáticamente cualquier tabla de un modelo Sequelize que aún no
  //    exista (ej. pos_orders, pos_order_lines, contactos_recuperacion). NO
  //    altera ni borra tablas existentes (sync sin alter/force).
  try {
    const { sequelize } = require("./models");
    await sequelize.sync();
    console.log("✅ Modelos sincronizados (tablas faltantes creadas)");
  } catch (err) {
    console.error("⚠ Error en sequelize.sync():", err.message);
  }
});
