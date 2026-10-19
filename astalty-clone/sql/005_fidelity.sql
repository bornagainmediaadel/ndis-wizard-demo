-- Astalty clone · fidelity patch for databases seeded before 2026-10-19.
-- Adds the columns and values the published Astalty resources require; safe to run more than once.
-- (Fresh installs get all of this from 001-004.)

alter table ast_participant_tags add column if not exists created_at timestamptz not null default '2025-01-06 00:30+00';
alter table ast_sites
  add column if not exists address_id uuid not null default gen_random_uuid(),
  add column if not exists address_2 text, add column if not exists country text not null default 'Australia',
  add column if not exists lat text, add column if not exists lng text,
  add column if not exists traditional_place_name text, add column if not exists address_details text;
alter table ast_user_record_types
  add column if not exists requires_verification boolean not null default false,
  add column if not exists is_self_service boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at timestamptz not null default '2025-01-06 00:30+00';
alter table ast_participant_information_item_defs
  add column if not exists "order" int not null default 0,
  add column if not exists created_at timestamptz not null default '2025-01-06 00:30+00';
alter table ast_forms
  add column if not exists description text, add column if not exists usage text not null default 'general',
  add column if not exists status text not null default 'published', add column if not exists hosted_url text,
  add column if not exists archived_at timestamptz;
alter table ast_signature_requests add column if not exists requested_by_id uuid references ast_users(id);

update ast_sites set address_id = ast_id('addr:site:1'), lat = '-34.8393', lng = '138.4817', traditional_place_name = 'Kaurna Country' where id = ast_id('site:1');
update ast_sites set address_id = ast_id('addr:site:2'), lat = '-34.9289', lng = '138.5716', traditional_place_name = 'Kaurna Country' where id = ast_id('site:2');
update ast_user_record_types set requires_verification = true where id in (ast_id('urt:screening'), ast_id('urt:firstaid'), ast_id('urt:cpr'), ast_id('urt:wwcc'));
update ast_user_record_types set is_self_service = true where id in (ast_id('urt:firstaid'), ast_id('urt:cpr'), ast_id('urt:licence'), ast_id('urt:orient'));
update ast_participant_information_item_defs set "order" = v.o from (values (ast_id('pii:comms'), 1), (ast_id('pii:med'), 2), (ast_id('pii:allerg'), 3), (ast_id('pii:emerg'), 4)) v(id, o) where ast_participant_information_item_defs.id = v.id;
update ast_forms set hosted_url = 'https://qzzlxhreshuxahocllwm.supabase.co/functions/v1/astalty-api/form/' || id where hosted_url is null;
update ast_forms set description = 'Internal incident report completed by staff', type = 'internal', usage = 'incident' where id = ast_id('form:incident');
update ast_forms set description = 'Public referral form linked from the website', type = 'public', usage = 'referral' where id = ast_id('form:referral');
update ast_forms set description = 'Public feedback and complaints form', type = 'public', usage = 'feedback' where id = ast_id('form:feedback');
-- the signature request is owned by the participant and requested by a staff member
update ast_signature_requests set requested_by_id = owner_id, owner_type = 'participant', owner_id = participant_id where owner_type = 'user';
-- charges: every charge carries a claim type; cancellations carry the NDIS cancellation code of their support
update ast_charges set claim_type = 'Direct' where claim_type is null;
update ast_charges c set cancellation_reason = s.cancellation_type from ast_supports s where s.id = c.support_id and c.claim_type = 'CANC' and c.cancellation_reason is distinct from s.cancellation_type;
-- internal plan implementations are provided by the account itself
update ast_plan_implementations set provider_id = ast_id('account') where provider_type = 'account' and provider_id is null;
