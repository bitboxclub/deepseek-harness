/**
 * Render the Linux application icon set from `resources/icon.svg`.
 *
 * electron-builder installs each `<N>x<N>.png` of `resources/icons` into
 * `hicolor/<N>x<N>/apps/`, and a desktop environment resolves an icon only for a size its
 * `index.theme` lists, so the set covers the standard sizes instead of one large bitmap. Each
 * entry is rasterized from the vector source at four times its edge and downsampled with a Lanczos
 * filter: rendering straight at 16 px stair-steps the whale's outline, and reusing one downscaled
 * bitmap blurs the large entries.
 *
 * Rerun `pnpm run render:app-icons` in `apps/desktop` after changing the vector source.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Bitmap edges of the installed set: the sizes a freedesktop theme resolves without extra hints. */
export const APP_ICON_SIZES = [16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512] as const

/** Rasterized pixels per installed pixel; the Lanczos downsample then removes the stair-steps. */
export const APP_ICON_SUPERSAMPLE = 4

/** Vector source and committed output directory of the icon set. */
export const APP_ICON_PATHS = {
  source: fileURLToPath(new URL('../resources/icon.svg', import.meta.url)),
  outputDirectory: fileURLToPath(new URL('../resources/icons', import.meta.url)),
} as const

/** Coordinate space of the vector canvas; the application tile fills 1024 of its 1104 units. */
const SOURCE_CANVAS_EDGE = 1104

/** Points per inch that SVG renderers scale a document's user units against. */
const SOURCE_DENSITY = 72

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Installed basename of one entry.
 *
 * electron-builder reads the pixel size out of the bitmap and installs it under
 * `hicolor/<N>x<N>/apps`, so the filename states the edge the bitmap already carries.
 * @param edge - Bitmap edge in pixels.
 * @returns The committed basename for that edge.
 */
export function appIconFilename(edge: number): string {
  return `${String(edge)}x${String(edge)}.png`
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('app icons: rendered bitmap is not a PNG stream')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * Rasterize one entry of the icon set.
 * @param svg - SVG document with the application tile in its viewBox.
 * @param edge - Bitmap edge in pixels.
 * @returns The PNG stream, checked to be square at that edge.
 */
export async function renderAppIcon(svg: Buffer, edge: number): Promise<Buffer> {
  const png = await sharp(svg, { density: SOURCE_DENSITY * APP_ICON_SUPERSAMPLE * edge / SOURCE_CANVAS_EDGE })
    .resize(edge, edge, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
  const { width, height } = pngDimensions(png)
  if (width !== edge || height !== edge) {
    throw new Error(`app icons: rendered ${String(width)}x${String(height)}, expected ${String(edge)}`)
  }
  return png
}

async function main(): Promise<void> {
  const svg = await readFile(APP_ICON_PATHS.source)
  await mkdir(APP_ICON_PATHS.outputDirectory, { recursive: true })
  for (const edge of APP_ICON_SIZES) {
    await writeFile(join(APP_ICON_PATHS.outputDirectory, appIconFilename(edge)), await renderAppIcon(svg, edge))
  }
  console.info(`app icons: wrote ${String(APP_ICON_SIZES.length)} bitmaps to ${APP_ICON_PATHS.outputDirectory}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
