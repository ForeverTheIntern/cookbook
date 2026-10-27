create table if not exists runs (
  id text primary key,
  factory_id text not null,
  repo text not null,
  issue integer not null,
  title text not null,
  stage text not null,
  hold text,
  pr integer,
  rev integer not null,
  created_at timestamptz not null,
  stage_since timestamptz not null,
  closed_at timestamptz,
  doc jsonb not null,
  received_at timestamptz not null default now()
);
create index if not exists runs_repo_created on runs (repo, created_at desc);
create index if not exists runs_closed on runs (closed_at);

create table if not exists transitions (
  run_id text not null references runs (id) on delete cascade,
  seq integer not null,
  stage text not null,
  at timestamptz not null,
  reason text not null,
  actor text,
  primary key (run_id, seq)
);

create table if not exists role_runs (
  agent_id text primary key,
  run_id text not null references runs (id) on delete cascade,
  role text not null,
  visit integer not null,
  status text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  cost_cents double precision,
  cost_state text,
  url text not null
);
create index if not exists role_runs_run on role_runs (run_id);

create table if not exists heartbeats (
  factory_id text primary key,
  at timestamptz not null,
  version text not null,
  repos jsonb not null default '[]',
  open_count integer not null,
  received_at timestamptz not null default now()
);
