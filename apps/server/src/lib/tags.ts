import type { Tag } from "@model-hub/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { projectTags as projectTagsTable, tags as tagsTable, type TagRow } from "../db/schema.js";

const MAX_TAG_NAME_LENGTH = 50;

export class InvalidTagNameError extends Error {}

export function normalizeTagName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new InvalidTagNameError("tag name cannot be empty");
  }
  if (trimmed.length > MAX_TAG_NAME_LENGTH) {
    throw new InvalidTagNameError(`tag name cannot exceed ${MAX_TAG_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/** Case-insensitive get-or-create: "Brackets" and "brackets" resolve to the same tag, keeping whichever casing was used first. */
export function getOrCreateTag(db: DbClient, rawName: string): TagRow {
  const name = normalizeTagName(rawName);
  const existing = db
    .select()
    .from(tagsTable)
    .where(sql`lower(${tagsTable.name}) = lower(${name})`)
    .get();
  if (existing) return existing;

  return db.insert(tagsTable).values({ name, createdAt: new Date() }).returning().get();
}

/** Removes the tag row if no project references it anymore — keeps the tag list free of dead entries. */
export function deleteTagIfUnused(db: DbClient, tagId: number): void {
  const stillUsed = db
    .select()
    .from(projectTagsTable)
    .where(eq(projectTagsTable.tagId, tagId))
    .get();
  if (!stillUsed) {
    db.delete(tagsTable).where(eq(tagsTable.id, tagId)).run();
  }
}

export function getTagsForProject(db: DbClient, projectId: number): Tag[] {
  const rows = db
    .select({ id: tagsTable.id, name: tagsTable.name })
    .from(projectTagsTable)
    .innerJoin(tagsTable, eq(projectTagsTable.tagId, tagsTable.id))
    .where(eq(projectTagsTable.projectId, projectId))
    .all();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function getTagsForProjects(db: DbClient, projectIds: number[]): Map<number, Tag[]> {
  const result = new Map<number, Tag[]>();
  if (projectIds.length === 0) return result;

  const rows = db
    .select({
      projectId: projectTagsTable.projectId,
      id: tagsTable.id,
      name: tagsTable.name,
    })
    .from(projectTagsTable)
    .innerJoin(tagsTable, eq(projectTagsTable.tagId, tagsTable.id))
    .where(inArray(projectTagsTable.projectId, projectIds))
    .all();

  for (const row of rows) {
    const list = result.get(row.projectId) ?? [];
    list.push({ id: row.id, name: row.name });
    result.set(row.projectId, list);
  }
  for (const list of result.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}
