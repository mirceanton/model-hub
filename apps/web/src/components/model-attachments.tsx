import type { FileEntry } from "@model-hub/shared"
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { formatBytes } from "@/lib/format"
import { fileUrl, isImageAttachment, isPdfAttachment } from "@/lib/model-loader"

function fileName(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath
}

/**
 * Dedicated gallery for a model's image/PDF attachments (build photos,
 * instruction sheets) — separate from the 3D viewer/thumbnail and from the
 * raw Files list. Images render as a thumbnail grid with a lightbox for the
 * full-size view; PDFs get an inline `<embed>` preview plus open/download
 * links. Both are served through the same authenticated
 * /api/models/:id/files/* route as everything else (see files.ts) — no
 * separate static path.
 */
export function ModelAttachments({
  modelId,
  attachments,
}: {
  modelId: number
  attachments: FileEntry[]
}) {
  const images = attachments.filter((f) => isImageAttachment(f.extension))
  const pdfs = attachments.filter((f) => isPdfAttachment(f.extension))
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  if (attachments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No attachments yet. Build photos and instruction PDFs uploaded alongside the model files
        will show up here.
      </p>
    )
  }

  const activeImage = lightboxIndex != null ? images[lightboxIndex] : undefined

  return (
    <div className="flex flex-col gap-6">
      {images.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Images ({images.length})
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {images.map((file, index) => (
              <button
                key={file.relativePath}
                type="button"
                onClick={() => setLightboxIndex(index)}
                className="group aspect-square overflow-hidden rounded-md border bg-muted/50"
                title={file.relativePath}
              >
                <img
                  src={fileUrl(modelId, file.relativePath)}
                  alt={file.relativePath}
                  loading="lazy"
                  className="size-full object-cover transition-transform group-hover:scale-105"
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {pdfs.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            PDFs ({pdfs.length})
          </h3>
          <div className="flex flex-col gap-3">
            {pdfs.map((file) => (
              <div key={file.relativePath} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm">{file.relativePath}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      nativeButton={false}
                      render={
                        <a
                          href={fileUrl(modelId, file.relativePath)}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      <ExternalLink className="size-4" />
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      title={`Download ${file.relativePath}`}
                      nativeButton={false}
                      render={
                        <a
                          href={fileUrl(modelId, file.relativePath)}
                          download={fileName(file.relativePath)}
                        />
                      }
                    >
                      <Download className="size-4" />
                    </Button>
                  </div>
                </div>
                <embed
                  src={fileUrl(modelId, file.relativePath)}
                  type="application/pdf"
                  className="h-64 w-full rounded-md border bg-muted/30"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={activeImage != null} onOpenChange={(open) => !open && setLightboxIndex(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] gap-3 p-3 sm:max-w-3xl">
          <DialogTitle className="truncate pr-6 text-sm font-normal text-muted-foreground">
            {activeImage?.relativePath}
          </DialogTitle>
          {activeImage && (
            <div className="flex items-center gap-2">
              {images.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label="Previous image"
                  onClick={() =>
                    setLightboxIndex((i) => (i == null ? i : (i - 1 + images.length) % images.length))
                  }
                >
                  <ChevronLeft className="size-5" />
                </Button>
              )}
              <img
                src={fileUrl(modelId, activeImage.relativePath)}
                alt={activeImage.relativePath}
                className="max-h-[70vh] min-w-0 flex-1 rounded-md object-contain"
              />
              {images.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label="Next image"
                  onClick={() => setLightboxIndex((i) => (i == null ? i : (i + 1) % images.length))}
                >
                  <ChevronRight className="size-5" />
                </Button>
              )}
            </div>
          )}
          {activeImage && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <a
                    href={fileUrl(modelId, activeImage.relativePath)}
                    download={fileName(activeImage.relativePath)}
                  />
                }
              >
                <Download className="size-4" />
                Download
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
