import http from 'node:http';
import type { Application } from '@microsoft/teams-ai';
import { TeamsAdapter } from '@microsoft/teams-ai';
import { CardFactory, TurnContext } from 'botbuilder';
import type { Activity, ConversationReference } from 'botbuilder';
import type { Request as BotRequest, Response as BotResponse } from 'botbuilder';
import {
  formatError,
  handleIngressMessage,
  type IngressRequest,
  type IngressResponse,
  type IngressRunner,
  type SessionStore,
} from 'framework-core';

export interface TeamsBotConfig {
  port?: number;
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

function toTeamsRequest(activity: Activity): IngressRequest | undefined {
  const text = activity.text ?? '';
  if (!text) {
    return undefined;
  }

  return {
    platform: 'teams',
    teamId: activity.conversation?.tenantId ?? 'unknown',
    channelId: activity.conversation?.id,
    userId: activity.from?.id ?? 'unknown',
    text,
    // M3 (review) mirror check: Teams has no bare "channel" concept the way
    // Slack does — `conversation.id` already identifies one specific
    // conversation/thread (a 1:1 chat, a channel thread, or a channel's
    // "General" root each get distinct conversation ids from Bot Framework),
    // so there is no channel-wide collision to fix here. Kept keyed by
    // conversation id, same as before this milestone.
    threadId: activity.conversation?.id,
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function wrapResponse(res: http.ServerResponse): BotResponse {
  const wrapper: BotResponse = {
    socket: res.socket,
    end: (...args: unknown[]) => res.end(...(args as [string?])),
    header: (name: string, value: unknown) => {
      res.setHeader(name, String(value));
      return wrapper;
    },
    send: (...args: unknown[]) => {
      res.end(...(args as [string?]));
      return wrapper;
    },
    status: (code: number) => {
      res.statusCode = code;
      return wrapper;
    },
  };
  return wrapper;
}

export function createTeamsBot(
  app: Application,
  store: SessionStore,
  runner: IngressRunner,
  config?: TeamsBotConfig
): { start: () => Promise<void>; stop: () => Promise<void> } {
  app.message(/.*/, async (context, _state) => {
    const request = toTeamsRequest(context.activity);
    if (!request) {
      return;
    }

    // Capture before the turn ends — context is only valid during this turn.
    const conversationRef = TurnContext.getConversationReference(context.activity);
    const adapter = app.adapter as TeamsAdapter;

    // Acknowledge immediately. Teams/Bot Framework sends its HTTP 202 when this
    // handler resolves, so the user gets an instant "working on it" before the
    // long Goose run starts.
    await context.sendActivity(':hourglass_flowing_sand: Working on it…');

    void postTeamsResponse(request, store, runner, adapter, conversationRef);
  });

  let server: http.Server | undefined;

  return {
    start: async () => {
      const adapter = app.adapter as TeamsAdapter;
      server = http.createServer(async (req, res) => {
        const body = await readRequestBody(req);
        const wrappedReq: BotRequest = {
          body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
        };
        const wrappedRes = wrapResponse(res);
        await adapter.process(wrappedReq, wrappedRes, async (context: TurnContext) => {
          await app.run(context);
        });
      });

      return new Promise<void>((resolve, reject) => {
        server!.listen(config?.port ?? 3978, () => resolve());
        server!.on('error', reject);
      });
    },
    stop: () =>
      new Promise((resolve) => {
        if (!server) {
          resolve(undefined);
          return;
        }
        server.close(() => resolve(undefined));
      }),
  };
}

async function postTeamsResponse(
  request: IngressRequest,
  store: SessionStore,
  runner: IngressRunner,
  adapter: TeamsAdapter,
  conversationRef: Partial<ConversationReference>
): Promise<void> {
  try {
    const response = await handleIngressMessage(request, store, runner);
    await adapter.continueConversation(conversationRef, async (ctx: TurnContext) => {
      await sendTeamsResponse(ctx, response);
    });
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
    await adapter.continueConversation(conversationRef, async (ctx: TurnContext) => {
      await ctx.sendActivity(summary);
    });
  }
}

async function sendTeamsResponse(context: TurnContext, response: IngressResponse): Promise<void> {
  if (response.adaptiveCard) {
    const card = CardFactory.adaptiveCard(response.adaptiveCard);
    await context.sendActivity({
      text: response.text,
      attachments: [card],
    });
  } else {
    await context.sendActivity(response.text);
  }
}
