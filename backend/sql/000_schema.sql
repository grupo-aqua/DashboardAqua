-- =========================================================================
-- ESQUEMA CONSOLIDADO — DASHBOARD AQUA (archivo ÚNICO)
-- Se ejecuta AUTOMÁTICAMENTE en cada arranque (backend/utils/runStartupSql.js).
-- 100% idempotente. Incluye: tablas, vista, triggers, índices y migraciones.
-- Las tablas de modelos no listadas aquí (pos_orders, etc.) las crea
-- sequelize.sync() al arrancar.
-- =========================================================================

-- =========================================================================
-- ESTRUCTURA DE BASE DE DATOS — DASHBOARD AQUA
-- Versión: 2026-04-18
-- Motor: PostgreSQL 12+
-- -------------------------------------------------------------------------
-- Este archivo es IDEMPOTENTE: puede ejecutarse cuantas veces sea necesario
-- en el mismo entorno sin producir errores. Está diseñado para:
--   • Crear cualquier tabla / índice / constraint / trigger faltante.
--   • Añadir columnas nuevas a tablas existentes sin romper datos.
--   • Reemplazar funciones / vistas sin pérdida de dependencias.
-- -------------------------------------------------------------------------
-- Las tablas están sincronizadas con los modelos Sequelize ubicados en:
--   backend/models/
-- Cualquier campo añadido en los modelos debe reflejarse aquí antes del
-- despliegue a producción.
-- =========================================================================


-- =========================================================================
-- SECCIÓN 1 — USUARIOS DE LA APLICACIÓN (app_users)
-- Modelo: backend/models/AppUser.js
-- Usuarios internos que acceden al dashboard (roles: ADMIN, VENDEDOR,
-- DESPACHADOR, SUPERVISOR). Las rutas asignadas se guardan como array.
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_users (
    id              SERIAL PRIMARY KEY,
    usuario         TEXT UNIQUE NOT NULL,
    clave           TEXT NOT NULL,
    rol             TEXT NOT NULL CHECK (rol IN ('ADMIN', 'VENDEDOR', 'DESPACHADOR', 'SUPERVISOR')),
    rutas_asignadas TEXT[] DEFAULT '{}',
    token_version   INTEGER DEFAULT 0,
    creado_en       TIMESTAMP DEFAULT NOW(),
    actualizado_en  TIMESTAMP DEFAULT NOW()
);

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version   INTEGER DEFAULT 0;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rutas_asignadas TEXT[] DEFAULT '{}';
-- Módulos del dashboard que el usuario puede ver (privilegios editables desde la UI).
-- Vacío = usa los permisos por defecto del rol/canal. Con valores = lista explícita.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS modulos_permitidos TEXT[] DEFAULT '{}';
-- Secciones permitidas por módulo: { "/dashboard/botellon": ["TIENDAS"], ... }.
-- Para un módulo concedido sin secciones aquí → ve todo el módulo.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS modulo_secciones JSONB DEFAULT '{}'::jsonb;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS creado_en       TIMESTAMP DEFAULT NOW();
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS actualizado_en  TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_app_users_rol ON app_users(rol);


-- =========================================================================
-- SECCIÓN 2 — TIPOS DE NEGOCIO (tipos_negocio)
-- Modelo: backend/models/tipos_negocio.js
-- Catálogo maestro de clasificación comercial (TIENDAS, MAYORISTA, VIP,
-- RURAL, EMPRESAS, etc.). Referenciado por clientes, ordenes y facturas.
-- =========================================================================
CREATE TABLE IF NOT EXISTS tipos_negocio (
    id                   SERIAL PRIMARY KEY,
    codigo               VARCHAR(50) UNIQUE NOT NULL,
    descripcion          VARCHAR(150) NOT NULL,
    color                VARCHAR(20),
    estado               INT DEFAULT 1,
    fecha_creacion       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tipos_negocio ADD COLUMN IF NOT EXISTS color               VARCHAR(20);
ALTER TABLE tipos_negocio ADD COLUMN IF NOT EXISTS estado              INT DEFAULT 1;
ALTER TABLE tipos_negocio ADD COLUMN IF NOT EXISTS fecha_creacion      TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE tipos_negocio ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_tipos_negocio_codigo ON tipos_negocio(codigo);


-- =========================================================================
-- SECCIÓN 3 — SUBCANALES (subcanales)
-- Modelo: backend/models/Subcanal.js
-- Subclasificación dentro de un tipo de negocio (ej. TIENDAS → BARRIO,
-- MINIMARKET, etc.). Permite análisis más granular del canal comercial.
-- =========================================================================
CREATE TABLE IF NOT EXISTS subcanales (
    id_subcanal          SERIAL PRIMARY KEY,
    codigo_subcanal      VARCHAR(50) UNIQUE NOT NULL,
    descripcion_subcanal VARCHAR(255),
    codigo_tipo_negocio  VARCHAR(50),
    estado               INTEGER DEFAULT 1,
    fecha_creacion       TIMESTAMP DEFAULT NOW(),
    fecha_actualizacion  TIMESTAMP DEFAULT NOW()
);

ALTER TABLE subcanales ADD COLUMN IF NOT EXISTS codigo_tipo_negocio VARCHAR(50);
ALTER TABLE subcanales ADD COLUMN IF NOT EXISTS estado              INTEGER DEFAULT 1;
ALTER TABLE subcanales ADD COLUMN IF NOT EXISTS fecha_creacion      TIMESTAMP DEFAULT NOW();
ALTER TABLE subcanales ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_subcanales_codigo        ON subcanales(codigo_subcanal);
CREATE INDEX IF NOT EXISTS idx_subcanales_tipo_negocio  ON subcanales(codigo_tipo_negocio);

-- Trigger idempotente: actualiza fecha_actualizacion en cada UPDATE
CREATE OR REPLACE FUNCTION update_subcanales_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.fecha_actualizacion = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_subcanales ON subcanales;
CREATE TRIGGER trg_update_subcanales
BEFORE UPDATE ON subcanales
FOR EACH ROW
EXECUTE FUNCTION update_subcanales_timestamp();


-- =========================================================================
-- SECCIÓN 4 — PRODUCTOS (productos)
-- Modelo: backend/models/Producto.js
-- Catálogo maestro de productos (botellones, hielo, etc.). La PK es
-- codigo_producto (string) para mantener compatibilidad con MobilVendor.
-- =========================================================================
CREATE TABLE IF NOT EXISTS productos (
    codigo_producto          VARCHAR(50) PRIMARY KEY,
    nombre_producto          VARCHAR(255) NOT NULL,
    nombre_producto_completo TEXT,
    nombre_alterno           VARCHAR(150),
    descripcion_venta        TEXT,
    codigo_barras            VARCHAR(100),
    codigo_marca             VARCHAR(50),
    codigo_categoria         VARCHAR(50),
    codigo_subcategoria      VARCHAR(50),
    codigo_familia           VARCHAR(50),
    codigo_unidad_medida     VARCHAR(50),
    unidad_medida            VARCHAR(50),
    unidad_medida_compra     VARCHAR(50),
    codigo_tipo_inventario   VARCHAR(50),
    costo                    NUMERIC(12,2),
    ultimo_costo             NUMERIC(12,2),
    precio                   DECIMAL(12,2),
    peso                     DECIMAL(10,3) DEFAULT 0,
    volumen                  DECIMAL(10,3) DEFAULT 0,
    estado                   INTEGER,
    activo                   BOOLEAN DEFAULT TRUE,
    tipo_producto            VARCHAR(50),
    origen_sistema           VARCHAR(50),
    mobilvendor_id           VARCHAR(100)
);

ALTER TABLE productos ADD COLUMN IF NOT EXISTS nombre_producto_completo TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS descripcion_venta        TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidad_medida            VARCHAR(50);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidad_medida_compra     VARCHAR(50);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio                   DECIMAL(12,2);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS peso                     DECIMAL(10,3) DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS volumen                  DECIMAL(10,3) DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS activo                   BOOLEAN DEFAULT TRUE;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS tipo_producto            VARCHAR(50);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS origen_sistema           VARCHAR(50);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS mobilvendor_id           VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(codigo_categoria);
CREATE INDEX IF NOT EXISTS idx_productos_marca     ON productos(codigo_marca);
CREATE INDEX IF NOT EXISTS idx_productos_estado    ON productos(estado);


-- =========================================================================
-- SECCIÓN 5 — CLIENTES (clientes)
-- Modelo: backend/models/clientes.js
-- Maestro de clientes unificado (Odoo + MobilVendor). La PK codigo_cliente
-- se mantiene como string para interoperabilidad multi-sistema.
-- =========================================================================
CREATE TABLE IF NOT EXISTS clientes (
    id_cliente                       SERIAL PRIMARY KEY,
    codigo_cliente                   VARCHAR(255) UNIQUE,

    -- Identificación corporativa
    company_id                       VARCHAR(20),
    descripcion_company              VARCHAR(200),

    -- Identificación fiscal
    tipo_identificacion_cliente      VARCHAR(50),
    identificacion_cliente           VARCHAR(30),

    -- Datos comerciales
    nombre_cliente                   VARCHAR(255),
    nombre_comercial_cliente         VARCHAR(255),
    contacto_cliente                 VARCHAR(255),

    -- Clasificación comercial
    codigo_tipo_negocio              VARCHAR(50),
    codigo_subcanal                  VARCHAR(50),

    -- Configuración financiera
    codigo_moneda_cliente            VARCHAR(3) DEFAULT 'USD',
    codigo_lista_precio_cliente      VARCHAR(50),
    metodo_pago_cliente              VARCHAR(50),
    condicion_pago_cliente           VARCHAR(100),
    codigo_grupo_cliente             VARCHAR(100),
    descuento_cliente                DECIMAL(10,2) DEFAULT 0.00,
    objetivo_venta_cliente           DECIMAL(10,2),
    saldo_cliente                    DECIMAL(10,2) DEFAULT 0.00,
    tiene_credito_cliente            BOOLEAN DEFAULT FALSE,
    tiene_documentos_cliente         BOOLEAN DEFAULT TRUE,

    -- Estados
    estado                           VARCHAR(25),
    estado_cliente                   INT DEFAULT 0,
    estado_proceso_cliente           INT DEFAULT 0,

    -- Ubicación
    nacionalidad_cliente             VARCHAR(100),
    codigo_usuario_asignado_cliente  VARCHAR(50),
    email_cliente                    VARCHAR(500),
    telefono_cliente                 VARCHAR(100),
    direccion_cliente                TEXT,
    ciudad_cliente                   VARCHAR(150),
    pais_cliente                     VARCHAR(150),
    industria_cliente                VARCHAR(150),

    -- Correo comercial alternativo
    correo_cliente                   VARCHAR(255),

    -- Geolocalización (antes TEXT; migrado a DECIMAL para cálculos espaciales)
    latitud_cliente                  DECIMAL(12,8),
    longitud_cliente                 DECIMAL(12,8),

    -- Relación comercial
    frecuencia_cliente               VARCHAR(100),
    vendedor_asignado_cliente        VARCHAR(100),
    comentario_cliente               TEXT,

    -- Integraciones externas
    id_odoo                          INTEGER,
    fecha_envio_odoo                 TIMESTAMP,
    mobilvendor_id_cliente           VARCHAR(100),

    -- Auditoría
    fecha_creacion_cliente           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion_cliente      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Añadir columnas faltantes si la tabla ya existía
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_subcanal                 VARCHAR(50);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS correo_cliente                  VARCHAR(255);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS descripcion_company             VARCHAR(200);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS id_odoo                         INTEGER;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_envio_odoo                TIMESTAMP;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS mobilvendor_id_cliente          VARCHAR(100);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS frecuencia_cliente              VARCHAR(100);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS vendedor_asignado_cliente       VARCHAR(100);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS comentario_cliente              TEXT;

-- FK: clientes → tipos_negocio
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_clientes_tipo_negocio'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT fk_clientes_tipo_negocio
      FOREIGN KEY (codigo_tipo_negocio)
      REFERENCES tipos_negocio(codigo)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- FK: clientes → subcanales
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_clientes_subcanal'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT fk_clientes_subcanal
      FOREIGN KEY (codigo_subcanal)
      REFERENCES subcanales(codigo_subcanal)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- Índices de rendimiento
CREATE INDEX IF NOT EXISTS idx_clientes_codigo_cliente           ON clientes(codigo_cliente);
CREATE INDEX IF NOT EXISTS idx_clientes_identificacion_cliente   ON clientes(identificacion_cliente);
CREATE INDEX IF NOT EXISTS idx_clientes_estado_cliente           ON clientes(estado_cliente);
CREATE INDEX IF NOT EXISTS idx_clientes_estado_proceso_cliente   ON clientes(estado_proceso_cliente);
CREATE INDEX IF NOT EXISTS idx_clientes_codigo_usuario_asignado  ON clientes(codigo_usuario_asignado_cliente);
CREATE INDEX IF NOT EXISTS idx_clientes_codigo_tipo_negocio      ON clientes(codigo_tipo_negocio);
CREATE INDEX IF NOT EXISTS idx_clientes_subcanal                 ON clientes(codigo_subcanal);

-- Trigger idempotente para fecha_actualizacion_cliente
CREATE OR REPLACE FUNCTION update_cliente_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.fecha_actualizacion_cliente = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_cliente_timestamp ON clientes;
CREATE TRIGGER update_cliente_timestamp
BEFORE UPDATE ON clientes
FOR EACH ROW
EXECUTE FUNCTION update_cliente_timestamp();


-- =========================================================================
-- SECCIÓN 6 — DIRECCIONES DE CLIENTES (direcciones_clientes)
-- Modelo: backend/models/DireccionCliente.js
-- Un cliente puede tener múltiples direcciones de entrega. La combinación
-- (codigo_cliente, codigo_direccion_cliente) debe ser única.
-- =========================================================================
CREATE TABLE IF NOT EXISTS direcciones_clientes (
    id_direccion_cliente                   SERIAL PRIMARY KEY,
    codigo_cliente                         VARCHAR(255) NOT NULL,
    descripcion_direccion_cliente          VARCHAR(255),
    codigo_direccion_cliente               VARCHAR(255),
    calle1_direccion_cliente               VARCHAR(255),
    bloque_direccion_cliente               VARCHAR(255),
    calle2_direccion_cliente               VARCHAR(255),
    referencia_direccion_cliente           VARCHAR(255),
    codigo_postal_direccion_cliente        VARCHAR(50),
    telefono_direccion_cliente             VARCHAR(50),
    fax_direccion_cliente                  VARCHAR(50),
    email_direccion_cliente                VARCHAR(100),
    latitud_direccion_cliente              DECIMAL(15,8),
    longitud_direccion_cliente             DECIMAL(15,8),
    fecha_ultima_visita_direccion_cliente  TIMESTAMP,
    estado_direccion_cliente               INT DEFAULT 1,
    estado_ubicacion_direccion_cliente     INT DEFAULT 3,
    fecha_creacion_direccion_cliente       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion_direccion_cliente  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- FK: direcciones_clientes → clientes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_direcciones_clientes'
  ) THEN
    ALTER TABLE direcciones_clientes
      ADD CONSTRAINT fk_direcciones_clientes
      FOREIGN KEY (codigo_cliente)
      REFERENCES clientes(codigo_cliente)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Unique compuesto cliente + codigo_direccion (evita duplicados lógicos)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_cliente_direccion'
  ) THEN
    ALTER TABLE direcciones_clientes
      ADD CONSTRAINT unique_cliente_direccion
      UNIQUE (codigo_cliente, codigo_direccion_cliente);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_codigo_cliente ON direcciones_clientes(codigo_cliente);
CREATE INDEX IF NOT EXISTS idx_direcciones_cliente_estado_fecha
    ON direcciones_clientes(codigo_cliente, estado_direccion_cliente, fecha_actualizacion_direccion_cliente);

-- Trigger idempotente para fecha_actualizacion_direccion_cliente
CREATE OR REPLACE FUNCTION update_direccion_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.fecha_actualizacion_direccion_cliente = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_direccion_timestamp ON direcciones_clientes;
CREATE TRIGGER update_direccion_timestamp
BEFORE UPDATE ON direcciones_clientes
FOR EACH ROW
EXECUTE FUNCTION update_direccion_timestamp();


-- =========================================================================
-- SECCIÓN 7 — RELACIÓN CLIENTE ↔ VENDEDOR (clientes_usuarios_ventas)
-- Modelo: backend/models/ClienteUsuarioVenta.js
-- Tabla de asignación N a N. Un cliente puede ser atendido por múltiples
-- vendedores (PREVENTA, TELEVENTA, VIP). Cada fila representa el vínculo
-- cliente + dirección + vendedor.
-- =========================================================================
CREATE TABLE IF NOT EXISTS clientes_usuarios_ventas (
    id_relacion              SERIAL PRIMARY KEY,
    codigo_cliente           VARCHAR(50) NOT NULL,
    codigo_direccion_cliente TEXT NOT NULL DEFAULT 'DEFAULT',
    seller_code              VARCHAR(50) NOT NULL,
    ruta_code                VARCHAR(50),
    tipo_atencion            VARCHAR(20),
    ultima_atencion          TIMESTAMP
);

ALTER TABLE clientes_usuarios_ventas ADD COLUMN IF NOT EXISTS ruta_code                VARCHAR(50);
ALTER TABLE clientes_usuarios_ventas ADD COLUMN IF NOT EXISTS tipo_atencion            VARCHAR(20);
ALTER TABLE clientes_usuarios_ventas ADD COLUMN IF NOT EXISTS ultima_atencion          TIMESTAMP;
ALTER TABLE clientes_usuarios_ventas ADD COLUMN IF NOT EXISTS codigo_direccion_cliente TEXT NOT NULL DEFAULT 'DEFAULT';

-- Limpieza: índice único antiguo de 2 columnas (codigo_cliente, seller_code)
-- auto-generado por sequelize.sync() en versiones previas. Era incorrecto
-- porque un cliente puede ser atendido por el mismo vendedor en direcciones
-- distintas; la unicidad real incluye codigo_direccion_cliente (ver abajo).
DROP INDEX IF EXISTS clientes_usuarios_ventas_codigo_cliente_seller_code;

-- Unique: cliente + vendedor + dirección (evita duplicar asignaciones)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_cliente_seller_direccion'
  ) THEN
    ALTER TABLE clientes_usuarios_ventas
      ADD CONSTRAINT uq_cliente_seller_direccion
      UNIQUE (codigo_cliente, seller_code, codigo_direccion_cliente);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cuv_cliente ON clientes_usuarios_ventas(codigo_cliente);
CREATE INDEX IF NOT EXISTS idx_cuv_seller  ON clientes_usuarios_ventas(seller_code);
CREATE INDEX IF NOT EXISTS idx_cuv_ruta    ON clientes_usuarios_ventas(ruta_code);


-- =========================================================================
-- SECCIÓN 8 — ÓRDENES DE VENTA (ordenes)
-- Modelo: backend/models/orden.js
-- Órdenes provenientes de Odoo y MobilVendor. Incluye la orden completa
-- con clasificación, estado, montos, logística y rentabilidad. Es el
-- núcleo del dashboard comercial.
-- =========================================================================
CREATE TABLE IF NOT EXISTS ordenes (
    id_orden              SERIAL PRIMARY KEY,
    code                  VARCHAR(50) NOT NULL UNIQUE,
    type                  INT,
    status                INT,

    -- Clasificación comercial
    codigo_tipo_negocio   VARCHAR(50),
    codigo_subcanal       VARCHAR(50),

    -- Fechas operativas
    fecha_creacion        TIMESTAMP,
    fecha_entrega         TIMESTAMP,
    fecha_validez         TIMESTAMP,
    fecha_compromiso      TIMESTAMP,

    -- Cliente
    customer_code         VARCHAR(50),
    customer_nombre       VARCHAR(255),
    customer_address_code VARCHAR(100),

    -- Comercial
    route_code            VARCHAR(50),
    seller_code           VARCHAR(50),
    seller_nombre         VARCHAR(255),
    equipo_ventas         VARCHAR(100),
    equipo_ventas_id      INTEGER,
    equipo_ventas_nombre  VARCHAR(255),
    campania_id           INT,
    descripcion_company   VARCHAR(60),
    medio_id              INT,
    fuente_id             INT,

    -- Estados de flujo Odoo
    estado_odoo           VARCHAR(50),
    estado_facturacion    VARCHAR(50),
    estado_entrega        VARCHAR(50),

    -- Monetario
    moneda                VARCHAR(10),
    tasa_cambio           DECIMAL(18,6),
    subtotal              DECIMAL(18,2),
    iva                   DECIMAL(18,2),
    discount              DECIMAL(18,2),
    total                 DECIMAL(18,2),
    monto_no_pagado       DECIMAL(18,2),
    costo_envio           DECIMAL(18,2),

    -- Rentabilidad
    margen                DECIMAL(12,2) DEFAULT 0,
    margen_porcentaje     DECIMAL(6,2) DEFAULT 0,

    -- Pago
    payment_term_id       INTEGER,
    payment_term_nombre   VARCHAR(255),

    -- Logística
    almacen_id            INT,
    almacen_nombre        VARCHAR(255),
    transportista_id      INT,
    transportista_nombre  VARCHAR(255),
    peso_total            DECIMAL(10,3) DEFAULT 0,
    politica_entrega      VARCHAR(50),

    -- Trazabilidad
    parent_id             VARCHAR(50),
    source_document       VARCHAR(255),
    latitude              DECIMAL(12,8),
    longitude             DECIMAL(12,8),
    concept_code          VARCHAR(50),
    concept_origin        VARCHAR(50),
    sequence_type         VARCHAR(10),
    etiquetas             TEXT,
    notes                 TEXT,

    -- Integraciones
    origen_sistema        VARCHAR(20),
    mobilvendor_id        VARCHAR(100)
);

-- Sincronización con modelo Sequelize (añade campos nuevos si faltan)
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS codigo_tipo_negocio   VARCHAR(50);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS codigo_subcanal       VARCHAR(50);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS equipo_ventas         VARCHAR(100);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS equipo_ventas_id      INTEGER;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS equipo_ventas_nombre  VARCHAR(255);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS campania_id           INT;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS descripcion_company   VARCHAR(60);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS medio_id              INT;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS fuente_id             INT;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS margen                DECIMAL(12,2) DEFAULT 0;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS margen_porcentaje     DECIMAL(6,2) DEFAULT 0;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS payment_term_id       INTEGER;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS payment_term_nombre   VARCHAR(255);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS almacen_nombre        VARCHAR(255);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS transportista_nombre  VARCHAR(255);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS peso_total            DECIMAL(10,3) DEFAULT 0;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS source_document       VARCHAR(255);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS etiquetas             TEXT;
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS mobilvendor_id        VARCHAR(100);
-- Guía de entrega (waybill) de MobilVendor — objeto separado del status de la
-- orden, nunca capturado antes. Necesario para distinguir "facturado/status=5"
-- de "efectivamente despachado" (ver PREVENTA en clasificacion.js del MCP).
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS waybill_code          VARCHAR(50);
ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS waybill_status        VARCHAR(10);

-- FK: ordenes → tipos_negocio
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ordenes_tipo_negocio'
  ) THEN
    ALTER TABLE ordenes
      ADD CONSTRAINT fk_ordenes_tipo_negocio
      FOREIGN KEY (codigo_tipo_negocio)
      REFERENCES tipos_negocio(codigo)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- FK: ordenes → subcanales
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ordenes_subcanal'
  ) THEN
    ALTER TABLE ordenes
      ADD CONSTRAINT fk_ordenes_subcanal
      FOREIGN KEY (codigo_subcanal)
      REFERENCES subcanales(codigo_subcanal)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- Índices críticos para consultas del dashboard
CREATE INDEX IF NOT EXISTS idx_orden_route            ON ordenes(route_code);
CREATE INDEX IF NOT EXISTS idx_orden_customer         ON ordenes(customer_code);
CREATE INDEX IF NOT EXISTS idx_orden_seller           ON ordenes(seller_code);
CREATE INDEX IF NOT EXISTS idx_ordenes_fecha_creacion ON ordenes(fecha_creacion);
CREATE INDEX IF NOT EXISTS idx_ordenes_seller_nombre  ON ordenes(seller_nombre);
CREATE INDEX IF NOT EXISTS idx_ordenes_status         ON ordenes(status);
CREATE INDEX IF NOT EXISTS idx_ordenes_type           ON ordenes(type);
CREATE INDEX IF NOT EXISTS idx_ordenes_subcanal       ON ordenes(codigo_subcanal);
CREATE INDEX IF NOT EXISTS idx_ordenes_tipo_negocio   ON ordenes(codigo_tipo_negocio);


-- =========================================================================
-- SECCIÓN 9 — FACTURAS (facturas)
-- Modelo: backend/models/factura.js
-- Documentos fiscales emitidos. Incluye notas de crédito y reversos.
-- Es la fuente oficial de dólares facturados. PK: code (string único).
-- =========================================================================
CREATE TABLE IF NOT EXISTS facturas (
    id_factura             SERIAL PRIMARY KEY,
    code                   VARCHAR(30) NOT NULL UNIQUE,

    -- Tipo y estado
    type                   INT,
    status                 INT,

    -- Fechas fiscales
    fecha_creacion         TIMESTAMP,
    fecha_autorizacion     TIMESTAMP,
    fecha_entrega          TIMESTAMP,
    fecha_vencimiento      TIMESTAMP,

    -- Cliente
    customer_code          VARCHAR(30),
    customer_address_code  VARCHAR(30),

    -- Clasificación comercial
    codigo_tipo_negocio    VARCHAR(50),
    codigo_subcanal        VARCHAR(50),

    -- Comercial / logística
    route_code             VARCHAR(50),
    seller_code            VARCHAR(50),

    -- Monetario
    total                  DECIMAL(18,2),
    subtotal               DECIMAL(18,2),
    iva                    DECIMAL(18,2),
    discount               DECIMAL(18,2),
    saldo_pendiente        DECIMAL(18,2),

    -- Estado de pago y tipo
    estado_pago            VARCHAR(20),
    tipo_documento         VARCHAR(20),
    moneda                 VARCHAR(10),

    -- Autorización fiscal (Ecuador)
    auth_code              VARCHAR(200),
    access_key             VARCHAR(200),

    -- Geolocalización
    latitude               DECIMAL(12,8),
    longitude              DECIMAL(12,8),

    -- Trazabilidad
    parent_id              VARCHAR(50),
    company_id             INT,
    reversed_entry_id      INT,
    origen_sistema         VARCHAR(15),
    notes                  TEXT
);

-- Sincronización con modelo Sequelize (añade campos nuevos si faltan)
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS codigo_tipo_negocio VARCHAR(50);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS codigo_subcanal     VARCHAR(50);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS estado_pago         VARCHAR(20);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS saldo_pendiente     DECIMAL(18,2);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS fecha_vencimiento   TIMESTAMP;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS tipo_documento      VARCHAR(20);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS moneda              VARCHAR(10);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS company_id          INT;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS reversed_entry_id   INT;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS origen_sistema      VARCHAR(15);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS odoo_id              INT;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS tipo_movimiento      VARCHAR(20);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS invoice_origin       TEXT;
-- Si la columna ya existía como VARCHAR(...), ampliarla a TEXT:
ALTER TABLE facturas ALTER COLUMN invoice_origin TYPE TEXT;

-- FK: facturas → tipos_negocio
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_facturas_tipo_negocio'
  ) THEN
    ALTER TABLE facturas
      ADD CONSTRAINT fk_facturas_tipo_negocio
      FOREIGN KEY (codigo_tipo_negocio)
      REFERENCES tipos_negocio(codigo)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- FK: facturas → subcanales
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_facturas_subcanal'
  ) THEN
    ALTER TABLE facturas
      ADD CONSTRAINT fk_facturas_subcanal
      FOREIGN KEY (codigo_subcanal)
      REFERENCES subcanales(codigo_subcanal)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- Índices críticos
CREATE INDEX IF NOT EXISTS idx_factura_route           ON facturas(route_code);
CREATE INDEX IF NOT EXISTS idx_factura_customer        ON facturas(customer_code);
CREATE INDEX IF NOT EXISTS idx_factura_parent          ON facturas(parent_id);
CREATE INDEX IF NOT EXISTS idx_factura_seller          ON facturas(seller_code);
CREATE INDEX IF NOT EXISTS idx_facturas_customer_fecha ON facturas(customer_code, fecha_creacion);
CREATE INDEX IF NOT EXISTS idx_facturas_fecha          ON facturas(fecha_creacion);
CREATE INDEX IF NOT EXISTS idx_facturas_customer_code  ON facturas(customer_code);
CREATE INDEX IF NOT EXISTS idx_facturas_subcanal       ON facturas(codigo_subcanal);
CREATE INDEX IF NOT EXISTS idx_facturas_tipo_negocio   ON facturas(codigo_tipo_negocio);
-- Necesarios para el matching NC ↔ factura original al clasificar código 29
-- (filtro tipoProducto liquido/envase usa invoice_origin como llave de matching)
CREATE INDEX IF NOT EXISTS idx_facturas_invoice_origin ON facturas(invoice_origin) WHERE invoice_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facturas_reversed_entry ON facturas(reversed_entry_id) WHERE reversed_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_odoo_id ON facturas(odoo_id) WHERE odoo_id IS NOT NULL;


-- =========================================================================
-- SECCIÓN 10 — DETALLE DE DOCUMENTOS (detalle_documento)
-- Modelo: backend/models/detalleDocumento.js
-- Líneas de detalle de órdenes y facturas. El campo documento_code
-- referencia tanto a ordenes.code como a facturas.code. Se desnormalizan
-- campos (producto_nombre, producto_categoria) para evitar JOINs en el
-- dashboard.
-- =========================================================================
CREATE TABLE IF NOT EXISTS detalle_documento (
    id_detalle                  SERIAL PRIMARY KEY,

    documento_code              VARCHAR(50),

    -- Producto
    codigo_producto             VARCHAR(100),
    producto_codigo_interno     VARCHAR(100),
    descripcion                 VARCHAR(300),
    producto_nombre             VARCHAR(255),
    producto_categoria          VARCHAR(255),

    -- Cantidades
    cantidad                    DECIMAL(18,2),
    cantidad_entregada          DECIMAL(18,2),
    cantidad_facturada          DECIMAL(18,2),
    cantidad_pendiente_entregar DECIMAL(18,2),
    cantidad_pendiente_facturar DECIMAL(18,2),

    -- Precios
    precio                      DECIMAL(18,2),
    descuento_linea             DECIMAL(18,2),
    subtotal                    DECIMAL(18,2),
    total                       DECIMAL(18,2),
    iva                         DECIMAL(18,2),
    precio_con_impuesto         DECIMAL(18,2),
    precio_sin_impuesto         DECIMAL(18,2),
    impuesto_linea              DECIMAL(18,2),

    -- Rentabilidad
    margen_linea                DECIMAL(12,2) DEFAULT 0,
    margen_porcentaje_linea     DECIMAL(6,2) DEFAULT 0,

    -- Clasificación
    unit_alias                  VARCHAR(100),
    unidad_medida               VARCHAR(50),
    barcode                     VARCHAR(100),
    codigo_categoria            VARCHAR(10),
    descripcion_categoria       VARCHAR(100),

    -- Estados
    estado_facturacion_linea    VARCHAR(50),
    estado_odoo_linea           VARCHAR(50),

    -- Promoción aplicada en la línea (origen MobilVendor) — base de la
    -- analítica "promos vendidas por prendedor".
    promo_code                  VARCHAR(50),
    promo_action_code           VARCHAR(50),

    -- Orden y flags
    secuencia                   INTEGER DEFAULT 0,
    es_anticipo                 BOOLEAN DEFAULT FALSE,
    es_envio                    BOOLEAN DEFAULT FALSE
);

ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS producto_nombre          VARCHAR(255);
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS producto_categoria       VARCHAR(255);
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS producto_codigo_interno  VARCHAR(100);
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS margen_linea             DECIMAL(12,2) DEFAULT 0;
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS margen_porcentaje_linea  DECIMAL(6,2) DEFAULT 0;
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS unidad_medida            VARCHAR(50);
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS secuencia                INTEGER DEFAULT 0;
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS promo_code               VARCHAR(50);
ALTER TABLE detalle_documento ADD COLUMN IF NOT EXISTS promo_action_code        VARCHAR(50);

-- Unique: evita duplicar la misma línea en un mismo documento.
-- Incluye la promo, porque dos líneas del mismo artículo con promos distintas
-- (o una con promo y otra sin) son líneas legítimamente diferentes.
DO $$
BEGIN
  -- Migrar/eliminar constraints únicos LEGADOS que NO incluyen la promo. En
  -- producción quedó una constraint vieja llamada "unique_detalle" (solo
  -- documento+producto) que rechazaba dos líneas del mismo artículo con promos
  -- distintas → "llave duplicada viola unique_detalle". Las eliminamos todas.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_detalle') THEN
    ALTER TABLE detalle_documento DROP CONSTRAINT unique_detalle;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_detalle_doc') THEN
    ALTER TABLE detalle_documento DROP CONSTRAINT unique_detalle_doc;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_detalle_doc_promo') THEN
    ALTER TABLE detalle_documento
      ADD CONSTRAINT unique_detalle_doc_promo
      UNIQUE (documento_code, codigo_producto, precio, cantidad, promo_code, promo_action_code);
  END IF;
END $$;

-- Por si "unique_detalle" quedó como índice único (no constraint) en algún entorno.
DROP INDEX IF EXISTS unique_detalle;

CREATE INDEX IF NOT EXISTS idx_doc_code              ON detalle_documento(documento_code);
CREATE INDEX IF NOT EXISTS idx_doc_producto          ON detalle_documento(codigo_producto);
CREATE INDEX IF NOT EXISTS idx_detalle_documento_doc ON detalle_documento(documento_code);
-- Acelera la analítica de promociones (filtra líneas con promo)
CREATE INDEX IF NOT EXISTS idx_dd_promo_code         ON detalle_documento(promo_code) WHERE promo_code IS NOT NULL;
-- Acelera el filtro de DISC en facturas (clasificación código 29 con/sin NotCr)
CREATE INDEX IF NOT EXISTS idx_dd_codigo_interno     ON detalle_documento(producto_codigo_interno) WHERE producto_codigo_interno = 'DISC';


-- =========================================================================
-- SECCIÓN 11 — RUTAS (rutas)
-- Modelo: backend/models/Ruta.js
-- Catálogo de rutas de distribución (A01, E01, U01, etc.). La PK lógica
-- es `codigo` aunque existe `id` SERIAL adicional.
-- =========================================================================
CREATE TABLE IF NOT EXISTS rutas (
    id                   SERIAL PRIMARY KEY,
    codigo               VARCHAR(100) NOT NULL,
    descripcion          VARCHAR(255),
    codigo_cliente       VARCHAR(30),
    codigo_direccion     VARCHAR(40),
    tipo                 INT,
    estado               INT,
    creado_por           INT,
    actualizado_por      INT,
    creado_por_id        VARCHAR(255),
    actualizado_por_id   VARCHAR(255),
    fecha_creacion       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS rutas_codigo_unique ON rutas(codigo);


-- =========================================================================
-- SECCIÓN 12 — DETALLE DE RUTAS (detalles_rutas)
-- Modelo: backend/models/DetalleRuta.js
-- Define la agenda semanal de visitas por ruta (cliente + dirección
-- + día + secuencia). Permite construir el plan de ruta para cada
-- vendedor.
-- =========================================================================
CREATE TABLE IF NOT EXISTS detalles_rutas (
    id                       SERIAL PRIMARY KEY,
    codigo                   VARCHAR(100) NOT NULL,
    codigo_ruta              VARCHAR(100),
    route_code               VARCHAR(100),
    codigo_cliente           VARCHAR(100),
    customer_code            VARCHAR(255),
    codigo_direccion_cliente VARCHAR(100),
    semana                   INT,
    dia                      INT,
    secuencia                INT,
    estado                   INT,
    datos                    JSONB,
    creado_por               INT,
    actualizado_por          INT,
    creado_por_id            VARCHAR(255),
    actualizado_por_id       VARCHAR(255),
    fecha_creacion           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ruta_codigo_lookup       VARCHAR(255),
    cliente_codigo_lookup    VARCHAR(255),
    direccion_codigo_lookup  VARCHAR(255)
);

ALTER TABLE detalles_rutas ADD COLUMN IF NOT EXISTS customer_code VARCHAR(255);
ALTER TABLE detalles_rutas ADD COLUMN IF NOT EXISTS route_code    VARCHAR(100);

-- Unique: evita duplicar un mismo código de detalle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_codigo'
  ) THEN
    ALTER TABLE detalles_rutas
      ADD CONSTRAINT unique_codigo UNIQUE (codigo);
  END IF;
END $$;


-- =========================================================================
-- SECCIÓN 13 — HISTORIAL DE VISITAS (historial_visitas)
-- Modelo: backend/models/HistorialVisitas.js
-- Registro cronológico de visitas realizadas por vendedores a clientes.
-- Sirve para trazabilidad de gestión comercial y análisis de adherencia
-- a ruta.
-- =========================================================================
CREATE TABLE IF NOT EXISTS historial_visitas (
    id                              SERIAL PRIMARY KEY,
    fecha_visita                    TIMESTAMP,
    codigo_usuario                  VARCHAR(50),
    codigo_ruta                     VARCHAR(50),
    codigo_cliente                  VARCHAR(50),
    codigo_direccion_cliente        VARCHAR(50),
    semana                          INT,
    dia                             INT,
    accion                          VARCHAR(50),
    codigo_comentario               VARCHAR(50),
    comentario                      TEXT,
    monto                           DECIMAL(18,2),
    latitud                         DECIMAL(12,8),
    longitud                        DECIMAL(12,8),
    estado_proceso                  INT,
    ruptura_secuencia               INT,

    -- Datos desnormalizados del cliente (snapshot en el momento de la visita)
    nombre_cliente                  VARCHAR(250),
    nombre_empresa_cliente          VARCHAR(250),
    nombre_comercial_cliente        VARCHAR(250),
    tipo_identificacion_cliente     VARCHAR(10),
    numero_identificacion_cliente   VARCHAR(20),
    contacto_cliente                VARCHAR(50),
    comentario_cliente              TEXT,
    estado_cliente                  INT,

    -- Datos desnormalizados del usuario / vendedor
    nombre_usuario                  VARCHAR(250),
    email_usuario                   VARCHAR(100),
    email_notificacion_usuario      VARCHAR(100),
    identidad_usuario               VARCHAR(50),
    tipo_identificacion_usuario     VARCHAR(10),
    sucursal_usuario                VARCHAR(100),
    telefono_usuario                VARCHAR(50),
    direccion_usuario               VARCHAR(500),
    marca_dispositivo_usuario       VARCHAR(100),
    modelo_dispositivo_usuario      VARCHAR(100),
    numero_dispositivo_usuario      VARCHAR(100),
    codigo_almacen_usuario          VARCHAR(50),
    codigo_ruta_predeterminada_usuario VARCHAR(50),
    codigo_rol_usuario              VARCHAR(50)
);

-- Unique: una visita por combinación cliente + ruta + fecha
CREATE UNIQUE INDEX IF NOT EXISTS idx_historial_visitas_unique
    ON historial_visitas(codigo_cliente, codigo_ruta, fecha_visita);

CREATE INDEX IF NOT EXISTS idx_historial_visitas_codigo_usuario
    ON historial_visitas(codigo_usuario);

CREATE INDEX IF NOT EXISTS idx_historial_visitas_accion
    ON historial_visitas(accion);


-- =========================================================================
-- SECCIÓN 14 — METAS DE PREVENTA (metas_preventas)
-- Modelo: backend/models/metaPreventa.js
-- Metas mensuales por ruta para preventistas. Una meta única por
-- (codigo_ruta, anio, mes). Usa `seccion` para agrupar por tipo (PREVENTA,
-- TELEVENTA, VIP, etc.).
-- =========================================================================
CREATE TABLE IF NOT EXISTS metas_preventas (
    id_meta        SERIAL PRIMARY KEY,
    codigo_ruta    VARCHAR(50) NOT NULL,
    anio           INT NOT NULL,
    mes            INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
    meta_unidades  INT NOT NULL DEFAULT 0,
    meta_dolares   FLOAT NOT NULL DEFAULT 0,
    seccion        VARCHAR(50) DEFAULT 'PREVENTA'
);

ALTER TABLE metas_preventas ADD COLUMN IF NOT EXISTS seccion VARCHAR(50) DEFAULT 'PREVENTA';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_codigo_ruta_anio_mes'
  ) THEN
    ALTER TABLE metas_preventas
      ADD CONSTRAINT unique_codigo_ruta_anio_mes
      UNIQUE (codigo_ruta, anio, mes);
  END IF;
END $$;


-- =========================================================================
-- SECCIÓN 15 — METAS DE BOTELLONES (metas_botellones)
-- Modelo: backend/models/metaBotellon.js
-- Metas mensuales específicas por canal botellón. Permite definir metas
-- separadas para TELEVENTA_VIP, TIENDAS, MAYORISTA, RURAL, etc. dentro
-- de la misma ruta.
-- =========================================================================
CREATE TABLE IF NOT EXISTS metas_botellones (
    id_meta        SERIAL PRIMARY KEY,
    codigo_ruta    VARCHAR(50) NOT NULL,
    seccion        VARCHAR(30) NOT NULL,
    anio           INT NOT NULL,
    mes            INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
    meta_unidades  INT NOT NULL DEFAULT 0,
    meta_dolares   FLOAT NOT NULL DEFAULT 0
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_metas_botellones'
  ) THEN
    ALTER TABLE metas_botellones
      ADD CONSTRAINT uq_metas_botellones
      UNIQUE (codigo_ruta, seccion, anio, mes);
  END IF;
END $$;


-- =========================================================================
-- SECCIÓN 16 — AJUSTE MENSUAL COTTSA (cottsa_extra_mes)
-- Modelo: backend/models/CottsaExtraMes.js
-- Registro de ventas adicionales manuales que deben sumarse al total
-- del mes (normalmente ventas a empresas externas procesadas fuera del
-- flujo estándar). Una fila por (anio, mes).
-- =========================================================================
CREATE TABLE IF NOT EXISTS cottsa_extra_mes (
    id               SERIAL PRIMARY KEY,
    anio             INT NOT NULL,
    mes              INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
    unidades         FLOAT NOT NULL DEFAULT 0,
    dolares          FLOAT NOT NULL DEFAULT 0,
    facturas         INT NOT NULL DEFAULT 0,
    actualizado_por  VARCHAR(100),
    created_at       TIMESTAMP DEFAULT NOW(),
    updated_at       TIMESTAMP DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_cottsa_extra_mes'
  ) THEN
    ALTER TABLE cottsa_extra_mes
      ADD CONSTRAINT uq_cottsa_extra_mes
      UNIQUE (anio, mes);
  END IF;
END $$;


-- =========================================================================
-- SECCIÓN 17 — SINCRONIZACIONES DE VENTAS (sincronizaciones_ventas)
-- Modelo: backend/models/SincronizacionVenta.js
-- Bitácora de ejecuciones del proceso de sincronización Odoo → DB local.
-- Cada fila representa una corrida con su rango de fechas y resultado.
-- =========================================================================
CREATE TABLE IF NOT EXISTS sincronizaciones_ventas (
    id_sync         SERIAL PRIMARY KEY,
    fecha_sync      TIMESTAMP DEFAULT NOW(),
    desde_date      DATE,
    hasta_date      DATE,
    total_registros INT,
    estado          VARCHAR(20),
    mensaje         TEXT
);

ALTER TABLE sincronizaciones_ventas ALTER COLUMN mensaje TYPE TEXT;


-- =========================================================================
-- SECCIÓN 18 — TIPOS DE DOCUMENTO LATAM (tipo_documento_latam)
-- Modelo: backend/models/TipoDocumentoLatam.js
-- Catálogo de tipos de documento fiscal para la región (facturas, notas
-- de crédito, liquidaciones, etc.). Importado desde Odoo.
-- =========================================================================
CREATE TABLE IF NOT EXISTS tipo_documento_latam (
    id                          SERIAL PRIMARY KEY,
    secuencia                   VARCHAR(255),
    id_pais                     INT,
    usuario_creacion            INT,
    usuario_actualizacion       INT,
    nombre                      VARCHAR(255) NOT NULL,
    prefijo_codigo_documento    VARCHAR(10),
    codigo                      VARCHAR(10),
    nombre_reporte              VARCHAR(255),
    tipo_interno                VARCHAR(50),
    activo                      BOOLEAN DEFAULT TRUE,
    fecha_creacion              TIMESTAMP,
    fecha_actualizacion         TIMESTAMP,
    verificar_formato_ecuador   BOOLEAN
);


-- =========================================================================
-- SECCIÓN 19 — RELACIÓN CLIENTE ↔ CATEGORÍA (clientes_categoria_relacion)
-- Tabla puente N a N entre clientes y categorías comerciales ad-hoc.
-- Permite tagging flexible de clientes sin alterar el maestro.
-- =========================================================================
CREATE TABLE IF NOT EXISTS clientes_categoria_relacion (
    categoria_id INTEGER NOT NULL,
    cliente_id   INTEGER NOT NULL,
    PRIMARY KEY (categoria_id, cliente_id)
);

CREATE INDEX IF NOT EXISTS idx_ccr_cliente   ON clientes_categoria_relacion(cliente_id);
CREATE INDEX IF NOT EXISTS idx_ccr_categoria ON clientes_categoria_relacion(categoria_id);


-- =========================================================================
-- SECCIÓN 20 — VISTA ANALÍTICA DE CLIENTES (vw_clientes_analisis)
-- Vista calculada para el dashboard de clientes. Combina:
--   • Dirección principal (más reciente activa)
--   • Totales de facturación (facturas, dólares, unidades)
--   • Clasificación de estado (ACTIVO / RIESGO / INACTIVO / SIN COMPRAS)
--   • Ticket promedio y días sin comprar
-- IMPORTANTE: reconstruir con CREATE OR REPLACE cada vez que cambie el
-- esquema de facturas o clientes.
-- =========================================================================
CREATE OR REPLACE VIEW vw_clientes_analisis AS
WITH direccion_principal AS (
  SELECT DISTINCT ON (dc.codigo_cliente)
    dc.codigo_cliente,
    COALESCE(dc.descripcion_direccion_cliente, '-') AS direccion,
    dc.codigo_direccion_cliente
  FROM direcciones_clientes dc
  WHERE dc.estado_direccion_cliente = 1
  ORDER BY
    dc.codigo_cliente,
    dc.fecha_actualizacion_direccion_cliente DESC NULLS LAST,
    dc.id_direccion_cliente DESC
),
facturas_cliente AS (
  SELECT
    f.customer_code AS codigo_cliente,
    COUNT(DISTINCT f.code) AS total_facturas,
    COALESCE(SUM(f.total), 0) AS total_ventas,
    MAX(f.fecha_creacion) AS ultima_compra,
    MIN(f.fecha_creacion) AS primera_compra
  FROM facturas f
  GROUP BY f.customer_code
),
unidades_cliente AS (
  SELECT
    f.customer_code AS codigo_cliente,
    COALESCE(SUM(dd.cantidad), 0) AS total_unidades
  FROM facturas f
  LEFT JOIN detalle_documento dd
    ON dd.documento_code = f.code
  GROUP BY f.customer_code
)
SELECT
  c.codigo_cliente,
  c.nombre_cliente,
  c.identificacion_cliente,
  c.nombre_comercial_cliente,
  dp.direccion,
  c.codigo_usuario_asignado_cliente AS seller_code,
  COALESCE(tn.descripcion, 'SIN CLASIFICAR') AS tipo_negocio,
  c.tiene_credito_cliente,
  CASE
    WHEN c.tiene_credito_cliente THEN 'CREDITO'
    ELSE 'CONTADO'
  END AS tipo_pago,
  COALESCE(fc.total_facturas, 0) AS total_facturas,
  COALESCE(uc.total_unidades, 0) AS total_unidades,
  COALESCE(fc.total_ventas, 0) AS total_ventas,
  fc.ultima_compra,
  fc.primera_compra,
  CASE
    WHEN COALESCE(fc.total_facturas, 0) > 0
      THEN COALESCE(fc.total_ventas, 0) / fc.total_facturas
    ELSE 0
  END AS ticket_promedio,
  CASE
    WHEN fc.ultima_compra IS NULL THEN NULL
    ELSE CURRENT_DATE - DATE(fc.ultima_compra)
  END AS dias_sin_comprar,
  CASE
    WHEN fc.ultima_compra IS NULL THEN 'SIN COMPRAS'
    WHEN CURRENT_DATE - DATE(fc.ultima_compra) <= 30 THEN 'ACTIVO'
    WHEN CURRENT_DATE - DATE(fc.ultima_compra) <= 60 THEN 'RIESGO'
    ELSE 'INACTIVO'
  END AS estado_cliente
FROM clientes c
LEFT JOIN direccion_principal dp ON dp.codigo_cliente = c.codigo_cliente
LEFT JOIN tipos_negocio     tn   ON tn.codigo         = c.codigo_tipo_negocio
LEFT JOIN facturas_cliente  fc   ON fc.codigo_cliente = c.codigo_cliente
LEFT JOIN unidades_cliente  uc   ON uc.codigo_cliente = c.codigo_cliente;


-- =========================================================================
-- FIN DEL ARCHIVO
-- Para añadir una nueva tabla: crea una nueva sección siguiendo el patrón
-- (CREATE TABLE IF NOT EXISTS → ALTER TABLE ADD COLUMN IF NOT EXISTS →
-- constraints dentro de DO blocks → índices → triggers idempotentes).
-- =========================================================================

-- =========================================================================
-- MIGRACIÓN 001 — Índices del dashboard de clientes
-- =========================================================================
-- ====================================================================
-- ÍNDICES PARA EL DASHBOARD DE CLIENTES
--
-- ⚙ AUTO-EJECUCIÓN: este archivo se ejecuta automáticamente en cada
-- arranque del backend (ver utils/runStartupSql.js). No requiere
-- ejecución manual. Es idempotente (CREATE INDEX IF NOT EXISTS).
--
-- Aceleran:
--   - Filtros por status + fecha en facturas
--   - Lookups de facturas por cliente
--   - JOINs con detalle_documento
--   - Filtros por ruta (codigo_usuario_asignado_cliente)
--   - Búsqueda por RUC
--   - Lookups de direcciones para el mapa
--   - Historial de contactos por cliente
-- ====================================================================

-- Acelera filtros por status + fecha en facturas (todos los endpoints lo usan)
CREATE INDEX IF NOT EXISTS idx_facturas_status_fecha
  ON facturas (status, fecha_creacion DESC)
  WHERE status IN (0,2,3,4,5);

-- Acelera lookup de facturas por cliente
CREATE INDEX IF NOT EXISTS idx_facturas_customer_fecha
  ON facturas (customer_code, fecha_creacion DESC)
  WHERE status IN (0,2,3,4,5);

-- Acelera join con detalle_documento
CREATE INDEX IF NOT EXISTS idx_detalle_documento_code
  ON detalle_documento (documento_code);

-- Acelera filtros por ruta (codigo_usuario_asignado_cliente)
CREATE INDEX IF NOT EXISTS idx_clientes_ruta
  ON clientes (UPPER(codigo_usuario_asignado_cliente))
  WHERE codigo_usuario_asignado_cliente IS NOT NULL;

-- Acelera búsqueda por RUC/identificación
CREATE INDEX IF NOT EXISTS idx_clientes_identificacion
  ON clientes (identificacion_cliente)
  WHERE identificacion_cliente IS NOT NULL AND TRIM(identificacion_cliente) <> '';

-- Acelera lookup en direcciones_clientes (para mapa)
CREATE INDEX IF NOT EXISTS idx_direcciones_clientes_codigo
  ON direcciones_clientes (codigo_cliente);

-- Acelera consulta de contactos_recuperacion por cliente y fecha
CREATE INDEX IF NOT EXISTS idx_contactos_group_fecha
  ON contactos_recuperacion (group_key, fecha_contacto DESC);

-- Estadísticas para que el planner tome buenas decisiones
ANALYZE clientes;
ANALYZE facturas;
ANALYZE detalle_documento;
ANALYZE direcciones_clientes;
ANALYZE contactos_recuperacion;

-- =========================================================================
-- MIGRACIÓN 002 — sincronizaciones_ventas.mensaje → TEXT
-- =========================================================================
-- ====================================================================
-- AJUSTE DE COLUMNA: sincronizaciones_ventas.mensaje
--
-- ⚙ AUTO-EJECUCIÓN: este archivo se ejecuta automáticamente en cada
-- arranque del backend (ver utils/runStartupSql.js). Es idempotente:
-- ALTER COLUMN TYPE TEXT se puede aplicar repetidamente sin error.
--
-- Motivo: el modelo Sequelize SincronizacionVenta define `mensaje` como
-- TEXT, pero la columna real en BD era VARCHAR(100). Los mensajes de
-- sincronización (resumen de Pedidos/Facturas/POS/Clientes/etc. y los
-- errores) superan los 100 caracteres y rompían con:
--   "value too long for type character varying(100)"
-- ====================================================================

ALTER TABLE sincronizaciones_ventas
  ALTER COLUMN mensaje TYPE TEXT;

-- =========================================================================
-- MIGRACIÓN 003 — Botellón invoice_origin
-- =========================================================================
-- ====================================================================
-- BOTELLÓN — Soporte para clasificación del código 29 (LÍQUIDO/ENVASE)
--
-- ⚙ AUTO-EJECUCIÓN: este archivo se ejecuta automáticamente en cada
-- arranque del backend (ver utils/runStartupSql.js). Idempotente.
--
-- Motivo: el filtro tipoProducto del dashboard de botellón clasifica las
-- líneas del producto código 29 (BOTELLÓN 20L AQUA PREMIUM) según si su
-- factura tiene una NotCr con DISC asociada. El matching NC↔Factura se
-- hace por `invoice_origin`. Hasta este cambio la columna no se
-- persistía (solo se traía temporal de Odoo para resolver equipo_ventas).
--
-- Esta migración:
--   1. Asegura que existan las columnas necesarias en `facturas`.
--   2. Amplía invoice_origin a TEXT (Odoo a veces concatena varias
--      referencias y supera 255 chars → causaba error de sincronización).
--   3. Crea índices para que el EXISTS del filtro sea rápido.
-- ====================================================================

-- ── Columnas de facturas (idempotente) ─────────────────────────────────
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS odoo_id          INTEGER;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS tipo_movimiento  VARCHAR(20);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS invoice_origin   TEXT;

-- ── Si invoice_origin ya existía como VARCHAR(n), ampliarla a TEXT ─────
ALTER TABLE facturas ALTER COLUMN invoice_origin TYPE TEXT;

-- ── Índices para acelerar el matching NC ↔ factura origen ──────────────
CREATE INDEX IF NOT EXISTS idx_facturas_invoice_origin
  ON facturas(invoice_origin)
  WHERE invoice_origin IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_facturas_reversed_entry
  ON facturas(reversed_entry_id)
  WHERE reversed_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_odoo_id
  ON facturas(odoo_id)
  WHERE odoo_id IS NOT NULL;

-- ── Índice parcial para localizar líneas DISC rápidamente ──────────────
CREATE INDEX IF NOT EXISTS idx_dd_codigo_interno_disc
  ON detalle_documento(producto_codigo_interno)
  WHERE producto_codigo_interno = 'DISC';

-- =========================================================================
-- SECCIÓN 21 — PROMOCIONES (promos)
-- Modelo: backend/models/Promo.js
-- Maestro de promociones importado desde MobilVendor (schema "promos").
-- La PK es code (string) para mantener compatibilidad con MobilVendor y
-- servir de referencia a condiciones, acciones y asignaciones por vendedor.
-- Los campos *_list (business_types, customers, articles, etc.) se guardan
-- como JSONB para no perder estructura aunque MobilVendor cambie el formato.
-- =========================================================================
CREATE TABLE IF NOT EXISTS promos (
    code                 VARCHAR(50) PRIMARY KEY,
    description          TEXT,
    type                 VARCHAR(50),
    status               VARCHAR(5),
    start_date           TIMESTAMP,
    end_date             TIMESTAMP,
    priority             INTEGER,
    cyclical             SMALLINT,
    min_sale             NUMERIC(14,2),
    max_sale             NUMERIC(14,2),
    payment_method       TEXT,
    business_types       JSONB,
    customers            JSONB,
    payload              JSONB,
    fecha_creacion       TIMESTAMP DEFAULT NOW(),
    fecha_actualizacion  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promos_status   ON promos(status);
CREATE INDEX IF NOT EXISTS idx_promos_priority ON promos(priority);

-- MobilVendor entrega datos crudos; ampliamos a TEXT para no truncar
-- (payment_method puede traer listas largas). Idempotente.
ALTER TABLE promos ALTER COLUMN payment_method TYPE TEXT;


-- =========================================================================
-- SECCIÓN 22 — CONDICIONES DE PROMOCIÓN (promo_conditions)
-- Modelo: backend/models/PromoCondicion.js
-- Reglas que se deben cumplir para que aplique una promo (monto/cantidad,
-- objeto sobre el que aplica, lista, unidad). N condiciones por promo.
-- Se refresca por completo en cada sincronización (snapshot).
-- =========================================================================
CREATE TABLE IF NOT EXISTS promo_conditions (
    id                  SERIAL PRIMARY KEY,
    promo_code          VARCHAR(50) NOT NULL,
    condition           TEXT,
    amount_condition    TEXT,
    amount1             NUMERIC(14,2),
    amount2             NUMERIC(14,2),
    quantity_condition  TEXT,
    quantity1           NUMERIC(14,2),
    quantity2           NUMERIC(14,2),
    object              TEXT,
    code                TEXT,
    list                TEXT,
    unit_code           VARCHAR(50),
    payload             JSONB,
    CONSTRAINT fk_pc_promo
        FOREIGN KEY (promo_code) REFERENCES promos(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pc_promo_code ON promo_conditions(promo_code);

-- Datos crudos de MobilVendor: object/code/list pueden traer listas largas
-- de artículos. Ampliamos a TEXT para no truncar. Idempotente.
ALTER TABLE promo_conditions ALTER COLUMN condition          TYPE TEXT;
ALTER TABLE promo_conditions ALTER COLUMN amount_condition   TYPE TEXT;
ALTER TABLE promo_conditions ALTER COLUMN quantity_condition TYPE TEXT;
ALTER TABLE promo_conditions ALTER COLUMN object             TYPE TEXT;
ALTER TABLE promo_conditions ALTER COLUMN code               TYPE TEXT;
ALTER TABLE promo_conditions ALTER COLUMN list               TYPE TEXT;


-- =========================================================================
-- SECCIÓN 23 — ACCIONES DE PROMOCIÓN (promo_actions)
-- Modelo: backend/models/PromoAccion.js
-- Beneficio que otorga la promo (descuento, precio especial, regalo /
-- escalonado) y el universo de artículos/marcas/categorías/familias sobre
-- el que aplica. N acciones por promo. Snapshot en cada sincronización.
-- =========================================================================
CREATE TABLE IF NOT EXISTS promo_actions (
    id              SERIAL PRIMARY KEY,
    promo_code      VARCHAR(50) NOT NULL,
    action          TEXT,
    discount        NUMERIC(14,4),
    discount_type   VARCHAR(50),
    price_value     NUMERIC(14,4),
    gift            TEXT,
    gift_base       TEXT,
    stepped         SMALLINT,
    articles        JSONB,
    brands          JSONB,
    categories      JSONB,
    families        JSONB,
    payload         JSONB,
    CONSTRAINT fk_pa_promo
        FOREIGN KEY (promo_code) REFERENCES promos(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pa_promo_code ON promo_actions(promo_code);

-- Datos crudos de MobilVendor: action/gift/gift_base pueden traer texto
-- largo. Ampliamos a TEXT para no truncar. Idempotente.
ALTER TABLE promo_actions ALTER COLUMN action    TYPE TEXT;
ALTER TABLE promo_actions ALTER COLUMN gift       TYPE TEXT;
ALTER TABLE promo_actions ALTER COLUMN gift_base  TYPE TEXT;


-- =========================================================================
-- SECCIÓN 24 — ASIGNACIÓN DE PROMO POR VENDEDOR (users_in_promos)
-- Modelo: backend/models/UsuarioEnPromo.js
-- Liga cada promo a un vendedor/prendedor (user_code) con su inventario
-- asignado y consumido. ES LA BASE DE LA ANALÍTICA "POR PRENDEDOR":
--   inventory_used / inventory_amount_used → cuánto ha usado/vendido,
--   (inventory_amount - inventory_amount_used) → monto disponible.
-- Clave única (promo_code, user_code) → upsert idempotente.
-- =========================================================================
CREATE TABLE IF NOT EXISTS users_in_promos (
    id                     SERIAL PRIMARY KEY,
    promo_code             VARCHAR(50) NOT NULL,
    user_code              VARCHAR(50) NOT NULL,
    status                 VARCHAR(5),
    inventory              NUMERIC(14,2),
    inventory_amount       NUMERIC(14,2),
    inventory_used         NUMERIC(14,2),
    inventory_amount_used  NUMERIC(14,2),
    payload                JSONB,
    fecha_actualizacion    TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_uip_promo_user UNIQUE (promo_code, user_code),
    CONSTRAINT fk_uip_promo
        FOREIGN KEY (promo_code) REFERENCES promos(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_uip_promo_code ON users_in_promos(promo_code);
CREATE INDEX IF NOT EXISTS idx_uip_user_code  ON users_in_promos(user_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- SECCIÓN 24b — LÍNEAS DE VENTA CON PROMOCIÓN (promo_lineas_venta)
-- ─────────────────────────────────────────────────────────────────────────────
-- Copia AISLADA de las líneas de venta que llevan promo, escrita SOLO por la
-- sincronización de MobilVendor (facturas Y órdenes). Odoo NUNCA la toca.
--
-- Por qué existe: la factura comparte su número fiscal (FA001-...) con Odoo, así
-- que ambos syncs escribían la MISMA fila de detalle_documento y se pisaban
-- (Odoo, que no trae la línea de promo, dejaba la factura sin promo_code). Las
-- órdenes no chocan porque Odoo nombra sus pedidos distinto (S00...).
--
-- Snapshot desnormalizado (vendedor/fecha/tipo) para que el reporte y la
-- analítica de promos no dependan de JOINs a facturas/ordenes (que Odoo reescribe).
CREATE TABLE IF NOT EXISTS promo_lineas_venta (
    id                 SERIAL PRIMARY KEY,
    documento_code     VARCHAR(100) NOT NULL,
    tipo               VARCHAR(10)  NOT NULL,          -- 'FACTURA' | 'ORDEN'
    seller_code        VARCHAR(50),
    fecha              TIMESTAMP,
    codigo_producto    VARCHAR(50),
    descripcion        TEXT,
    unidad             VARCHAR(50),
    cantidad           DECIMAL(18,2) DEFAULT 0,
    precio             DECIMAL(18,2) DEFAULT 0,
    descuento_linea    DECIMAL(18,2) DEFAULT 0,
    subtotal           DECIMAL(18,2) DEFAULT 0,
    total              DECIMAL(18,2) DEFAULT 0,
    iva                DECIMAL(18,2) DEFAULT 0,
    promo_code         VARCHAR(50)  NOT NULL,
    promo_action_code  VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_plv_doc        ON promo_lineas_venta(documento_code);
CREATE INDEX IF NOT EXISTS idx_plv_promo_code ON promo_lineas_venta(promo_code);
CREATE INDEX IF NOT EXISTS idx_plv_seller     ON promo_lineas_venta(seller_code);
CREATE INDEX IF NOT EXISTS idx_plv_fecha      ON promo_lineas_venta(fecha);


-- ── Flota (Vigilo/SeamTrack, b2b.vigiloo.net) — tramos de ruta/parada por
-- vehículo, sincronizados por cron (23:00 America/Guayaquil, ventana
-- rodante de 3 días — ver backend/cron/tareasCron.js y
-- backend/services/vigiloServicio/). Solo lectura desde mcp-server (tool
-- auditoriaParadasFlota, aún no construida) — nunca se consulta Vigilo en
-- vivo desde ahí, por el rate limit real de la API (1 llamada/15s, ~34
-- vehículos → ~9 min por corrida, inviable bajo demanda).
CREATE TABLE IF NOT EXISTS vigilo_vehiculos (
  target_id      UUID PRIMARY KEY,              -- GUID de Vigilo (Target.TargetId)
  tag            VARCHAR(20) NOT NULL,           -- ej. 'T5' — coincide directo con seller_code (confirmado con datos reales, sin tabla de mapeo)
  grupo_vigilo   VARCHAR(50),                    -- TargetGroup.Name en Vigilo (TIENDAS, EMPRESAS, VIP, RURAL, MAYORISTAS, HIELO, DESCARTABLE)
  placa          VARCHAR(20),
  activo         BOOLEAN NOT NULL DEFAULT TRUE,  -- false si desaparece de TrackONLINE (vehículo dado de baja en Vigilo)
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `trace_id` es el TraceId real de Vigilo (identificador único del tramo) —
-- se usa como PK para que el sync sea un UPSERT idempotente, nunca duplica
-- filas al resincronizar la ventana rodante de 3 días.
CREATE TABLE IF NOT EXISTS vigilo_tramos_ruta (
  trace_id           BIGINT PRIMARY KEY,
  target_id          UUID NOT NULL REFERENCES vigilo_vehiculos(target_id),
  tipo_tramo         VARCHAR(10) NOT NULL CHECK (tipo_tramo IN ('RUTA','PARADA')),
  desde_fecha        TIMESTAMP NOT NULL,
  hasta_fecha        TIMESTAMP NOT NULL,
  duracion_segundos  INTEGER NOT NULL,
  desde_lat          NUMERIC(10,6),
  desde_lon          NUMERIC(10,6),
  hasta_lat          NUMERIC(10,6),
  hasta_lon          NUMERIC(10,6),
  desde_direccion    TEXT,
  hasta_direccion    TEXT,
  cruza_medianoche   BOOLEAN NOT NULL,            -- date(desde_fecha) != date(hasta_fecha)
  odometro_distancia NUMERIC(10,2),
  sincronizado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vigilo_tramos_target_fecha ON vigilo_tramos_ruta(target_id, desde_fecha);
CREATE INDEX IF NOT EXISTS idx_vigilo_tramos_tipo         ON vigilo_tramos_ruta(tipo_tramo);

-- ── Auditoría del chatbot IA (consultas y SQL generado) ────────────────
CREATE TABLE IF NOT EXISTS auditoria_chat (
  id              SERIAL PRIMARY KEY,
  usuario         VARCHAR(100),
  rol             VARCHAR(50),
  mensaje         TEXT,
  sql_generado    TEXT,
  filas_resultado INTEGER,
  tiempo_ms       INTEGER,
  creado_en       TIMESTAMP DEFAULT NOW()
);

-- =========================================================================
-- Permisos de mcp_readonly sobre las tablas de ventas (incidente 2026-09-17,
-- ver TODO.md: mcp_readonly quedó SIN GRANT sobre estas tablas — de hecho
-- SIN NINGÚN rastro de su creación/permisos en git — hasta que se reconstruyó
-- a mano en producción, provisionado por fuera de todo control de versiones).
--
-- El ROL en sí (CREATE ROLE mcp_readonly ...) se crea en
-- backend/sql/postgres-init/01_mcp_roles_y_pg_hba.sh, que corre UNA SOLA VEZ
-- al inicializar un volumen de Postgres nuevo (docker-entrypoint-initdb.d) —
-- ANTES de que estas tablas existan, así que el GRANT no puede ir ahí. Acá
-- SÍ pueden existir las tablas (este archivo las crea arriba), así que el
-- GRANT va acá — se repite en cada arranque del backend, pero GRANT es
-- inherentemente idempotente (repetirlo no es un error).
--
-- El `IF EXISTS` sobre el rol es defensivo: en un entorno donde mcp_readonly
-- no se aprovisionó (ej. un dev local sin el servidor MCP), este archivo
-- sigue corriendo limpio en vez de fallar por un rol que no le interesa a
-- ese entorno.
-- =========================================================================
-- Reconciliación de `facturas` MobilVendor↔Odoo (2026-10-01, ver TODO.md:
-- "Propuesta de diseño COMPLETA — reconciliación de facturas"). `facturas`
-- quedaba con 2 filas para la misma venta real: el sync de MobilVendor y el
-- de Odoo escriben cada uno con su propio criterio de `code` (PK), sin
-- coordinarse — ver TODO.md, sección de causa raíz, para el análisis
-- completo con datos reales.
--
-- `duplicado_de`: marcado NO DESTRUCTIVO (nunca se borra una fila). Cuando
-- una fila es el duplicado detectado de otra, apunta al `code` de la fila
-- "buena" (la que debe contar en los reportes). Las 8 tools que suman
-- `facturas` agregan `AND f.duplicado_de IS NULL` (ver
-- `FILTRO_FACTURAS_NO_DUPLICADO` en mcp-server/src/sql/clasificacion.js) —
-- un solo lugar deja de contar la fila marcada, en vez de borrarla (que
-- rompería `promo_lineas_venta`, huérfana de FK, para las filas de
-- MobilVendor con promos — ver TODO.md).
--
-- `mobilvendor_internal_id`: el `id` interno de MobilVendor (campo crudo de
-- su API, confirmado en vivo — ver TODO.md — DISTINTO de `code`, que
-- cambia de valor para el mismo documento real a lo largo de su ciclo de
-- vida). Lo captura SOLO el sync de MobilVendor
-- (`backend/services/sincronizacionService.js`, función `syncDocumento`) —
-- Odoo nunca lo conoce. Permite detectar, de forma determinística (sin
-- heurística de fecha/monto), cuando MobilVendor reporta el MISMO
-- documento real dos veces con 2 `code` distintos en 2 sincronizaciones
-- separadas (el "Tier 1" del diseño — resuelve ~38% de los pares conocidos
-- sin depender de Odoo).
-- =========================================================================
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS duplicado_de            VARCHAR(30);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS mobilvendor_internal_id VARCHAR(30);

-- FK autorreferencial defensiva: `duplicado_de` siempre debe apuntar a un
-- `code` real de la misma tabla. ON DELETE SET NULL es solo defensivo (en
-- la práctica nunca se borra una fila de `facturas`).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_facturas_duplicado_de'
  ) THEN
    ALTER TABLE facturas
      ADD CONSTRAINT fk_facturas_duplicado_de
      FOREIGN KEY (duplicado_de)
      REFERENCES facturas(code)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_facturas_duplicado_de
  ON facturas(duplicado_de)
  WHERE duplicado_de IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_facturas_mobilvendor_internal_id
  ON facturas(mobilvendor_internal_id)
  WHERE mobilvendor_internal_id IS NOT NULL;

-- Tabla de revisión manual (Tier 2 / backfill): pares candidatos detectados
-- por la llave heurística (cliente+día+monto) que NO cumplen la condición
-- de 1-a-1 (ver TODO.md) — ej. cuentas de cadena/consolidadas (TIA, El
-- Rosado) donde varios documentos reales distintos coinciden en
-- cliente+día+monto por azar. Nunca se marcan `duplicado_de`
-- automáticamente — quedan acá para que alguien los revise a mano.
CREATE TABLE IF NOT EXISTS facturas_duplicados_revision_manual (
  id                SERIAL PRIMARY KEY,
  code_candidato_a  VARCHAR(30) NOT NULL,
  code_candidato_b  VARCHAR(30) NOT NULL,
  motivo            VARCHAR(100) NOT NULL, -- ej. 'AMBIGUO_MULTIPLES_CANDIDATOS'
  detectado_en      TIMESTAMP DEFAULT NOW(),
  revisado          BOOLEAN DEFAULT FALSE,
  UNIQUE (code_candidato_a, code_candidato_b)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    GRANT SELECT ON clientes, detalle_documento, direcciones_clientes, facturas, ordenes, productos TO mcp_readonly;
    GRANT SELECT (codigo_cliente, fecha_visita, accion) ON historial_visitas TO mcp_readonly;
    GRANT SELECT ON facturas_duplicados_revision_manual TO mcp_readonly;
  END IF;
END $$;
