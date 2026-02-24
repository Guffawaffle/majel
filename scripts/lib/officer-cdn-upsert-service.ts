import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { UpsertOutcome } from "./cdn-ingest-pipeline.ts";
import { mapCdnOfficerToReferenceInput } from "../../src/server/services/cdn-mappers.js";
import { serializeNormalizedJson } from "../../src/server/services/json-number-normalize.js";

interface AbilityValue {
  value: number;
  chance: number;
}

export interface CdnOfficerAbilityRef {
  loca_id?: number | null;
  value_is_percentage?: boolean;
  values?: AbilityValue[] | null;
}

export interface CdnOfficerSummary {
  id: number;
  loca_id: number;
  rarity: number;
  class: number;
  faction?: { id?: number | null; loca_id?: number | null } | null;
  captain_ability?: CdnOfficerAbilityRef | null;
  ability?: CdnOfficerAbilityRef | null;
  below_decks_ability?: CdnOfficerAbilityRef | null;
  synergy_id?: number | null;
  max_rank?: number | null;
}

interface TraitProgression {
  required_rank: number;
  trait_id: number;
}

interface OfficerDetail {
  captain_ability?: { values?: AbilityValue[] | null };
  ability?: { values?: AbilityValue[] | null };
  below_decks_ability?: { values?: AbilityValue[] | null };
  trait_config?: { progression: TraitProgression[] };
  max_rank?: number | null;
}

interface OfficerAbilityText {
  name: string;
  description: string;
  shortDescription: string;
}

interface OfficerCdnUpsertServiceOptions {
  pool: pg.Pool;
  snapshotDir: string;
  rarityLabels: Record<number, string>;
  officerClassLabels: Record<number, string>;
  factionLabels: Record<number, string>;
  officerNameMap: Map<number, string>;
  officerAbilityTextMap: Map<number, OfficerAbilityText>;
  factionNameMap: Map<number, string>;
  traitNameMap: Map<number, string>;
  formatAbilityDescription: (
    description: string | null | undefined,
    values: AbilityValue[] | null | undefined,
    isPercentage: boolean
  ) => string | null;
}

export class OfficerCdnUpsertService {
  constructor(private readonly options: OfficerCdnUpsertServiceOptions) {}

  async upsertOne(officer: CdnOfficerSummary): Promise<UpsertOutcome> {
    const {
      pool,
      snapshotDir,
      rarityLabels,
      officerClassLabels,
      factionLabels,
      officerNameMap,
      officerAbilityTextMap,
      factionNameMap,
      traitNameMap,
      formatAbilityDescription,
    } = this.options;

    const detail = await this.loadOfficerDetail(officer.id, snapshotDir);

    const mapped = mapCdnOfficerToReferenceInput({
      officer,
      detail,
      rarityLabels,
      officerClassLabels,
      factionLabels,
      officerNameMap,
      officerAbilityTextMap,
      factionNameMap,
      traitNameMap,
      formatAbilityDescription,
    });

    const abilitiesJson = serializeNormalizedJson(mapped.abilities, "reference_officers.abilities");
    const factionJson = serializeNormalizedJson(mapped.faction, "reference_officers.faction");
    const traitConfigJson = serializeNormalizedJson(mapped.traitConfig, "reference_officers.trait_config");

    const result = await pool.query<{ inserted: boolean }>(`
      INSERT INTO reference_officers (id, name, rarity, group_name, captain_maneuver, officer_ability,
        below_deck_ability, abilities, tags, officer_game_id, officer_class, faction, synergy_id,
        max_rank, trait_config, source, source_url, license)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        rarity = EXCLUDED.rarity,
        group_name = EXCLUDED.group_name,
        captain_maneuver = EXCLUDED.captain_maneuver,
        officer_ability = EXCLUDED.officer_ability,
        below_deck_ability = EXCLUDED.below_deck_ability,
        abilities = EXCLUDED.abilities,
        officer_game_id = EXCLUDED.officer_game_id,
        officer_class = EXCLUDED.officer_class,
        faction = EXCLUDED.faction,
        synergy_id = EXCLUDED.synergy_id,
        max_rank = EXCLUDED.max_rank,
        trait_config = EXCLUDED.trait_config
      RETURNING (xmax = 0) as inserted
    `, [
      mapped.id,
      mapped.name,
      mapped.rarity,
      mapped.groupName,
      mapped.captainManeuver,
      mapped.officerAbility,
      mapped.belowDeckAbility,
      abilitiesJson,
      null,
      mapped.officerGameId,
      mapped.officerClass,
      factionJson,
      mapped.synergyId,
      mapped.maxRank,
      traitConfigJson,
      mapped.source,
      mapped.sourceUrl,
      "CC-BY-NC 4.0",
    ]);

    return result.rows[0]?.inserted ? "created" : "updated";
  }

  private async loadOfficerDetail(officerId: number, snapshotDir: string): Promise<OfficerDetail | null> {
    try {
      const detailPath = join(snapshotDir, "officer", `${officerId}.json`);
      if (!existsSync(detailPath)) {
        return null;
      }
      const detailRaw = await readFile(detailPath, "utf-8");
      return JSON.parse(detailRaw) as OfficerDetail;
    } catch {
      return null;
    }
  }
}
