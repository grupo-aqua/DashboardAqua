// src/tools/direccionesEntregaDuplicadas.js
// FASE 1, SOLO DIAGNÓSTICO — pedido explícito del usuario (2026-10-15,
// seguimiento de la investigación de duplicados_en_odoo en
// auditoriaClientes.js): direcciones de entrega (`res.partner`,
// `type='delivery'`) duplicadas dentro del MISMO cliente padre. Corre
// directo contra Odoo (res.partner), igual patrón que
// `duplicados_en_odoo` — NO depende de MobilVendor/`clientes`.
//
// ============================================================
// Investigado antes de construir (datos reales, no asumidos)
// ============================================================
// Total direcciones de entrega activas: 3,517. Agrupando por
// (parent_id + nombre EXACTO): 99 grupos. Por (parent_id + calle EXACTA):
// 258 grupos. Caso real confirmado (ATIMASA S.A., varias direcciones
// "PRIMAX ..."): la misma tienda cargada 2 veces, una con coordenadas
// reales y otra en (0,0) — claramente reingresada, no una sucursal nueva.
//
// Diseño: UNA sola señal unificada (nombre O calle, no 2 separadas como
// senal_fuerte/senal_debil en auditoriaClientes) — decisión explícita del
// usuario, "más simple de revisar". El match es TRANSITIVO (union-find):
// si A comparte nombre con B, y B comparte calle con C, A/B/C quedan en
// el mismo grupo aunque A y C no compartan nada entre sí directamente —
// evita partir en 2 grupos lo que en la práctica es la misma dirección
// reingresada varias veces con pequeñas variaciones.
//
// Nunca fusiona ni borra nada — mismo principio que el resto de esta
// familia de tools (auditoriaClientes).
"use strict";
const { z } = require("zod");
const { executeKw } = require("../integrations/odooContabilidad");

const LIMITE_DEFAULT = 50;
const LIMITE_MAX = 500;
// Mismo principio que UMBRAL_CADENA_GRANDE en auditoriaClientes.js — ver
// comentario grande en agruparDuplicadas() para el hallazgo real que
// motivó este umbral.
const UMBRAL_CADENA_GRANDE_DIRECCIONES = 8;

const inputSchema = {
  company_id: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limite: z.number().int().min(1).max(LIMITE_MAX).default(LIMITE_DEFAULT),
  formato_salida: z.enum(["json", "resumen_por_tipo"]).default("json"),
};

function normalizar(texto) {
  return (texto || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function paginar(items, offset, limite) {
  const pagina = items.slice(offset, offset + limite);
  return { total: items.length, offset, limite, hay_mas: offset + pagina.length < items.length, items: pagina };
}

// Union-find mínimo — agrupa transitivamente direcciones del MISMO padre
// que comparten nombre o calle normalizados.
class UnionFind {
  constructor(n) {
    this.padre = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.padre[x] !== x) {
      this.padre[x] = this.padre[this.padre[x]];
      x = this.padre[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.padre[ra] = rb;
  }
}

function agruparDuplicadas(direcciones) {
  // Nunca cruza direcciones de clientes padre distintos.
  const porPadre = new Map();
  for (const d of direcciones) {
    if (!d.parent_id) continue; // sin cliente padre -- el criterio (parent_id) no aplica.
    const padreId = d.parent_id[0];
    if (!porPadre.has(padreId)) porPadre.set(padreId, { padre_nombre: d.parent_id[1], direcciones: [] });
    porPadre.get(padreId).direcciones.push(d);
  }

  const grupos = [];
  let cadenasGrandesSinMatchPorCalle = 0;
  for (const [padreId, { padre_nombre, direcciones: lista }] of porPadre.entries()) {
    if (lista.length < 2) continue;
    if (lista.length > UMBRAL_CADENA_GRANDE_DIRECCIONES) cadenasGrandesSinMatchPorCalle++;

    // Unión por NOMBRE exacto: siempre segura (si 2 direcciones de un mismo
    // padre tienen el nombre idéntico, es casi con certeza la misma
    // reingresada) — se aplica sin importar cuántas direcciones tenga el
    // padre.
    //
    // Unión por CALLE exacta: SOLO si el padre tiene pocas direcciones
    // (<= UMBRAL_CADENA_GRANDE_DIRECCIONES). Encontrado validando en vivo:
    // cadenas grandes (El Rosado: 166 direcciones, 108 nombres DISTINTOS;
    // CRESA-RETAIL: 152 direcciones, 152 nombres DISTINTOS; ATIMASA,
    // CONECEL) registran MUCHOS locales reales bajo la MISMA calle de
    // matriz/facturación — unir solo por calle ahí fusiona decenas de
    // tiendas genuinamente distintas en un solo "grupo duplicado" gigante,
    // puro ruido. Mismo principio que `UMBRAL_CADENA_GRANDE` en
    // auditoriaClientes.js (señal débil ahí, señal por calle acá).
    const uf = new UnionFind(lista.length);
    const porNombre = new Map();
    const porCalle = new Map();
    const permitirPorCalle = lista.length <= UMBRAL_CADENA_GRANDE_DIRECCIONES;
    lista.forEach((d, i) => {
      const nombre = normalizar(d.name);
      const calle = normalizar(d.street);
      if (nombre) {
        if (porNombre.has(nombre)) uf.union(i, porNombre.get(nombre));
        else porNombre.set(nombre, i);
      }
      if (calle && permitirPorCalle) {
        if (porCalle.has(calle)) uf.union(i, porCalle.get(calle));
        else porCalle.set(calle, i);
      }
    });

    const clusters = new Map();
    lista.forEach((d, i) => {
      const raiz = uf.find(i);
      if (!clusters.has(raiz)) clusters.set(raiz, []);
      clusters.get(raiz).push(d);
    });

    for (const miembros of clusters.values()) {
      if (miembros.length < 2) continue;
      grupos.push({
        padre_id: padreId,
        padre_nombre,
        company_id: miembros[0].company_id ? miembros[0].company_id[0] : null,
        direcciones: miembros.map((d) => ({
          id: d.id,
          nombre: d.name,
          calle: d.street || null,
          calle2: d.street2 || null,
          ciudad: d.city || null,
          latitud: d.partner_latitude || null,
          longitud: d.partner_longitude || null,
        })),
      });
    }
  }

  grupos.sort((a, b) => b.direcciones.length - a.direcciones.length);
  return { grupos, cadenasGrandesSinMatchPorCalle };
}

const DESCRIPCION =
  `FASE 1, SOLO DIAGNÓSTICO — direcciones de entrega (res.partner, type='delivery', active=true) duplicadas dentro del MISMO cliente padre (parent_id). Se agrupan TRANSITIVAMENTE (union-find) las que comparten nombre EXACTO siempre, o calle EXACTA SOLO cuando el padre tiene ${UMBRAL_CADENA_GRANDE_DIRECCIONES} direcciones de entrega o menos — normalizados (mayúsculas, sin tildes, sin espacios al borde). El límite por calle existe porque las cadenas grandes (ej. El Rosado, CRESA-RETAIL) registran muchos locales reales bajo la MISMA calle de matriz/facturación — sin el límite, eso fusiona decenas de tiendas genuinamente distintas en un solo grupo (confirmado con datos reales: 166 direcciones / 108 nombres distintos en un solo cliente, puro ruido). Para esos padres grandes solo se usa nombre exacto, que sigue siendo seguro. Caso típico de duplicado real: la misma tienda/local cargada 2+ veces, a veces una con coordenadas reales y otra en (0,0). \`cadenas_grandes_sin_match_por_calle\` cuenta cuántos padres grandes quedaron limitados a solo nombre. company_id (opcional) filtra por compañía de Odoo. Nunca fusiona ni borra nada — requiere revisión humana en Odoo.`;

async function direccionesEntregaDuplicadas({ company_id, offset = 0, limite = LIMITE_DEFAULT, formato_salida = "json" }) {
  const domain = [["type", "=", "delivery"], ["active", "=", true]];
  if (company_id) domain.push(["company_id", "=", Number(company_id)]);

  const direcciones = await executeKw(
    "res.partner",
    "search_read",
    [domain],
    {
      fields: ["id", "name", "parent_id", "street", "street2", "city", "partner_latitude", "partner_longitude", "company_id"],
      limit: 0,
    }
  );

  const { grupos, cadenasGrandesSinMatchPorCalle } = agruparDuplicadas(direcciones);

  if (formato_salida === "resumen_por_tipo") {
    return {
      company_id: company_id || null,
      descripcion: DESCRIPCION,
      total: grupos.length,
      cadenas_grandes_sin_match_por_calle: cadenasGrandesSinMatchPorCalle,
    };
  }
  return {
    company_id: company_id || null,
    descripcion: DESCRIPCION,
    cadenas_grandes_sin_match_por_calle: cadenasGrandesSinMatchPorCalle,
    ...paginar(grupos, offset, limite),
  };
}

module.exports = { direccionesEntregaDuplicadas, inputSchema };
