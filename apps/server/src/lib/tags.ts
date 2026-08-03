import type { Tag } from "@model-hub/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { modelTags as modelTagsTable, tags as tagsTable, type TagRow } from "../db/schema.js";

const MAX_TAG_NAME_LENGTH = 50;

// A curated set of distinct, legible hues (Tailwind ~500 shades) rather than
// fully random HSL, so every generated color reads clearly as a chip/dot.
const TAG_COLOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
] as const;

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export class InvalidTagNameError extends Error {}
export class InvalidTagColorError extends Error {}
export class DuplicateTagNameError extends Error {}

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

export function normalizeTagColor(rawColor: string): string {
  const trimmed = rawColor.trim();
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new InvalidTagColorError("color must be a hex string like #3b82f6");
  }
  return trimmed.toLowerCase();
}

export function randomTagColor(): string {
  const index = Math.floor(Math.random() * TAG_COLOR_PALETTE.length);
  return TAG_COLOR_PALETTE[index] ?? TAG_COLOR_PALETTE[0];
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

  return db
    .insert(tagsTable)
    .values({ name, color: randomTagColor(), createdAt: new Date() })
    .returning()
    .get();
}

/** Updates a tag's name and/or color. Returns undefined if the tag doesn't exist. */
export function updateTag(
  db: DbClient,
  tagId: number,
  patch: { name?: string; color?: string },
): TagRow | undefined {
  const updates: { name?: string; color?: string } = {};

  if (patch.name !== undefined) {
    const name = normalizeTagName(patch.name);
    const conflict = db
      .select()
      .from(tagsTable)
      .where(sql`lower(${tagsTable.name}) = lower(${name}) and ${tagsTable.id} != ${tagId}`)
      .get();
    if (conflict) {
      throw new DuplicateTagNameError(`a tag named "${name}" already exists`);
    }
    updates.name = name;
  }

  if (patch.color !== undefined) {
    updates.color = normalizeTagColor(patch.color);
  }

  if (Object.keys(updates).length === 0) {
    return db.select().from(tagsTable).where(eq(tagsTable.id, tagId)).get();
  }

  return db.update(tagsTable).set(updates).where(eq(tagsTable.id, tagId)).returning().get();
}

/** Removes the tag row if no model references it anymore — keeps the tag list free of dead entries. */
export function deleteTagIfUnused(db: DbClient, tagId: number): void {
  const stillUsed = db
    .select()
    .from(modelTagsTable)
    .where(eq(modelTagsTable.tagId, tagId))
    .get();
  if (!stillUsed) {
    db.delete(tagsTable).where(eq(tagsTable.id, tagId)).run();
  }
}

/** Deletes a tag outright, detaching it from every model that had it. Returns false if the tag didn't exist. */
export function deleteTag(db: DbClient, tagId: number): boolean {
  const result = db.delete(tagsTable).where(eq(tagsTable.id, tagId)).run();
  return result.changes > 0;
}

export function getTagsForModel(db: DbClient, modelId: number): Tag[] {
  const rows = db
    .select({ id: tagsTable.id, name: tagsTable.name, color: tagsTable.color })
    .from(modelTagsTable)
    .innerJoin(tagsTable, eq(modelTagsTable.tagId, tagsTable.id))
    .where(eq(modelTagsTable.modelId, modelId))
    .all();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function getTagsForModels(db: DbClient, modelIds: number[]): Map<number, Tag[]> {
  const result = new Map<number, Tag[]>();
  if (modelIds.length === 0) return result;

  const rows = db
    .select({
      modelId: modelTagsTable.modelId,
      id: tagsTable.id,
      name: tagsTable.name,
      color: tagsTable.color,
    })
    .from(modelTagsTable)
    .innerJoin(tagsTable, eq(modelTagsTable.tagId, tagsTable.id))
    .where(inArray(modelTagsTable.modelId, modelIds))
    .all();

  for (const row of rows) {
    const list = result.get(row.modelId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    result.set(row.modelId, list);
  }
  for (const list of result.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}
