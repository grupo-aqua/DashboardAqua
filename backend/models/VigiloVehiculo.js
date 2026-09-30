const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const VigiloVehiculo = sequelize.define('VigiloVehiculo', {
  target_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    allowNull: false,
  },
  tag: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  grupo_vigilo: DataTypes.STRING,
  placa: DataTypes.STRING,
  activo: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  actualizado_en: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'vigilo_vehiculos',
  timestamps: false,
});

VigiloVehiculo.associate = (models) => {
  VigiloVehiculo.hasMany(models.VigiloTramoRuta, {
    foreignKey: 'target_id',
    as: 'tramos',
  });
};

module.exports = VigiloVehiculo;
