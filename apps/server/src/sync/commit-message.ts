const MAX_LISTED_FILES = 5;

/** Auto-generated message for a commit created from changes noticed on disk (not via the UI). */
export function generateAutoCommitMessage(changedPaths: string[]): string {
  if (changedPaths.length === 0) {
    return "Synced external changes";
  }

  const listed = changedPaths.slice(0, MAX_LISTED_FILES);
  const remainder = changedPaths.length - listed.length;
  const suffix = remainder > 0 ? `, and ${remainder} more` : "";
  return `Synced external changes: ${listed.join(", ")}${suffix}`;
}
