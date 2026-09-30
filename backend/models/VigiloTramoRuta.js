const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const VigiloTramoRuta = sequelize.define('VigiloTramoRuta', {
  trace_id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    allowNull: false,
  },
  target_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'vigilo_vehiculos',
      key: 'target_id',
    },
  },
  tipo_tramo: {
    // STRING, no ENUM: la columna real es VARCHAR(10) + CHECK constraint
    // (ver 000_schema.sql) — no un tipo ENUM nativo de Postgres.
    type: DataTypes.STRING(10),
    allowNull: false,
    validate: { isIn: [['RUTA', 'PARADA']] },
  },
  desde_fecha: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  hasta_fecha: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  duracion_segundos: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  desde_lat: DataTypes.DECIMAL(10, 6),
  desde_lon: DataTypes.DECIMAL(10, 6),
  hasta_lat: DataTypes.DECIMAL(10, 6),
  hasta_lon: DataTypes.DECIMAL(10, 6),
  desde_direccion: DataTypes.TEXT,
  hasta_direccion: DataTypes.TEXT,
  cruza_medianoche: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  odometro_distancia: DataTypes.DECIMAL(10, 2),
  sincronizado_en: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'vigilo_tramos_ruta',
  timestamps: false,
});

VigiloTramoRuta.associate = (models) => {
  VigiloTramoRuta.belongsTo(models.VigiloVehiculo, {
    foreignKey: 'target_id',
    as: 'vehiculo',
  });
};

module.exports = VigiloTramoRuta;
