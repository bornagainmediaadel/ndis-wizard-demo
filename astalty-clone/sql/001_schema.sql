-- Astalty clone · schema
-- Synthetic replica of the Astalty public API (https://api.app.astalty.com.au/docs.json)
-- for the NDIS Wizard demo. All tables are prefixed ast_ and live next to the
-- ShiftCare clone in the "NDIS Wizard Shiftcare Dummy" project. Synthetic data only.

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------- account + auth
create table if not exists ast_account (
  id int primary key default 1,
  name text not null,
  abn text,
  timezone text not null default 'Australia/Adelaide',
  created_at timestamptz not null default now()
);

create table if not exists ast_api_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_prefix text not null,
  token_hash text not null,
  permission text not null default 'full' check (permission in ('full','read')),
  last_used_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

-- verify a bearer token; returns null when invalid
create or replace function ast_verify_token(p_token text)
returns table (key_id uuid, label text, permission text)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select k.id, k.label, k.permission
    from ast_api_keys k
    where k.archived_at is null
      and k.token_prefix = left(p_token, 12)
      and k.token_hash = crypt(p_token, k.token_hash)
    limit 1;
  update ast_api_keys set last_used_at = now()
   where token_prefix = left(p_token, 12) and token_hash = crypt(p_token, token_hash);
end $$;

-- mint a key; returns the plaintext token exactly once
create or replace function ast_mint_api_key(p_label text, p_permission text default 'full')
returns text language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  tok := 'ast_' || encode(gen_random_bytes(24), 'hex');
  insert into ast_api_keys(label, token_prefix, token_hash, permission)
  values (p_label, left(tok, 12), crypt(tok, gen_salt('bf', 6)), p_permission);
  return tok;
end $$;

-- ---------------------------------------------------------------- change log
create table if not exists ast_change_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  tbl text not null,
  row_id text not null,
  op text not null,
  actor text,
  via text,
  before jsonb,
  after jsonb
);
create index if not exists ast_change_log_at on ast_change_log (at desc);

create or replace function ast_log_change() returns trigger
language plpgsql as $$
declare rid text; b jsonb; a jsonb;
begin
  if tg_op = 'DELETE' then rid := old.id::text; b := to_jsonb(old); a := null;
  elsif tg_op = 'INSERT' then rid := new.id::text; b := null; a := to_jsonb(new);
  else rid := new.id::text; b := to_jsonb(old); a := to_jsonb(new);
    if b = a then return new; end if;
  end if;
  insert into ast_change_log(tbl, row_id, op, actor, via, before, after)
  values (tg_table_name, rid, tg_op,
          nullif(current_setting('ast.actor', true), ''),
          nullif(current_setting('ast.via', true), ''), b, a);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------- people
create table if not exists ast_users (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text not null unique,
  mobile text,
  phone text,
  employment_title text,
  employment_basis text check (employment_basis in ('casual','full_time','part_time')),
  type text not null default 'support_worker' check (type in ('auditor','standard','support_worker')),
  role text not null default 'support-worker' check (role in ('admin','auditor','manager','support-worker','team-member')),
  status text not null default 'active' check (status in ('active','deactivated','invited','restricted')),
  hourly_rate_cents int,
  created_at timestamptz not null default now()
);

create table if not exists ast_plan_managers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invoice_email text,
  phone text,
  abn text,
  created_at timestamptz not null default now()
);

create table if not exists ast_organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text,
  abn text,
  email text,
  phone text,
  website text,
  description text,
  ndis_registered boolean,
  registration_number text,
  created_at timestamptz not null default now()
);

create table if not exists ast_contacts (
  id uuid primary key default gen_random_uuid(),
  first_name text,
  last_name text,
  email text,
  phone text,
  mobile text,
  dob date,
  gender text,
  occupation text,
  description text,
  preferred_contact_method text,
  organisation_id uuid references ast_organisations(id),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ast_participant_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  colour text
);

create table if not exists ast_participants (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  middle_name text,
  last_name text,
  preferred_name text,
  dob date,
  phone text,
  mobile text,
  email text,
  invoice_email text,
  status text not null default 'active' check (status in ('active','archived')),
  primary_diagnosis text,
  secondary_diagnosis text,
  pronouns text,
  gender text,
  sex text,
  language text,
  ethnicity text,
  ndis_number text,
  is_ndis_number_exempt boolean not null default false,
  external_id text,
  medicare text,
  centrelink text,
  preferred_contact_method text,
  commencement_date date,
  exit_date date,
  exit_reason text,
  exit_details text,
  checkin_period int,
  plan_manager_id uuid references ast_plan_managers(id),
  primary_coordinator_id uuid references ast_users(id),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ast_participant_tag_links (
  participant_id uuid references ast_participants(id) on delete cascade,
  tag_id uuid references ast_participant_tags(id) on delete cascade,
  primary key (participant_id, tag_id)
);

create table if not exists ast_participant_addresses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  type text,
  label text,
  address_1 text not null,
  address_2 text,
  address_3 text,
  suburb text,
  state text not null,
  postcode text not null,
  country text not null default 'Australia',
  lat text, lng text,
  traditional_place_name text,
  details text
);

create table if not exists ast_participant_alerts (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  title text,
  content text not null,
  type text not null default 'info',
  visible_to_support_workers boolean not null default true,
  visible_when_scheduling boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists ast_participant_contacts (
  participant_id uuid references ast_participants(id) on delete cascade,
  contact_id uuid references ast_contacts(id) on delete cascade,
  relationship text,
  starred boolean not null default false,
  consent boolean,
  details text,
  visible_to_support_workers boolean not null default true,
  primary key (participant_id, contact_id)
);

create table if not exists ast_participant_checkins (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  type text not null,
  date timestamptz not null
);

-- ---------------------------------------------------------------- plans, budgets, services
create table if not exists ast_support_categories (
  prefix text primary key,          -- '01', '04', '07', '15' ...
  name text not null,
  "group" text not null             -- core | capacity_building | capital
);

create table if not exists ast_ndis_plans (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  "start" date not null,
  "end" date not null,
  is_pace boolean not null default true,
  total_funded_supports bigint not null default 0,  -- cents
  created_at timestamptz not null default now()
);

create table if not exists ast_plan_budgets (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references ast_ndis_plans(id) on delete cascade,
  support_category text references ast_support_categories(prefix),
  amount bigint not null,            -- cents
  management_type text not null check (management_type in ('plan','self','ndia','unknown')),
  stated boolean not null default false,
  description text
);

create table if not exists ast_charge_items (
  id uuid primary key default gen_random_uuid(),
  number text not null,              -- NDIS support item number e.g. 01_011_0107_1_1
  reference text not null,
  name text not null,
  price int not null,                -- cents
  unit text not null default 'H',    -- H, E, D, WK, KM, YR
  gst_code text not null default 'P2',
  default_claim_type text,
  support_category text references ast_support_categories(prefix),
  archived_at timestamptz
);

create table if not exists ast_charge_item_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  reference text not null,
  charge_rate_pattern text not null default 'time_of_day',
  gst_code text,
  archived_at timestamptz
);
create table if not exists ast_charge_item_set_items (
  set_id uuid references ast_charge_item_sets(id) on delete cascade,
  charge_item_id uuid references ast_charge_items(id) on delete cascade,
  primary key (set_id, charge_item_id)
);

create table if not exists ast_services (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references ast_ndis_plans(id) on delete cascade,
  participant_id uuid not null references ast_participants(id) on delete cascade,
  name text not null,
  amount bigint not null,            -- cents agreed
  management_type text not null check (management_type in ('plan','self','ndia','unknown')),
  type text check (type in ('scheduled_service','unscheduled_service')),
  support_category text references ast_support_categories(prefix),
  service_coordinator_id uuid references ast_users(id),
  "start" date not null,
  "end" date not null,
  has_funding_schedule boolean not null default false,
  reconciled_amount bigint,
  reconciled_date date,
  created_at timestamptz not null default now()
);
create table if not exists ast_service_charge_items (
  service_id uuid references ast_services(id) on delete cascade,
  charge_item_id uuid references ast_charge_items(id) on delete cascade,
  primary key (service_id, charge_item_id)
);
create table if not exists ast_service_charge_item_sets (
  service_id uuid references ast_services(id) on delete cascade,
  set_id uuid references ast_charge_item_sets(id) on delete cascade,
  primary key (service_id, set_id)
);

create table if not exists ast_budgets (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  plan_id uuid references ast_ndis_plans(id),
  name text not null,
  description text,
  type text not null default 'internal' check (type in ('internal','external')),
  "start" date not null,
  "end" date not null,
  total bigint not null default 0,
  has_funding_schedule boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists ast_budget_items (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references ast_budgets(id) on delete cascade,
  charge_item_id uuid references ast_charge_items(id),
  name text not null,
  description text,
  number text,
  price int not null,
  unit_price int not null,
  ratio_numerator int, ratio_denominator int,
  quantity numeric(10,2) not null,
  unit text not null default 'H',
  period text not null default 'week',
  total bigint not null,
  "start" date not null,
  "end" date not null
);
create table if not exists ast_budget_periods (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references ast_budgets(id) on delete cascade,
  "start" date not null, "end" date not null, amount bigint not null
);

create table if not exists ast_plan_implementations (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references ast_ndis_plans(id) on delete cascade,
  plan_budget_id uuid references ast_plan_budgets(id),
  status text not null default 'implemented',
  amount bigint,
  frequency text,
  description text,
  implemented_at date,
  is_internal boolean not null default true,
  provider_type text, provider_id uuid, provider_name text
);

-- ---------------------------------------------------------------- goals, notes, tasks
create table if not exists ast_goals (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'in_progress' check (status in ('achieved','in_progress','unattainable')),
  goal_type text check (goal_type in ('long_term','medium_term','short_term')),
  barriers text,
  achievement_strategy text,
  achieved_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists ast_goal_plans (
  goal_id uuid references ast_goals(id) on delete cascade,
  plan_id uuid references ast_ndis_plans(id) on delete cascade,
  primary key (goal_id, plan_id)
);

create table if not exists ast_notes (
  id uuid primary key default gen_random_uuid(),
  notable_type text not null check (notable_type in ('participant','user','task')),
  notable_id uuid not null,
  author_id uuid references ast_users(id),
  content text not null,
  checkin_type text check (checkin_type in ('email','face to face','phone','sms','teleconsult')),
  source_type text not null default 'profile' check (source_type in ('profile','support','task')),
  source_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists ast_notes_notable on ast_notes (notable_type, notable_id, created_at desc);

create table if not exists ast_note_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null, content text not null, usage text, created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- sites, supports, shifts
create table if not exists ast_sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'other' check (type in ('other','sil_house')),
  description text,
  capacity int,
  default_support_type text,
  site_manager_id uuid references ast_users(id),
  address_1 text, suburb text, state text, postcode text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ast_group_supports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  details text,
  site_id uuid references ast_sites(id),
  start_time timestamptz not null,
  end_time timestamptz not null,
  timezone text not null default 'Australia/Adelaide',
  is_sleepover boolean not null default false
);

create table if not exists ast_supports (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  service_id uuid references ast_services(id),
  group_support_id uuid references ast_group_supports(id),
  site_id uuid references ast_sites(id),
  support_type text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  timezone text not null default 'Australia/Adelaide',
  details text,
  address_state text default 'SA',
  is_sleepover boolean not null default false,
  sleepover_starts_at timestamptz, sleepover_ends_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  cancellation_type text check (cancellation_type in ('NSDF','NSDH','NSDO','NSDT')),
  created_at timestamptz not null default now()
);
create index if not exists ast_supports_start on ast_supports (start_time);

create table if not exists ast_shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references ast_users(id),
  support_id uuid references ast_supports(id) on delete cascade,
  group_support_id uuid references ast_group_supports(id),
  event_type text not null default 'support' check (event_type in ('support','group_support','internal_event')),
  name text,
  details text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  timezone text not null default 'Australia/Adelaide',
  status text not null default 'published' check (status in ('draft','published','completed','cancelled','no_show')),
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ast_shifts_start on ast_shifts (start_time);

create table if not exists ast_shift_breaks (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references ast_shifts(id) on delete cascade,
  type text not null default 'meal',
  duration int not null,  -- minutes
  is_paid boolean not null default false
);

create table if not exists ast_travels (
  id uuid primary key default gen_random_uuid(),
  support_id uuid references ast_supports(id) on delete cascade,
  user_id uuid references ast_users(id),
  travel_anchor text not null default 'before',
  details text,
  distance int not null default 0,      -- km planned
  duration int not null default 0,      -- minutes planned
  approved_distance int, approved_duration int,
  odometer_start int, odometer_end int,
  actual_start_time timestamptz, actual_end_time timestamptz,
  actual_distance int, actual_duration int,
  was_not_travelled boolean,
  is_unscheduled boolean not null default false,
  group_travel_id uuid,
  shared_with_count int not null default 0
);

-- ---------------------------------------------------------------- tasks (support coordination time)
create table if not exists ast_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  participant_id uuid references ast_participants(id),
  user_id uuid references ast_users(id),
  start_time timestamptz not null,
  duration int not null default 0,    -- minutes
  billable boolean not null default true,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists ast_task_goals (
  task_id uuid references ast_tasks(id) on delete cascade,
  goal_id uuid references ast_goals(id) on delete cascade,
  primary key (task_id, goal_id)
);

-- ---------------------------------------------------------------- billing
create table if not exists ast_invoice_batches (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  status text not null default 'draft' check (status in ('draft','finalised','processing','queued')),
  invoice_sending_behaviour text not null default 'do_not_send_automatically',
  "start" date, "end" date,
  charge_type text,
  management_types text[],
  finalised_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ast_invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  participant_id uuid not null references ast_participants(id),
  plan_manager_id uuid references ast_plan_managers(id),
  batch_id uuid references ast_invoice_batches(id),
  management_type text not null check (management_type in ('plan','self','ndia','unknown')),
  date date not null,
  due_date date not null,
  total bigint not null default 0,    -- cents, as stored (may deliberately disagree with charges)
  status text not null default 'issued' check (status in ('draft','issued','part_paid','paid','voided')),
  voided_at timestamptz, voided_reason text,
  sent_at timestamptz,
  xero_invoice_id text,
  created_at timestamptz not null default now()
);

create table if not exists ast_charges (
  -- a charge is one billable line: from a support (shift), a task, or a direct charge
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id),
  charge_item_id uuid references ast_charge_items(id),
  service_id uuid references ast_services(id),
  source text not null default 'support' check (source in ('direct_charge','support','task')),
  support_id uuid references ast_supports(id),
  task_id uuid references ast_tasks(id),
  invoice_id uuid references ast_invoices(id),
  date date not null,
  quantity numeric(10,2),
  unit_cost int not null,             -- cents
  total_cost bigint not null,         -- cents
  claim_type text check (claim_type in ('CANC','Direct','IRSS','NF2F','REPW','THLT','TRAN')),
  claim_reference text,
  cancellation_reason text,
  is_primary boolean not null default true,
  status text not null default 'uninvoiced' check (status in ('uninvoiced','invoiced','paid','voided')),
  created_at timestamptz not null default now()
);
create index if not exists ast_charges_invoice on ast_charges (invoice_id);
create index if not exists ast_charges_support on ast_charges (support_id);

create table if not exists ast_invoice_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references ast_invoices(id) on delete cascade,
  amount bigint not null,
  payment_date date not null,
  reference text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- quality & safeguarding
create table if not exists ast_incidents (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  participant_id uuid references ast_participants(id),
  reported_by_id uuid references ast_users(id),
  type text not null,
  severity text,
  status text not null default 'open',
  reportable text not null default 'no',
  reportable_type text,
  time timestamptz not null,
  details text not null,
  follow_up_details text,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ast_feedback (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  feedback_type text not null default 'complaint',
  sentiment text,
  status text not null default 'open',
  subject_name text,
  complainant_name text, complainant_email text, complainant_phone text,
  details text,
  follow_up_details text,
  participant_id uuid references ast_participants(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists ast_referrals (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  participant_name text,
  status text not null default 'new',
  details text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists ast_participant_risks (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  title text not null,
  description text,
  likelihood int not null check (likelihood between 1 and 5),
  consequence int not null check (consequence between 1 and 5),
  residual_likelihood int not null check (residual_likelihood between 1 and 5),
  risk_to text not null check (risk_to in ('business','others','participant','staff')),
  status text not null default 'active',
  review_frequency text not null default 'quarterly',
  risk_management_type text not null default 'active',
  visible_to_support_workers boolean not null default true,
  last_reviewed_at date,
  next_review_at date not null,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists ast_participant_risk_controls (
  id uuid primary key default gen_random_uuid(),
  risk_id uuid not null references ast_participant_risks(id) on delete cascade,
  title text not null, description text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- documents & records
create table if not exists ast_document_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null, archived_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists ast_documents (
  id uuid primary key default gen_random_uuid(),
  documentable_type text not null,    -- participant | user | contact | organisation | plan_manager | site | task | note
  documentable_id uuid not null,
  category_id uuid references ast_document_categories(id),
  name text not null,
  file_extension text not null default 'pdf',
  size_bytes int,
  created_at timestamptz not null default now()
);
create index if not exists ast_documents_owner on ast_documents (documentable_type, documentable_id);

create table if not exists ast_participant_record_types (
  id uuid primary key default gen_random_uuid(),
  name text not null, expires boolean not null default true, requires_documents boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists ast_participant_records (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  type_id uuid not null references ast_participant_record_types(id),
  name text, reference text,
  issue_date date, expiry_date date,
  created_at timestamptz not null default now()
);
create table if not exists ast_user_record_types (
  id uuid primary key default gen_random_uuid(),
  name text not null, expires boolean not null default true
);
create table if not exists ast_user_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references ast_users(id) on delete cascade,
  type_id uuid not null references ast_user_record_types(id),
  name text, reference text,
  issue_date date, expiry_date date,
  created_at timestamptz not null default now()
);

create table if not exists ast_participant_information_item_defs (
  id uuid primary key default gen_random_uuid(),
  name text not null, required boolean not null default false,
  documents_allowed boolean not null default false, visible_to_support_workers boolean not null default true
);
create table if not exists ast_participant_information_items (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references ast_participants(id) on delete cascade,
  def_id uuid not null references ast_participant_information_item_defs(id),
  detail text,
  created_at timestamptz not null default now(), updated_at timestamptz,
  unique (participant_id, def_id)
);

-- ---------------------------------------------------------------- forms, signatures, misc
create table if not exists ast_forms (
  id uuid primary key default gen_random_uuid(),
  name text not null, type text not null default 'general', created_at timestamptz not null default now()
);
create table if not exists ast_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references ast_forms(id),
  submitted_by_id uuid references ast_users(id),
  participant_id uuid references ast_participants(id),
  fields jsonb not null default '[]',
  submitted_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists ast_signature_requests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  owner_type text, owner_id uuid,
  participant_id uuid references ast_participants(id),
  platform text not null default 'astalty',
  status text not null default 'sent',
  is_test boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists ast_public_holiday_groups (
  id uuid primary key default gen_random_uuid(), name text not null
);
create table if not exists ast_public_holidays (
  id uuid primary key default gen_random_uuid(),
  name text not null, date date not null, state text not null default 'SA',
  timezone text not null default 'Australia/Adelaide', custom boolean not null default false
);
create table if not exists ast_webhooks (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  url text not null,
  event_types text[] not null,
  is_enabled boolean not null default true,
  signing_secret text not null default ('whsec_' || encode(gen_random_bytes(24),'hex')),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists ast_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  payload jsonb not null,
  webhook_id uuid references ast_webhooks(id),
  delivery_status text not null default 'pending',
  response_code int,
  created_at timestamptz not null default now()
);
create table if not exists ast_exports (
  id uuid primary key default gen_random_uuid(),
  name text not null, export_type text not null, export_reason text,
  status text not null default 'completed', failed_reason text, last_downloaded_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- triggers + RLS
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'ast\_%'
            and tablename not in ('ast_change_log','ast_api_keys','ast_webhook_events','ast_participant_checkins')
  loop
    execute format('drop trigger if exists ast_log on %I', t);
    execute format('create trigger ast_log after insert or update or delete on %I for each row execute function ast_log_change()', t);
    execute format('alter table %I enable row level security', t);
  end loop;
  alter table ast_change_log enable row level security;
  alter table ast_api_keys enable row level security;
  alter table ast_webhook_events enable row level security;
  alter table ast_participant_checkins enable row level security;
end $$;
