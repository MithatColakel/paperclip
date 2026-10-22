import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Fork: production applied the Claude account pool migrations as 0306–0310.
// The 2026-10 upstream sync renumbered them behind upstream's files (now
// 0371–0375). The ledger (drizzle.__drizzle_migrations) keeps only each file's
// SHA-256, so moving a file is safe and changing one byte is not: the runner
// would take the file as new and run it again. None of them is idempotent.
// 0372–0374 would stop the boot (42701/42P07), and 0375 would re-run its
// backfills: every account's origin becomes legacy_host_pool, and accounts an
// admin disabled become owner-disabled. Never edit these files. If one must
// change, map its deployed hash to it in mapHashesToMigrationFiles (client.ts),
// as upstream does for 0355. Add a fork migration here once production has
// applied it.
const deployedForkMigrations = [
  { name: "faulty_the_executioner", deployedAs: "0306", hash: "723bbb0b9daf9159af2e3b10fa4c6fbc1c40c26943d90e268f1aec319d3262e7" },
  { name: "many_the_fury", deployedAs: "0307", hash: "0da3c28648d59952f0af884bec6f96e7ea3d8781c22124a8250ea5a8c21419f8" },
  { name: "spicy_silk_fever", deployedAs: "0308", hash: "9dd6589262a91d7c552ad9b0be0721638aa1ac2a867a5c582cf70683785ee456" },
  { name: "smooth_killmonger", deployedAs: "0309", hash: "76eeaca8b16547508dc2d1227c624e5d0b9fc0ec0a785c05fbf9e084999b7773" },
  { name: "productive_veda", deployedAs: "0310", hash: "76d117430005c697a60c6df8b59a8e0e5e7174dc7e72372ad560023f36b37aca" },
] as const;

type JournalEntry = { idx: number; tag: string };

async function journalTags(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries.map((entry) => entry.tag);
}

/** The digest the runner records: sha256 of the file read as UTF-8 (client.ts). */
async function migrationHash(tag: string): Promise<string> {
  const content = await readFile(new URL(`./migrations/${tag}.sql`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describe("fork migration receipts", () => {
  it("keeps the five deployed fork migrations byte-identical after renumbering", async () => {
    const tags = await journalTags();
    for (const migration of deployedForkMigrations) {
      const tag = tags.find((candidate) => candidate.replace(/^\d{4}_/, "") === migration.name);
      expect(tag, `${migration.deployedAs}_${migration.name} is missing from the journal`).toBeDefined();
      expect(await migrationHash(tag!), `${tag} no longer matches what production applied as ${migration.deployedAs}`)
        .toBe(migration.hash);
    }
  });

  it("keeps them in their deployed order, as one block", async () => {
    const tags = await journalTags();
    const positions = deployedForkMigrations.map((migration) =>
      tags.findIndex((tag) => tag.replace(/^\d{4}_/, "") === migration.name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.map((_, offset) => positions[0]! + offset));
  });
});
