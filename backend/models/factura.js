const { DataTypes } = require("sequelize");
const sequelize = require("../db");

const Factura = sequelize.define("Factura", {
  code: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  },

  //  ID real de Odoo (MUY recomendado)
  odoo_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    unique: true,
  },

  type: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  status: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  tipo_movimiento: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },

  fecha_creacion: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  fecha_autorizacion: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  fecha_entrega: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  fecha_vencimiento: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  customer_code: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  customer_address_code: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  // 🔥 RELACIÓN CON PEDIDO
  // TEXT: Odoo puede concatenar varias referencias (p.ej. NC sobre varias
  // facturas) y el valor llega a exceder 255 chars.
  invoice_origin: {
    type: DataTypes.TEXT,
    allowNull: true,
  },

  // 🔥 COMERCIAL (CRÍTICO PARA REPORTES)
  equipo_ventas: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  equipo_ventas_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  equipo_ventas_nombre: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  route_code: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  seller_code: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  total: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
  },

  subtotal: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
  },

  iva: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
  },

  discount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
  },

  saldo_pendiente: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
  },

  estado_pago: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  tipo_documento: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  moneda: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  auth_code: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  access_key: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  latitude: {
    type: DataTypes.DECIMAL(12, 8),
    allowNull: true,
  },

  longitude: {
    type: DataTypes.DECIMAL(12, 8),
    allowNull: true,
  },

  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },

  origen_sistema: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  company_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  reversed_entry_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  // Clasificación comercial
  codigo_tipo_negocio: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },

  codigo_subcanal: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },

  // Reconciliación MobilVendor↔Odoo (2026-10-01, ver TODO.md) — marcado NO
  // destructivo: si está poblado, esta fila es un duplicado detectado y su
  // valor es el `code` de la fila "buena" que debe contar en los reportes.
  duplicado_de: {
    type: DataTypes.STRING(30),
    allowNull: true,
  },

  // `id` crudo de la API de MobilVendor (NO el `code` fiscal, que cambia de
  // valor para el mismo documento real a lo largo de su ciclo de vida) —
  // lo captura solo el sync de MobilVendor, Odoo nunca lo conoce.
  mobilvendor_internal_id: {
    type: DataTypes.STRING(30),
    allowNull: true,
  },

}, {
  tableName: "facturas",
  timestamps: false,
});

module.exports = Factura;