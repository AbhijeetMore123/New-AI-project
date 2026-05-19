# AI Web Test Agent

हा MVP वेबसाइटसाठी automation testing agent आहे. तो URL inspect करतो, test cases तयार करतो, Playwright आणि Cypress specs generate करतो, दोन्ही execute करतो, आणि bug report तयार करतो.

## Setup

```powershell
npm install
npm run install:browsers
```

## Run

```powershell
npm run agent -- --url https://your-site.com
```

GPT-style chat UI वापरायचा असेल तर:

```powershell
npm run chat
```

मग browser मध्ये `http://localhost:4173` उघडा.

Optional AI planning साठी `.env` मध्ये `OPENAI_API_KEY` सेट करा. API key नसेल तर agent heuristic test generation वापरतो.

## Output

- `generated/playwright/ai-generated.spec.js`
- `generated/cypress/ai-generated.cy.js`
- `reports/agent-report.json`
- `reports/agent-report.html`
- `reports/playwright-html/index.html`
- `cypress/videos/*.mp4`

## काय तपासतो

- page load आणि title
- console errors
- broken links
- visible buttons/links/forms
- basic form fill/submit flows
- accessibility-friendly labels/selectors
- Playwright failure analysis
