import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

export type UpsertOutcome = "created" | "updated";

export interface PruneStats {
  records: number;
  overlays: number;
  targets: number;
}

export interface IngestStats {
  created: number;
  updated: number;
  total: number;
}

export interface EntityIngestResult {
  entity: "ships" | "officers";
  pruned: PruneStats;
  upsert: IngestStats;
}

export interface PipelineRunResult {
  ships?: EntityIngestResult;
  officers?: EntityIngestResult;
}

export interface IngestLogger {
  info(message: string): void;
  warn(message: string): void;
}

const DEFAULT_LOGGER: IngestLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

abstract class CdnEntityIngestor<TSummary extends { id: number }> {
  constructor(
    protected readonly pool: pg.Pool,
    protected readonly snapshotDir: string,
    protected readonly logger: IngestLogger,
  ) {}

  protected abstract readonly entity: "ships" | "officers";
  protected abstract readonly summaryRelativePath: string;
  protected abstract readonly idPrefix: "cdn:ship:" | "cdn:officer:";
  protected abstract prune(validIds: string[]): Promise<PruneStats>;
  protected abstract upsertOne(summary: TSummary): Promise<UpsertOutcome>;

  async run(): Promise<EntityIngestResult | null> {
    const summaries = await this.loadSummaries();
    if (summaries == null) {
      return null;
    }

    const validIds = summaries.map((entry) => `${this.idPrefix}${entry.id}`);
    const pruned = await this.prune(validIds);

    let created = 0;
    let updated = 0;
    for (const summary of summaries) {
      const outcome = await this.upsertOne(summary);
      if (outcome === "created") created++;
      else updated++;
    }

    return {
      entity: this.entity,
      pruned,
      upsert: { created, updated, total: summaries.length },
    };
  }

  private async loadSummaries(): Promise<TSummary[] | null> {
    const summaryPath = join(this.snapshotDir, this.summaryRelativePath);
    try {
      const raw = await readFile(summaryPath, "utf-8");
      return JSON.parse(raw) as TSummary[];
    } catch {
      this.logger.warn(`⚠️  ${this.entity} summary not found at ${summaryPath}, skipping ${this.entity}`);
      return null;
    }
  }
}

interface ShipIngestorOptions<TShip extends { id: number }> {
  pool: pg.Pool;
  snapshotDir: string;
  logger?: IngestLogger;
  upsertOne: (ship: TShip) => Promise<UpsertOutcome>;
}

export class ShipCdnIngestor<TShip extends { id: number }> extends CdnEntityIngestor<TShip> {
  protected readonly entity = "ships" as const;
  protected readonly summaryRelativePath = join("ship", "summary.json");
  protected readonly idPrefix = "cdn:ship:" as const;

  private readonly upsertHandler: (ship: TShip) => Promise<UpsertOutcome>;

  constructor(options: ShipIngestorOptions<TShip>) {
    super(options.pool, options.snapshotDir, options.logger ?? DEFAULT_LOGGER);
    this.upsertHandler = options.upsertOne;
  }

  protected async prune(validIds: string[]): Promise<PruneStats> {
    const overlayResult = await this.pool.query(
      `DELETE FROM ship_overlay WHERE ref_id LIKE 'cdn:ship:%' AND NOT (ref_id = ANY($1::text[]))`,
      [validIds],
    );
    const targetResult = await this.pool.query(
      `DELETE FROM targets WHERE ref_id LIKE 'cdn:ship:%' AND NOT (ref_id = ANY($1::text[]))`,
      [validIds],
    );
    const recordResult = await this.pool.query(
      `DELETE FROM reference_ships WHERE id LIKE 'cdn:ship:%' AND NOT (id = ANY($1::text[]))`,
      [validIds],
    );

    return {
      records: recordResult.rowCount ?? 0,
      overlays: overlayResult.rowCount ?? 0,
      targets: targetResult.rowCount ?? 0,
    };
  }

  protected upsertOne(summary: TShip): Promise<UpsertOutcome> {
    return this.upsertHandler(summary);
  }
}

interface OfficerIngestorOptions<TOfficer extends { id: number }> {
  pool: pg.Pool;
  snapshotDir: string;
  logger?: IngestLogger;
  upsertOne: (officer: TOfficer) => Promise<UpsertOutcome>;
}

export class OfficerCdnIngestor<TOfficer extends { id: number }> extends CdnEntityIngestor<TOfficer> {
  protected readonly entity = "officers" as const;
  protected readonly summaryRelativePath = join("officer", "summary.json");
  protected readonly idPrefix = "cdn:officer:" as const;

  private readonly upsertHandler: (officer: TOfficer) => Promise<UpsertOutcome>;

  constructor(options: OfficerIngestorOptions<TOfficer>) {
    super(options.pool, options.snapshotDir, options.logger ?? DEFAULT_LOGGER);
    this.upsertHandler = options.upsertOne;
  }

  protected async prune(validIds: string[]): Promise<PruneStats> {
    const overlayResult = await this.pool.query(
      `DELETE FROM officer_overlay WHERE ref_id LIKE 'cdn:officer:%' AND NOT (ref_id = ANY($1::text[]))`,
      [validIds],
    );
    const targetResult = await this.pool.query(
      `DELETE FROM targets WHERE ref_id LIKE 'cdn:officer:%' AND NOT (ref_id = ANY($1::text[]))`,
      [validIds],
    );
    const recordResult = await this.pool.query(
      `DELETE FROM reference_officers WHERE id LIKE 'cdn:officer:%' AND NOT (id = ANY($1::text[]))`,
      [validIds],
    );

    return {
      records: recordResult.rowCount ?? 0,
      overlays: overlayResult.rowCount ?? 0,
      targets: targetResult.rowCount ?? 0,
    };
  }

  protected upsertOne(summary: TOfficer): Promise<UpsertOutcome> {
    return this.upsertHandler(summary);
  }
}

export class CdnIngestPipeline {
  constructor(
    private readonly ingestors: Array<CdnEntityIngestor<{ id: number }>>,
    private readonly logger: IngestLogger = DEFAULT_LOGGER,
  ) {}

  async run(): Promise<PipelineRunResult> {
    const result: PipelineRunResult = {};

    for (const ingestor of this.ingestors) {
      const entityResult = await ingestor.run();
      if (!entityResult) continue;

      if (entityResult.entity === "ships") {
        result.ships = entityResult;
      } else {
        result.officers = entityResult;
      }

      if (entityResult.pruned.records > 0) {
        this.logger.info(
          `   🧹 Pruned ${entityResult.pruned.records} stale CDN ${entityResult.entity} `
          + `(${entityResult.pruned.overlays} overlays, ${entityResult.pruned.targets} targets)`
        );
      }
      this.logger.info(
        `   ✅ ${entityResult.entity[0].toUpperCase() + entityResult.entity.slice(1)}: `
          + `${entityResult.upsert.created} created, ${entityResult.upsert.updated} updated `
          + `(${entityResult.upsert.total} total)`
      );
    }

    return result;
  }
}
