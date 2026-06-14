import { test, expect, describe } from "bun:test";
import { detectMigrationPaths, MIGRATION_GLOBS } from "../src/epic-migrations";

describe("detectMigrationPaths — pure migration-path detection (#645)", () => {
  test("empty input → empty output", () => {
    expect(detectMigrationPaths([])).toEqual([]);
  });

  test("matches each glob family", () => {
    expect(detectMigrationPaths(["server/migrations/001_init.sql"])).toEqual([
      "server/migrations/001_init.sql",
    ]);
    expect(detectMigrationPaths(["drizzle/0000_snapshot.sql"])).toEqual([
      "drizzle/0000_snapshot.sql",
    ]);
    expect(detectMigrationPaths(["db/schema/init.cypher"])).toEqual(["db/schema/init.cypher"]);
    expect(detectMigrationPaths(["infra/neo4j/seed.cql"])).toEqual(["infra/neo4j/seed.cql"]);
    expect(detectMigrationPaths(["backend/alembic/versions/abc.py"])).toEqual([
      "backend/alembic/versions/abc.py",
    ]);
  });

  test("matches a migrations dir at the repo root (no leading segment)", () => {
    expect(detectMigrationPaths(["migrations/001.sql"])).toEqual(["migrations/001.sql"]);
  });

  test("rejects non-migration paths", () => {
    expect(
      detectMigrationPaths([
        "src/foo.ts",
        "README.md",
        "ui/src/lib/api.ts",
        "package.json",
        "docs/migration-guide.md", // a doc *about* migrations is NOT a migration file
        "src/migrate.ts", // a code file named migrate is not under a migrations dir
      ]),
    ).toEqual([]);
  });

  test("filters a mixed list to only the migration paths, preserving order", () => {
    expect(
      detectMigrationPaths([
        "src/foo.ts",
        "drizzle/0001.sql",
        "README.md",
        "server/migrations/002.sql",
        "src/bar.ts",
      ]),
    ).toEqual(["drizzle/0001.sql", "server/migrations/002.sql"]);
  });

  test("dedupes repeated paths, first occurrence wins (order-preserving)", () => {
    expect(
      detectMigrationPaths([
        "drizzle/a.sql",
        "migrations/b.sql",
        "drizzle/a.sql",
        "migrations/b.sql",
      ]),
    ).toEqual(["drizzle/a.sql", "migrations/b.sql"]);
  });

  test("MIGRATION_GLOBS is the single source of truth (non-empty, includes the core families)", () => {
    expect(MIGRATION_GLOBS).toContain("**/migrations/**");
    expect(MIGRATION_GLOBS).toContain("**/drizzle/**");
    expect(MIGRATION_GLOBS).toContain("**/*.cypher");
    expect(MIGRATION_GLOBS).toContain("**/neo4j/**");
    expect(MIGRATION_GLOBS).toContain("**/alembic/**");
  });
});
