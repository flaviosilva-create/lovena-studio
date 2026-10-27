-- Lovena Studio: initial production schema
-- Apply with Supabase CLI or SQL Editor after creating the Supabase project.
-- Client-facing access is intentionally denied by default. Trusted Edge Functions
-- using the service role must validate payment and publication permissions.

create extension if not exists pgcrypto;

create table if not exists public.lovena_experiences (
  id uuid primary key default gen_random_uuid(),
  public_slug text unique,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'expired', 'removed')),
  plan text not null default 'simple'
    check (plan in ('simple', 'premium')),
  locale text not null default 'pt-BR',
  experience_data jsonb not null default '{}'::jsonb,
  online_expires_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint published_experience_has_slug
    check (status <> 'published' or public_slug is not null)
);

create index if not exists lovena_experiences_status_expiry_idx
  on public.lovena_experiences (status, online_expires_at);

create table if not exists public.lovena_orders (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid references public.lovena_experiences(id) on delete set null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  customer_email text,
  plan text not null check (plan in ('simple', 'premium')),
  currency text not null,
  amount_total integer not null check (amount_total >= 0),
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'failed', 'refunded', 'disputed')),
  online_term text not null default 'one_year'
    check (online_term in ('one_year', 'lifetime')),
  includes_html_download boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lovena_orders_experience_idx
  on public.lovena_orders (experience_id);
create index if not exists lovena_orders_status_created_idx
  on public.lovena_orders (payment_status, created_at desc);

create table if not exists public.lovena_media (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references public.lovena_experiences(id) on delete cascade,
  storage_path text not null unique,
  media_type text not null default 'image'
    check (media_type in ('image', 'audio', 'video', 'other')),
  content_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists lovena_media_experience_sort_idx
  on public.lovena_media (experience_id, sort_order);

-- updated_at is maintained by the trusted application layer.
-- Enable RLS and intentionally define no anon/authenticated policies yet.
-- This prevents accidental exposure before the authenticated editor and
-- public experience Edge Functions are implemented.
alter table public.lovena_experiences enable row level security;
alter table public.lovena_orders enable row level security;
alter table public.lovena_media enable row level security;

revoke all on public.lovena_experiences from anon, authenticated;
revoke all on public.lovena_orders from anon, authenticated;
revoke all on public.lovena_media from anon, authenticated;

comment on table public.lovena_experiences is
  'Lovena experience content and publication/expiry state. Access through validated Edge Functions.';
comment on table public.lovena_orders is
  'Stripe payment ledger. Never accept payment status or price from the browser as authoritative.';
comment on table public.lovena_media is
  'Private Storage object metadata. Keep photos in a private Storage bucket and issue short-lived signed URLs only after authorization.';
