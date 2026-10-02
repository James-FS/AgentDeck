import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const executablePath = process.env.AGENTDECK_BROWSER_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(candidate => existsSync(candidate));

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 30_000,
  outputDir: 'work/browser-results',
  reporter: 'list',
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
