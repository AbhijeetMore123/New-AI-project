# Public Deployment

This app can run like a normal website instead of only on localhost. Use a Docker-friendly host because the agent runs real browsers for Playwright and Cypress.

## Recommended Hosts

- Render Web Service
- Railway
- Fly.io
- DigitalOcean App Platform
- A VPS with Docker

Vercel/Netlify serverless hosting is not a good fit for this MVP because browser automation needs a long-running server and browser binaries.

## Render Deployment

1. Push this folder to a GitHub repository.
2. Create a new Render Web Service.
3. Select the repository.
4. Choose Docker environment.
5. Keep the default start command from the Dockerfile.
6. Add environment variables:

```text
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
NODE_ENV=production
PORT=4173
```

7. Deploy.

After deploy, Render gives a public URL like:

```text
https://ai-web-test-agent.onrender.com
```

You can connect a custom domain later from Render settings.

## Important

This MVP writes generated reports to local container storage. For production multi-user use, add:

- login/auth
- per-user report folders
- job queue
- database
- cloud storage for reports/videos
- rate limits
