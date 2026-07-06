import { Application, TeamsAdapter } from '@microsoft/teams-ai';
import { createSqliteStore } from 'mcp-toolshed';
import { createGooseRunner } from 'framework-core';
import { createTeamsBot } from './teams-bot.js';

const botFrameworkAuthConfig = {
  MicrosoftAppId: process.env.MICROSOFT_APP_ID ?? '',
  MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD ?? '',
  MicrosoftAppType: process.env.MICROSOFT_APP_TYPE ?? 'MultiTenant',
};

const adapter = new TeamsAdapter(botFrameworkAuthConfig);
const app = new Application({
  adapter,
  removeRecipientMention: true,
  startTypingTimer: true,
});

const store = createSqliteStore(process.env.SQLITE_PATH ?? ':memory:');
const runner = createGooseRunner({
  baseUrl: process.env.GOOSE_SERVE_URL ?? 'http://localhost:3284',
});
const bot = createTeamsBot(app, store, runner, {
  port: Number(process.env.PORT ?? 3978),
});

bot.start().catch((err) => {
  console.error('Teams bot failed to start', err);
  process.exit(1);
});
