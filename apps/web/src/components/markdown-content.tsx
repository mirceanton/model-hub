import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

/** Renders user-authored markdown (e.g. a model's description) as sanitized React elements — never raw HTML, so this is safe against injected markup by construction. */
export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-pre:bg-muted prose-pre:text-foreground",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
