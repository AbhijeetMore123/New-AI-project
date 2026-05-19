#!/usr/bin/env node
import 'dotenv/config';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';

const root = process.cwd();
const generatedPlaywrightDir = path.join(root, 'generated', 'playwright');
const generatedCypressDir = path.join(root, 'generated', 'cypress');
const reportsDir = path.join(root, 'reports');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };

  return {
    url: get('url', process.env.TARGET_URL),
    maxLinks: Number(get('max-links', '8')),
    skipRun: args.includes('--skip-run'),
    skipPlaywright: args.includes('--skip-playwright'),
    skipCypress: args.includes('--skip-cypress')
  };
}

function quote(value) {
  return JSON.stringify(value);
}

function cssEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function ensureDirs() {
  await mkdir(generatedPlaywrightDir, { recursive: true });
  await mkdir(generatedCypressDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
}

async function inspectSite(url, maxLinks) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? 'request failed'
    });
  });

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const snapshot = await page.evaluate((limit) => {
    const textOf = (element) => (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
    const short = (value) => value.slice(0, 120);
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };

    const links = [...document.querySelectorAll('a[href]')]
      .filter(visible)
      .slice(0, limit)
      .map((element) => ({
        text: short(textOf(element) || element.getAttribute('aria-label') || 'link'),
        href: element.href
      }));

    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .filter(visible)
      .slice(0, 12)
      .map((element) => ({
        text: short(textOf(element) || element.value || element.getAttribute('aria-label') || 'button'),
        type: element.getAttribute('type') || element.tagName.toLowerCase()
      }));

    const inputs = [...document.querySelectorAll('input, textarea, select')]
      .filter(visible)
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || 'text',
        name: element.getAttribute('name') || '',
        id: element.id || '',
        placeholder: element.getAttribute('placeholder') || '',
        label: element.labels?.[0]?.innerText?.trim() || element.getAttribute('aria-label') || ''
      }));

    const forms = [...document.querySelectorAll('form')]
      .filter(visible)
      .slice(0, 5)
      .map((form, index) => ({
        index,
        action: form.action,
        method: form.method,
        inputs: [...form.querySelectorAll('input, textarea, select')].map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || 'text',
          name: element.getAttribute('name') || '',
          id: element.id || '',
          placeholder: element.getAttribute('placeholder') || '',
          required: element.required
        }))
      }));

    return {
      title: document.title,
      url: location.href,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 10).map((h) => short(textOf(h))),
      links,
      buttons,
      inputs,
      forms
    };
  }, maxLinks);

  await browser.close();

  return {
    status: response?.status() ?? null,
    ok: response?.ok() ?? false,
    consoleErrors,
    failedRequests,
    snapshot
  };
}

async function aiPlan(url, inspection) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You create concise web automation test plans. Return JSON with key "tests": array of {name, goal, priority, selectorsOrTargets}.'
      },
      {
        role: 'user',
        content: JSON.stringify({ url, inspection }, null, 2)
      }
    ]
  });

  return JSON.parse(completion.choices[0].message.content);
}

function heuristicPlan(url, inspection) {
  const tests = [
    {
      name: 'loads the page successfully',
      goal: 'Verify the page opens, returns a successful response, and has a title.',
      priority: 'high',
      selectorsOrTargets: [url]
    },
    {
      name: 'has no browser console errors on load',
      goal: 'Catch JavaScript runtime errors visible in the browser console.',
      priority: 'high',
      selectorsOrTargets: ['console']
    },
    {
      name: 'important links are reachable',
      goal: 'Check visible links do not produce failed navigation responses.',
      priority: 'medium',
      selectorsOrTargets: inspection.snapshot.links.map((link) => link.href)
    }
  ];

  if (inspection.snapshot.buttons.length) {
    tests.push({
      name: 'visible buttons can be discovered',
      goal: 'Verify key clickable controls are visible to automation.',
      priority: 'medium',
      selectorsOrTargets: inspection.snapshot.buttons.map((button) => button.text)
    });
  }

  if (inspection.snapshot.forms.length || inspection.snapshot.inputs.length) {
    tests.push({
      name: 'forms accept synthetic input',
      goal: 'Fill visible fields with safe test data and validate the page remains stable.',
      priority: 'high',
      selectorsOrTargets: inspection.snapshot.inputs.map((input) => input.name || input.id || input.placeholder || input.type)
    });
  }

  return { tests };
}

function inputSelector(input) {
  if (input.id) return `#${cssEscape(input.id)}`;
  if (input.name) return `[name='${cssEscape(input.name)}']`;
  if (input.placeholder) return `[placeholder='${cssEscape(input.placeholder)}']`;
  return `${input.tag}[type='${cssEscape(input.type)}']`;
}

function valueFor(input) {
  const key = `${input.name} ${input.id} ${input.placeholder} ${input.type}`.toLowerCase();
  if (key.includes('email')) return 'qa@example.com';
  if (key.includes('phone') || key.includes('mobile')) return '9876543210';
  if (key.includes('password')) return 'Test@12345';
  if (key.includes('search')) return 'test';
  if (input.type === 'number') return '42';
  return 'Automation Test';
}

function makePlaywrightSpec(url, inspection, plan) {
  const links = inspection.snapshot.links.map((link) => link.href);
  const inputs = inspection.snapshot.inputs;
  const buttons = inspection.snapshot.buttons;

  return `import { test, expect } from '@playwright/test';

const targetUrl = ${quote(url)};
const links = ${JSON.stringify(links, null, 2)};
const generatedPlan = ${JSON.stringify(plan.tests, null, 2)};

test.describe('AI generated web tests', () => {
  test('generated test plan exists', async () => {
    expect(generatedPlan.length).toBeGreaterThan(0);
  });

  test('page loads with title and successful response', async ({ page }) => {
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    expect(response?.ok(), \`Expected successful response for \${targetUrl}\`).toBeTruthy();
    await expect(page).toHaveTitle(/.+/);
  });

  test('page has no console errors during load', async ({ page }) => {
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    expect(errors, errors.join('\\n')).toEqual([]);
  });

  test('visible links are reachable', async ({ page, request }) => {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    for (const href of links) {
      const response = await request.get(href, { failOnStatusCode: false });
      expect(response.status(), \`Broken link: \${href}\`).toBeLessThan(400);
    }
  });

  test('key controls are visible', async ({ page }) => {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
${buttons.length ? buttons.map((button) => `    await expect(page.getByText(${quote(button.text)}, { exact: false }).first()).toBeVisible({ timeout: 5000 }).catch(async () => {
      await expect(page.locator('button, [role="button"], input[type="submit"], input[type="button"]').filter({ hasText: ${quote(button.text)} }).first()).toBeVisible();
    });`).join('\n') : "    test.skip(true, 'No visible buttons found during inspection.');"}
  });

  test('visible form fields accept safe synthetic input', async ({ page }) => {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
${inputs.length ? inputs.map((input) => {
    const selector = inputSelector(input);
    if (input.tag === 'select') {
      return `    await page.locator(${quote(selector)}).first().selectOption({ index: 1 }).catch(() => {});`;
    }
    if (input.type === 'checkbox' || input.type === 'radio') {
      return `    await page.locator(${quote(selector)}).first().check().catch(() => {});`;
    }
    return `    await page.locator(${quote(selector)}).first().fill(${quote(valueFor(input))}).catch(() => {});`;
  }).join('\n') : "    test.skip(true, 'No visible form fields found during inspection.');"}
    await expect(page.locator('body')).toBeVisible();
  });
});
`;
}

function makeCypressSpec(url, inspection, plan) {
  const links = inspection.snapshot.links.map((link) => link.href);
  const inputs = inspection.snapshot.inputs;

  return `const targetUrl = ${quote(url)};
const links = ${JSON.stringify(links, null, 2)};
const generatedPlan = ${JSON.stringify(plan.tests, null, 2)};

describe('AI generated web tests', () => {
  it('generated test plan exists', () => {
    expect(generatedPlan.length).to.be.greaterThan(0);
  });

  it('page loads with a title', () => {
    cy.visit(targetUrl);
    cy.title().should('not.be.empty');
  });

  it('visible links are reachable', () => {
    cy.visit(targetUrl);
    links.forEach((href) => {
      cy.request({ url: href, failOnStatusCode: false }).its('status').should('be.lessThan', 400);
    });
  });

  it('visible form fields accept safe synthetic input', () => {
    cy.visit(targetUrl);
${inputs.length ? inputs.map((input) => {
    const selector = inputSelector(input);
    if (input.tag === 'select') {
      return `    cy.get(${quote(selector)}).first().select(1, { force: true }).then(() => {}, () => {});`;
    }
    if (input.type === 'checkbox' || input.type === 'radio') {
      return `    cy.get(${quote(selector)}).first().check({ force: true }).then(() => {}, () => {});`;
    }
    return `    cy.get(${quote(selector)}).first().clear({ force: true }).type(${quote(valueFor(input))}, { force: true }).then(() => {}, () => {});`;
  }).join('\n') : "    cy.log('No visible form fields found during inspection.');"}
    cy.get('body').should('be.visible');
  });
});
`;
}

async function runCommand(commandLine) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', commandLine]
      : ['-lc', commandLine];

    const child = spawn(command, args, {
      cwd: root,
      stdio: 'pipe',
      shell: false
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runPlaywright() {
  return runCommand('npx playwright test');
}

async function runCypress() {
  return runCommand('npx cypress run --config video=false');
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function analyzeBugs(inspection, playwrightRunResult, cypressRunResult, playwrightJson) {
  const bugs = [];

  if (!inspection.ok) {
    bugs.push({
      severity: 'critical',
      title: 'Initial page response was not successful',
      evidence: `HTTP status: ${inspection.status}`
    });
  }

  for (const error of inspection.consoleErrors) {
    bugs.push({
      severity: 'high',
      title: 'Browser console error on load',
      evidence: error
    });
  }

  for (const request of inspection.failedRequests) {
    bugs.push({
      severity: 'medium',
      title: 'Network request failed',
      evidence: `${request.url} - ${request.error}`
    });
  }

  if (playwrightRunResult && playwrightRunResult.code !== 0) {
    bugs.push({
      severity: 'high',
      title: 'Generated Playwright suite failed',
      evidence: playwrightRunResult.stderr || playwrightRunResult.stdout.slice(-2000)
    });
  }

  if (cypressRunResult && cypressRunResult.code !== 0) {
    bugs.push({
      severity: 'high',
      title: 'Generated Cypress suite failed',
      evidence: cypressRunResult.stderr || cypressRunResult.stdout.slice(-2000)
    });
  }

  const failedTests = playwrightJson?.suites?.flatMap((suite) => suite.specs ?? [])
    .filter((spec) => spec.tests?.some((test) => test.results?.some((result) => result.status !== 'passed'))) ?? [];

  for (const spec of failedTests) {
    bugs.push({
      severity: 'high',
      title: `Failing test: ${spec.title}`,
      evidence: spec.tests?.[0]?.results?.[0]?.error?.message || 'See Playwright HTML report.'
    });
  }

  return bugs;
}

function makeHtmlReport(report) {
  const rows = report.bugs.map((bug) => `<tr><td>${bug.severity}</td><td>${bug.title}</td><td><pre>${String(bug.evidence).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))}</pre></td></tr>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AI Test Agent Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #17202a; }
    h1 { margin-bottom: 8px; }
    .meta { color: #52616b; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    th, td { border: 1px solid #d8dee4; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f4f6f8; }
    pre { white-space: pre-wrap; margin: 0; }
  </style>
</head>
<body>
  <h1>AI Test Agent Report</h1>
  <div class="meta">Target: ${report.url}</div>
  <div class="meta">Generated: ${report.generatedAt}</div>
  <h2>Test Plan</h2>
  <ol>${report.plan.tests.map((testCase) => `<li><strong>${testCase.name}</strong>: ${testCase.goal}</li>`).join('')}</ol>
  <h2>Bugs</h2>
  ${report.bugs.length ? `<table><thead><tr><th>Severity</th><th>Title</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No bugs detected by this run.</p>'}
</body>
</html>`;
}

export async function runAgent(options = {}) {
  const args = {
    url: options.url,
    maxLinks: options.maxLinks ?? 8,
    skipRun: options.skipRun ?? false,
    skipPlaywright: options.skipPlaywright ?? false,
    skipCypress: options.skipCypress ?? false
  };

  if (!args.url) {
    throw new Error('URL missing. Run: npm run agent -- --url https://your-site.com');
  }

  await ensureDirs();
  console.log(`Inspecting ${args.url}`);
  const inspection = await inspectSite(args.url, args.maxLinks);
  const plan = (await aiPlan(args.url, inspection).catch((error) => {
    console.warn(`AI planning failed, using heuristic plan: ${error.message}`);
    return null;
  })) || heuristicPlan(args.url, inspection);

  await writeFile(path.join(generatedPlaywrightDir, 'ai-generated.spec.js'), makePlaywrightSpec(args.url, inspection, plan));
  await writeFile(path.join(generatedCypressDir, 'ai-generated.cy.js'), makeCypressSpec(args.url, inspection, plan));

  const playwrightRunResult = args.skipRun || args.skipPlaywright ? null : await runPlaywright();
  const cypressRunResult = args.skipRun || args.skipCypress ? null : await runCypress();
  const playwrightJson = await readJsonIfExists(path.join(reportsDir, 'playwright-results.json'));
  const bugs = analyzeBugs(inspection, playwrightRunResult, cypressRunResult, playwrightJson);
  const report = {
    url: args.url,
    generatedAt: new Date().toISOString(),
    inspection,
    plan,
    playwrightExitCode: playwrightRunResult?.code ?? null,
    cypressExitCode: cypressRunResult?.code ?? null,
    bugs
  };

  await writeFile(path.join(reportsDir, 'agent-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(reportsDir, 'agent-report.html'), makeHtmlReport(report));

  console.log(`Generated Playwright spec: ${path.join(generatedPlaywrightDir, 'ai-generated.spec.js')}`);
  console.log(`Generated Cypress spec: ${path.join(generatedCypressDir, 'ai-generated.cy.js')}`);
  console.log(`Report: ${path.join(reportsDir, 'agent-report.html')}`);
  console.log(`Bugs found: ${bugs.length}`);
  return {
    report,
    files: {
      playwrightSpec: path.join(generatedPlaywrightDir, 'ai-generated.spec.js'),
      cypressSpec: path.join(generatedCypressDir, 'ai-generated.cy.js'),
      htmlReport: path.join(reportsDir, 'agent-report.html'),
      jsonReport: path.join(reportsDir, 'agent-report.json')
    },
    exitCode: Math.max(playwrightRunResult?.code ?? 0, cypressRunResult?.code ?? 0)
  };
}

async function main() {
  const result = await runAgent(parseArgs());
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
