const express = require("express");
const router = express.Router();
const { obtenerVentasPorRuta, obtenerPrecioPromedioLiquido } = require("../../controllers/controllerVentasPorRuta/ventasPorRutaController");

router.get("/", obtenerVentasPorRuta);
router.get("/precio-promedio-liquido", obtenerPrecioPromedioLiquido);

module.exports = router;
