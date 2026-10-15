import type { AppConfig } from "./config.js";
import { assertMigrationsCurrent, Database } from "./database.js";
import type { ScenarioRegistry } from "./scenario-loader.js";
import { PublishedScenarioRepository } from "./published-scenarios.js";
import { PostgresRunStore } from "./run-store.js";

export type PersistenceState = "disabled" | "initializing" | "ready" | "unavailable";

export class PersistenceCoordinator {
  readonly database?: Database;
  readonly repository?: PublishedScenarioRepository;
  readonly runStore?: PostgresRunStore;
  state: PersistenceState;

  constructor(private readonly config: AppConfig, private readonly registry: ScenarioRegistry) {
    this.state = config.persistenceMode === "published" ? "initializing" : "disabled";
    if (config.persistenceMode === "published") {
      this.database = new Database(config);
      this.repository = new PublishedScenarioRepository(this.database);
      if (config.runPersistenceEnabled) {
        this.runStore = new PostgresRunStore(this.database, config.runRetentionMs);
      }
    }
  }

  async initialize(): Promise<void> {
    if (!this.database || !this.repository) return;
    try {
      await assertMigrationsCurrent(this.database);
      await this.database.readiness();
      this.state = "ready";
    } catch (error) {
      this.state = "unavailable";
      throw error;
    }
  }

  async check(): Promise<boolean> {
    if (!this.database) return true;
    try { await this.database.readiness(); this.state = "ready"; return true; }
    catch { this.state = "unavailable"; return false; }
  }

  async close(): Promise<void> { await this.database?.close(); }
}
