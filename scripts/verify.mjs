/**
 * Loads the bakery calculator in headless Chrome and checks
 * console cleanliness plus 2× and 0.5× scaling.
 *
 * Usage: node scripts/verify.mjs
 * Expects the page at http://127.0.0.1:47231/ (override with PAGE_URL).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:47231/';
const CHROME = process.env.CHROME || 'google-chrome';
const CDP_PORT = process.env.CDP_PORT || '9333';
const SHOT = process.env.SHOT || '/workspace/artifacts/bakery-batch-calculator-12-loaves.png';

const errors = [];
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function almost(actual, expected, eps, label) {
  if (actual == null || !Number.isFinite(Number(actual)) || Math.abs(Number(actual) - expected) > eps) {
    failures.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* Chrome is still booting. */
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const handlers = [];
    const api = {
      on(handler) { handlers.push(handler); },
      send(method, params = {}, sessionId) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          const payload = { id, method, params };
          if (sessionId) payload.sessionId = sessionId;
          ws.send(JSON.stringify(payload));
        });
      },
      close() { ws.close(); },
    };
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('DevTools socket failed')));
    ws.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString();
      const message = JSON.parse(raw);
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.rej(new Error(JSON.stringify(message.error)));
        else waiter.res(message.result);
      } else if (message.method) {
        handlers.forEach((handler) => handler(message));
      }
    });
  });
}

const browser = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--disable-extensions',
  '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=/tmp/bakery-chrome-${CDP_PORT}`,
  '--window-size=1440,1200',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderr = '';
browser.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const version = await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const cdp = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  function send(method, params = {}) {
    return cdp.send(method, params, sessionId);
  }

  cdp.on((message) => {
    if (message.sessionId && message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push(`exception: ${details.text} ${details.exception?.description || ''}`.trim());
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      errors.push(`console.error: ${text}`);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  let loaded = false;
  cdp.on((message) => {
    if (message.method === 'Page.loadEventFired' && (!message.sessionId || message.sessionId === sessionId)) {
      loaded = true;
    }
  });
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 75 && !loaded; i += 1) await sleep(100);
  if (!loaded) throw new Error('Page load timed out');
  await sleep(200);

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }

  async function setValue(selector, value) {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  async function click(selector) {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`);
  }

  async function readModel() {
    return evaluate(`(() => {
      const num = (value) => value === '' || value == null ? null : Number(value);
      return {
        title: document.title,
        heading: document.querySelector('h1')?.textContent || '',
        scale: num(document.getElementById('scale-chip').dataset.scale),
        totalGrams: num(document.getElementById('total-weight').dataset.grams),
        totalWeightText: document.getElementById('total-weight').textContent,
        totalCost: num(document.getElementById('total-cost').dataset.cost),
        perLoaf: num(document.getElementById('per-loaf-cost').dataset.cost),
        bakers: num(document.getElementById('bakers-total').dataset.percent),
        message: document.getElementById('result-message').textContent,
        plain: document.getElementById('plain-text').textContent,
        theme: document.documentElement.dataset.theme,
        rowCount: document.querySelectorAll('#ingredient-rows .ingredient-row').length,
        rows: [...document.querySelectorAll('#scaled-body tr')].map((tr) => ({
          name: tr.dataset.name,
          amount: num(tr.dataset.amount),
          unit: tr.dataset.unit,
          percent: num(tr.dataset.percent),
          grams: num(tr.dataset.grams),
          cost: num(tr.dataset.cost),
        })),
      };
    })()`);
  }

  function expectRecipe(model, expected, label) {
    assert(model.rows.length === expected.length, `${label}: row count ${model.rows.length}`);
    expected.forEach((row, index) => {
      const actual = model.rows[index];
      assert(actual && actual.name === row.name, `${label}: name ${actual?.name} !== ${row.name}`);
      almost(actual?.amount, row.amount, 1e-6, `${label} ${row.name} amount`);
      almost(actual?.grams, row.grams, 1e-4, `${label} ${row.name} grams`);
      almost(actual?.percent, row.percent, 1e-6, `${label} ${row.name} percent`);
    });
    almost(model.scale, expected.scale, 1e-9, `${label} scale`);
    almost(model.totalGrams, expected.total, 1e-4, `${label} total grams`);
    almost(model.bakers, 192, 1e-6, `${label} baker's total`);
    assert(model.totalWeightText === expected.weightText, `${label}: weight text "${model.totalWeightText}" !== "${expected.weightText}"`);
    assert(!model.message, `${label}: unexpected error "${model.message}"`);
  }

  const baseRecipe = [
    { name: 'Flour', amount: 500, grams: 500, percent: 100 },
    { name: 'Water', amount: 350, grams: 350, percent: 70 },
    { name: 'Levain', amount: 100, grams: 100, percent: 20 },
    { name: 'Salt', amount: 10, grams: 10, percent: 2 },
  ];

  let model = await readModel();
  assert(model.title === 'Bakery Batch Calculator', `title ${model.title}`);
  assert(model.heading === 'Bakery Batch Calculator', `heading ${model.heading}`);
  assert(model.rowCount === 4, 'prefill should have 4 rows');
  expectRecipe(model, Object.assign(baseRecipe.map((row) => ({ ...row })), {
    scale: 1,
    total: 960,
    weightText: '960 g',
  }), '1×');

  model = await readModel();
  assert(model.plain.includes('Flour: 500 g'), 'plain text missing flour');
  assert(model.plain.includes('70%'), 'plain text missing hydration');
  assert(model.plain.includes('Total batch weight: 960 g'), 'plain text missing weight');
  assert(model.plain.includes('Total cost: not entered'), 'plain text should omit a price');

  await setValue('#target-yield', '2');
  model = await readModel();
  expectRecipe(model, Object.assign([
    { name: 'Flour', amount: 1000, grams: 1000, percent: 100 },
    { name: 'Water', amount: 700, grams: 700, percent: 70 },
    { name: 'Levain', amount: 200, grams: 200, percent: 20 },
    { name: 'Salt', amount: 20, grams: 20, percent: 2 },
  ], { scale: 2, total: 1920, weightText: '1,920 g (1.92 kg)' }), '2×');
  assert(model.plain.includes('Target yield: 2 loaves'), '2× plain target');
  assert(model.plain.includes('Flour: 1,000 g'), '2× plain flour');

  await setValue('#ingredient-rows .ingredient-row:nth-child(1) [data-field="cost"]', '0.002');
  await setValue('#ingredient-rows .ingredient-row:nth-child(2) [data-field="cost"]', '0.001');
  await setValue('#ingredient-rows .ingredient-row:nth-child(3) [data-field="cost"]', '0.005');
  await setValue('#ingredient-rows .ingredient-row:nth-child(4) [data-field="cost"]', '0.01');
  model = await readModel();
  almost(model.totalCost, 3.9, 0.001, '2× total cost');
  almost(model.perLoaf, 1.95, 0.001, '2× per loaf');
  almost(model.rows[0].cost, 2, 0.001, '2× flour cost');
  almost(model.rows[1].cost, 0.7, 0.001, '2× water cost');
  almost(model.rows[2].cost, 1, 0.001, '2× levain cost');
  almost(model.rows[3].cost, 0.2, 0.001, '2× salt cost');

  await setValue('#target-yield', '0.5');
  model = await readModel();
  expectRecipe(model, Object.assign([
    { name: 'Flour', amount: 250, grams: 250, percent: 100 },
    { name: 'Water', amount: 175, grams: 175, percent: 70 },
    { name: 'Levain', amount: 50, grams: 50, percent: 20 },
    { name: 'Salt', amount: 5, grams: 5, percent: 2 },
  ], { scale: 0.5, total: 480, weightText: '480 g' }), '0.5× target');
  almost(model.totalCost, 0.975, 0.001, '0.5× total cost');
  almost(model.perLoaf, 1.95, 0.001, '0.5× per loaf stays constant');

  await setValue('#base-yield', '2');
  await setValue('#target-yield', '1');
  model = await readModel();
  expectRecipe(model, Object.assign([
    { name: 'Flour', amount: 250, grams: 250, percent: 100 },
    { name: 'Water', amount: 175, grams: 175, percent: 70 },
    { name: 'Levain', amount: 50, grams: 50, percent: 20 },
    { name: 'Salt', amount: 5, grams: 5, percent: 2 },
  ], { scale: 0.5, total: 480, weightText: '480 g' }), '0.5× via base yield 2');

  for (const selector of [
    '#ingredient-rows .ingredient-row:nth-child(1) [data-field="cost"]',
    '#ingredient-rows .ingredient-row:nth-child(2) [data-field="cost"]',
    '#ingredient-rows .ingredient-row:nth-child(3) [data-field="cost"]',
    '#ingredient-rows .ingredient-row:nth-child(4) [data-field="cost"]',
  ]) {
    await setValue(selector, '');
  }
  await setValue('#base-yield', '1');
  await setValue('#target-yield', '1');

  await setValue('#ingredient-rows .ingredient-row:nth-child(1) [data-field="unit"]', 'kg');
  await setValue('#ingredient-rows .ingredient-row:nth-child(1) [data-field="amount"]', '0.5');
  model = await readModel();
  almost(model.rows[0].grams, 500, 1e-4, '0.5 kg flour in grams');
  almost(model.rows[1].percent, 70, 1e-6, 'water percent against 0.5 kg flour');
  almost(model.totalGrams, 960, 1e-3, 'mixed unit total');
  await setValue('#ingredient-rows .ingredient-row:nth-child(1) [data-field="unit"]', 'g');
  await setValue('#ingredient-rows .ingredient-row:nth-child(1) [data-field="amount"]', '500');

  await click('#add-ingredient');
  await setValue('#ingredient-rows .ingredient-row:nth-child(5) [data-field="name"]', 'Whole wheat flour');
  await setValue('#ingredient-rows .ingredient-row:nth-child(5) [data-field="amount"]', '100');
  model = await readModel();
  almost(model.rows[0].percent, (500 / 600) * 100, 1e-4, 'bread flour share');
  almost(model.rows[4].percent, (100 / 600) * 100, 1e-4, 'whole wheat share');
  almost(model.rows[1].percent, (350 / 600) * 100, 1e-4, 'water against total flour');
  almost(model.totalGrams, 1060, 1e-4, 'weight with second flour');
  await click('#ingredient-rows .ingredient-row:nth-child(5) .remove-row');
  model = await readModel();
  assert(model.rowCount === 4, 'remove should restore 4 rows');
  almost(model.rows[1].percent, 70, 1e-6, 'water percent after remove');

  await setValue('#base-yield', '0');
  model = await readModel();
  assert(model.message.includes('greater than zero'), `zero yield message: ${model.message}`);
  assert(model.rows.length === 0, 'invalid yield should hide a stale batch');
  await setValue('#base-yield', '1');
  await setValue('#target-yield', '-3');
  model = await readModel();
  assert(model.message.includes('greater than zero'), `negative yield message: ${model.message}`);
  await setValue('#target-yield', '1');
  await setValue('#ingredient-rows .ingredient-row:nth-child(4) [data-field="amount"]', '-2');
  model = await readModel();
  assert(model.rows.every((row) => row.name !== 'Salt'), 'negative salt should be excluded');
  assert(model.plain.includes('skipped'), 'plain text should mention the skipped row');
  await setValue('#ingredient-rows .ingredient-row:nth-child(4) [data-field="amount"]', '10');

  const themeBefore = (await readModel()).theme;
  await click('#theme-toggle');
  const themeAfter = (await readModel()).theme;
  assert(themeAfter !== themeBefore, 'theme toggle should switch');
  if (themeAfter !== 'light') await click('#theme-toggle');
  assert((await readModel()).theme === 'light', 'screenshot theme should be light');

  await setValue('#target-yield', '2');
  const pageOrigin = new URL(PAGE_URL).origin;
  try {
    await cdp.send('Browser.grantPermissions', {
      origin: pageOrigin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (permissionError) {
    failures.push(`clipboard permission: ${permissionError.message}`);
  }
  await send('Runtime.evaluate', {
    expression: `document.getElementById('copy-button').click()`,
    userGesture: true,
  });
  await sleep(200);
  const copyStatus = await evaluate(`document.getElementById('copy-status').textContent`);
  assert(copyStatus === 'Copied.', `copy status "${copyStatus}"`);
  const clipboardText = await evaluate(`navigator.clipboard.readText()`);
  assert(typeof clipboardText === 'string' && clipboardText.includes('Flour: 1,000 g'), 'clipboard missing scaled flour');
  const plain = (await readModel()).plain;
  assert(plain.includes('Scale: 2×') || plain.includes('Scale: 2\u00d7'), 'copied scale line');

  await setValue('#base-yield', '1');
  await setValue('#target-yield', '12');
  await setValue('#ingredient-rows .ingredient-row:nth-child(1) [data-field="cost"]', '0.002');
  await setValue('#ingredient-rows .ingredient-row:nth-child(2) [data-field="cost"]', '');
  await setValue('#ingredient-rows .ingredient-row:nth-child(3) [data-field="cost"]', '0.004');
  await setValue('#ingredient-rows .ingredient-row:nth-child(4) [data-field="cost"]', '0.005');
  model = await readModel();
  expectRecipe(model, Object.assign([
    { name: 'Flour', amount: 6000, grams: 6000, percent: 100 },
    { name: 'Water', amount: 4200, grams: 4200, percent: 70 },
    { name: 'Levain', amount: 1200, grams: 1200, percent: 20 },
    { name: 'Salt', amount: 120, grams: 120, percent: 2 },
  ], { scale: 12, total: 11520, weightText: '11,520 g (11.52 kg)' }), '12 loaves');
  almost(model.totalCost, 17.4, 0.001, '12 loaf total cost');
  almost(model.perLoaf, 1.45, 0.001, '12 loaf per-loaf cost');
  assert(model.rows[1].cost == null, 'blank water cost should stay blank');

  async function overflowAt(width, height) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 700,
    });
    await sleep(50);
    return evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  }

  const narrowOverflow = await overflowAt(390, 900);
  const wideOverflow = await overflowAt(1440, 1100);
  assert(narrowOverflow <= 1, `mobile overflow ${narrowOverflow}px`);
  assert(wideOverflow <= 1, `desktop overflow ${wideOverflow}px`);

  const metrics = await send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    },
  });
  mkdirSync('/workspace/artifacts', { recursive: true });
  mkdirSync('/opt/cursor/artifacts', { recursive: true });
  const buffer = Buffer.from(shot.data, 'base64');
  writeFileSync(SHOT, buffer);
  writeFileSync('/opt/cursor/artifacts/bakery-batch-calculator-12-loaves.png', buffer);

  await sleep(100);
  if (errors.length) {
    console.error('CONSOLE ERRORS:');
    errors.forEach((error) => console.error(error));
  }
  if (failures.length) {
    console.error('ASSERTIONS:');
    failures.forEach((failure) => console.error(failure));
  }
  if (errors.length || failures.length) {
    console.error(`FAILED errors=${errors.length} assertions=${failures.length}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS console=0 checks ok screenshot=${SHOT} bytes=${buffer.length}`);
  }
  cdp.close();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  if (stderr) console.error(stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  browser.kill();
}
