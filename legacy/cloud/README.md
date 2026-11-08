# Nube · Postgres + ingesta + portal

Esta carpeta contiene la parte que corre contra PostgreSQL: esquema, migración,
ingesta de Fudo, agregados, reportes y el portal web.

## Requisitos

- Python 3.10+
- PostgreSQL (Neon free alcanza)
- Fudo Plan Pro con usuario de API (Key + Secret)

## Configuración

En la raíz del repo:

```bash
cp cloud/.env.example .env
```

Completá:

```
DATABASE_URL=postgresql://usuario:clave@ep-xxxx-pooler.../neondb?sslmode=require
DATABASE_URL_DIRECT=postgresql://usuario:clave@ep-xxxx.../neondb?sslmode=require
FUDO_API_KEY=...
FUDO_API_SECRET=...
```

`DATABASE_URL` es la **pooled** (la usa el portal) y `DATABASE_URL_DIRECT` la
**directa** (migraciones y scripts).

Instalar la dependencia:

```bash
python -m pip install -r cloud/requirements.txt
```

## Comandos

```bash
# credenciales de Fudo (sin tocar la base)
python -m cloud.fudo_check

# esquema + migración desde SQLite (opcional)
python -m cloud.migrate
python -m cloud.check

# ingesta
python -m cloud.ingest --what all --from 2026-01-01 --to 2026-12-31

# canales (salón / take away / delivery)
python -m cloud.channels

# costos de respaldo desde la planilla
python -m cloud.overrides          # informe
python -m cloud.overrides --apply  # aplica los casos claros

# agregados semanales y diarios
python -m cloud.recompute

# worker: una corrida o loop cada 15 min
python -m cloud.worker --once
python -m cloud.worker --minutes 15

# portal web
python -m cloud.server_pg
```

## Portal

- `GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/meta`
- `GET /healthz`

Variables:

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | 8788 | puerto |
| `HOST` | 127.0.0.1 | interfaz (en el server, 0.0.0.0) |
| `PORTAL_USER` | `bois` | usuario de Basic Auth |
| `PORTAL_PASS` | vacío | si se define, el portal pide contraseña |

Si `PORTAL_PASS` queda vacío, el portal es abierto. Usalo solo en local.

## Deploy

Con Docker, desde la raíz del repo:

```bash
docker build -t gest-system .
docker run --env-file .env -e HOST=0.0.0.0 -e PORT=8080 -e PORTAL_PASS=una-clave -p 8080:8080 gest-system
```

En Render: Web Service → Docker, variables `DATABASE_URL` (pooled),
`PORTAL_USER` y `PORTAL_PASS`. El `render.yaml` de la raíz lo deja configurado.

## Esquema

El esquema canónico está en [`../docs/schema-postgres.sql`](../docs/schema-postgres.sql).
La especificación de la API de Fudo, en [`../docs/fudo-openapi.yml`](../docs/fudo-openapi.yml).
