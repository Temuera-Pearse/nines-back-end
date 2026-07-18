alter table races
  add column if not exists race_ref text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'races_race_ref_format_chk'
  ) then
    alter table races
      add constraint races_race_ref_format_chk
      check (
        race_ref is null
        or race_ref ~ '^N9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$'
      );
  end if;
end
$$;

create unique index if not exists races_race_ref_uidx
  on races (race_ref)
  where race_ref is not null;
