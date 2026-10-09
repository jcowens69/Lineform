create table if not exists subscriptions (
  user_id text primary key,
  plan text not null,
  status text not null,
  stripe_customer text,
  stripe_subscription text,
  current_period_end timestamptz not null,
  updated_at timestamptz not null default now()
);
