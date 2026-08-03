import { describe, expect, it } from 'vitest';
import {
  backgroundPath,
  devtoolsPath,
  sidePanelPath,
  type RawManifest,
} from '../../src/browser/manifest.js';

describe('extension surface manifest helpers', () => {
  it('discovers side-panel, DevTools and explicit MV2 background pages', () => {
    const manifest: RawManifest = {
      side_panel: { default_path: 'panel.html' },
      devtools_page: 'devtools.html',
      background: { page: 'background.html' },
    };
    expect(sidePanelPath(manifest)).toBe('panel.html');
    expect(devtoolsPath(manifest)).toBe('devtools.html');
    expect(backgroundPath(manifest)).toBe('background.html');
  });

  it('uses Chrome’s generated background page for MV2 background scripts', () => {
    expect(backgroundPath({ background: { scripts: ['one.js', 'two.js'] } })).toBe(
      '_generated_background_page.html',
    );
  });
});
