'use strict';

/**
 * Renders tools/demo.html and saves a screenshot to screenshots/.
 * Run with: npm run screenshot
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#0e1014',
  });

  await win.loadFile(path.join(__dirname, 'demo.html'));
  await new Promise((r) => setTimeout(r, 800)); // let fonts and layout settle

  const image = await win.webContents.capturePage();
  const outDir = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'ssh-deployer.png');
  fs.writeFileSync(out, image.toPNG());
  console.log('saved', out, fs.statSync(out).size, 'bytes');

  app.quit();
});
