-- DeezaBot Schema with Encryption Support
create table if not exists deeza_users (
  id uuid primary key default uuid_generate_v4(),
  telegram_id bigint unique not null,
  telegram_username text,
  wallet_address text unique not null,
  encrypted_private_key text not null,
  tier text default 'regular',
  created_at timestamp with time zone default now()
);

create index if not exists idx_telegram_id on deeza_users(telegram_id);

create index if not exists idx_wallet_address on deeza_users(wallet_address);
create index if not exists idx_telegram_username on deeza_users(telegram_username);