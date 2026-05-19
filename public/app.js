const form = document.getElementById('chatForm');
const input = document.getElementById('messageInput');
const messages = document.getElementById('messages');
const sendButton = document.getElementById('sendButton');
const statusText = document.getElementById('status');
const bugCount = document.getElementById('bugCount');
const testCount = document.getElementById('testCount');
const previewPanel = document.getElementById('previewPanel');
const previewTitle = document.getElementById('previewTitle');
const previewBody = document.getElementById('previewBody');
const closePreview = document.getElementById('closePreview');

let latestResult = null;

function addMessage(role, text, result) {
  const article = document.createElement('article');
  article.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'You' : 'AI';

  const bubble = result ? createResultCard(result) : document.createElement('div');
  if (!result) {
    bubble.className = 'bubble';
    bubble.textContent = text;
  }

  article.append(avatar, bubble);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
}

function createResultCard(data) {
  const report = data.report;
  const card = document.createElement('div');
  card.className = 'resultCard';

  const topline = document.createElement('div');
  topline.className = 'resultTopline';

  const title = document.createElement('h3');
  title.className = 'resultTitle';
  title.textContent = `Test completed for ${report.url}`;

  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.textContent = report.bugs.length ? `${report.bugs.length} bug found` : 'Clean run';

  topline.append(title, pill);

  const meta = document.createElement('div');
  meta.className = 'resultMeta';
  meta.append(
    metric('Bugs', report.bugs.length),
    metric('Playwright', exitLabel(report.playwrightExitCode)),
    metric('Cypress', exitLabel(report.cypressExitCode))
  );

  const bugs = document.createElement(report.bugs.length ? 'ol' : 'div');
  bugs.className = report.bugs.length ? 'bugList' : 'bubbleNote';
  if (report.bugs.length) {
    for (const bug of report.bugs.slice(0, 4)) {
      const item = document.createElement('li');
      item.textContent = `[${bug.severity}] ${bug.title}`;
      bugs.append(item);
    }
  } else {
    bugs.textContent = 'No bugs detected in this run.';
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionButton('View Report', 'primary', () => showReport()),
    actionButton('Details', '', () => showDetails()),
    actionButton('Playwright Test', '', () => showTextFile('Playwright Test', '/generated/playwright/ai-generated.spec.js')),
    actionButton('Cypress Test', '', () => showTextFile('Cypress Test', '/generated/cypress/ai-generated.cy.js'))
  );

  card.append(topline, meta, bugs, actions);
  return card;
}

function metric(label, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'metric';

  const labelEl = document.createElement('span');
  labelEl.textContent = label;

  const valueEl = document.createElement('strong');
  valueEl.textContent = String(value);

  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function exitLabel(code) {
  if (code === null || code === undefined) return 'Skipped';
  return code === 0 ? 'Pass' : 'Fail';
}

function actionButton(label, variant, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = variant ? `actionButton ${variant}` : 'actionButton';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function openPreview(title) {
  previewTitle.textContent = title;
  previewPanel.classList.add('open');
}

function showReport() {
  openPreview('HTML Report');
  previewBody.replaceChildren();

  const frame = document.createElement('iframe');
  frame.className = 'previewFrame';
  frame.title = 'Agent report';
  frame.src = '/reports/agent-report.html';
  previewBody.append(frame);
}

async function showTextFile(title, url) {
  openPreview(title);
  previewBody.textContent = 'Loading...';

  const response = await fetch(url);
  const text = await response.text();
  const pre = document.createElement('pre');
  pre.className = 'codePreview';
  pre.textContent = text;
  previewBody.replaceChildren(pre);
}

function showDetails() {
  if (!latestResult?.report) return;
  const report = latestResult.report;
  openPreview('Run Details');

  const testPlan = report.plan.tests
    .map((testCase, index) => `${index + 1}. ${testCase.name}\n   ${testCase.goal}`)
    .join('\n\n');
  const bugs = report.bugs.length
    ? report.bugs.map((bug, index) => `${index + 1}. [${bug.severity}] ${bug.title}\n   ${bug.evidence}`).join('\n\n')
    : 'No bugs detected.';

  const pre = document.createElement('pre');
  pre.className = 'detailsPreview';
  pre.textContent = [
    `Target: ${report.url}`,
    `Generated: ${report.generatedAt}`,
    `Playwright: ${exitLabel(report.playwrightExitCode)}`,
    `Cypress: ${exitLabel(report.cypressExitCode)}`,
    '',
    'Test Plan',
    testPlan,
    '',
    'Bug Summary',
    bugs
  ].join('\n');
  previewBody.replaceChildren(pre);
}

closePreview.addEventListener('click', () => {
  previewPanel.classList.remove('open');
});

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  input.disabled = isBusy;
  statusText.textContent = isBusy ? 'Testing...' : 'Ready';
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  addMessage('user', message);
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await response.json();

    latestResult = data.report ? data : latestResult;
    addMessage('assistant', data.reply || 'Done.', data.report ? data : null);
    if (data.report) {
      bugCount.textContent = String(data.report.bugs?.length ?? 0);
      testCount.textContent = String(data.report.plan?.tests?.length ?? 0);
    }
  } catch (error) {
    addMessage('assistant', `Something failed: ${error.message}`);
  } finally {
    setBusy(false);
    input.focus();
  }
});
