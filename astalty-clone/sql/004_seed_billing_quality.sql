-- Astalty clone · seed part 3: planted billing errors, invoices, payments, incidents, complaints, risks, API keys
-- Synthetic data only. Run after 003_seed_delivery.sql.

-- ---------------------------------------------------------------- planted errors applied BEFORE invoicing
-- P1: Alex's Saturday 26 Sep community support charged at the weekday daytime rate
update ast_charges set charge_item_id = ast_id('ci:04_104'), unit_cost = 7023, total_cost = round(quantity * 7023)
 where id = ast_id('chg:'||ast_id('sup:1:2026-09-26:09:00:00')::text);
-- P2: Mia's 24 Sep community support charged twice
insert into ast_charges(id, participant_id, charge_item_id, service_id, source, support_id, date, quantity, unit_cost, total_cost, status, created_at)
select ast_id('chg-dup:'||id::text), participant_id, charge_item_id, service_id, source, support_id, date, quantity, unit_cost, total_cost, status, created_at + interval '1 minute'
  from ast_charges where id = ast_id('chg:'||ast_id('sup:5:2026-09-24:09:00:00')::text)
on conflict (id) do nothing;
-- P4: Jordan's 29 Sep support charged 4 hours for a 2 hour shift
update ast_charges set quantity = 4.00, total_cost = 4 * unit_cost where id = ast_id('chg:'||ast_id('sup:2:2026-09-29:16:00:00')::text);
-- P14: Liam claimed 48 km on 10 Oct against 20 km approved
update ast_travels set approved_distance = 20, approved_duration = 40, actual_distance = 48, actual_duration = 70, odometer_end = odometer_start + 48
 where id = ast_id('trv:'||ast_id('sup:4:2026-10-10:09:30:00')::text);
update ast_charges set quantity = 48, total_cost = 4800 where id = ast_id('chgkm:'||ast_id('sup:4:2026-10-10:09:30:00')::text);
-- P5: Tom's 14 Oct shift with Oliver has a clock-in but no clock-out
update ast_shifts set clock_out_at = null where id = ast_id('shift:8:2026-10-14:10:00:00');
-- P10: a poor-quality progress note (Grace, Jordan, Sat 10 Oct)
update ast_notes set content = 'Jordan was being difficult today and refused to do anything so we just sat there. Nothing else to report.'
 where id = ast_id('note:'||ast_id('sup:2:2026-10-10:10:00:00')::text);
-- P11b: a note describing an unreported incident (Priya, Mia, Wed 14 Oct) with no incident record
update ast_notes set content = 'Shift 6:30am–7:30am. Mia slipped getting out of the shower and landed on her knee. No visible injury and she said she was fine, so we carried on with the routine. Did not call anyone.'
 where id = ast_id('note:'||ast_id('sup:5:2026-10-14:06:30:00')::text);
-- P18: Priya rostered to two overlapping shifts on Wed 21 Oct (Alex 07:30–10:00 and this one)
insert into ast_supports(id, participant_id, service_id, support_type, start_time, end_time, timezone, details, status, created_at) values
 (ast_id('sup:9:2026-10-21:09:00:00'), ast_id('p:9'), ast_id('svc:9:community'), 'community_access', ast_adl('2026-10-21','09:00'), ast_adl('2026-10-21','11:00'), 'Australia/Adelaide', 'School holiday outing', 'scheduled', now())
on conflict (id) do nothing;
insert into ast_shifts(id, user_id, support_id, event_type, name, start_time, end_time, timezone, status, created_at) values
 (ast_id('shift:9:2026-10-21:09:00:00'), ast_id('user:4'), ast_id('sup:9:2026-10-21:09:00:00'), 'support', 'Isla · School holiday outing', ast_adl('2026-10-21','09:00'), ast_adl('2026-10-21','11:00'), 'Australia/Adelaide', 'published', now())
on conflict (id) do nothing;
-- P8 (cont.): Hannah is still rostered next week despite expired screening - nothing to do, the generator already rostered her.

-- ---------------------------------------------------------------- invoice batches and invoices
insert into ast_invoice_batches(id, reference, status, invoice_sending_behaviour, "start", "end", charge_type, management_types, finalised_at, created_at) values
 (ast_id('batch:1'), 'BATCH-2026-09A', 'finalised', 'send_automatically', '2026-09-07', '2026-09-20', null, array['plan','self','ndia'], ast_adl('2026-09-22','10:15'), ast_adl('2026-09-22','09:40')),
 (ast_id('batch:2'), 'BATCH-2026-09B', 'finalised', 'send_automatically', '2026-09-21', '2026-10-04', null, array['plan','self','ndia'], ast_adl('2026-10-06','10:05'), ast_adl('2026-10-06','09:30')),
 (ast_id('batch:3'), 'BATCH-2026-10A', 'draft', 'do_not_send_automatically', '2026-10-05', '2026-10-18', null, array['plan','self','ndia'], null, ast_adl('2026-10-19','08:50'))
on conflict (id) do nothing;

with periods as (
  select 1 as n, date '2026-09-07' s, date '2026-09-20' e union all
  select 2, '2026-09-21', '2026-10-04' union all
  select 3, '2026-10-05', '2026-10-18'
), agg as (
  select pr.n, c.participant_id, s.management_type, sum(c.total_cost) total
  from ast_charges c join ast_services s on s.id = c.service_id join periods pr on c.date between pr.s and pr.e
  where c.invoice_id is null
  group by pr.n, c.participant_id, s.management_type
), numbered as (
  select *, row_number() over (order by n, participant_id, management_type) rn from agg
)
insert into ast_invoices(id, number, participant_id, plan_manager_id, batch_id, management_type, date, due_date, total, status, sent_at, created_at)
select ast_id('inv:'||n||':'||participant_id::text||':'||management_type), 'INV-2026-'||lpad((100 + rn)::text, 4, '0'), participant_id,
       case when management_type = 'plan' then p.plan_manager_id end, ast_id('batch:'||n), management_type,
       pr.e + 2, pr.e + 16, total,
       case n when 1 then 'paid' when 2 then 'issued' else 'draft' end,
       case when n < 3 then ast_adl(pr.e + 2, '10:30') end, ast_adl(pr.e + 2, '09:45')
from numbered join periods pr using (n) join ast_participants p on p.id = numbered.participant_id
on conflict (id) do nothing;

update ast_charges c set invoice_id = i.id, status = case when i.status = 'paid' then 'paid' else 'invoiced' end
from ast_services s, ast_invoices i, (select 1 as n, date '2026-09-07' s, date '2026-09-20' e union all select 2, '2026-09-21', '2026-10-04' union all select 3, '2026-10-05', '2026-10-18') pr
where s.id = c.service_id and c.invoice_id is null and c.date between pr.s and pr.e
  and i.id = ast_id('inv:'||pr.n||':'||c.participant_id::text||':'||s.management_type);

-- payments: period 1 paid in full, period 2 partly paid for plan-managed invoices
insert into ast_invoice_payment_allocations(id, invoice_id, amount, payment_date, reference, created_at)
select ast_id('pay:'||id::text), id, total, date + 9, 'EFT '||number, ast_adl(date + 9, '14:00') from ast_invoices where batch_id = ast_id('batch:1')
union all
select ast_id('pay:'||id::text), id, round(total * 0.6), date + 7, 'Part payment '||number, ast_adl(date + 7, '14:00') from ast_invoices where batch_id = ast_id('batch:2') and management_type = 'plan' and abs(hashtext(id::text)) % 2 = 0
on conflict (id) do nothing;
update ast_invoices i set status = 'part_paid' where batch_id = ast_id('batch:2') and exists (select 1 from ast_invoice_payment_allocations a where a.invoice_id = i.id);

-- ---------------------------------------------------------------- planted errors applied AFTER invoicing
-- P3: Ethan's period-2 invoice total is two hours more than its charges
update ast_invoices set total = total + 14046 where id = ast_id('inv:2:'||ast_id('p:4')::text||':plan');
-- P16: Chloe is NDIA managed but her period-2 invoice went out as plan managed with no plan manager
update ast_invoices set management_type = 'plan', plan_manager_id = null where id = ast_id('inv:2:'||ast_id('p:3')::text||':ndia');
-- P13: Oliver's community access agreement ($3,000) is exceeded by the invoiced charges (data already does this; nothing to do)
-- P6: Sophie's plan and services ended 30 Sep, period-3 charges are against an expired service (data already does this)
-- P7: Harper's supports have no service, so her charges stay uninvoiced (data already does this)
-- P17: Oliver's 13 Oct support coordination task is billable, completed and unbilled (data already does this)

-- ---------------------------------------------------------------- plan implementations, check-ins
insert into ast_plan_implementations(id, plan_id, plan_budget_id, status, amount, frequency, description, implemented_at, is_internal, provider_type, provider_id, provider_name)
select ast_id('impl:'||s.id::text), s.plan_id, pb.id, 'active', s.amount, 'weekly', s.name, s."start", true, 'account', null, 'NDIS Wizard Test Care Co'
from ast_services s left join ast_plan_budgets pb on pb.plan_id = s.plan_id and pb.support_category = s.support_category
on conflict (id) do nothing;
insert into ast_plan_implementations(id, plan_id, plan_budget_id, status, amount, frequency, description, implemented_at, is_internal, provider_type, provider_id, provider_name) values
 (ast_id('impl:1:ot'), ast_id('plan:1'), ast_id('pb:1:15'), 'active', 800000, 'as_needed', 'OT assessment and equipment review', '2026-03-10', false, 'organisation', ast_id('org:1'), 'Hills Allied Health'),
 (ast_id('impl:8:bs'), ast_id('plan:8'), ast_id('pb:8:15'), 'active', 700000, 'monthly', 'Behaviour support plan and training', '2026-05-02', false, 'organisation', ast_id('org:2'), 'Northern Behaviour Support'),
 (ast_id('impl:14:15'), ast_id('plan:14'), ast_id('pb:14:15'), 'pending', 1000000, null, 'Psychology - provider to be chosen', null, false, null, null, null)
on conflict (id) do nothing;

insert into ast_participant_checkins(id, participant_id, type, date)
select ast_id('chk:'||n), ast_id('p:'||n), (array['phone','sms','face to face','email'])[1 + (n % 4)], ast_adl(date '2026-10-19' - (n * 3 % 40), '11:00') from generate_series(1,14) n
on conflict (id) do nothing;

-- ---------------------------------------------------------------- incidents, complaints, referrals, risks
insert into ast_incidents(id, reference, participant_id, reported_by_id, type, severity, status, reportable, reportable_type, time, details, follow_up_details, completed_at, created_at) values
 (ast_id('inc:12'), 'INC-2026-012', ast_id('p:8'), ast_id('user:5'), 'behaviour', 'minor', 'closed', 'no', null, ast_adl('2026-09-22','11:40'),
   'Oliver became verbally agitated at the Centrelink office after a long wait. Worker used the de-escalation strategies in the BSP; left the office and sat outside for 15 minutes. No one was hurt.',
   'Discussed with behaviour support practitioner 23 Sep. Future appointments to be booked first thing in the morning. Participant and worker debriefed.', ast_adl('2026-09-24','16:00'), ast_adl('2026-09-22','13:10')),
 (ast_id('inc:14'), 'INC-2026-014', ast_id('p:3'), ast_id('user:10'), 'fall', 'moderate', 'reported', 'yes', null, ast_adl('2026-10-10','08:35'),
   'Chloe fell in the hallway while walking without her walker. Bruising to the left hip. GP visit arranged by her daughter the same day.',
   null, null, ast_adl('2026-10-10','09:20')),
 (ast_id('inc:15'), 'INC-2026-015', ast_id('p:10'), ast_id('user:7'), 'medication', 'minor', 'reported', 'no', null, ast_adl('2026-10-15','09:10'),
   'Lucas''s morning Webster pack blister for Thursday was still full when the worker arrived; Wednesday''s prompt appears to have been missed.',
   'Team leader to check Wednesday''s shift note and speak with the worker.', null, ast_adl('2026-10-15','09:30'))
on conflict (id) do nothing;

insert into ast_feedback(id, reference, feedback_type, sentiment, status, subject_name, complainant_name, complainant_email, complainant_phone, details, follow_up_details, participant_id, created_at, updated_at) values
 (ast_id('fb:7'), 'FB-2026-007', 'complaint', 'negative', 'new', 'Rostering', 'Teresa Marino', 'teresa.marino@example', '0430 000 001',
   'Alex''s morning worker has been late three times in two weeks and twice nobody called to say so. He missed his gym session on the 16th as a result.', null, ast_id('p:1'), ast_adl('2026-09-29','15:20'), null),
 (ast_id('fb:8'), 'FB-2026-008', 'compliment', 'positive', 'resolved', 'Support worker', 'Fiona McKenzie', 'parent.mckenzie@example', '0430 000 005',
   'Priya has been wonderful with Isla at Saturday sport. Isla now asks to go.', 'Passed on to Priya and her team leader.', ast_id('p:9'), ast_adl('2026-10-06','18:05'), ast_adl('2026-10-07','09:00'))
on conflict (id) do nothing;

insert into ast_referrals(id, reference, participant_name, status, details, created_at, updated_at) values
 (ast_id('ref:21'), 'REF-2026-021', 'Benjamin Carter', 'new', 'Referred by LAC for community access 6 hrs/week, plan managed. Lives in Christies Beach.', ast_adl('2026-10-16','10:10'), null),
 (ast_id('ref:20'), 'REF-2026-020', 'Harper Osei', 'accepted', 'Self-referral via website. Psychosocial disability, new plan starting 28 Sep.', ast_adl('2026-09-21','14:00'), ast_adl('2026-09-26','11:00'))
on conflict (id) do nothing;

insert into ast_participant_risks(id, participant_id, title, description, likelihood, consequence, residual_likelihood, risk_to, status, review_frequency, risk_management_type, visible_to_support_workers, last_reviewed_at, next_review_at, created_at) values
 (ast_id('risk:1'), ast_id('p:1'), 'Pressure injury', 'Long periods seated in the wheelchair; history of a stage 1 pressure area in 2025.', 3, 4, 2, 'participant', 'active', 'quarterly', 'active', true, '2026-05-30', '2026-08-31', '2025-06-01 00:00+00'),
 (ast_id('risk:2'), ast_id('p:2'), 'Seizure during community access', 'Tonic-clonic seizures roughly monthly, usually with warning.', 3, 4, 2, 'participant', 'active', 'quarterly', 'active', true, '2026-09-10', '2026-12-10', '2024-01-10 00:00+00'),
 (ast_id('risk:3'), ast_id('p:3'), 'Falls at home', 'Progressive MS; two falls in 60 days.', 4, 4, 3, 'participant', 'active', 'monthly', 'active', true, '2026-10-01', '2026-11-01', '2025-02-01 00:00+00'),
 (ast_id('risk:8'), ast_id('p:8'), 'Verbal aggression towards staff', 'Escalates when routines change without warning. BSP in place.', 3, 3, 2, 'staff', 'active', 'quarterly', 'active', true, '2026-09-24', '2026-12-24', '2024-05-01 00:00+00')
on conflict (id) do nothing;
insert into ast_participant_risk_controls(id, risk_id, title, description) values
 (ast_id('rc:1a'), ast_id('risk:1'), 'Pressure relief every 2 hours', 'Prompt weight shifts; cushion check each morning.'),
 (ast_id('rc:1b'), ast_id('risk:1'), 'Skin check at each personal care shift', 'Report any redness in the shift note.'),
 (ast_id('rc:2a'), ast_id('risk:2'), 'Seizure management plan in the car and at home', 'Workers trained in midazolam administration (annual).'),
 (ast_id('rc:3a'), ast_id('risk:3'), 'Walker within reach at all times', 'Worker checks before leaving the room.'),
 (ast_id('rc:8a'), ast_id('risk:8'), 'Call before every visit', 'Confirm the plan for the day; no surprise changes.')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- webhook, exports, demo webhook events
insert into ast_webhooks(id, description, url, event_types, is_enabled, created_at) values
 (ast_id('wh:1'), 'NDIS Wizard listener (disabled in the demo)', 'https://example.invalid/astalty/webhook', array['participant.created','participant.updated','invoice_batch.finalised','incident.created','task.created'], false, '2026-10-01 00:00+00')
on conflict (id) do nothing;
insert into ast_exports(id, name, export_type, export_reason, status, created_at) values
 (ast_id('exp:1'), 'Participants export 2026-10-01', 'participant-export', 'Monthly audit', 'completed', '2026-10-01 01:00+00')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- tidy: the seed is not a "change"
delete from ast_change_log;
select (select count(*) from ast_invoices) invoices, (select sum(total) from ast_invoices) invoiced_cents, (select count(*) from ast_charges where invoice_id is null and date < '2026-10-19') uninvoiced, (select count(*) from ast_incidents) incidents, (select count(*) from ast_participant_risks) risks;
