import path from 'path'
import fs from 'fs-extra'
import { blue, cyan, dim, green, yellow } from 'kolorist'
import { Presets, SingleBar } from 'cli-progress'
import { parseRangeString } from '@slidev/parser/core'
import type { SlideInfo } from '@slidev/types'
import { packageExists } from './themes'

export interface ExportOptions {
  total: number
  range?: string
  slides: SlideInfo[]
  port?: number
  base?: string
  format?: 'pdf' | 'png' | 'md'
  output?: string
  timeout?: number
  dark?: boolean
  routerMode?: 'hash' | 'history'
  width?: number
  height?: number
  withClicks?: boolean
}

function createSlidevProgress(indeterminate = false) {
  function getSpinner(n = 0) {
    return [cyan('●'), green('◆'), blue('■'), yellow('▲')][n % 4]
  }
  let current = 0
  let spinner = 0
  let timer: any

  const progress = new SingleBar({
    clearOnComplete: true,
    hideCursor: true,
    format: `  {spin} ${yellow('rendering')}${indeterminate ? dim(yellow('...')) : ' {bar} {value}/{total}'}`,
    linewrap: false,
    barsize: 30,
  }, Presets.shades_grey)

  return {
    bar: progress,
    start(total: number) {
      progress.start(total, 0, { spin: getSpinner(spinner) })
      timer = setInterval(() => {
        spinner += 1
        progress.update(current, { spin: getSpinner(spinner) })
      }, 200)
    },
    update(v: number) {
      current = v
      progress.update(v, { spin: getSpinner(spinner) })
    },
    stop() {
      clearInterval(timer)
      progress.stop()
    },
  }
}

export async function exportSlides({
  port = 18724,
  total = 0,
  range,
  format = 'pdf',
  output = 'slides',
  slides,
  base = '/',
  timeout = 500,
  dark = false,
  routerMode = 'history',
  width = 1920,
  height = 1080,
  withClicks = false,
}: ExportOptions) {
  if (!packageExists('playwright-chromium'))
    throw new Error('The exporting for Slidev is powered by Playwright, please installed it via `npm i -D playwright-chromium`')

  const pages: number[] = parseRangeString(total, range)

  const { chromium } = await import('playwright-chromium')
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: {
      width,
      // Calculate height for every slides to be in the viewport to trigger the rendering of iframes (twitter, youtube...)
      height: height * pages.length,
    },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const progress = createSlidevProgress(true)

  async function go(no: number | string, clicks?: string) {
    const path = `${no}?print${withClicks ? '=clicks' : ''}${clicks ? `&clicks=${clicks}` : ''}`
    const url = routerMode === 'hash'
      ? `http://localhost:${port}${base}#${path}`
      : `http://localhost:${port}${base}${path}`
    await page.goto(url, {
      waitUntil: 'networkidle',
    })
    await page.waitForLoadState('networkidle')
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', media: 'screen' })
    // Check for "data-waitfor" attribute and wait for given element to be loaded
    const elements = await page.locator('[data-waitfor]')
    const count = await elements.count()
    for (let index = 0; index < count; index++) {
      const element = await elements.nth(index)
      const attribute = await element.getAttribute('data-waitfor')
      if (attribute)
        await element.locator(attribute).waitFor()
    }
    // Wait for frames to load
    const frames = await page.frames()
    await Promise.all(frames.map(frame => frame.waitForLoadState()))
    await page.waitForTimeout(timeout)
  }

  async function genPagePdf() {
    if (!output.endsWith('.pdf'))
      output = `${output}.pdf`
    await go('print')
    await page.pdf({
      path: output,
      width,
      height,
      margin: {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      },
      printBackground: true,
      preferCSSPageSize: true,
    })
  }

  async function genPagePng() {
    await go('print')
    const slides = await page.locator('.slide-container')
    const count = await slides.count()
    for (let i = 0; i < count; i++) {
      progress.update(i + 1)
      const buffer = await slides.nth(i).screenshot()
      await fs.ensureDir(output)
      await fs.writeFile(path.join(output, `${(i + 1).toString().padStart(2, '0')}.png`), buffer)
    }
  }

  async function genPageMd(pages: number[], slides: SlideInfo[]) {
    const mds: string[] = []

    for (const i of pages) {
      const mdImg = `![${slides[i - 1]?.title}](./${output}/${i.toString().padStart(2, '0')}.png)\n\n`
      const mdNote = slides[i - 1]?.note ? `${slides[i - 1]?.note}\n\n` : ''
      mds.push(`${mdImg}${mdNote}`)
    }

    if (!output.endsWith('.md'))
      output = `${output}.md`
    await fs.writeFile(output, mds.join(''))
  }

  progress.start(pages.length)

  if (format === 'pdf') {
    await genPagePdf()
  }
  else if (format === 'png') {
    await genPagePng()
  }
  else if (format === 'md') {
    await genPagePng()
    await genPageMd(pages, slides)
  }
  else {
    throw new Error(`Unsupported exporting format "${format}"`)
  }

  progress.stop()
  browser.close()
  return output
}
