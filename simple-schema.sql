-- Simple DeezaBot Table Schema
-- Run this SQL in your Supabase SQL editor

-- Drop table if exists (for testing)
drop table if exists deeza_users;

-- Create simple table with essential columns
create table deeza_users (
  id uuid primary key default uuid_generate_v4(),
  telegram_id bigint unique not null,
  telegram_username text,
  wallet_address text unique,
  wallet_id text unique,
  tier text default 'regular',
  created_at timestamp with time zone default now()
);

-- Create index for fast lookup
create index idx_telegram_id on deeza_users(telegram_id);
create index idx_wallet_address on deeza_users(wallet_address);
