-- ============================================================================
-- GesT · esquema Postgres (Neon) — versión 1
-- ----------------------------------------------------------------------------
-- · venue_id en todo: hoy un solo local, mañana varios.
-- · ventas y gastos unificados con `source` (fudo | sheet | manual) y
--   `external_id`, así conviven Fudo, la planilla y las cargas a mano.
-- · payload jsonb para auditoría y reproceso.
-- · unique por (venue_id, source, external_id) => ingesta idempotente.
-- · importes numeric(12,2); cantidades numeric(12,3).
-- ============================================================================

-- ---------------------------------------------------------------- dimensiones

create table if not exists venues (
    id          bigserial primary key,
    name        text not null,
    slug        text not null unique,
    timezone    text not null default 'America/Argentina/Buenos_Aires',
    active      boolean not null default true,
    created_at  timestamptz not null default now()
);

create table if not exists users (
    id            bigserial primary key,
    venue_id      bigint references venues(id) on delete cascade,
    email         text not null,
    name          text,
    password_hash text not null,
    role          text not null default 'viewer' check (role in ('admin', 'viewer')),
    active        boolean not null default true,
    last_login_at timestamptz,
    created_at    timestamptz not null default now()
);
create unique index if not exists users_email_uq on users (lower(email));

create table if not exists sessions (
    token_hash  text primary key,
    user_id     bigint not null references users(id) on delete cascade,
    expires_at  timestamptz not null,
    created_at  timestamptz not null default now(),
    ip          text,
    user_agent  text
);
create index if not exists sessions_user_ix on sessions (user_id);

create table if not exists product_categories (
    id       bigserial primary key,
    venue_id bigint not null references venues(id) on delete cascade,
    fudo_id  text,
    name     text not null,
    unique (venue_id, name)
);

create table if not exists products (
    id          bigserial primary key,
    venue_id    bigint not null references venues(id) on delete cascade,
    fudo_id     text,
    name        text not null,
    category_id bigint references product_categories(id),
    active      boolean not null default true,
    updated_at  timestamptz not null default now(),
    unique (venue_id, name)
);
-- costo actual (directo de Fudo o calculado con la receta) y precio de lista
alter table products add column if not exists cost numeric(12,4);
alter table products add column if not exists price numeric(12,2);

-- costo de respaldo cuando Fudo no costea el producto (ej. importado de la planilla)
create table if not exists product_cost_overrides (
    venue_id   bigint not null references venues(id) on delete cascade,
    product_id bigint not null references products(id) on delete cascade,
    cost       numeric(12,4) not null,
    source     text not null default 'sheet',
    note       text,
    updated_at timestamptz not null default now(),
    primary key (venue_id, product_id)
);

create table if not exists providers (
    id       bigserial primary key,
    venue_id bigint not null references venues(id) on delete cascade,
    fudo_id  text,
    name     text not null,
    unique (venue_id, name)
);

create table if not exists expense_categories (
    id       bigserial primary key,
    venue_id bigint not null references venues(id) on delete cascade,
    fudo_id  text,
    name     text not null,
    unique (venue_id, name)
);

create table if not exists ingredients (
    id         bigserial primary key,
    venue_id   bigint not null references venues(id) on delete cascade,
    fudo_id    text,
    name       text not null,
    unit       text,
    cost       numeric(12,4),
    updated_at timestamptz not null default now(),
    unique (venue_id, name)
);

-- ---------------------------------------------------------------- ventas

create table if not exists sales (
    id            bigserial primary key,
    venue_id      bigint not null references venues(id) on delete cascade,
    source        text not null default 'fudo' check (source in ('fudo', 'sheet', 'manual')),
    external_id   text not null,
    closed_at     timestamptz,
    business_date date not null,
    sale_type     text,
    state         text,
    total         numeric(12,2) not null default 0,
    payload       jsonb,
    fetched_at    timestamptz not null default now(),
    unique (venue_id, source, external_id)
);
create index if not exists sales_date_ix on sales (venue_id, business_date);
create index if not exists sales_payload_gin on sales using gin (payload);
-- canal: salon | takeaway | delivery (las apps aparte, en channel_detail)
alter table sales add column if not exists channel text not null default 'salon';
alter table sales add column if not exists channel_detail text;
create index if not exists sales_channel_ix on sales (venue_id, channel);

create table if not exists sale_items (
    id         bigserial primary key,
    sale_id    bigint not null references sales(id) on delete cascade,
    product_id bigint references products(id),
    quantity   numeric(12,3) not null default 0,
    unit_price numeric(12,2),
    line_total numeric(12,2) not null default 0,
    unit_cost  numeric(12,2),
    line_cost  numeric(12,2) not null default 0,
    canceled   boolean not null default false,
    payload    jsonb
);
create index if not exists sale_items_sale_ix on sale_items (sale_id);
create index if not exists sale_items_product_ix on sale_items (product_id);

-- ---------------------------------------------------------------- gastos

create table if not exists expenses (
    id            bigserial primary key,
    venue_id      bigint not null references venues(id) on delete cascade,
    source        text not null default 'fudo' check (source in ('fudo', 'sheet', 'manual')),
    external_id   text not null,
    expense_date  date not null,
    amount        numeric(12,2) not null default 0,
    description   text,
    provider_id   bigint references providers(id),
    category_id   bigint references expense_categories(id),
    category_name text,
    status        text,
    payload       jsonb,
    fetched_at    timestamptz not null default now(),
    unique (venue_id, source, external_id)
);
create index if not exists expenses_date_ix on expenses (venue_id, expense_date);
create index if not exists expenses_payload_gin on expenses using gin (payload);

create table if not exists expense_items (
    id            bigserial primary key,
    expense_id    bigint not null references expenses(id) on delete cascade,
    ingredient_id bigint references ingredients(id),
    detail        text,
    quantity      numeric(12,3),
    unit          text,
    unit_price    numeric(12,4),
    line_total    numeric(12,2),
    canceled      boolean not null default false,
    payload       jsonb
);
create index if not exists expense_items_expense_ix on expense_items (expense_id);
create index if not exists expense_items_ingredient_ix on expense_items (ingredient_id);

-- historial de precios por insumo (para detectar aumentos reales)
create or replace view v_ingredient_prices as
select e.venue_id,
       ei.ingredient_id,
       e.expense_date,
       e.provider_id,
       ei.unit,
       ei.quantity,
       ei.unit_price,
       ei.line_total
from expense_items ei
join expenses e on e.id = ei.expense_id
where ei.canceled = false
  and ei.unit_price is not null
  and ei.unit_price > 0;

-- ---------------------------------------------------------------- histórico de la planilla

-- Resumen semanal por categoría tal como estaba en Historico_Semanal.
create table if not exists weekly_history (
    id            bigserial primary key,
    venue_id      bigint not null references venues(id) on delete cascade,
    week_key      text not null,
    category_name text not null,
    cantidad      numeric(14,3) not null default 0,
    ventas        numeric(14,2) not null default 0,
    cmv           numeric(14,2) not null default 0,
    ganancia      numeric(14,2),
    cmv_pct       numeric(8,3),
    participacion numeric(8,3),
    observaciones text,
    unique (venue_id, week_key, category_name)
);

-- Cierres mensuales cargados a mano (Historico_Mensual).
create table if not exists monthly_closes (
    venue_id         bigint not null references venues(id) on delete cascade,
    month_key        text not null,
    ventas           numeric(14,2) not null default 0,
    cmv              numeric(14,2) not null default 0,
    resultado_bruto  numeric(14,2) not null default 0,
    gastos           numeric(14,2) not null default 0,
    resultado_final  numeric(14,2) not null default 0,
    margen_pct       numeric(8,3),
    source           text not null default 'sheet',
    updated_at       timestamptz not null default now(),
    primary key (venue_id, month_key)
);

-- ---------------------------------------------------------------- agregados

create table if not exists weekly_category_stats (
    venue_id    bigint not null references venues(id) on delete cascade,
    week_key    text not null,
    category_id bigint not null,
    cantidad    numeric(14,3) not null default 0,
    ventas      numeric(14,2) not null default 0,
    cmv         numeric(14,2) not null default 0,
    computed_at timestamptz not null default now(),
    primary key (venue_id, week_key, category_id)
);

create table if not exists daily_category_stats (
    venue_id      bigint not null references venues(id) on delete cascade,
    business_date date not null,
    category_id   bigint not null,
    cantidad      numeric(14,3) not null default 0,
    ventas        numeric(14,2) not null default 0,
    cmv           numeric(14,2) not null default 0,
    primary key (venue_id, business_date, category_id)
);

-- vistas rápidas para el portal
create or replace view v_monthly_sales as
select s.venue_id,
       to_char(s.business_date, 'YYYY-MM') as month_key,
       sum(si.line_total) as ventas,
       sum(si.line_cost)  as cmv
from sales s
join sale_items si on si.sale_id = s.id
where s.state = 'CLOSED' and si.canceled = false
group by 1, 2;

create or replace view v_weekly_channel as
select venue_id, week_key, channel,
       sum(line_total) as ventas,
       sum(line_cost)  as cmv
from (
    select s.venue_id,
           to_char(s.business_date, 'YYYY-MM') || '-S' ||
             (((extract(day from s.business_date)::int - 1) / 7) + 1)::text as week_key,
           s.channel,
           si.line_total,
           si.line_cost
    from sales s
    join sale_items si on si.sale_id = s.id
    where s.state = 'CLOSED' and si.canceled = false
) x
group by 1, 2, 3;

create or replace view v_monthly_channel as
select venue_id,
       month_key,
       channel,
       sum(line_total) as ventas,
       sum(line_cost)  as cmv
from (
    select s.venue_id,
           to_char(s.business_date, 'YYYY-MM') as month_key,
           s.channel,
           si.line_total,
           si.line_cost
    from sales s
    join sale_items si on si.sale_id = s.id
    where s.state = 'CLOSED' and si.canceled = false
) x
group by 1, 2, 3;

create or replace view v_monthly_expenses as
with totals as (
    select e.venue_id,
           to_char(e.expense_date, 'YYYY-MM') as month_key,
           e.source,
           sum(e.amount) as total
    from expenses e
    group by 1, 2, 3
), pref as (
    select venue_id,
           month_key,
           coalesce(
               max(total) filter (where source = 'sheet'),
               max(total) filter (where source = 'fudo'),
               max(total) filter (where source = 'manual'),
               0
           ) as gastos
    from totals
    group by 1, 2
)
select venue_id, month_key, gastos from pref;

-- ---------------------------------------------------------------- gastos externos

-- Gastos que no pasan por Fudo, cargados desde el portal.
--   fijo: se repite (mensual/semanal) y se prorratea por día; excepcional: puntual.
create table if not exists external_expenses (
    id           bigserial primary key,
    venue_id     bigint not null references venues(id) on delete cascade,
    kind         text not null check (kind in ('fijo', 'excepcional')),
    name         text not null,
    amount       numeric(12,2) not null check (amount >= 0),
    expense_date date,
    frequency    text,
    start_date   date,
    end_date     date,
    created_at   timestamptz not null default now()
);
create index if not exists external_expenses_ix on external_expenses (venue_id, kind, expense_date);

-- ---------------------------------------------------------------- operación

create table if not exists sync_runs (
    id           bigserial primary key,
    venue_id     bigint not null references venues(id) on delete cascade,
    kind         text not null,
    range_start  date,
    range_end    date,
    status       text not null,
    rows_read    integer default 0,
    rows_written integer default 0,
    message      text,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz
);
create index if not exists sync_runs_venue_ix on sync_runs (venue_id, started_at desc);

create table if not exists settings (
    venue_id bigint not null references venues(id) on delete cascade,
    key      text not null,
    value    jsonb,
    primary key (venue_id, key)
);

create table if not exists fudo_credentials (
    venue_id       bigint primary key references venues(id) on delete cascade,
    api_key_enc    text not null,
    api_secret_enc text not null,
    updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- datos iniciales

insert into venues (name, slug)
values ('Mi local', 'bois')
on conflict (slug) do nothing;
