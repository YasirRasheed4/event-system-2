-- ============================================================
--  EventSphere — OPTIONAL demo data.   Run AFTER schema.sql.
--  Requires at least one admin/organizer profile to exist
--  (see "FIRST ADMIN" at the bottom of schema.sql).
--  Dates are relative to today so "Upcoming Events" is never empty.
--  Safe to re-run: it only inserts when there are no events yet.
-- ============================================================

insert into public.venues (name, address, city, capacity, contact_info, facilities)
select * from (values
  ('Grand Convention Hall', 'Blue Area, Jinnah Ave', 'Islamabad',  2000, '+92-51-1234567', 'WiFi, Projector, Stage, Parking, Cafeteria'),
  ('Expo Center',           'Johar Town',            'Lahore',      5000, '+92-42-9876543', 'WiFi, Multiple Halls, Food Court, AC'),
  ('Tech Hub Auditorium',   'Gulshan-e-Iqbal',       'Karachi',      800, '+92-21-5556677', 'WiFi, Recording Studio, Green Room'),
  ('University Auditorium', 'University Road',       'Peshawar',     600, '+92-91-9112233', 'WiFi, AC, Stage, Projector'),
  ('City Arts Center',      'Saddar',                'Rawalpindi',  1200, '+92-51-4441122', 'Gallery, Stage, Parking')
) as v(name, address, city, capacity, contact_info, facilities)
where not exists (select 1 from public.venues);

do $$
declare
  v_org uuid;
  v_ev  bigint;
begin
  select user_id into v_org from public.profiles
   where role_id in (1, 2) and is_active
   order by role_id, created_at limit 1;

  if v_org is null then
    raise notice 'No admin/organizer profile found - skipping demo events. Promote a user first (see schema.sql).';
    return;
  end if;
  if exists (select 1 from public.events) then
    raise notice 'Events already exist - skipping demo events.';
    return;
  end if;

  insert into public.events (organizer_id, category_id, venue_id, title, description, event_date, start_time, end_time, total_seats, ticket_price, status)
  select v_org, (select category_id from public.categories where name = x.cat),
         (select venue_id from public.venues where name = x.venue),
         x.title, x.descr, current_date + x.days, x.st::time, x.en::time, x.seats, x.price, x.status
  from (values
    ('Conference', 'Grand Convention Hall', 'National Tech Conference',  'Annual flagship technology conference bringing together industry leaders.',  12, '09:00', '18:00', 500, 2500, 'published'),
    ('Workshop',   'Tech Hub Auditorium',   'AI & Machine Learning Workshop', 'Hands-on workshop covering ML fundamentals to advanced neural networks.', 6, '10:00', '16:00',  80, 1500, 'published'),
    ('Networking', 'Expo Center',           'Startup Networking Night',  'Connect with founders, investors, and innovators in one room.',             20, '18:00', '22:00', 200,  500, 'published'),
    ('Hackathon',  'Tech Hub Auditorium',   'University Hackathon',      'Coding competition with prizes worth PKR 500,000.',                         40, '08:00', '20:00', 300,    0, 'published'),
    ('Seminar',    'University Auditorium', 'Cloud Computing Seminar',   'Deep dive into AWS, Azure, and GCP for enterprise solutions.',              55, '09:30', '14:00', 120,  800, 'draft')
  ) as x(cat, venue, title, descr, days, st, en, seats, price, status);

  select event_id into v_ev from public.events where title = 'National Tech Conference';
  insert into public.ticket_types (event_id, type_name, price, quantity, benefits) values
    (v_ev, 'General', 2500, 400, 'Access to all sessions, lunch, kit bag'),
    (v_ev, 'VIP',     5000,  80, 'Front seating, networking dinner, speaker meet & greet'),
    (v_ev, 'Student', 1000,  20, 'Student discount, all sessions, certificate');

  select event_id into v_ev from public.events where title = 'AI & Machine Learning Workshop';
  insert into public.ticket_types (event_id, type_name, price, quantity, benefits) values
    (v_ev, 'Standard', 1500, 70, 'Full workshop, materials, certificate'),
    (v_ev, 'Premium',  2500, 10, 'Workshop + 1-on-1 mentoring session');
end $$;
