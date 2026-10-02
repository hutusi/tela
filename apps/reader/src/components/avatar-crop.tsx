/**
 * Cropping a picture before it is uploaded (ADR 0033): a modal dialog with the image in a square,
 * a round mask over it, drag (or the arrow keys) to move it and a slider to zoom. Saving draws the
 * square at 256 px, as WebP where the browser can encode it and JPEG where not, and uploads that;
 * a Worker cannot resize an image, so this is where it is made small.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { type Crop, centred, cropRect, MAX_ZOOM, moveBy, PICTURE_SIDE, zoomTo } from '../lib/crop'
import { api } from '../store/api'
import { useStore } from '../store/hooks'

/** The square the picture is framed in, in CSS pixels. */
const VIEW = 280
/** A file larger than this is not decoded at all: a phone's photo is a few MB. */
const FILE_MAX_BYTES = 20 * 1024 * 1024

export type CropError = 'unreadable' | 'too_large' | 'rate_limited' | 'failed'

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** The crop drawn at 256 px: WebP, or JPEG where the browser cannot encode WebP. */
async function draw(image: HTMLImageElement, crop: Crop): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = PICTURE_SIDE
  canvas.height = PICTURE_SIDE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const { sx, sy, size } = cropRect(crop)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, sx, sy, size, size, 0, 0, PICTURE_SIDE, PICTURE_SIDE)
  const webp = await encode(canvas, 'image/webp', 0.86)
  if (webp?.type === 'image/webp') return webp
  return encode(canvas, 'image/jpeg', 0.88)
}

export function AvatarCrop({ file, onClose }: { file: File; onClose: (saved: boolean) => void }) {
  const t = useTranslations('settings')
  const { engine } = useStore()
  const dialog = useRef<HTMLDialogElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CropError | null>(
    file.size > FILE_MAX_BYTES ? 'too_large' : null,
  )

  useEffect(() => {
    // Once: React may run this twice in development, and an open dialog refuses a second.
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
    if (file.size > FILE_MAX_BYTES) return
    const made = URL.createObjectURL(file)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [file])

  const scale = crop ? (VIEW / Math.min(crop.width, crop.height)) * crop.zoom : 1

  async function save() {
    const img = image.current
    if (!img || !crop || busy) return
    setBusy(true)
    setError(null)
    try {
      const blob = await draw(img, crop)
      if (!blob) {
        setError('unreadable')
        return
      }
      const res = await api('/api/v1/avatar', { method: 'PUT', raw: blob })
      if (res.status === 429) {
        setError('rate_limited')
        return
      }
      if (!res.ok) {
        setError('failed')
        return
      }
      void engine.pull()
      onClose(true)
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  /** Which way each arrow key moves the picture. */
  const keys: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }

  return (
    <dialog
      ref={dialog}
      // Esc, or a form's own cancel: closing the dialog is cancelling the crop.
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose(false)
      }}
      aria-labelledby="avatar-crop-title"
      className="m-auto w-[min(328px,calc(100vw-32px))] rounded-xl border border-line bg-surface p-5 text-ink shadow-[0_16px_40px_rgba(0,0,0,.16)] backdrop:bg-[rgba(0,0,0,.45)]"
      data-testid="avatar-crop"
    >
      <h2 id="avatar-crop-title" className="mb-1 font-serif text-[20px] font-medium">
        {t('cropTitle')}
      </h2>
      <p className="mb-4 text-[13px] text-muted">{t('cropHint')}</p>
      <div
        role="img"
        aria-label={t('cropArea')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the frame moves the picture with the arrow keys.
        tabIndex={0}
        className="relative mx-auto touch-none select-none overflow-hidden rounded-lg bg-hover outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
        style={{ width: VIEW, height: VIEW, cursor: crop ? 'grab' : 'default' }}
        onPointerDown={(e) => {
          if (!crop) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY }
        }}
        onPointerMove={(e) => {
          const from = drag.current
          if (!from || from.pointer !== e.pointerId || !crop) return
          setCrop(moveBy(crop, e.clientX - from.x, e.clientY - from.y))
          drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY }
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onKeyDown={(e) => {
          const step = keys[e.key]
          if (!crop || !step) return
          e.preventDefault()
          const by = e.shiftKey ? 32 : 8
          setCrop(moveBy(crop, step[0] * by, step[1] * by))
        }}
        data-testid="avatar-crop-frame"
      >
        {url ? (
          <img
            ref={image}
            src={url}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              setCrop(centred(img.naturalWidth, img.naturalHeight, VIEW))
            }}
            onError={() => setError('unreadable')}
            className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
            style={
              crop
                ? {
                    width: crop.width * scale,
                    height: crop.height * scale,
                    transform: `translate(${crop.x}px, ${crop.y}px)`,
                  }
                : { visibility: 'hidden' }
            }
          />
        ) : null}
        {/* The circle the picture is shown in; outside it, dimmed. */}
        <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,.45)]" />
      </div>
      <label className="mt-4 flex items-center gap-3 text-[13px] text-ink-2">
        <span>{t('cropZoom')}</span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={crop?.zoom ?? 1}
          disabled={!crop}
          onChange={(e) => crop && setCrop(zoomTo(crop, Number(e.target.value)))}
          className="flex-1 accent-accent"
          data-testid="avatar-crop-zoom"
        />
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger" data-testid="avatar-crop-error">
          {t(`pictureErrors.${error}`)}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={busy}
          className="rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium text-ink hover:border-ink disabled:opacity-60"
        >
          {t('cropCancel')}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!crop || busy}
          className="rounded-full bg-ink px-4 py-[7px] text-[13px] font-medium text-paper disabled:opacity-60"
          data-testid="avatar-crop-save"
        >
          {busy ? t('cropSaving') : t('cropSave')}
        </button>
      </div>
    </dialog>
  )
}
