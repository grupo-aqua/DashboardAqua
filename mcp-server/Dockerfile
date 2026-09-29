FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src

# Commit/rama/fecha del build "horneados" en la imagen — para saber qué
# código corre en el droplet sin tener que reconstruir el estado a mano
# (git rev-parse + docker exec + grep). Se pasan como build-args (ver
# docker-compose.yml y scripts/deploy.sh, que los calculan automáticamente
# de git); si se construye sin pasarlos (ej. `docker build` suelto), caen a
# "unknown" — nunca rompe el build. Expuestos en runtime vía GET /health.
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.revision="$GIT_COMMIT" \
      com.aqua.git-branch="$GIT_BRANCH" \
      org.opencontainers.image.created="$BUILD_DATE"
RUN printf '{"commit":"%s","branch":"%s","build_date":"%s"}\n' "$GIT_COMMIT" "$GIT_BRANCH" "$BUILD_DATE" > /app/VERSION.json

EXPOSE 8787

CMD ["node", "src/server.js"]
