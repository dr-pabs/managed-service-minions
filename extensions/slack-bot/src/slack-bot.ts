import type { App as BoltApp } from '@slack/bolt';
import type { AppMentionEvent, GenericMessageEvent } from '@slack/types';
import {
  formatError,
  handleIngressMessage,
  type IngressRequest,
  type IngressResponse,
  type IngressRunner,
  type SessionStore,
} from 'framework-core';

export interface SlackBotConfig {
  signingSecret: string;
  token: string;
  port?: number;
}

// Duck-typed subset of WebClient needed for proactive posting.
// The real type is WebClient from @slack/web-api — Bolt provides it as `client`
// in all event/message handler args.
export interface SlackPoster {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: unknown[];
    }): Promise<unknown>;
  };
}

/**
 * A minimal runner that echoes the request back. Useful for local smoke tests
 * until the real Minions orchestrator is wired in.
 */
export function createEchoRunner(): IngressRunner {
  return {
    run: async (request) => ({ text: `Minions received: ${request.text}` }),
  };
}

function isDirectMessage(event: GenericMessageEvent): boolean {
  return event.channel_type === 'im' && event.subtype === undefined;
}

function cleanSlackText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

function toSlackRequest(
  event: AppMentionEvent | GenericMessageEvent,
  text: string
): IngressRequest {
  const teamId = event.team ?? 'unknown';
  const channelId = event.channel ?? undefined;
  const userId = ('user' in event && event.user ? event.user : 'unknown') as string;
  const threadId = event.thread_ts ?? event.channel ?? undefined;

  return {
    platform: 'slack',
    teamId,
    channelId,
    userId,
    text,
    threadId,
  };
}

export function createSlackBot(
  app: BoltApp,
  store: SessionStore,
  runner: IngressRunner,
  config: SlackBotConfig
): { start: () => Promise<void>; stop: () => Promise<unknown> } {
  app.event('app_mention', async ({ event, say, client }) => {
    const mention = event as AppMentionEvent;
    const text = cleanSlackText(mention.text);

    if (!text) {
      await say('Hi! What can I help you with?');
      return;
    }

    // Acknowledge immediately. Bolt sends HTTP 200 when this handler returns, so
    // Slack gets its ack before the 3-second window closes and suppresses retries.
    await say(':hourglass_flowing_sand: Working on it…');

    const channel = mention.channel ?? '';
    const thread_ts = mention.thread_ts ?? mention.ts;

    void postSlackResponse(
      toSlackRequest(mention, text),
      store,
      runner,
      client as unknown as SlackPoster,
      channel,
      thread_ts
    );
  });

  app.message(async ({ message, say, client }) => {
    const msg = message as GenericMessageEvent;
    if (!isDirectMessage(msg)) {
      return;
    }

    const text = msg.text ?? '';
    if (!text) {
      return;
    }

    await say(':hourglass_flowing_sand: Working on it…');

    const channel = msg.channel ?? '';
    const thread_ts = msg.ts;

    void postSlackResponse(
      toSlackRequest(msg, text),
      store,
      runner,
      client as unknown as SlackPoster,
      channel,
      thread_ts
    );
  });

  return {
    start: async () => {
      await app.start(config.port ?? 3000);
    },
    stop: () => app.stop(),
  };
}

async function postSlackResponse(
  request: IngressRequest,
  store: SessionStore,
  runner: IngressRunner,
  poster: SlackPoster,
  channel: string,
  thread_ts: string
): Promise<void> {
  try {
    const response = await handleIngressMessage(request, store, runner);
    await sendSlackResponseProactive(poster, channel, thread_ts, response);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const summary = formatError({
      severity: 'failure',
      summary: 'Something went wrong handling your request.',
      cause: error.message,
      impact: 'Your request was not processed.',
      action: 'Try again or contact the platform team with the session id.',
      correlationId: 'unknown',
    });
    await poster.chat.postMessage({ channel, thread_ts, text: summary });
  }
}

async function sendSlackResponseProactive(
  poster: SlackPoster,
  channel: string,
  thread_ts: string,
  response: IngressResponse
): Promise<void> {
  if (response.blocks && response.blocks.length > 0) {
    await poster.chat.postMessage({
      channel,
      thread_ts,
      text: response.text,
      blocks: response.blocks,
    });
  } else {
    await poster.chat.postMessage({ channel, thread_ts, text: response.text });
  }
}
