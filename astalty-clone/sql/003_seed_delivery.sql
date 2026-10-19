-- Astalty clone · seed part 2: supports, shifts, progress notes, charges, travel, tasks
-- Generates seven weeks (2026-09-07 .. 2026-10-25) from weekly patterns. "Today" is 2026-10-19.
-- Synthetic data only.
set session_replication_role = replica;

create temp table if not exists ast_pat (p int, dow int, st time, mins int, kind text, worker int, site int, from_date date, details text);
truncate ast_pat;
insert into ast_pat values
 (1,1,'07:30',150,'core',4,null,null,'Morning routine support'),(1,3,'07:30',150,'core',4,null,null,'Morning routine support'),(1,5,'07:30',150,'core',4,null,null,'Morning routine support'),
 (1,2,'10:00',180,'community',5,null,null,'Gym at Marion and shopping'),(1,6,'09:00',180,'community',6,null,null,'Weekend community access'),
 (2,2,'16:00',120,'core',7,null,null,'Afternoon support: meal prep and planning'),(2,4,'16:00',120,'core',7,null,null,'Afternoon support: meal prep and planning'),
 (2,6,'10:00',240,'community',8,null,null,'Community access (study visit, errands)'),
 (3,1,'08:00',90,'core',9,null,null,'Morning support'),(3,2,'08:00',90,'core',9,null,null,'Morning support'),(3,3,'08:00',90,'core',9,null,null,'Morning support'),
 (3,4,'08:00',90,'core',10,null,null,'Morning support'),(3,5,'08:00',90,'core',10,null,null,'Morning support'),(3,6,'08:00',90,'core',6,null,null,'Morning support'),(3,7,'08:00',90,'core',6,null,null,'Morning support'),
 (3,1,'20:00',60,'core',5,null,null,'Evening support'),(3,3,'20:00',60,'core',5,null,null,'Evening support'),(3,5,'20:00',60,'core',5,null,null,'Evening support'),
 (4,3,'15:30',120,'community',8,null,null,'After-school social program'),(4,6,'09:30',180,'community',7,null,null,'Saturday youth group'),
 (5,1,'06:30',60,'core',4,null,null,'Morning routine before work'),(5,2,'06:30',60,'core',4,null,null,'Morning routine before work'),(5,3,'06:30',60,'core',4,null,null,'Morning routine before work'),
 (5,4,'06:30',60,'core',4,null,null,'Morning routine before work'),(5,5,'06:30',60,'core',4,null,null,'Morning routine before work'),(5,4,'09:00',240,'community',5,null,null,'Travel training and community access'),
 (6,1,'07:00',120,'core',7,null,null,'Morning support'),(6,2,'07:00',120,'core',7,null,null,'Morning support'),(6,3,'07:00',120,'core',7,null,null,'Morning support'),(6,4,'07:00',120,'core',7,null,null,'Morning support'),(6,5,'07:00',120,'core',7,null,null,'Morning support'),
 (6,6,'07:00',120,'core',9,null,null,'Morning support'),(6,7,'07:00',120,'core',9,null,null,'Morning support'),
 (6,1,'20:00',90,'core',6,null,null,'Evening support'),(6,2,'20:00',90,'core',6,null,null,'Evening support'),(6,3,'20:00',90,'core',6,null,null,'Evening support'),(6,4,'20:00',90,'core',6,null,null,'Evening support'),
 (6,5,'20:00',90,'core',10,null,null,'Evening support'),(6,6,'20:00',90,'core',10,null,null,'Evening support'),(6,7,'20:00',90,'core',10,null,null,'Evening support'),
 (7,2,'10:00',180,'community',8,2,null,'Cooking group at Mile End hub'),(7,5,'13:00',180,'community',10,null,null,'Community access'),
 (8,1,'09:00',90,'core',9,null,null,'Morning check-in and household tasks'),(8,4,'09:00',90,'core',9,null,null,'Morning check-in and household tasks'),(8,3,'10:00',240,'community',5,null,null,'Community access and appointments'),
 (9,6,'08:30',150,'community',4,null,null,'Saturday sport'),
 (10,1,'08:00',120,'core',10,null,null,'Morning support and exercises'),(10,3,'08:00',120,'core',10,null,null,'Morning support and exercises'),(10,5,'08:00',120,'core',10,null,null,'Morning support and exercises'),
 (10,2,'08:00',120,'core',7,null,null,'Morning support and exercises'),(10,4,'08:00',120,'core',7,null,null,'Morning support and exercises'),(10,7,'10:00',180,'community',9,null,null,'Sunday community access'),
 (11,2,'07:00',120,'core',6,null,null,'Campus-day morning support'),(11,4,'07:00',120,'core',6,null,null,'Campus-day morning support'),
 (13,1,'13:00',180,'community',8,null,null,'Community access'),(13,5,'10:00',180,'community',4,null,null,'Work trial support'),
 (14,3,'11:00',120,'community',5,null,'2026-09-30','Getting-to-know-you community visit'),(14,5,'11:00',120,'community',5,null,'2026-09-30','Community access');

do $$
declare
  today date := '2026-10-19';
  d date; pat record;
  sid uuid; shid uuid; h int;
  ts0 timestamptz; ts1 timestamptz;
  done boolean; cancelled boolean;
  svc uuid; ci uuid; code text;
  qty numeric; price int; isodow int; isph boolean; evening boolean;
  pname text; wname text; note text; km int;
  core_notes text[] := array[
    'Shift %s–%s. Supported %s with the morning routine as per the support plan. %s was well and in good spirits. Medication self-administered and observed. No concerns.',
    'Shift %s–%s. Supported %s with the daily routine. %s was tired and needed extra prompting, about 10 minutes longer than usual. Encouraged fluids. Nothing to follow up.',
    'Shift %s–%s. Routine supports completed with %s. %s reported mild discomfort, 3/10, which eased after repositioning. Will mention at handover.',
    'Shift %s–%s. Supported %s with breakfast and medication prompts. %s practised the independence goal and managed most steps alone. Positive and engaged.',
    'Shift %s–%s. %s chose a lighter routine today and the choice was respected. %s ate well. Completed one set of the physio exercises with standby assistance.'
  ];
  comm_notes text[] := array[
    'Shift %s–%s. Took %s to the shopping centre and the library. %s chose the route and used the concession card at the counter with minimal prompting. Travel %s km in worker vehicle. Enjoyed the outing.',
    'Shift %s–%s. Community access with %s: swim at the local pool as part of the fitness goal. %s swam 6 laps with rest breaks. Travel %s km. No concerns.',
    'Shift %s–%s. Supported %s at the group program. %s joined the activity for the full session and spoke with two other participants. Travel %s km. Good session.',
    'Shift %s–%s. %s attended an appointment with support, then a coffee in the community. %s was anxious beforehand and settled after arriving. Travel %s km. Follow up: confirm the next appointment date with the coordinator.',
    'Shift %s–%s. Community access with %s: errands and a walk along the foreshore. %s set the pace and asked to stop early, so we returned 20 minutes before the end. Travel %s km.'
  ];
begin
  for d in select generate_series(date '2026-09-07', date '2026-10-25', interval '1 day')::date loop
    isodow := extract(isodow from d);
    isph := exists (select 1 from ast_public_holidays where date = d);
    for pat in select * from ast_pat where dow = isodow and (from_date is null or d >= from_date) loop
      sid := ast_id('sup:'||pat.p||':'||d||':'||pat.st);
      shid := ast_id('shift:'||pat.p||':'||d||':'||pat.st);
      h := abs(hashtext(sid::text));
      ts0 := ast_adl(d, pat.st); ts1 := ts0 + make_interval(mins => pat.mins);
      done := d < today;
      cancelled := done and (h % 23 = 0);
      svc := (select id from ast_services where id = ast_id('svc:'||pat.p||':'||pat.kind));
      evening := pat.st >= time '20:00';
      code := case when isph then (case pat.kind when 'core' then '01_012' else '04_102' end)
                   when isodow = 6 then (case pat.kind when 'core' then '01_013' else '04_105' end)
                   when isodow = 7 then (case pat.kind when 'core' then '01_014' else '04_106' end)
                   when evening then (case pat.kind when 'core' then '01_015' else '04_103' end)
                   else (case pat.kind when 'core' then '01_011' else '04_104' end) end;
      ci := ast_id('ci:'||code);
      price := (select c.price from ast_charge_items c where c.id = ci);
      qty := round(pat.mins / 60.0, 2);
      select coalesce(preferred_name, first_name) into pname from ast_participants where id = ast_id('p:'||pat.p);
      select first_name into wname from ast_users where id = ast_id('user:'||pat.worker);

      insert into ast_supports(id, participant_id, service_id, site_id, support_type, start_time, end_time, timezone, details, status, cancellation_type, created_at)
      values (sid, ast_id('p:'||pat.p), svc, case when pat.site is not null then ast_id('site:'||pat.site) end,
              case pat.kind when 'core' then 'personal_care' else 'community_access' end,
              ts0, ts1, 'Australia/Adelaide', pat.details,
              case when cancelled then 'cancelled' when done then 'completed' else 'scheduled' end,
              case when cancelled then (case when h % 2 = 0 then 'NSDH' else 'NSDF' end) end,
              ts0 - interval '21 days')
      on conflict (id) do nothing;

      insert into ast_shifts(id, user_id, support_id, event_type, name, start_time, end_time, timezone, status, clock_in_at, clock_out_at, created_at)
      values (shid, ast_id('user:'||pat.worker), sid, 'support', pname||' · '||pat.details, ts0, ts1, 'Australia/Adelaide',
              case when cancelled then 'cancelled' when done then 'completed' else 'published' end,
              case when done and not cancelled then ts0 + make_interval(mins => (h % 7) - 2) end,
              case when done and not cancelled then ts1 + make_interval(mins => (h % 9) - 3) end,
              ts0 - interval '21 days')
      on conflict (id) do nothing;

      if pat.mins >= 240 then
        insert into ast_shift_breaks(id, shift_id, type, duration, is_paid) values (ast_id('brk:'||shid::text), shid, 'meal', 30, false) on conflict (id) do nothing;
      end if;

      -- travel on community supports
      if pat.kind = 'community' then
        km := 10 + (h % 16);
        insert into ast_travels(id, support_id, user_id, travel_anchor, distance, duration, approved_distance, approved_duration, odometer_start, odometer_end, actual_start_time, actual_end_time, actual_distance, actual_duration, was_not_travelled)
        values (ast_id('trv:'||sid::text), sid, ast_id('user:'||pat.worker), 'during', km, km * 2, km, km * 2,
                case when done and not cancelled then 40000 + (h % 9000) end, case when done and not cancelled then 40000 + (h % 9000) + km end,
                case when done and not cancelled then ts0 + interval '30 minutes' end, case when done and not cancelled then ts0 + interval '30 minutes' + make_interval(mins => km*2) end,
                case when done and not cancelled then km end, case when done and not cancelled then km * 2 end,
                case when done and not cancelled then false end)
        on conflict (id) do nothing;
      end if;

      -- charges
      if done then
        insert into ast_charges(id, participant_id, charge_item_id, service_id, source, support_id, date, quantity, unit_cost, total_cost, claim_type, cancellation_reason, status, created_at)
        values (ast_id('chg:'||sid::text), ast_id('p:'||pat.p), ci, svc, 'support', sid, d, qty, price, round(qty * price),
                case when cancelled then 'CANC' end, case when cancelled then 'Short notice cancellation by participant' end, 'uninvoiced', ts1)
        on conflict (id) do nothing;
        if pat.kind = 'community' and not cancelled then
          insert into ast_charges(id, participant_id, charge_item_id, service_id, source, support_id, date, quantity, unit_cost, total_cost, claim_type, is_primary, status, created_at)
          values (ast_id('chgkm:'||sid::text), ast_id('p:'||pat.p), ast_id('ci:'||left(code,2)||'_799'), svc, 'support', sid, d, km, 100, km * 100, 'TRAN', false, 'uninvoiced', ts1)
          on conflict (id) do nothing;
        end if;
      end if;

      -- progress notes (most completed supports; PLANTED P9: none from Grace, user 8, in the week of 12 Oct)
      if done and not cancelled and (h % 11 <> 4) and not (pat.worker = 8 and d between '2026-10-12' and '2026-10-18') then
        if pat.kind = 'core' then
          note := format(core_notes[1 + (h % 5)], to_char(ts0 at time zone 'Australia/Adelaide','HH12:MIam'), to_char(ts1 at time zone 'Australia/Adelaide','HH12:MIam'), pname, pname);
        else
          note := format(comm_notes[1 + (h % 5)], to_char(ts0 at time zone 'Australia/Adelaide','HH12:MIam'), to_char(ts1 at time zone 'Australia/Adelaide','HH12:MIam'), pname, pname, km);
        end if;
        insert into ast_notes(id, notable_type, notable_id, author_id, content, source_type, source_id, created_at)
        values (ast_id('note:'||sid::text), 'participant', ast_id('p:'||pat.p), ast_id('user:'||pat.worker), note, 'support', sid, ts1 + interval '20 minutes')
        on conflict (id) do nothing;
      end if;
    end loop;
  end loop;
end $$;

-- support coordination tasks (Mei Lin) with notes and charges, one per week per SC participant
do $$
declare
  wk date; n int; tid uuid; h int; mins int; ts0 timestamptz; done boolean;
  topics text[] := array['Phone check-in and plan budget review','Liaison with allied health provider about the report','Service booking follow-up and roster change','Plan implementation meeting with participant and family','Chased plan manager about unpaid invoices','Review of goals and progress notes'];
  pname text;
begin
  for wk in select generate_series(date '2026-09-07', date '2026-10-19', interval '7 days')::date loop
    foreach n in array array[1,2,4,5,6,7,8,10,11,13] loop
      tid := ast_id('task:'||n||':'||wk);
      h := abs(hashtext(tid::text));
      mins := 30 + 15 * (h % 5);
      ts0 := ast_adl(wk + (h % 5), make_time(9 + (h % 6), 0, 0));
      done := ts0 < ast_adl('2026-10-19','00:00');
      select coalesce(preferred_name, first_name) into pname from ast_participants where id = ast_id('p:'||n);
      insert into ast_tasks(id, title, participant_id, user_id, start_time, duration, billable, completed, created_at)
      values (tid, topics[1 + (h % 6)]||' · '||pname, ast_id('p:'||n), ast_id('user:2'), ts0, mins, true, done, ts0 - interval '3 days') on conflict (id) do nothing;
      insert into ast_task_goals(task_id, goal_id) select tid, id from ast_goals where participant_id = ast_id('p:'||n) limit 1 on conflict do nothing;
      if done then
        insert into ast_notes(id, notable_type, notable_id, author_id, content, checkin_type, source_type, source_id, created_at)
        values (ast_id('tnote:'||tid::text), 'participant', ast_id('p:'||n), ast_id('user:2'),
                format('Contact type: %s. %s. Actions: %s. Time spent: %s min.', (array['phone','email','face to face','teleconsult'])[1 + (h % 4)], topics[1 + (h % 6)],
                       (array['Email sent to provider','Roster updated and participant informed','Plan manager to confirm by Friday','Booked follow-up for next week'])[1 + (h % 4)], mins),
                (array['phone','email','face to face','teleconsult'])[1 + (h % 4)], 'task', tid, ts0 + make_interval(mins => mins)) on conflict (id) do nothing;
        -- PLANTED (P17): task on 13 Oct for Oliver is billable and completed but has no charge
        if not (n = 8 and wk = '2026-10-12') then
          insert into ast_charges(id, participant_id, charge_item_id, service_id, source, task_id, date, quantity, unit_cost, total_cost, status, created_at)
          values (ast_id('tchg:'||tid::text), ast_id('p:'||n), case when n = 7 then ast_id('ci:07_001') else ast_id('ci:07_002') end,
                  (select id from ast_services where id = ast_id('svc:'||n||':sc')), 'task', tid, ts0::date, round(mins/60.0, 2),
                  case when n = 7 then 6756 else 10014 end, round(round(mins/60.0, 2) * case when n = 7 then 6756 else 10014 end), 'uninvoiced', ts0 + make_interval(mins => mins))
          on conflict (id) do nothing;
        end if;
      end if;
    end loop;
  end loop;
end $$;

drop table if exists ast_pat;
reset session_replication_role;
select (select count(*) from ast_supports) supports, (select count(*) from ast_shifts) shifts, (select count(*) from ast_notes) notes, (select count(*) from ast_charges) charges, (select count(*) from ast_travels) travels, (select count(*) from ast_tasks) tasks;
