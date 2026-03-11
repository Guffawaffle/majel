/**
 * reference-store-schema.ts — Schema DDL + SQL fragments for reference data (#191)
 */

// ─── Constants ──────────────────────────────────────────────

export const DEFAULT_LICENSE = "Community Data";
export const DEFAULT_ATTRIBUTION = "STFC community data";

// ─── Schema DDL ─────────────────────────────────────────────

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS reference_officers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rarity TEXT,
    group_name TEXT,
    captain_maneuver TEXT,
    officer_ability TEXT,
    below_deck_ability TEXT,
    abilities JSONB,
    tags JSONB,
    officer_game_id BIGINT,
    officer_class INTEGER,
    faction JSONB,
    synergy_id BIGINT,
    max_rank INTEGER,
    trait_config JSONB,
    source TEXT NOT NULL,
    source_url TEXT,
    source_page_id TEXT,
    source_revision_id TEXT,
    source_revision_timestamp TEXT,
    license TEXT NOT NULL DEFAULT 'Community Data',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'abilities') THEN
      ALTER TABLE reference_officers ADD COLUMN abilities JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'tags') THEN
      ALTER TABLE reference_officers ADD COLUMN tags JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'officer_game_id') THEN
      ALTER TABLE reference_officers ADD COLUMN officer_game_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'officer_class') THEN
      ALTER TABLE reference_officers ADD COLUMN officer_class INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'faction') THEN
      ALTER TABLE reference_officers ADD COLUMN faction JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'synergy_id') THEN
      ALTER TABLE reference_officers ADD COLUMN synergy_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'max_rank') THEN
      ALTER TABLE reference_officers ADD COLUMN max_rank INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_officers' AND column_name = 'trait_config') THEN
      ALTER TABLE reference_officers ADD COLUMN trait_config JSONB;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_ref_officers_name ON reference_officers(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_officers_group ON reference_officers(group_name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_officers_rarity ON reference_officers(rarity)`,
  `CREATE TABLE IF NOT EXISTS reference_ships (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ship_class TEXT,
    grade INTEGER,
    rarity TEXT,
    faction TEXT,
    tier INTEGER,
    hull_type INTEGER,
    build_time_in_seconds BIGINT,
    max_tier INTEGER,
    max_level INTEGER,
    officer_bonus JSONB,
    crew_slots JSONB,
    build_cost JSONB,
    levels JSONB,
    game_id BIGINT,
    tiers JSONB,
    build_requirements JSONB,
    blueprints_required INTEGER,
    source TEXT NOT NULL,
    source_url TEXT,
    source_page_id TEXT,
    source_revision_id TEXT,
    source_revision_timestamp TEXT,
    license TEXT NOT NULL DEFAULT 'Community Data',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'ability') THEN
      ALTER TABLE reference_ships ADD COLUMN ability JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'warp_range') THEN
      ALTER TABLE reference_ships ADD COLUMN warp_range JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'link') THEN
      ALTER TABLE reference_ships ADD COLUMN link TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'hull_type') THEN
      ALTER TABLE reference_ships ADD COLUMN hull_type INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'build_time_in_seconds') THEN
      ALTER TABLE reference_ships ADD COLUMN build_time_in_seconds BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'max_tier') THEN
      ALTER TABLE reference_ships ADD COLUMN max_tier INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'max_level') THEN
      ALTER TABLE reference_ships ADD COLUMN max_level INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'officer_bonus') THEN
      ALTER TABLE reference_ships ADD COLUMN officer_bonus JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'crew_slots') THEN
      ALTER TABLE reference_ships ADD COLUMN crew_slots JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'build_cost') THEN
      ALTER TABLE reference_ships ADD COLUMN build_cost JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'levels') THEN
      ALTER TABLE reference_ships ADD COLUMN levels JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'game_id') THEN
      ALTER TABLE reference_ships ADD COLUMN game_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'tiers') THEN
      ALTER TABLE reference_ships ADD COLUMN tiers JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'build_requirements') THEN
      ALTER TABLE reference_ships ADD COLUMN build_requirements JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_ships' AND column_name = 'blueprints_required') THEN
      ALTER TABLE reference_ships ADD COLUMN blueprints_required INTEGER;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_name ON reference_ships(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_class ON reference_ships(ship_class)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_ships_faction ON reference_ships(faction)`,
  // ── Research ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS reference_research (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    research_tree TEXT,
    unlock_level INTEGER,
    max_level INTEGER,
    buffs JSONB,
    requirements JSONB,
    row INTEGER,
    col INTEGER,
    game_id BIGINT,
    source TEXT NOT NULL DEFAULT 'cdn:game-data',
    license TEXT NOT NULL DEFAULT 'CC-BY-NC 4.0',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_research_name ON reference_research(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_research_tree ON reference_research(research_tree)`,
  // ── Buildings ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS reference_buildings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    max_level INTEGER,
    unlock_level INTEGER,
    buffs JSONB,
    requirements JSONB,
    game_id BIGINT,
    source TEXT NOT NULL DEFAULT 'cdn:game-data',
    license TEXT NOT NULL DEFAULT 'CC-BY-NC 4.0',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_buildings_name ON reference_buildings(name)`,
  // ── Hostiles ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS reference_hostiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    faction TEXT,
    level INTEGER,
    ship_type INTEGER,
    hull_type INTEGER,
    rarity INTEGER,
    strength BIGINT,
    systems TEXT[],
    warp INTEGER,
    resources JSONB,
    game_id BIGINT,
    source TEXT NOT NULL DEFAULT 'cdn:game-data',
    license TEXT NOT NULL DEFAULT 'CC-BY-NC 4.0',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_hostiles_name ON reference_hostiles(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_hostiles_level ON reference_hostiles(level)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_hostiles_faction ON reference_hostiles(faction)`,
  // ── Consumables ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS reference_consumables (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rarity TEXT,
    grade INTEGER,
    requires_slot BOOLEAN,
    buff JSONB,
    duration_seconds INTEGER,
    category TEXT,
    game_id BIGINT,
    source TEXT NOT NULL DEFAULT 'cdn:game-data',
    license TEXT NOT NULL DEFAULT 'CC-BY-NC 4.0',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_consumables_name ON reference_consumables(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_consumables_category ON reference_consumables(category)`,
  // ── Systems ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS reference_systems (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    est_warp INTEGER,
    is_deep_space BOOLEAN,
    factions TEXT[],
    level INTEGER,
    coords_x REAL,
    coords_y REAL,
    has_mines BOOLEAN,
    has_planets BOOLEAN,
    has_missions BOOLEAN,
    mine_resources JSONB,
    hostile_count INTEGER,
    node_sizes JSONB,
    hazard_level INTEGER,
    game_id BIGINT,
    source TEXT NOT NULL DEFAULT 'cdn:game-data',
    license TEXT NOT NULL DEFAULT 'CC-BY-NC 4.0',
    attribution TEXT NOT NULL DEFAULT 'STFC community data',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ref_systems_name ON reference_systems(name)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_systems_level ON reference_systems(level)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_systems_mine_resources ON reference_systems USING GIN (mine_resources)`,
];

// ─── SQL Column Fragments ───────────────────────────────────

export const OFFICER_COLS = `id, name, rarity, group_name AS "groupName", captain_maneuver AS "captainManeuver",
  officer_ability AS "officerAbility", below_deck_ability AS "belowDeckAbility",
  abilities, tags, officer_game_id AS "officerGameId",
  officer_class AS "officerClass", faction, synergy_id AS "synergyId",
  max_rank AS "maxRank", trait_config AS "traitConfig",
  source, source_url AS "sourceUrl", source_page_id AS "sourcePageId",
  source_revision_id AS "sourceRevisionId", source_revision_timestamp AS "sourceRevisionTimestamp",
  license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const SHIP_COLS = `id, name, ship_class AS "shipClass", grade, rarity, faction, tier,
  ability, warp_range AS "warpRange", link,
  hull_type AS "hullType", build_time_in_seconds AS "buildTimeInSeconds",
  max_tier AS "maxTier", max_level AS "maxLevel",
  officer_bonus AS "officerBonus", crew_slots AS "crewSlots",
  build_cost AS "buildCost", levels, game_id AS "gameId",
  tiers, build_requirements AS "buildRequirements", blueprints_required AS "blueprintsRequired",
  source, source_url AS "sourceUrl", source_page_id AS "sourcePageId",
  source_revision_id AS "sourceRevisionId", source_revision_timestamp AS "sourceRevisionTimestamp",
  license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const RESEARCH_COLS = `id, name, research_tree AS "researchTree", unlock_level AS "unlockLevel",
  max_level AS "maxLevel", buffs, requirements, row, col, game_id AS "gameId",
  source, license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const BUILDING_COLS = `id, name, max_level AS "maxLevel", unlock_level AS "unlockLevel",
  buffs, requirements, game_id AS "gameId",
  source, license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const HOSTILE_COLS = `id, name, faction, level, ship_type AS "shipType", hull_type AS "hullType",
  rarity, strength, systems, warp, resources, game_id AS "gameId",
  source, license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const CONSUMABLE_COLS = `id, name, rarity, grade, requires_slot AS "requiresSlot",
  buff, duration_seconds AS "durationSeconds", category, game_id AS "gameId",
  source, license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const SYSTEM_COLS = `id, name, est_warp AS "estWarp", is_deep_space AS "isDeepSpace",
  factions, level, coords_x AS "coordsX", coords_y AS "coordsY",
  has_mines AS "hasMines", has_planets AS "hasPlanets", has_missions AS "hasMissions",
  mine_resources AS "mineResources", hostile_count AS "hostileCount",
  node_sizes AS "nodeSizes", hazard_level AS "hazardLevel", game_id AS "gameId",
  source, license, attribution, created_at AS "createdAt", updated_at AS "updatedAt"`;

// ─── SQL Prepared Statements ────────────────────────────────

export const SQL = {
  // Officers
  insertOfficer: `INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability, below_deck_ability,
    abilities, tags, officer_game_id, officer_class, faction, synergy_id, max_rank, trait_config,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
  updateOfficer: `UPDATE reference_officers SET name = $1, rarity = $2, group_name = $3, captain_maneuver = $4, officer_ability = $5,
    below_deck_ability = $6, abilities = $7, tags = $8, officer_game_id = $9,
    officer_class = $10, faction = $11, synergy_id = $12, max_rank = $13, trait_config = $14,
    source = $15, source_url = $16, source_page_id = $17, source_revision_id = $18,
    source_revision_timestamp = $19, license = $20, attribution = $21, updated_at = $22 WHERE id = $23`,
  getOfficer: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE id = $1`,
  findOfficerByName: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE LOWER(name) = LOWER($1)`,
  listOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers ORDER BY name`,
  searchOfficers: `SELECT ${OFFICER_COLS} FROM reference_officers WHERE name ILIKE $1 ORDER BY name`,
  deleteOfficer: `DELETE FROM reference_officers WHERE id = $1`,
  officerExists: `SELECT 1 FROM reference_officers WHERE id = $1`,
  countOfficers: `SELECT COUNT(*) AS count FROM reference_officers`,

  // Ships
  insertShip: `INSERT INTO reference_ships (id, name, ship_class, grade, rarity, faction, tier,
    ability, warp_range, link,
    hull_type, build_time_in_seconds, max_tier, max_level, officer_bonus, crew_slots, build_cost, levels, game_id,
    tiers, build_requirements, blueprints_required,
    source, source_url, source_page_id, source_revision_id, source_revision_timestamp, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)`,
  updateShip: `UPDATE reference_ships SET name = $1, ship_class = $2, grade = $3, rarity = $4, faction = $5, tier = $6,
    ability = $7, warp_range = $8, link = $9,
    hull_type = $10, build_time_in_seconds = $11, max_tier = $12, max_level = $13,
    officer_bonus = $14, crew_slots = $15, build_cost = $16, levels = $17, game_id = $18,
    tiers = $19, build_requirements = $20, blueprints_required = $21,
    source = $22, source_url = $23, source_page_id = $24, source_revision_id = $25,
    source_revision_timestamp = $26, license = $27, attribution = $28, updated_at = $29 WHERE id = $30`,
  getShip: `SELECT ${SHIP_COLS} FROM reference_ships WHERE id = $1`,
  findShipByName: `SELECT ${SHIP_COLS} FROM reference_ships WHERE LOWER(name) = LOWER($1)`,
  listShips: `SELECT ${SHIP_COLS} FROM reference_ships ORDER BY name`,
  searchShips: `SELECT ${SHIP_COLS} FROM reference_ships WHERE name ILIKE $1 ORDER BY name`,
  deleteShip: `DELETE FROM reference_ships WHERE id = $1`,
  shipExists: `SELECT 1 FROM reference_ships WHERE id = $1`,
  countShips: `SELECT COUNT(*) AS count FROM reference_ships`,

  // Research
  insertResearch: `INSERT INTO reference_research (id, name, research_tree, unlock_level, max_level, buffs, requirements, row, col, game_id, source, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
  updateResearch: `UPDATE reference_research SET name = $1, research_tree = $2, unlock_level = $3, max_level = $4, buffs = $5, requirements = $6, row = $7, col = $8, game_id = $9, source = $10, license = $11, attribution = $12, updated_at = $13 WHERE id = $14`,
  researchExists: `SELECT 1 FROM reference_research WHERE id = $1`,
  getResearch: `SELECT ${RESEARCH_COLS} FROM reference_research WHERE id = $1`,
  searchResearch: `SELECT ${RESEARCH_COLS} FROM reference_research WHERE name ILIKE $1 ORDER BY name`,
  countResearch: `SELECT COUNT(*) AS count FROM reference_research`,

  // Buildings
  insertBuilding: `INSERT INTO reference_buildings (id, name, max_level, unlock_level, buffs, requirements, game_id, source, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
  updateBuilding: `UPDATE reference_buildings SET name = $1, max_level = $2, unlock_level = $3, buffs = $4, requirements = $5, game_id = $6, source = $7, license = $8, attribution = $9, updated_at = $10 WHERE id = $11`,
  buildingExists: `SELECT 1 FROM reference_buildings WHERE id = $1`,
  getBuilding: `SELECT ${BUILDING_COLS} FROM reference_buildings WHERE id = $1`,
  searchBuildings: `SELECT ${BUILDING_COLS} FROM reference_buildings WHERE name ILIKE $1 ORDER BY name`,
  countBuildings: `SELECT COUNT(*) AS count FROM reference_buildings`,

  // Hostiles
  insertHostile: `INSERT INTO reference_hostiles (id, name, faction, level, ship_type, hull_type, rarity, strength, systems, warp, resources, game_id, source, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
  updateHostile: `UPDATE reference_hostiles SET name = $1, faction = $2, level = $3, ship_type = $4, hull_type = $5, rarity = $6, strength = $7, systems = $8, warp = $9, resources = $10, game_id = $11, source = $12, license = $13, attribution = $14, updated_at = $15 WHERE id = $16`,
  hostileExists: `SELECT 1 FROM reference_hostiles WHERE id = $1`,
  getHostile: `SELECT ${HOSTILE_COLS} FROM reference_hostiles WHERE id = $1`,
  searchHostiles: `SELECT ${HOSTILE_COLS} FROM reference_hostiles WHERE name ILIKE $1 ORDER BY name`,
  countHostiles: `SELECT COUNT(*) AS count FROM reference_hostiles`,

  // Consumables
  insertConsumable: `INSERT INTO reference_consumables (id, name, rarity, grade, requires_slot, buff, duration_seconds, category, game_id, source, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
  updateConsumable: `UPDATE reference_consumables SET name = $1, rarity = $2, grade = $3, requires_slot = $4, buff = $5, duration_seconds = $6, category = $7, game_id = $8, source = $9, license = $10, attribution = $11, updated_at = $12 WHERE id = $13`,
  consumableExists: `SELECT 1 FROM reference_consumables WHERE id = $1`,
  getConsumable: `SELECT ${CONSUMABLE_COLS} FROM reference_consumables WHERE id = $1`,
  searchConsumables: `SELECT ${CONSUMABLE_COLS} FROM reference_consumables WHERE name ILIKE $1 ORDER BY name`,
  countConsumables: `SELECT COUNT(*) AS count FROM reference_consumables`,

  // Systems
  insertSystem: `INSERT INTO reference_systems (id, name, est_warp, is_deep_space, factions, level, coords_x, coords_y, has_mines, has_planets, has_missions, mine_resources, hostile_count, node_sizes, hazard_level, game_id, source, license, attribution, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
  updateSystem: `UPDATE reference_systems SET name = $1, est_warp = $2, is_deep_space = $3, factions = $4, level = $5, coords_x = $6, coords_y = $7, has_mines = $8, has_planets = $9, has_missions = $10, mine_resources = $11, hostile_count = $12, node_sizes = $13, hazard_level = $14, game_id = $15, source = $16, license = $17, attribution = $18, updated_at = $19 WHERE id = $20`,
  systemExists: `SELECT 1 FROM reference_systems WHERE id = $1`,
  getSystem: `SELECT ${SYSTEM_COLS} FROM reference_systems WHERE id = $1`,
  searchSystems: `SELECT ${SYSTEM_COLS} FROM reference_systems WHERE name ILIKE $1 ORDER BY name`,
  listSystemsByResource: `SELECT ${SYSTEM_COLS} FROM reference_systems WHERE mine_resources @> $1::jsonb ORDER BY est_warp ASC NULLS LAST, name`,
  countSystems: `SELECT COUNT(*) AS count FROM reference_systems`,
};
