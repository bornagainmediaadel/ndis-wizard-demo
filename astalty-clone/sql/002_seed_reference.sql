-- Astalty clone · seed part 1: reference data, staff, participants, plans, services
-- Synthetic data only. Deterministic ids via ast_id('label') so tests can refer to them.
set session_replication_role = replica;  -- keep the change log quiet while seeding

create or replace function ast_id(label text) returns uuid
language sql immutable as $$ select uuid_generate_v5('5a7a17e0-0000-4000-8000-000000a57a17'::uuid, label) $$;

create or replace function ast_adl(d date, t time) returns timestamptz
language sql immutable as $$ select (d + t) at time zone 'Australia/Adelaide' $$;

insert into ast_account(id, name, abn, timezone) values (1, 'NDIS Wizard Test Care Co', '00 000 000 000', 'Australia/Adelaide')
on conflict (id) do update set name = excluded.name;

-- support categories (NDIS Pricing Arrangements groupings)
insert into ast_support_categories(prefix, name, "group") values
 ('01','Assistance with Daily Life','core'),
 ('02','Transport','core'),
 ('03','Consumables','core'),
 ('04','Assistance with Social, Economic and Community Participation','core'),
 ('07','Support Coordination and Psychosocial Recovery Coaches','capacity_building'),
 ('09','Increased Social and Community Participation','capacity_building'),
 ('15','Improved Daily Living','capacity_building')
on conflict (prefix) do nothing;

-- charge items (support items; prices in cents, approximate 2025-26 SA rates)
insert into ast_charge_items(id, number, reference, name, price, unit, gst_code, default_claim_type, support_category) values
 (ast_id('ci:01_011'), '01_011_0107_1_1', 'SC_WD_DAY', 'Assistance With Self-Care Activities - Standard - Weekday Daytime', 7023, 'H', 'P2', null, '01'),
 (ast_id('ci:01_015'), '01_015_0107_1_1', 'SC_WD_EVE', 'Assistance With Self-Care Activities - Standard - Weekday Evening', 7738, 'H', 'P2', null, '01'),
 (ast_id('ci:01_013'), '01_013_0107_1_1', 'SC_SAT', 'Assistance With Self-Care Activities - Standard - Saturday', 9883, 'H', 'P2', null, '01'),
 (ast_id('ci:01_014'), '01_014_0107_1_1', 'SC_SUN', 'Assistance With Self-Care Activities - Standard - Sunday', 12743, 'H', 'P2', null, '01'),
 (ast_id('ci:01_012'), '01_012_0107_1_1', 'SC_PH', 'Assistance With Self-Care Activities - Standard - Public Holiday', 15603, 'H', 'P2', null, '01'),
 (ast_id('ci:01_002'), '01_002_0107_1_1', 'SC_SLEEPOVER', 'Assistance With Self-Care Activities - Night-Time Sleepover', 28656, 'E', 'P2', null, '01'),
 (ast_id('ci:01_799'), '01_799_0107_1_1', 'TRAVEL_KM_CORE', 'Provider Travel - Non-Labour Costs (Daily Activities)', 100, 'KM', 'P2', 'TRAN', '01'),
 (ast_id('ci:04_104'), '04_104_0125_6_1', 'CA_WD_DAY', 'Access Community Social And Rec Activities - Standard - Weekday Daytime', 7023, 'H', 'P2', null, '04'),
 (ast_id('ci:04_103'), '04_103_0125_6_1', 'CA_WD_EVE', 'Access Community Social And Rec Activities - Standard - Weekday Evening', 7738, 'H', 'P2', null, '04'),
 (ast_id('ci:04_105'), '04_105_0125_6_1', 'CA_SAT', 'Access Community Social And Rec Activities - Standard - Saturday', 9883, 'H', 'P2', null, '04'),
 (ast_id('ci:04_106'), '04_106_0125_6_1', 'CA_SUN', 'Access Community Social And Rec Activities - Standard - Sunday', 12743, 'H', 'P2', null, '04'),
 (ast_id('ci:04_102'), '04_102_0125_6_1', 'CA_PH', 'Access Community Social And Rec Activities - Standard - Public Holiday', 15603, 'H', 'P2', null, '04'),
 (ast_id('ci:04_799'), '04_799_0125_6_1', 'TRAVEL_KM_CA', 'Provider Travel - Non-Labour Costs (Community Participation)', 100, 'KM', 'P2', 'TRAN', '04'),
 (ast_id('ci:07_002'), '07_002_0106_8_3', 'SUPPORT_COORD_L2', 'Level 2: Coordination Of Supports', 10014, 'H', 'P2', null, '07'),
 (ast_id('ci:07_001'), '07_001_0106_8_3', 'SUPPORT_CONN_L1', 'Level 1: Support Connection', 6756, 'H', 'P2', null, '07'),
 (ast_id('ci:15_056'), '15_056_0128_1_3', 'OT_ASSESSMENT', 'Assessment Recommendation Therapy Or Training - Occupational Therapist', 19399, 'H', 'P2', null, '15'),
 (ast_id('ci:15_037'), '15_037_0117_1_3', 'SKILL_DEV_WD', 'Individual Skill Development And Training - Standard - Weekday Daytime', 7023, 'H', 'P2', null, '15')
on conflict (id) do nothing;

insert into ast_charge_item_sets(id, name, reference, charge_rate_pattern, gst_code) values
 (ast_id('cis:core'), 'Daily personal activities (time of day)', 'CORE-TOD', 'time_of_day', 'P2'),
 (ast_id('cis:community'), 'Community access (time of day)', 'COMM-TOD', 'time_of_day', 'P2')
on conflict (id) do nothing;
insert into ast_charge_item_set_items(set_id, charge_item_id)
select ast_id('cis:core'), ast_id('ci:'||s) from unnest(array['01_011','01_015','01_013','01_014','01_012','01_002']) s
union all
select ast_id('cis:community'), ast_id('ci:'||s) from unnest(array['04_104','04_103','04_105','04_106','04_102']) s
on conflict do nothing;

-- public holidays (SA)
insert into ast_public_holiday_groups(id, name) values (ast_id('phg:sa'), 'South Australia') on conflict (id) do nothing;
insert into ast_public_holidays(id, name, date, state) values
 (ast_id('ph:2026-10-05'), 'Labour Day', '2026-10-05', 'SA'),
 (ast_id('ph:2026-12-25'), 'Christmas Day', '2026-12-25', 'SA'),
 (ast_id('ph:2026-12-26'), 'Proclamation Day', '2026-12-26', 'SA'),
 (ast_id('ph:2026-06-08'), 'King''s Birthday', '2026-06-08', 'SA')
on conflict (id) do nothing;

-- staff
insert into ast_users(id, first_name, last_name, email, mobile, employment_title, employment_basis, type, role, status, hourly_rate_cents) values
 (ast_id('user:1'),  'Saleha',  'Bokolis',   'saleha@testcareco.example',  '0400 100 001', 'Director',            'full_time', 'standard',       'admin',          'active', null),
 (ast_id('user:2'),  'Mei Lin', 'Zhao',      'meilin@testcareco.example',  '0400 100 002', 'Support Coordinator', 'full_time', 'standard',       'manager',        'active', 4600),
 (ast_id('user:3'),  'Daniel',  'Okafor',    'daniel@testcareco.example',  '0400 100 003', 'Team Leader',         'full_time', 'standard',       'manager',        'active', 4200),
 (ast_id('user:4'),  'Priya',   'Nair',      'priya@testcareco.example',   '0411 111 222', 'Support Worker',      'casual',    'support_worker', 'support-worker', 'active', 4120),
 (ast_id('user:5'),  'Tom',     'Whittaker', 'tom@testcareco.example',     '0411 111 333', 'Support Worker',      'part_time', 'support_worker', 'support-worker', 'active', 3550),
 (ast_id('user:6'),  'Aisha',   'Rahman',    'aisha@testcareco.example',   '0411 111 444', 'Support Worker',      'casual',    'support_worker', 'support-worker', 'active', 4120),
 (ast_id('user:7'),  'Liam',    'O''Connell','liam@testcareco.example',    '0411 111 555', 'Support Worker',      'full_time', 'support_worker', 'support-worker', 'active', 3550),
 (ast_id('user:8'),  'Grace',   'Nguyen',    'grace@testcareco.example',   '0411 111 666', 'Support Worker',      'casual',    'support_worker', 'support-worker', 'active', 4120),
 (ast_id('user:9'),  'Marcus',  'Bell',      'marcus@testcareco.example',  '0411 111 777', 'Support Worker',      'part_time', 'support_worker', 'support-worker', 'active', 3550),
 (ast_id('user:10'), 'Hannah',  'Kowalski',  'hannah@testcareco.example',  '0411 111 888', 'Support Worker',      'casual',    'support_worker', 'support-worker', 'active', 4120),
 (ast_id('user:11'), 'Jacob',   'Tanaka',    'jacob@testcareco.example',   '0411 111 999', 'Support Worker',      'casual',    'support_worker', 'support-worker', 'invited', 4120),
 (ast_id('user:12'), 'Fatima',  'Haddad',    'fatima@testcareco.example',  '0400 100 012', 'Finance Officer',     'part_time', 'standard',       'team-member',    'active', null)
on conflict (id) do nothing;

-- worker compliance records
insert into ast_user_record_types(id, name, expires, requires_verification, is_self_service, created_at) values
 (ast_id('urt:screening'), 'NDIS Worker Screening Check', true, true, false, '2025-01-06 00:30+00'),
 (ast_id('urt:firstaid'),  'First Aid (HLTAID011)', true, true, true, '2025-01-06 00:30+00'),
 (ast_id('urt:cpr'),       'CPR (HLTAID009)', true, true, true, '2025-01-06 00:30+00'),
 (ast_id('urt:wwcc'),      'Working With Children Check', true, true, false, '2025-01-06 00:30+00'),
 (ast_id('urt:licence'),   'Driver Licence', true, false, true, '2025-01-06 00:30+00'),
 (ast_id('urt:orient'),    'NDIS Worker Orientation Module', false, false, true, '2025-01-06 00:30+00')
on conflict (id) do nothing;

insert into ast_user_records(id, user_id, type_id, name, reference, issue_date, expiry_date)
select ast_id('ur:'||u||':'||t), ast_id('user:'||u), ast_id('urt:'||t), null, upper(left(t,2))||'-'||(100000+u*37+length(t))::text,
       case t when 'screening' then date '2024-03-01' when 'firstaid' then date '2025-02-10' when 'cpr' then date '2025-11-10' when 'wwcc' then date '2024-06-01' when 'licence' then date '2022-01-15' else date '2024-03-01' end + (u*11) * interval '1 day',
       case t when 'screening' then date '2029-03-01' when 'firstaid' then date '2028-02-10' when 'cpr' then date '2026-11-10' when 'wwcc' then date '2029-06-01' when 'licence' then date '2032-01-15' else null end + (u*11) * interval '1 day'
from generate_series(4,11) u, unnest(array['screening','firstaid','cpr','wwcc','licence','orient']) t
on conflict (id) do nothing;
-- PLANTED (P8): Hannah Kowalski's screening and first aid have expired but she is still rostered
update ast_user_records set expiry_date = '2026-09-15' where id = ast_id('ur:10:screening');
update ast_user_records set expiry_date = '2026-08-30' where id = ast_id('ur:10:firstaid');
-- Marcus's CPR expires next week (warning, not breach)
update ast_user_records set expiry_date = '2026-10-26' where id = ast_id('ur:9:cpr');

-- plan managers and organisations
insert into ast_plan_managers(id, name, invoice_email, phone, abn) values
 (ast_id('pm:1'), 'Southern Plan Management', 'invoices@southernplan.example', '08 8000 1001', '11 111 111 111'),
 (ast_id('pm:2'), 'Adelaide Plan Co', 'accounts@adelaideplanco.example', '08 8000 1002', '22 222 222 222')
on conflict (id) do nothing;

insert into ast_organisations(id, name, type, abn, email, phone, ndis_registered, registration_number) values
 (ast_id('org:1'), 'Hills Allied Health', 'allied_health', '33 333 333 333', 'reception@hillsallied.example', '08 8000 2001', true, '4050012345'),
 (ast_id('org:2'), 'Northern Behaviour Support', 'behaviour_support', '44 444 444 444', 'intake@northernbs.example', '08 8000 2002', true, '4050067890'),
 (ast_id('org:3'), 'Local Area Coordination - Adelaide South', 'lac', null, 'lac.south@example', '1800 000 000', false, null)
on conflict (id) do nothing;

insert into ast_participant_tags(id, name, colour, created_at) values
 (ast_id('tag:sil'), 'SIL', '#2563eb', '2025-01-06 00:30+00'),
 (ast_id('tag:sc'), 'Support Coordination', '#7c3aed', '2025-01-06 00:30+00'),
 (ast_id('tag:high'), 'High Priority', '#dc2626', '2025-01-06 00:30+00'),
 (ast_id('tag:new'), 'New Participant', '#059669', '2025-01-06 00:30+00')
on conflict (id) do nothing;

-- participants (14)
insert into ast_participants(id, first_name, middle_name, last_name, preferred_name, dob, mobile, email, status, primary_diagnosis, secondary_diagnosis, pronouns, gender, sex, language, ndis_number, preferred_contact_method, commencement_date, checkin_period, plan_manager_id, primary_coordinator_id, archived_at, exit_date, exit_reason) values
 (ast_id('p:1'),  'Alex',   'James',  'Marino',    'Alex',  '1998-04-12', '0420 000 001', 'alex.marino@example', 'active', 'Cerebral palsy', null, 'he/him', 'male', 'male', 'English', '430000101', 'sms', '2024-02-05', 14, ast_id('pm:1'), ast_id('user:2'), null, null, null),
 (ast_id('p:2'),  'Jordan', null,     'Whitfield', 'Jordy', '1989-11-30', '0420 000 002', 'jordan.w@example', 'active', 'Acquired brain injury', 'Epilepsy', 'they/them', 'non_binary', 'female', 'English', '430000102', 'phone', '2023-07-17', 30, null, ast_id('user:2'), null, null, null),
 (ast_id('p:3'),  'Chloe',  'Marie',  'Baptiste',  'Chloe', '1975-06-21', '0420 000 003', null, 'active', 'Multiple sclerosis', null, 'she/her', 'female', 'female', 'French', '430000103', 'phone', '2022-10-03', 14, null, ast_id('user:3'), null, null, null),
 (ast_id('p:4'),  'Ethan',  null,     'Kaur',      'Ethan', '2008-01-09', '0420 000 004', 'ethan.kaur@example', 'active', 'Autism spectrum disorder', 'ADHD', 'he/him', 'male', 'male', 'English', '430000104', 'email', '2025-01-20', 30, ast_id('pm:2'), ast_id('user:2'), null, null, null),
 (ast_id('p:5'),  'Mia',    null,     'Tran',      'Mia',   '1994-09-02', '0420 000 005', 'mia.tran@example', 'active', 'Down syndrome', null, 'she/her', 'female', 'female', 'Vietnamese', '430000105', 'sms', '2023-03-13', 14, ast_id('pm:1'), ast_id('user:3'), null, null, null),
 (ast_id('p:6'),  'Noah',   'Patrick','Fitzgerald','Noah',  '1982-02-14', '0420 000 006', 'noah.f@example', 'active', 'Spinal cord injury (T6)', null, 'he/him', 'male', 'male', 'English', '430000106', 'email', '2021-11-01', 30, null, ast_id('user:2'), null, null, null),
 (ast_id('p:7'),  'Zara',   null,     'Hussain',   'Zara',  '2001-12-25', '0420 000 007', 'zara.h@example', 'active', 'Intellectual disability', 'Anxiety', 'she/her', 'female', 'female', 'Urdu', '430000107', 'sms', '2024-08-12', 14, null, ast_id('user:3'), null, null, null),
 (ast_id('p:8'),  'Oliver', null,     'Petrov',    'Ollie', '1990-05-05', '0420 000 008', 'oliver.p@example', 'active', 'Schizophrenia', null, 'he/him', 'male', 'male', 'English', '430000108', 'phone', '2024-04-01', 7, ast_id('pm:2'), ast_id('user:2'), null, null, null),
 (ast_id('p:9'),  'Isla',   'Rose',   'McKenzie',  'Isla',  '2012-03-18', '0420 000 009', 'parent.mckenzie@example', 'active', 'Global developmental delay', null, 'she/her', 'female', 'female', 'English', '430000109', 'email', '2025-06-16', 30, ast_id('pm:1'), ast_id('user:3'), null, null, null),
 (ast_id('p:10'), 'Lucas',  null,     'Abara',     'Lucas', '1969-08-08', '0420 000 010', null, 'active', 'Stroke (left hemiparesis)', 'Type 2 diabetes', 'he/him', 'male', 'male', 'English', '430000110', 'phone', '2023-09-04', 14, null, ast_id('user:2'), null, null, null),
 (ast_id('p:11'), 'Sophie', null,     'Lindqvist', 'Soph',  '1996-10-10', '0420 000 011', 'sophie.l@example', 'active', 'Muscular dystrophy', null, 'she/her', 'female', 'female', 'English', '430000111', 'sms', '2024-10-01', 14, ast_id('pm:1'), ast_id('user:2'), null, null, null),
 (ast_id('p:12'), 'Kai',    null,     'Nakamura',  'Kai',   '1987-07-07', '0420 000 012', 'kai.n@example', 'archived', 'Bipolar disorder', null, 'he/him', 'male', 'male', 'Japanese', '430000112', 'email', '2022-05-02', 30, null, ast_id('user:3'), '2026-07-31 02:00+00', '2026-07-31', 'Moved interstate'),
 (ast_id('p:13'), 'Ruby',   'Anne',   'Delacroix', 'Ruby',  '2004-02-29', '0420 000 013', 'ruby.d@example', 'active', 'Autism spectrum disorder', null, 'she/her', 'female', 'female', 'English', '430000113', 'sms', '2025-11-03', 14, ast_id('pm:2'), ast_id('user:2'), null, null, null),
 (ast_id('p:14'), 'Harper', null,     'Osei',      'Harper','1999-01-01', '0420 000 014', 'harper.o@example', 'active', 'Psychosocial disability', null, 'they/them', 'non_binary', 'female', 'English', '430000114', 'sms', '2026-09-28', 7, ast_id('pm:1'), ast_id('user:2'), null, null, null)
on conflict (id) do nothing;

insert into ast_participant_tag_links(participant_id, tag_id) values
 (ast_id('p:1'), ast_id('tag:sc')), (ast_id('p:3'), ast_id('tag:high')), (ast_id('p:8'), ast_id('tag:sc')), (ast_id('p:8'), ast_id('tag:high')),
 (ast_id('p:14'), ast_id('tag:new')), (ast_id('p:13'), ast_id('tag:sc')), (ast_id('p:6'), ast_id('tag:sc'))
on conflict do nothing;

insert into ast_participant_addresses(id, participant_id, type, label, address_1, suburb, state, postcode)
select ast_id('addr:'||n), ast_id('p:'||n), 'home', 'Home', a, s, 'SA', pc from (values
 (1,'12 Jetty Road','Glenelg','5045'),(2,'4/88 Prospect Road','Prospect','5082'),(3,'27 Marion Road','Plympton','5038'),
 (4,'9 Beach Street','Grange','5022'),(5,'61 Henley Beach Road','Mile End','5031'),(6,'3 Oaklands Road','Warradale','5046'),
 (7,'140 Main North Road','Blair Athol','5084'),(8,'15 Semaphore Road','Semaphore','5019'),(9,'22 Mount Barker Road','Stirling','5152'),
 (10,'7 Diagonal Road','Oaklands Park','5046'),(11,'33 Magill Road','Norwood','5067'),(12,'1 Gouger Street','Adelaide','5000'),
 (13,'18 Payneham Road','Stepney','5069'),(14,'5 Port Road','Hindmarsh','5007')) v(n,a,s,pc)
on conflict (id) do nothing;

insert into ast_participant_alerts(id, participant_id, title, content, type) values
 (ast_id('alert:1'), ast_id('p:1'), 'Mobility', 'Uses a powered wheelchair. Hoist transfer required for showering (two-person assist).', 'warning'),
 (ast_id('alert:2'), ast_id('p:2'), 'Seizure plan', 'Epilepsy management plan on file. Rescue medication in the kitchen cupboard.', 'critical'),
 (ast_id('alert:3'), ast_id('p:3'), 'Falls risk', 'Two falls in the last 60 days. Use walker at all times.', 'warning'),
 (ast_id('alert:4'), ast_id('p:8'), 'Behaviour support', 'Behaviour support plan in place. Call Mei Lin before any unplanned change to routine.', 'warning'),
 (ast_id('alert:5'), ast_id('p:10'), 'Diabetes', 'Blood glucose before meals; log in the notes.', 'info')
on conflict (id) do nothing;

insert into ast_contacts(id, first_name, last_name, email, mobile, occupation, organisation_id) values
 (ast_id('c:1'), 'Teresa', 'Marino', 'teresa.marino@example', '0430 000 001', 'Parent', null),
 (ast_id('c:2'), 'Sam', 'Whitfield', 'sam.w@example', '0430 000 002', 'Sibling', null),
 (ast_id('c:3'), 'Dr Anita', 'Rao', 'arao@hillsallied.example', '0430 000 003', 'Occupational Therapist', ast_id('org:1')),
 (ast_id('c:4'), 'Ben', 'Carver', 'bcarver@northernbs.example', '0430 000 004', 'Behaviour Support Practitioner', ast_id('org:2')),
 (ast_id('c:5'), 'Fiona', 'McKenzie', 'parent.mckenzie@example', '0430 000 005', 'Parent', null),
 (ast_id('c:6'), 'Leah', 'Osei', 'leah.osei@example', '0430 000 006', 'Parent', null)
on conflict (id) do nothing;
insert into ast_participant_contacts(participant_id, contact_id, relationship, starred, consent) values
 (ast_id('p:1'), ast_id('c:1'), 'Mother / nominee', true, true), (ast_id('p:1'), ast_id('c:3'), 'Occupational therapist', false, true),
 (ast_id('p:2'), ast_id('c:2'), 'Brother', true, true), (ast_id('p:8'), ast_id('c:4'), 'Behaviour support practitioner', true, true),
 (ast_id('p:9'), ast_id('c:5'), 'Mother / nominee', true, true), (ast_id('p:14'), ast_id('c:6'), 'Mother', true, null)
on conflict do nothing;

-- NDIS plans (one current plan each; Sophie's ended 30 Sep - PLANTED P6; Kai archived)
insert into ast_ndis_plans(id, participant_id, "start", "end", is_pace, total_funded_supports) values
 (ast_id('plan:1'),  ast_id('p:1'),  '2026-02-01', '2027-01-31', true, 14200000),
 (ast_id('plan:2'),  ast_id('p:2'),  '2026-04-15', '2027-04-14', true,  8800000),
 (ast_id('plan:3'),  ast_id('p:3'),  '2025-11-01', '2026-10-31', true,  9600000),
 (ast_id('plan:4'),  ast_id('p:4'),  '2026-01-20', '2027-01-19', true,  6100000),
 (ast_id('plan:5'),  ast_id('p:5'),  '2026-03-01', '2027-02-28', true,  7300000),
 (ast_id('plan:6'),  ast_id('p:6'),  '2026-06-01', '2027-05-31', true, 11800000),
 (ast_id('plan:7'),  ast_id('p:7'),  '2026-08-12', '2027-08-11', true,  5200000),
 (ast_id('plan:8'),  ast_id('p:8'),  '2026-04-01', '2027-03-31', true,  6900000),
 (ast_id('plan:9'),  ast_id('p:9'),  '2026-06-16', '2027-06-15', true,  4400000),
 (ast_id('plan:10'), ast_id('p:10'), '2026-09-01', '2027-08-31', true,  9100000),
 (ast_id('plan:11'), ast_id('p:11'), '2025-10-01', '2026-09-30', true,  8200000),
 (ast_id('plan:12'), ast_id('p:12'), '2025-05-01', '2026-04-30', false, 4100000),
 (ast_id('plan:13'), ast_id('p:13'), '2025-11-03', '2026-11-02', true,  5600000),
 (ast_id('plan:14'), ast_id('p:14'), '2026-09-28', '2027-09-27', true,  4800000)
on conflict (id) do nothing;

-- plan budgets by category
insert into ast_plan_budgets(id, plan_id, support_category, amount, management_type, stated, description)
select ast_id('pb:'||n||':'||cat), ast_id('plan:'||n), cat, amt, mt, cat='07', null from (values
 (1,'01',9000000,'plan'),(1,'04',3200000,'plan'),(1,'07',1200000,'plan'),(1,'15',800000,'plan'),
 (2,'01',4000000,'self'),(2,'04',2800000,'self'),(2,'07',1000000,'self'),(2,'15',1000000,'self'),
 (3,'01',7000000,'ndia'),(3,'04',1800000,'ndia'),(3,'15',800000,'ndia'),
 (4,'04',3600000,'plan'),(4,'07',1000000,'plan'),(4,'15',1500000,'plan'),
 (5,'01',3000000,'plan'),(5,'04',3300000,'plan'),(5,'07',1000000,'plan'),
 (6,'01',8800000,'self'),(6,'04',1500000,'self'),(6,'07',1500000,'self'),
 (7,'04',3200000,'ndia'),(7,'07',1000000,'ndia'),(7,'15',1000000,'ndia'),
 (8,'01',1800000,'plan'),(8,'04',3000000,'plan'),(8,'07',1400000,'plan'),(8,'15',700000,'plan'),
 (9,'04',2400000,'plan'),(9,'15',2000000,'plan'),
 (10,'01',6500000,'ndia'),(10,'04',1600000,'ndia'),(10,'07',1000000,'ndia'),
 (11,'01',5200000,'plan'),(11,'04',2000000,'plan'),(11,'07',1000000,'plan'),
 (12,'04',2600000,'self'),(12,'07',1500000,'self'),
 (13,'04',2800000,'plan'),(13,'07',1300000,'plan'),(13,'15',1500000,'plan'),
 (14,'04',2400000,'plan'),(14,'07',1400000,'plan'),(14,'15',1000000,'plan')) v(n,cat,amt,mt)
on conflict (id) do nothing;

-- services (service agreements). Harper (14) has none yet - PLANTED P7.
insert into ast_services(id, plan_id, participant_id, name, amount, management_type, type, support_category, service_coordinator_id, "start", "end")
select ast_id('svc:'||n||':'||kind), ast_id('plan:'||n), ast_id('p:'||n), nm, amt, mt, 'scheduled_service', cat, ast_id('user:2'), s, e from (values
 (1,'core','Daily personal activities', 8600000,'plan','01','2026-02-01','2027-01-31'),
 (1,'community','Community access', 3000000,'plan','04','2026-02-01','2027-01-31'),
 (1,'sc','Support coordination (Level 2)', 1200000,'plan','07','2026-02-01','2027-01-31'),
 (2,'core','Daily personal activities', 3800000,'self','01','2026-04-15','2027-04-14'),
 (2,'community','Community access', 2600000,'self','04','2026-04-15','2027-04-14'),
 (2,'sc','Support coordination (Level 2)', 1000000,'self','07','2026-04-15','2027-04-14'),
 (3,'core','Daily personal activities', 6800000,'ndia','01','2025-11-01','2026-10-31'),
 (3,'community','Community access', 1600000,'ndia','04','2025-11-01','2026-10-31'),
 (4,'community','Community access', 3400000,'plan','04','2026-01-20','2027-01-19'),
 (4,'sc','Support coordination (Level 2)', 1000000,'plan','07','2026-01-20','2027-01-19'),
 (5,'core','Daily personal activities', 2900000,'plan','01','2026-03-01','2027-02-28'),
 (5,'community','Community access', 3100000,'plan','04','2026-03-01','2027-02-28'),
 (5,'sc','Support coordination (Level 2)', 1000000,'plan','07','2026-03-01','2027-02-28'),
 (6,'core','Daily personal activities', 8500000,'self','01','2026-06-01','2027-05-31'),
 (6,'sc','Support coordination (Level 2)', 1500000,'self','07','2026-06-01','2027-05-31'),
 (7,'community','Community access', 3000000,'ndia','04','2026-08-12','2027-08-11'),
 (7,'sc','Support coordination (Level 1)', 1000000,'ndia','07','2026-08-12','2027-08-11'),
 (8,'core','Daily personal activities', 1700000,'plan','01','2026-04-01','2027-03-31'),
 (8,'community','Community access', 300000,'plan','04','2026-04-01','2027-03-31'),
 (8,'sc','Support coordination (Level 2)', 1400000,'plan','07','2026-04-01','2027-03-31'),
 (9,'community','Community access', 2200000,'plan','04','2026-06-16','2027-06-15'),
 (10,'core','Daily personal activities', 6200000,'ndia','01','2026-09-01','2027-08-31'),
 (10,'community','Community access', 1500000,'ndia','04','2026-09-01','2027-08-31'),
 (10,'sc','Support coordination (Level 2)', 1000000,'ndia','07','2026-09-01','2027-08-31'),
 (11,'core','Daily personal activities', 5000000,'plan','01','2025-10-01','2026-09-30'),
 (11,'community','Community access', 1900000,'plan','04','2025-10-01','2026-09-30'),
 (11,'sc','Support coordination (Level 2)', 1000000,'plan','07','2025-10-01','2026-09-30'),
 (12,'community','Community access', 2400000,'self','04','2025-05-01','2026-04-30'),
 (13,'community','Community access', 2600000,'plan','04','2025-11-03','2026-11-02'),
 (13,'sc','Support coordination (Level 2)', 1300000,'plan','07','2025-11-03','2026-11-02')) v(n,kind,nm,amt,mt,cat,s,e)
on conflict (id) do nothing;
-- PLANTED (P13): Oliver's community access agreement is only $3,000; charges will exceed it.

insert into ast_service_charge_item_sets(service_id, set_id)
select id, case when support_category='01' then ast_id('cis:core') else ast_id('cis:community') end from ast_services where support_category in ('01','04')
on conflict do nothing;
insert into ast_service_charge_items(service_id, charge_item_id)
select id, case when name like '%Level 1%' then ast_id('ci:07_001') else ast_id('ci:07_002') end from ast_services where support_category='07'
on conflict do nothing;
insert into ast_service_charge_items(service_id, charge_item_id)
select id, case when support_category='01' then ast_id('ci:01_799') else ast_id('ci:04_799') end from ast_services where support_category in ('01','04')
on conflict do nothing;

-- internal budgets (one per participant with a core or community service)
insert into ast_budgets(id, participant_id, plan_id, name, type, "start", "end", total)
select ast_id('bud:'||n), ast_id('p:'||n), ast_id('plan:'||n), 'Schedule of supports '||to_char(p."start",'Mon YYYY')||' – '||to_char(p."end",'Mon YYYY'), 'internal', p."start", p."end",
       (select coalesce(sum(amount),0) from ast_services s where s.participant_id = ast_id('p:'||n))
from generate_series(1,14) n join ast_ndis_plans p on p.id = ast_id('plan:'||n)
where exists (select 1 from ast_services s where s.participant_id = ast_id('p:'||n))
on conflict (id) do nothing;
insert into ast_budget_items(id, budget_id, charge_item_id, name, number, price, unit_price, quantity, unit, period, total, "start", "end")
select ast_id('bi:'||s.id::text), ast_id('bud:'||n), ci.id, ci.name, ci.number, ci.price, ci.price,
       round(s.amount::numeric / ci.price / 52, 2), 'H', 'week', s.amount, s."start", s."end"
from ast_services s join generate_series(1,14) n on s.participant_id = ast_id('p:'||n) join ast_participants p on p.id = s.participant_id
join ast_charge_items ci on ci.id = case s.support_category when '01' then ast_id('ci:01_011') when '04' then ast_id('ci:04_104') when '07' then (case when s.name like '%Level 1%' then ast_id('ci:07_001') else ast_id('ci:07_002') end) end
on conflict (id) do nothing;

-- goals
insert into ast_goals(id, participant_id, name, description, status, goal_type, barriers, achievement_strategy)
select ast_id('goal:'||n||':'||i), ast_id('p:'||n), g, d, st, gt, b, a from (values
 (1,1,'Build independence with morning routine','Alex wants to need less hands-on help getting ready in the mornings.','in_progress','medium_term','Fatigue on cold mornings','Graded prompting; OT review of bathroom setup'),
 (1,2,'Get to the gym twice a week','Attend the accessible gym at Marion with support.','in_progress','short_term','Transport availability','Book the same worker for consistency'),
 (2,1,'Return to part-time study','Enrol in a TAFE short course by mid 2027.','in_progress','long_term','Memory and planning after ABI','Weekly planning session with support coordinator'),
 (3,1,'Stay safe at home','Reduce falls and keep living in her own unit.','in_progress','long_term','Progressive MS symptoms','Walker use, home mods referral, falls diary'),
 (4,1,'Make a friend outside school','Join a social group with support.','in_progress','medium_term','Anxiety in new groups','Start with the Saturday youth group, one hour at a time'),
 (5,1,'Learn to catch the bus to work','Travel training route from Mile End to the city.','in_progress','short_term',null,'Worker shadows then fades'),
 (6,1,'Manage personal care with fewer hours','Trial new equipment to cut shower time.','in_progress','medium_term',null,'OT equipment trial'),
 (7,1,'Cook two meals a week','Build cooking skills in a small group.','in_progress','short_term',null,'Tuesday cooking group'),
 (8,1,'Keep the tenancy stable','No missed rent, keep appointments with the housing officer.','in_progress','long_term','Episodes of low mood','Weekly check-in, BSP strategies'),
 (9,1,'Join a sport','Try two community sports this term.','in_progress','short_term',null,'Saturday morning sessions'),
 (10,1,'Walk to the letterbox unaided','Strength and balance after stroke.','in_progress','medium_term','Fatigue','Daily exercise program from physio'),
 (11,1,'Attend uni two days a week','Maintain enrolment with personal care support on campus.','in_progress','long_term',null,'Campus personal care roster'),
 (13,1,'Start a casual job','Explore supported employment.','in_progress','long_term','Sensory overload','Short work trials'),
 (14,1,'Settle into supports','Build trust with a small team of workers.','in_progress','short_term','New to NDIS','Two consistent workers, weekly check-in')) v(n,i,g,d,st,gt,b,a)
on conflict (id) do nothing;
insert into ast_goal_plans(goal_id, plan_id) select g.id, p.id from ast_goals g join ast_ndis_plans p on p.participant_id = g.participant_id on conflict do nothing;

-- sites
insert into ast_sites(id, name, type, description, capacity, default_support_type, site_manager_id, address_id, address_1, suburb, state, postcode, lat, lng, traditional_place_name) values
 (ast_id('site:1'), 'Semaphore SIL house', 'sil_house', 'Three-bedroom SIL house', 3, 'supported_independent_living', ast_id('user:3'), ast_id('addr:site:1'), '15 Semaphore Road', 'Semaphore', 'SA', '5019', '-34.8393', '138.4817', 'Kaurna Country'),
 (ast_id('site:2'), 'Mile End hub', 'other', 'Group programs and cooking kitchen', 12, 'group_support', ast_id('user:3'), ast_id('addr:site:2'), '61 Henley Beach Road', 'Mile End', 'SA', '5031', '-34.9289', '138.5716', 'Kaurna Country')
on conflict (id) do nothing;

-- document categories, participant record types, information items
insert into ast_document_categories(id, name) values
 (ast_id('dc:plan'), 'NDIS Plan'), (ast_id('dc:sa'), 'Service Agreement'), (ast_id('dc:consent'), 'Consent'),
 (ast_id('dc:report'), 'Allied Health Report'), (ast_id('dc:bsp'), 'Behaviour Support Plan'), (ast_id('dc:id'), 'Identification')
on conflict (id) do nothing;
insert into ast_participant_record_types(id, name, expires, requires_documents) values
 (ast_id('prt:plan'), 'NDIS Plan', true, true), (ast_id('prt:sa'), 'Signed Service Agreement', true, true),
 (ast_id('prt:consent'), 'Consent to share information', true, true), (ast_id('prt:bsp'), 'Behaviour Support Plan', true, true),
 (ast_id('prt:medplan'), 'Medication / health plan', true, false)
on conflict (id) do nothing;
insert into ast_participant_information_item_defs(id, name, required, documents_allowed, visible_to_support_workers, "order", created_at) values
 (ast_id('pii:comms'), 'Communication preferences', true, false, true, 1, '2025-01-06 00:30+00'), (ast_id('pii:med'), 'Medications', true, true, true, 2, '2025-01-06 00:30+00'),
 (ast_id('pii:allerg'), 'Allergies', true, false, true, 3, '2025-01-06 00:30+00'), (ast_id('pii:emerg'), 'Emergency plan', false, true, true, 4, '2025-01-06 00:30+00')
on conflict (id) do nothing;

-- participant records: plan + signed service agreement for everyone with a service; consent for most
insert into ast_participant_records(id, participant_id, type_id, name, reference, issue_date, expiry_date)
select ast_id('pr:'||n||':plan'), ast_id('p:'||n), ast_id('prt:plan'), 'NDIS plan', 'PLAN-'||n, p."start", p."end" from generate_series(1,14) n join ast_ndis_plans p on p.id = ast_id('plan:'||n)
union all
select ast_id('pr:'||n||':sa'), ast_id('p:'||n), ast_id('prt:sa'), 'Service agreement', 'SA-2026-'||lpad(n::text,3,'0'), p."start", p."end" from generate_series(1,13) n join ast_ndis_plans p on p.id = ast_id('plan:'||n)
union all
select ast_id('pr:'||n||':consent'), ast_id('p:'||n), ast_id('prt:consent'), 'Consent to share information', null, p."start", p."start" + interval '2 years' from generate_series(1,14) n join ast_ndis_plans p on p.id = ast_id('plan:'||n) where n <> 13
on conflict (id) do nothing;
-- PLANTED (P15): Ruby's consent expired and her service agreement was never signed
insert into ast_participant_records(id, participant_id, type_id, name, reference, issue_date, expiry_date) values
 (ast_id('pr:13:consent'), ast_id('p:13'), ast_id('prt:consent'), 'Consent to share information', null, '2024-09-01', '2026-09-01') on conflict (id) do nothing;
insert into ast_signature_requests(id, title, owner_type, owner_id, requested_by_id, participant_id, platform, status, is_test, expires_at, created_at) values
 (ast_id('sig:13'), 'Service Agreement 2025-26 - Ruby Delacroix', 'participant', ast_id('p:13'), ast_id('user:2'), ast_id('p:13'), 'docusign', 'expired', false, '2025-12-03 00:00+00', '2025-11-03 03:00+00'),
 (ast_id('sig:14'), 'Service Agreement 2026-27 - Harper Osei', 'participant', ast_id('p:14'), ast_id('user:2'), ast_id('p:14'), 'docusign', 'awaiting_signatures', false, '2026-10-28 00:00+00', '2026-09-28 03:00+00'),
 (ast_id('sig:10'), 'Service Agreement 2026-27 - Lucas Abara', 'participant', ast_id('p:10'), ast_id('user:2'), ast_id('p:10'), 'docusign', 'completed', false, null, '2026-08-25 03:00+00')
on conflict (id) do nothing;

insert into ast_documents(id, documentable_type, documentable_id, category_id, name, file_extension, size_bytes)
select ast_id('doc:'||n||':plan'), 'participant', ast_id('p:'||n), ast_id('dc:plan'), 'NDIS Plan '||n||'.pdf', 'pdf', 180000 + n*1000 from generate_series(1,14) n
union all
select ast_id('doc:'||n||':sa'), 'participant', ast_id('p:'||n), ast_id('dc:sa'), 'Signed service agreement.pdf', 'pdf', 220000 + n*1000 from generate_series(1,12) n
union all
select ast_id('doc:8:bsp'), 'participant', ast_id('p:8'), ast_id('dc:bsp'), 'Behaviour Support Plan - Petrov (2026).pdf', 'pdf', 540000
union all
select ast_id('doc:1:ot'), 'participant', ast_id('p:1'), ast_id('dc:report'), 'OT functional assessment - Marino.pdf', 'pdf', 310000
on conflict (id) do nothing;

insert into ast_participant_information_items(id, participant_id, def_id, detail)
select ast_id('piiv:'||n||':'||d), ast_id('p:'||n), ast_id('pii:'||d), v from (values
 (1,'comms','Speaks clearly; prefers texts to calls.'),(1,'med','Baclofen 10mg twice daily (self-administers).'),(1,'allerg','Nil known.'),
 (2,'comms','Give one instruction at a time; write things down.'),(2,'med','Levetiracetam 500mg BD. Midazolam rescue - see seizure plan.'),(2,'allerg','Penicillin.'),
 (3,'comms','English is her second language; speak slowly.'),(3,'med','See medication chart.'),(3,'allerg','Nil known.'),
 (8,'comms','Phone call before every visit.'),(8,'med','Managed by GP; worker does not handle medication.'),(8,'allerg','Nil known.'),
 (10,'comms','Hard of hearing (left).'),(10,'med','Metformin 500mg with meals.'),(10,'allerg','Sulfa drugs.')) v(n,d,v)
on conflict do nothing;

-- note templates and forms
insert into ast_note_templates(id, name, content, usage) values
 (ast_id('nt:shift'), 'Shift note', 'Shift <start>–<end>. Supports provided: ... Participant wellbeing: ... Progress toward goals: ... Follow up: ...', 'support_notes'),
 (ast_id('nt:sc'), 'Support coordination contact', 'Contact type: ... Discussed: ... Actions: ... Time spent: ... min', 'task_notes')
on conflict (id) do nothing;
insert into ast_forms(id, name, description, type, usage, status, hosted_url, created_at) values
 (ast_id('form:incident'), 'Incident report', 'Internal incident report completed by staff', 'internal', 'incident', 'published', 'https://qzzlxhreshuxahocllwm.supabase.co/functions/v1/astalty-api/form/'||ast_id('form:incident'), '2025-01-06 00:30+00'),
 (ast_id('form:referral'), 'Referral form', 'Public referral form linked from the website', 'public', 'referral', 'published', 'https://qzzlxhreshuxahocllwm.supabase.co/functions/v1/astalty-api/form/'||ast_id('form:referral'), '2025-01-06 00:30+00'),
 (ast_id('form:feedback'), 'Feedback and complaints', 'Public feedback and complaints form', 'public', 'feedback', 'published', 'https://qzzlxhreshuxahocllwm.supabase.co/functions/v1/astalty-api/form/'||ast_id('form:feedback'), '2025-01-06 00:30+00')
on conflict (id) do nothing;

reset session_replication_role;
select (select count(*) from ast_users) users, (select count(*) from ast_participants) participants, (select count(*) from ast_services) services, (select count(*) from ast_charge_items) charge_items, (select count(*) from ast_budget_items) budget_items;
