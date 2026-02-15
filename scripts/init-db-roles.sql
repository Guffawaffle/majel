-- init-db-roles.sql — Create non-superuser application role (#39)
--
-- Majel — STFC Fleet Intelligence System
--
-- Purpose:
--   The `majel` user is a superuser (for schema migrations/DDL).
--   Superusers bypass RLS entirely, so application queries MUST use
--   a non-superuser role (`majel_app`) for Row-Level Security to work.
--
-- This script is mounted as a docker-entrypoint-initdb.d script and runs
-- automatically on first `docker compose up`. It is idempotent.
--
-- See: ADR-021, #39

-- Create the application role (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'majel_app') THEN
    CREATE ROLE majel_app LOGIN PASSWORD 'majel_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
    RAISE NOTICE 'Created role majel_app';
  END IF;
END $$;

-- Grant connection to the majel database
GRANT CONNECT ON DATABASE majel TO majel_app;

-- Grant schema usage + full DML (SELECT, INSERT, UPDATE, DELETE) on public schema
GRANT USAGE ON SCHEMA public TO majel_app;

-- Grant on existing tables (if any)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO majel_app;

-- Grant on sequences (for any serial/identity columns)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO majel_app;

-- Auto-grant on future tables created by the superuser
ALTER DEFAULT PRIVILEGES FOR ROLE majel
  IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO majel_app;

ALTER DEFAULT PRIVILEGES FOR ROLE majel
  IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO majel_app;
