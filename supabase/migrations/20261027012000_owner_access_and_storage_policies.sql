-- Reproducible owner-scoped access policies for Lovena Studio.
-- Idempotent so this can safely reconcile a provisioned environment.

alter table public.lovena_experiences enable row level security;
alter table public.lovena_orders enable row level security;
alter table public.lovena_media enable row level security;

drop policy if exists "owners create own drafts" on public.lovena_experiences;
create policy "owners create own drafts" on public.lovena_experiences
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'draft' and public_slug is null);

drop policy if exists "owners delete own drafts" on public.lovena_experiences;
create policy "owners delete own drafts" on public.lovena_experiences
  for delete to authenticated
  using (owner_id = (select auth.uid()) and status = 'draft');

drop policy if exists "owners read own experiences" on public.lovena_experiences;
create policy "owners read own experiences" on public.lovena_experiences
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "owners update own drafts only" on public.lovena_experiences;
create policy "owners update own drafts only" on public.lovena_experiences
  for update to authenticated
  using (owner_id = (select auth.uid()) and status = 'draft' and public_slug is null)
  with check (owner_id = (select auth.uid()) and status = 'draft' and public_slug is null);

drop policy if exists "owners add media metadata" on public.lovena_media;
create policy "owners add media metadata" on public.lovena_media
  for insert to authenticated
  with check (exists (
    select 1 from public.lovena_experiences e
    where e.id = lovena_media.experience_id
      and e.owner_id = (select auth.uid())
      and e.status = 'draft'
  ));

drop policy if exists "owners delete own draft media metadata" on public.lovena_media;
create policy "owners delete own draft media metadata" on public.lovena_media
  for delete to authenticated
  using (exists (
    select 1 from public.lovena_experiences e
    where e.id = lovena_media.experience_id
      and e.owner_id = (select auth.uid())
      and e.status = 'draft'
      and e.public_slug is null
  ));

drop policy if exists "owners read own media metadata" on public.lovena_media;
create policy "owners read own media metadata" on public.lovena_media
  for select to authenticated
  using (exists (
    select 1 from public.lovena_experiences e
    where e.id = lovena_media.experience_id
      and e.owner_id = (select auth.uid())
  ));

drop policy if exists "owners update own draft media metadata" on public.lovena_media;
create policy "owners update own draft media metadata" on public.lovena_media
  for update to authenticated
  using (exists (
    select 1 from public.lovena_experiences e
    where e.id = lovena_media.experience_id
      and e.owner_id = (select auth.uid())
      and e.status = 'draft'
      and e.public_slug is null
  ))
  with check (exists (
    select 1 from public.lovena_experiences e
    where e.id = lovena_media.experience_id
      and e.owner_id = (select auth.uid())
      and e.status = 'draft'
      and e.public_slug is null
  ));

drop policy if exists "owners read orders for own experiences" on public.lovena_orders;
create policy "owners read orders for own experiences" on public.lovena_orders
  for select to authenticated
  using (exists (
    select 1 from public.lovena_experiences e
    where e.id = lovena_orders.experience_id
      and e.owner_id = (select auth.uid())
  ));

drop policy if exists "owners delete own media objects" on storage.objects;
create policy "owners delete own media objects" on storage.objects
  for delete to authenticated
  using (bucket_id = 'lovena-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "owners read own media objects" on storage.objects;
create policy "owners read own media objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'lovena-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "owners update own media objects" on storage.objects;
create policy "owners update own media objects" on storage.objects
  for update to authenticated
  using (bucket_id = 'lovena-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'lovena-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "owners upload own draft media" on storage.objects;
create policy "owners upload own draft media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lovena-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.lovena_experiences e
      where e.id::text = (storage.foldername(name))[2]
        and e.owner_id = (select auth.uid())
        and e.status = 'draft'
    )
  );
