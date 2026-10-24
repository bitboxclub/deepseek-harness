import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ICON_PATHS, APP_ICON_SIZES, appIconFilename, renderAppIcon } from '../scripts/render-app-icons.ts'

/** Bitmap edge recorded in a PNG's IHDR chunk. */
function pngEdge(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('application icon set', () => {
  it('commits exactly the sizes the renderer installs, each at its own edge', () => {
    const committed = readdirSync(APP_ICON_PATHS.outputDirectory).sort()
    expect(committed).toEqual([...APP_ICON_SIZES].map(appIconFilename).sort())
    for (const name of committed) {
      const png: Buffer = readFileSync(join(APP_ICON_PATHS.outputDirectory, name))
      const edge = Number(name.slice(0, name.indexOf('x')))
      // electron-builder derives the hicolor directory from the bitmap, not from the filename.
      expect(pngEdge(png)).toEqual({ width: edge, height: edge })
    }
  })

  it('rasterizes one entry from the vector source at the requested edge', async () => {
    const png = await renderAppIcon(readFileSync(APP_ICON_PATHS.source), 48)
    expect(pngEdge(png)).toEqual({ width: 48, height: 48 })
  })
})
