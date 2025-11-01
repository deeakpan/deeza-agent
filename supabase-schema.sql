-- Deeza Gift Drop Bot - Supabase Schema

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table - stores Telegram users and their wallet addresses
CREATE TABLE IF NOT EXISTS deeza_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  wallet_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Contexts table - manages conversation flows and state
CREATE TABLE IF NOT EXISTS deeza_contexts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id BIGINT UNIQUE NOT NULL,
  context_type TEXT NOT NULL,
  context_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Gifts table - tracks all gifts (pending, active, claimed)
CREATE TABLE IF NOT EXISTS deeza_gifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gift_id TEXT UNIQUE NOT NULL, -- bytes32 from contract (hex string)
  code TEXT UNIQUE NOT NULL, -- Claim code (e.g., "john42")
  gifter_telegram_id BIGINT NOT NULL,
  recipient_username TEXT,
  recipient_telegram_id BIGINT,
  token TEXT, -- Token symbol (e.g., "USDC", "ZAZZ", "NIA")
  token_address TEXT, -- Contract address (0x0 for native)
  amount TEXT, -- Amount as string (to handle large numbers)
  ipfs_link TEXT, -- Lighthouse IPFS link for Q&A
  deposited BOOLEAN DEFAULT FALSE,
  claimed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_deeza_users_telegram_id ON deeza_users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_deeza_users_username ON deeza_users(LOWER(telegram_username));
CREATE INDEX IF NOT EXISTS idx_deeza_users_wallet ON deeza_users(wallet_address) WHERE wallet_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deeza_contexts_telegram_id ON deeza_contexts(telegram_id);
CREATE INDEX IF NOT EXISTS idx_deeza_contexts_type ON deeza_contexts(context_type);

CREATE INDEX IF NOT EXISTS idx_deeza_gifts_code ON deeza_gifts(code);
CREATE INDEX IF NOT EXISTS idx_deeza_gifts_gift_id ON deeza_gifts(gift_id);
CREATE INDEX IF NOT EXISTS idx_deeza_gifts_gifter ON deeza_gifts(gifter_telegram_id);
CREATE INDEX IF NOT EXISTS idx_deeza_gifts_recipient_username ON deeza_gifts(LOWER(recipient_username));
CREATE INDEX IF NOT EXISTS idx_deeza_gifts_recipient_id ON deeza_gifts(recipient_telegram_id);
CREATE INDEX IF NOT EXISTS idx_deeza_gifts_deposited ON deeza_gifts(deposited);
CREATE INDEX IF NOT EXISTS idx_deeza_gifts_claimed ON deeza_gifts(claimed);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to auto-update updated_at
CREATE TRIGGER update_deeza_users_updated_at BEFORE UPDATE ON deeza_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_deeza_contexts_updated_at BEFORE UPDATE ON deeza_contexts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_deeza_gifts_updated_at BEFORE UPDATE ON deeza_gifts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE deeza_users IS 'Stores Telegram users and their registered wallet addresses';
COMMENT ON TABLE deeza_contexts IS 'Manages conversation context/state for follow-up flows (registration, gift sending, claiming)';
COMMENT ON TABLE deeza_gifts IS 'Tracks all gifts created, deposited, and claimed on-chain';