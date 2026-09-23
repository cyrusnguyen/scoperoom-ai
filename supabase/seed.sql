do $$ begin
  create role app_migrator nologin noinherit;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role app_web nologin noinherit;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role app_worker nologin noinherit;
exception when duplicate_object then null;
end $$;
grant app_migrator, app_web, app_worker to postgres;
