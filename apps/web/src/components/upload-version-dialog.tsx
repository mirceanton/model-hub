import { Loader2, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { formatBytes } from "@/lib/format"
import { useUploadVersion } from "@/lib/queries"

export function UploadVersionDialog({
  modelId,
  className,
}: {
  modelId: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [message, setMessage] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadVersion(modelId)

  function reset() {
    setFiles([])
    setMessage("")
    upload.reset()
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handleSubmit() {
    if (files.length === 0) return
    upload.mutate(
      { files, message },
      {
        onSuccess: () => {
          setOpen(false)
          reset()
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" className={className} />}>
        <Upload className="size-4" />
        Upload new version
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload new version</DialogTitle>
          <DialogDescription>
            Files with the same name replace the current version. This creates a new commit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".stl,.3mf,.obj"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
          />
          {files.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-md border p-2 text-xs text-muted-foreground">
              {files.map((file) => (
                <li key={file.name} className="flex justify-between gap-2">
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0">{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
          )}
          <Textarea
            placeholder="What changed in this version? (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
          />
          {upload.isError && <p className="text-xs text-destructive">{upload.error.message}</p>}
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={files.length === 0 || upload.isPending}
          >
            {upload.isPending && <Loader2 className="size-4 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
