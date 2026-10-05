const express = require("express");
const router = express.Router();
const {
  obtenerVentasPorRuta,
  obtenerPrecioPromedioLiquido,
  obtenerVentaPorProducto,
  obtenerPrecioPromedioProducto,
} = require("../../controllers/controllerVentasPorRuta/ventasPorRutaController");

router.get("/", obtenerVentasPorRuta);
router.get("/precio-promedio-liquido", obtenerPrecioPromedioLiquido);
router.get("/por-producto", obtenerVentaPorProducto);
router.get("/precio-promedio-producto", obtenerPrecioPromedioProducto);

module.exports = router;
