/**
 * Render the SVG marks in `assets/` to PNG, using the Chromium this project already installs.
 *
 * PNGs exist for one reason: npm's README renderer strips SVG, so the npm page cannot use the
 * vector files that GitHub is happy with. Only the two PNGs the README and the GitHub social
 * preview actually reference are committed; every other size is regenerated on demand.
 *
 *   npx tsx scripts/rasterize-logo.ts                      # the committed pair, into assets/
 *   npx tsx scripts/rasterize-logo.ts --all --out drafts/logo   # every favicon size, elsewhere
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Job {
  src: string;
  name: string;
  width: number;
  height: number;
}

const COMMITTED: Job[] = [
  { src: 'assets/banner.svg', name: 'banner-900.png', width: 900, height: 220 },
  { src: 'assets/logo.svg', name: 'logo-512.png', width: 512, height: 512 },
];

const EXTRA: Job[] = [
  { src: 'assets/logo.svg', name: 'logo-256.png', width: 256, height: 256 },
  { src: 'assets/logo.svg', name: 'logo-128.png', width: 128, height: 128 },
  { src: 'assets/logo.svg', name: 'logo-64.png', width: 64, height: 64 },
  { src: 'assets/logo.svg', name: 'logo-32.png', width: 32, height: 32 },
  { src: 'assets/logo.svg', name: 'logo-16.png', width: 16, height: 16 },
  { src: 'assets/lockup.svg', name: 'lockup-780.png', width: 780, height: 192 },
];

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? 'assets' : (args[outIndex + 1] ?? 'assets');
const jobs = args.includes('--all') ? [...COMMITTED, ...EXTRA] : COMMITTED;

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height } });
    // The SVG is inlined rather than loaded over file:// so no server or path juggling is needed.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${job.width}px;height:${job.height}px}</style>` +
        readFileSync(job.src, 'utf8'),
    );
    const target = join(outDir, job.name);
    writeFileSync(target, await page.screenshot({ omitBackground: true }));
    await page.close();
    console.log(`  ${target.padEnd(28)} ${job.width}×${job.height}`);
  }
} finally {
  await browser.close();
}
