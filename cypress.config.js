import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    specPattern: 'generated/cypress/**/*.cy.js',
    supportFile: false,
    video: true,
    screenshotOnRunFailure: true
  }
});
