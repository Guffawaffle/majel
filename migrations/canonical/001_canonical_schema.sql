CREATE SCHEMA IF NOT EXISTS canonical;

CREATE TABLE IF NOT EXISTS canonical.factions (
  id BIGSERIAL PRIMARY KEY,
  faction_game_id BIGINT NOT NULL UNIQUE,
  loca_id BIGINT
);

CREATE TABLE IF NOT EXISTS canonical.resources (
  id BIGSERIAL PRIMARY KEY,
  resource_game_id BIGINT NOT NULL UNIQUE,
  resource_type TEXT,
  grade INTEGER,
  loca_id BIGINT
);

CREATE TABLE IF NOT EXISTS canonical.translations (
  id BIGSERIAL PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'en',
  namespace TEXT NOT NULL,
  translation_key TEXT NOT NULL,
  translation_text TEXT NOT NULL,
  translation_external_id TEXT,
  UNIQUE (locale, namespace, translation_key)
);

CREATE TABLE IF NOT EXISTS canonical.asset_refs (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  art_id BIGINT,
  loca_id BIGINT,
  UNIQUE (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS canonical.officers (
  id BIGSERIAL PRIMARY KEY,
  officer_game_id BIGINT NOT NULL UNIQUE,
  faction_id BIGINT REFERENCES canonical.factions(id),
  rarity INTEGER,
  officer_class INTEGER,
  synergy_game_id BIGINT,
  max_rank INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS canonical.officer_levels (
  id BIGSERIAL PRIMARY KEY,
  officer_id BIGINT NOT NULL REFERENCES canonical.officers(id) ON DELETE CASCADE,
  level_number INTEGER NOT NULL,
  xp_required BIGINT,
  UNIQUE (officer_id, level_number)
);

CREATE TABLE IF NOT EXISTS canonical.officer_level_resources (
  id BIGSERIAL PRIMARY KEY,
  officer_level_id BIGINT NOT NULL REFERENCES canonical.officer_levels(id) ON DELETE CASCADE,
  resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (officer_level_id, resource_id)
);

CREATE TABLE IF NOT EXISTS canonical.ships (
  id BIGSERIAL PRIMARY KEY,
  ship_game_id BIGINT NOT NULL UNIQUE,
  faction_id BIGINT REFERENCES canonical.factions(id),
  hull_type TEXT,
  ship_class TEXT,
  grade INTEGER,
  rarity INTEGER,
  max_tier INTEGER,
  max_level INTEGER,
  blueprints_required BIGINT,
  build_time_in_seconds BIGINT
);

CREATE TABLE IF NOT EXISTS canonical.ship_levels (
  id BIGSERIAL PRIMARY KEY,
  ship_id BIGINT NOT NULL REFERENCES canonical.ships(id) ON DELETE CASCADE,
  level_number INTEGER NOT NULL,
  xp_required BIGINT,
  shield BIGINT,
  health BIGINT,
  UNIQUE (ship_id, level_number)
);

CREATE TABLE IF NOT EXISTS canonical.ship_build_costs (
  id BIGSERIAL PRIMARY KEY,
  ship_id BIGINT NOT NULL REFERENCES canonical.ships(id) ON DELETE CASCADE,
  resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (ship_id, resource_id)
);

CREATE TABLE IF NOT EXISTS canonical.ship_repair_costs (
  id BIGSERIAL PRIMARY KEY,
  ship_id BIGINT NOT NULL REFERENCES canonical.ships(id) ON DELETE CASCADE,
  resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (ship_id, resource_id)
);

CREATE TABLE IF NOT EXISTS canonical.research_trees (
  id BIGSERIAL PRIMARY KEY,
  tree_game_id BIGINT NOT NULL UNIQUE,
  loca_id BIGINT,
  tree_type TEXT
);

CREATE TABLE IF NOT EXISTS canonical.research_nodes (
  id BIGSERIAL PRIMARY KEY,
  research_game_id BIGINT NOT NULL UNIQUE,
  research_tree_id BIGINT REFERENCES canonical.research_trees(id) ON DELETE SET NULL,
  row_num INTEGER,
  column_num INTEGER,
  unlock_level INTEGER,
  view_level INTEGER,
  max_level INTEGER,
  generation INTEGER
);

CREATE TABLE IF NOT EXISTS canonical.research_buffs (
  id BIGSERIAL PRIMARY KEY,
  research_node_id BIGINT NOT NULL REFERENCES canonical.research_nodes(id) ON DELETE CASCADE,
  buff_game_id BIGINT NOT NULL,
  value_is_percentage BOOLEAN,
  show_percentage BOOLEAN,
  value_type TEXT,
  UNIQUE (research_node_id, buff_game_id)
);

CREATE TABLE IF NOT EXISTS canonical.research_buff_levels (
  id BIGSERIAL PRIMARY KEY,
  research_buff_id BIGINT NOT NULL REFERENCES canonical.research_buffs(id) ON DELETE CASCADE,
  level_number INTEGER NOT NULL,
  value_numeric DOUBLE PRECISION,
  UNIQUE (research_buff_id, level_number)
);

CREATE TABLE IF NOT EXISTS canonical.research_levels (
  id BIGSERIAL PRIMARY KEY,
  research_node_id BIGINT NOT NULL REFERENCES canonical.research_nodes(id) ON DELETE CASCADE,
  level_number INTEGER NOT NULL,
  research_time_seconds BIGINT,
  hard_currency_cost BIGINT,
  UNIQUE (research_node_id, level_number)
);

CREATE TABLE IF NOT EXISTS canonical.research_level_resources (
  id BIGSERIAL PRIMARY KEY,
  research_level_id BIGINT NOT NULL REFERENCES canonical.research_levels(id) ON DELETE CASCADE,
  resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (research_level_id, resource_id)
);

CREATE TABLE IF NOT EXISTS canonical.research_requirements (
  id BIGSERIAL PRIMARY KEY,
  research_level_id BIGINT NOT NULL REFERENCES canonical.research_levels(id) ON DELETE CASCADE,
  requirement_type TEXT NOT NULL,
  requirement_external_id TEXT,
  requirement_level INTEGER,
  UNIQUE (research_level_id, requirement_type, requirement_external_id)
);

CREATE TABLE IF NOT EXISTS canonical.research_rewards (
  id BIGSERIAL PRIMARY KEY,
  research_level_id BIGINT NOT NULL REFERENCES canonical.research_levels(id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL,
  reward_external_id TEXT,
  amount BIGINT,
  UNIQUE (research_level_id, reward_type, reward_external_id)
);

CREATE TABLE IF NOT EXISTS canonical.buildings (
  id BIGSERIAL PRIMARY KEY,
  building_game_id BIGINT NOT NULL UNIQUE,
  section TEXT,
  max_level INTEGER,
  unlock_level INTEGER
);

CREATE TABLE IF NOT EXISTS canonical.building_buffs (
  id BIGSERIAL PRIMARY KEY,
  building_id BIGINT NOT NULL REFERENCES canonical.buildings(id) ON DELETE CASCADE,
  buff_game_id BIGINT NOT NULL,
  UNIQUE (building_id, buff_game_id)
);

CREATE TABLE IF NOT EXISTS canonical.building_buff_levels (
  id BIGSERIAL PRIMARY KEY,
  building_buff_id BIGINT NOT NULL REFERENCES canonical.building_buffs(id) ON DELETE CASCADE,
  level_number INTEGER NOT NULL,
  value_numeric DOUBLE PRECISION,
  UNIQUE (building_buff_id, level_number)
);

CREATE TABLE IF NOT EXISTS canonical.building_levels (
  id BIGSERIAL PRIMARY KEY,
  building_id BIGINT NOT NULL REFERENCES canonical.buildings(id) ON DELETE CASCADE,
  level_number INTEGER NOT NULL,
  build_time_seconds BIGINT,
  strength BIGINT,
  strength_increase BIGINT,
  UNIQUE (building_id, level_number)
);

CREATE TABLE IF NOT EXISTS canonical.building_level_resources (
  id BIGSERIAL PRIMARY KEY,
  building_level_id BIGINT NOT NULL REFERENCES canonical.building_levels(id) ON DELETE CASCADE,
  resource_id BIGINT NOT NULL REFERENCES canonical.resources(id),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  UNIQUE (building_level_id, resource_id)
);

CREATE TABLE IF NOT EXISTS canonical.building_requirements (
  id BIGSERIAL PRIMARY KEY,
  building_level_id BIGINT NOT NULL REFERENCES canonical.building_levels(id) ON DELETE CASCADE,
  requirement_type TEXT NOT NULL,
  requirement_external_id TEXT,
  requirement_level INTEGER,
  UNIQUE (building_level_id, requirement_type, requirement_external_id)
);

CREATE TABLE IF NOT EXISTS canonical.systems (
  id BIGSERIAL PRIMARY KEY,
  system_game_id BIGINT NOT NULL UNIQUE,
  level INTEGER,
  coords_x INTEGER,
  coords_y INTEGER,
  est_warp INTEGER,
  est_warp_with_superhighways INTEGER,
  is_deep_space BOOLEAN,
  is_mirror_universe BOOLEAN,
  is_wave_defense BOOLEAN,
  is_surge_system BOOLEAN,
  is_regional_space BOOLEAN,
  hazards_enabled BOOLEAN,
  hazard_level INTEGER
);

CREATE TABLE IF NOT EXISTS canonical.system_factions (
  id BIGSERIAL PRIMARY KEY,
  system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
  faction_id BIGINT NOT NULL REFERENCES canonical.factions(id),
  UNIQUE (system_id, faction_id)
);

CREATE TABLE IF NOT EXISTS canonical.system_mines (
  id BIGSERIAL PRIMARY KEY,
  system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
  mine_game_id BIGINT,
  resource_id BIGINT REFERENCES canonical.resources(id),
  rate BIGINT,
  amount BIGINT,
  coords_x INTEGER,
  coords_y INTEGER,
  UNIQUE (system_id, mine_game_id)
);

CREATE TABLE IF NOT EXISTS canonical.system_planets (
  id BIGSERIAL PRIMARY KEY,
  system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
  planet_game_id BIGINT,
  coords_x INTEGER,
  coords_y INTEGER,
  slots INTEGER,
  UNIQUE (system_id, planet_game_id)
);

CREATE TABLE IF NOT EXISTS canonical.system_missions (
  id BIGSERIAL PRIMARY KEY,
  system_id BIGINT NOT NULL REFERENCES canonical.systems(id) ON DELETE CASCADE,
  mission_game_id BIGINT NOT NULL,
  UNIQUE (system_id, mission_game_id)
);
