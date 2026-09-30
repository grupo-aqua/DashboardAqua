const sequelize = require('../db');

// =============================
// IMPORTACIÓN DE MODELOS
// =============================
const Factura = require('./factura');
const DetalleDocumento = require('./detalleDocumento');
const MetaPreventa = require('./metaPreventa');
const Clientes = require('./clientes');
const Orden = require('./orden');
const SincronizacionVenta = require('./SincronizacionVenta');
const DireccionCliente = require('./DireccionCliente');
const ClienteUsuarioVenta = require('./ClienteUsuarioVenta');
const AppUser = require('./AppUser');
const HistorialVisitas = require('./HistorialVisitas');
const Ruta = require('./Ruta');
const DetalleRuta = require('./DetalleRuta');
const TipoNegocio = require('./tipos_negocio');
const TipoDocumentoLatam = require('./TipoDocumentoLatam');
const Producto = require('./Producto');
const Subcanal = require('./Subcanal'); // 🔥 NUEVO
const CottsaExtraMes = require('./CottsaExtraMes');
const ContactoRecuperacion = require('./ContactoRecuperacion');
const PosOrder = require('./posOrder');
const PosOrderLine = require('./posOrderLine');
const Promo = require('./Promo');                 // 🔥 NUEVO — promociones MobilVendor
const PromoCondicion = require('./PromoCondicion');
const PromoAccion = require('./PromoAccion');
const UsuarioEnPromo = require('./UsuarioEnPromo');
const PromoLineaVenta = require('./PromoLineaVenta'); // líneas de venta con promo (aisladas de Odoo)
const VigiloVehiculo = require('./VigiloVehiculo');       // 🔥 NUEVO — flota Vigilo
const VigiloTramoRuta = require('./VigiloTramoRuta');     // 🔥 NUEVO — tramos ruta/parada Vigilo

// =============================
// RELACIONES
// =============================

// ---------- FACTURA ----------
Factura.belongsTo(Clientes, {
  foreignKey: 'customer_code',
  targetKey: 'codigo_cliente',
  as: 'cliente_venta',
});

Factura.hasMany(DetalleDocumento, {
  foreignKey: 'documento_code',
  sourceKey: 'code',
  as: 'detalles',
});

DetalleDocumento.belongsTo(Factura, {
  foreignKey: 'documento_code',
  targetKey: 'code',
  as: 'factura',
});

// Relación Factura con TipoDocumentoLatam
TipoDocumentoLatam.hasMany(Factura, {
  foreignKey: 'tipo_documento',
  as: 'facturas',
});

Factura.belongsTo(TipoDocumentoLatam, {
  foreignKey: 'tipo_documento',
  as: 'tipo_documento_latam',
});

// ---------- ORDEN ----------
Orden.belongsTo(Clientes, {
  foreignKey: 'customer_code',
  targetKey: 'codigo_cliente',
  as: 'cliente_venta',
});

Orden.hasMany(DetalleDocumento, {
  foreignKey: 'documento_code',
  sourceKey: 'code',
  as: 'detalles',
});

DetalleDocumento.belongsTo(Orden, {
  foreignKey: 'documento_code',
  targetKey: 'code',
  as: 'orden',
});

// 🔥 RELACIÓN ORDEN → SUBCANAL
Orden.belongsTo(Subcanal, {
  foreignKey: 'codigo_subcanal',
  targetKey: 'codigo_subcanal',
  as: 'subcanal',
});

// 🔥 RELACIÓN ORDEN → TIPO NEGOCIO
Orden.belongsTo(TipoNegocio, {
  foreignKey: 'codigo_tipo_negocio',
  targetKey: 'codigo',
  as: 'tipo_negocio',
});

// 🔥 RELACIÓN FACTURA → SUBCANAL
Factura.belongsTo(Subcanal, {
  foreignKey: 'codigo_subcanal',
  targetKey: 'codigo_subcanal',
  as: 'subcanal',
});

// 🔥 RELACIÓN FACTURA → TIPO NEGOCIO
Factura.belongsTo(TipoNegocio, {
  foreignKey: 'codigo_tipo_negocio',
  targetKey: 'codigo',
  as: 'tipo_negocio',
});

// ---------- PRODUCTO ----------
DetalleDocumento.belongsTo(Producto, {
  foreignKey: 'codigo_producto',
  targetKey: 'codigo_producto',
  as: 'producto',
});

Producto.hasMany(DetalleDocumento, {
  foreignKey: 'codigo_producto',
  sourceKey: 'codigo_producto',
  as: 'detalles',
});

// ---------- RUTAS ----------
HistorialVisitas.belongsTo(Ruta, {
  foreignKey: 'codigo_ruta',
  targetKey: 'codigo',
  as: 'rutaDirecta',
});

Ruta.hasMany(DetalleRuta, {
  foreignKey: 'route_code',
  sourceKey: 'codigo',
  as: 'detalles_rutas',
});

DetalleRuta.belongsTo(Ruta, {
  foreignKey: 'route_code',
  targetKey: 'codigo',
  as: 'rutaDetalle',
});

// ---------- CLIENTES ----------
DetalleRuta.belongsTo(Clientes, {
  foreignKey: 'customer_code',
  targetKey: 'codigo_cliente',
  as: 'cliente',
});

HistorialVisitas.belongsTo(Clientes, {
  foreignKey: 'codigo_cliente',
  targetKey: 'codigo_cliente',
  as: 'cliente',
});

// 🔥 RELACIÓN CLIENTE → TIPO NEGOCIO
Clientes.belongsTo(TipoNegocio, {
  foreignKey: 'codigo_tipo_negocio',
  targetKey: 'codigo',
  as: 'tipo_negocio',
});

// 🔥 RELACIÓN CLIENTE → SUBCANAL
Clientes.belongsTo(Subcanal, {
  foreignKey: 'codigo_subcanal',
  targetKey: 'codigo_subcanal',
  as: 'subcanal',
});

// ---------- SUBCANAL ----------
Subcanal.hasMany(Clientes, {
  foreignKey: 'codigo_subcanal',
  sourceKey: 'codigo_subcanal',
  as: 'clientes',
});

Subcanal.hasMany(Orden, {
  foreignKey: 'codigo_subcanal',
  sourceKey: 'codigo_subcanal',
  as: 'ordenes',
});

Subcanal.hasMany(Factura, {
  foreignKey: 'codigo_subcanal',
  sourceKey: 'codigo_subcanal',
  as: 'facturas',
});

TipoNegocio.hasMany(Factura, {
  foreignKey: 'codigo_tipo_negocio',
  sourceKey: 'codigo',
  as: 'facturas',
});

TipoNegocio.hasMany(Orden, {
  foreignKey: 'codigo_tipo_negocio',
  sourceKey: 'codigo',
  as: 'ordenes',
});

// ---------- HISTORIAL VISITAS Y ORDEN ----------
HistorialVisitas.belongsTo(Orden, {
  foreignKey: 'codigo_cliente',
  targetKey: 'customer_code',
  as: 'orden',
});

// ---------- POS ORDER ----------
PosOrder.hasMany(PosOrderLine, {
  foreignKey: 'order_odoo_id',
  sourceKey: 'odoo_id',
  as: 'lines',
});

PosOrderLine.belongsTo(PosOrder, {
  foreignKey: 'order_odoo_id',
  targetKey: 'odoo_id',
  as: 'order',
});

// ---------- PROMOCIONES (MobilVendor) ----------
// promos (maestro) → condiciones, acciones y asignaciones por vendedor.
Promo.hasMany(PromoCondicion, {
  foreignKey: 'promo_code',
  sourceKey : 'code',
  as        : 'condiciones',
});
PromoCondicion.belongsTo(Promo, {
  foreignKey: 'promo_code',
  targetKey : 'code',
  as        : 'promo',
});

Promo.hasMany(PromoAccion, {
  foreignKey: 'promo_code',
  sourceKey : 'code',
  as        : 'acciones',
});
PromoAccion.belongsTo(Promo, {
  foreignKey: 'promo_code',
  targetKey : 'code',
  as        : 'promo',
});

Promo.hasMany(UsuarioEnPromo, {
  foreignKey: 'promo_code',
  sourceKey : 'code',
  as        : 'usuarios',
});
UsuarioEnPromo.belongsTo(Promo, {
  foreignKey: 'promo_code',
  targetKey : 'code',
  as        : 'promo',
});

// ---------- VIGILO (flota) ----------
VigiloVehiculo.hasMany(VigiloTramoRuta, {
  foreignKey: 'target_id',
  as        : 'tramos',
});
VigiloTramoRuta.belongsTo(VigiloVehiculo, {
  foreignKey: 'target_id',
  as        : 'vehiculo',
});

// =============================
// EXPORTACIÓN
// =============================
module.exports = {
  Factura,
  DetalleDocumento,
  MetaPreventa,
  Clientes,
  ClienteUsuarioVenta,
  Orden,
  SincronizacionVenta,
  DireccionCliente,
  AppUser,
  HistorialVisitas,
  Ruta,
  DetalleRuta,
  TipoNegocio,
  TipoDocumentoLatam,
  Producto,
  Subcanal, //  NUEVO
  CottsaExtraMes,
  ContactoRecuperacion,
  PosOrder,
  PosOrderLine,
  Promo,            // 🔥 NUEVO
  PromoCondicion,
  PromoAccion,
  UsuarioEnPromo,
  PromoLineaVenta,
  VigiloVehiculo,
  VigiloTramoRuta,
  sequelize,
};