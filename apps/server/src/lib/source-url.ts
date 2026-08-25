/** Syntactic validation only — the SSRF-relevant IP checks happen at fetch time, see lib/safe-fetch.ts. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
