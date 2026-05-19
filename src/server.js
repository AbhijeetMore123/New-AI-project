#!/usr/bin/env node
import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from './agent.js';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const reportsDir = path.join(root, 'reports');
const generatedDir = path.join(root, 'generated');
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Message is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function extractUrl(message) {
  const match = message.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0]?.replace(/[),.]+$/, '') ?? null;
}

function makeReply(result) {
  const { report, files } = result;
  const bugsText = report.bugs.length
    ? report.bugs.map((bug, index) => `${index + 1}. [${bug.severity}] ${bug.title}`).join('\n')
    : 'No bugs detected in this run.';

  return [
    `Done. I tested ${report.url}.`,
    `Playwright exit code: ${report.playwrightExitCode ?? 'skipped'}`,
    `Cypress exit code: ${report.cypressExitCode ?? 'skipped'}`,
    `Bugs found: ${report.bugs.length}`,
    '',
    bugsText,
    '',
    `Report: /reports/agent-report.html`,
    `Playwright spec: /generated/playwright/ai-generated.spec.js`,
    `Cypress spec: /generated/cypress/ai-generated.cy.js`
  ].join('\n');
}

async function serveFileFrom(baseDir, requestPath, res) {
  const filePath = path.normalize(path.join(baseDir, requestPath));

  if (!filePath.startsWith(baseDir)) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }

  try {
    const data = await readFile(filePath);
    send(res, 200, data, mimeTypes[path.extname(filePath)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/reports/')) {
    await serveFileFrom(reportsDir, url.pathname.replace('/reports/', ''), res);
    return;
  }

  if (url.pathname.startsWith('/generated/')) {
    await serveFileFrom(generatedDir, url.pathname.replace('/generated/', ''), res);
    return;
  }

  const requestPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  await serveFileFrom(publicDir, requestPath, res);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      const message = String(body.message || '');
      const url = extractUrl(message);

      if (!url) {
        send(res, 200, JSON.stringify({
          reply: 'Send me a website URL, for example: test https://example.com'
        }));
        return;
      }

      const result = await runAgent({ url });
      send(res, 200, JSON.stringify({
        reply: makeReply(result),
        report: result.report,
        files: result.files
      }));
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  } catch (error) {
    send(res, 500, JSON.stringify({
      reply: `Test run failed: ${error.message}`
    }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`AI test agent chat is running on port ${port}`);
});
