import { App } from '@slack/bolt';
import { createSqliteStore } from 'mcp-toolshed';
import { createGooseRunner } from 'framework-core';
import { createSlackBot } from './slack-bot.js';

const config = {
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  token: process.env.SLACK_BOT_TOKEN ?? '',
  port: Number(process.env.PORT ?? 3000),
};

const app = new App({
  signingSecret: config.signingSecret,
  token: config.token,
});

const store = createSqliteStore(process.env.SQLITE_PATH ?? ':memory:');
const runner = createGooseRunner({
  baseUrl: process.env.GOOSE_SERVE_URL ?? 'http://localhost:3284',
});
const bot = createSlackBot(app, store, runner, config);

bot.start().catch((err) => {
  console.error('Slack bot failed to start', err);
  process.exit(1);
});
