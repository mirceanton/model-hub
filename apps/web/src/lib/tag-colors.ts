import type { CSSProperties } from "react"

export function tagBadgeStyle(color: string): CSSProperties {
  return {
    backgroundColor: `${color}22`,
    borderColor: `${color}66`,
    color,
  }
}
