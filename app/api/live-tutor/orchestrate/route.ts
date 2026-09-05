import { NextResponse } from 'next/server';
import { createLiveTutorOrchestrator, type LiveTutorStatus } from '../../../../lib/liveTutorOrchestrator';
import {
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
} from '../../../../lib/aiSecurityGateway';
import logger from '../../../../lib/logger';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';

// In-memory orchestrator instances per user
// TODO: Move to Redis/session cache for production
const orchestratorInstances = new Map<string, ReturnType<typeof createLiveTutorOrchestrator>>();

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    headers: {
      ...buildCorsHeaders(req.headers.get('origin')),
      'Access-Control-Allow-Methods': CORS_METHODS,
    },
    status: 200,
  });
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const corsHeaders = {
    ...buildCorsHeaders(origin),
    'Access-Control-Allow-Methods': CORS_METHODS,
  };

  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'This Live Tutor endpoint is not available in production.' },
      { status: 410, headers: corsHeaders }
    );
  }

  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { action, message, conversationId } = body;

    if (!action || typeof action !== 'string') {
      return NextResponse.json(
        { error: 'action is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    logger.info('Live Tutor orchestrate request', {
      userId: user.id,
      action,
      messageLength: message?.length ?? 0,
    });

    // Get or create orchestrator for this user session
    let orchestrator = orchestratorInstances.get(user.id);
    if (!orchestrator) {
      orchestrator = createLiveTutorOrchestrator(null, {
        onStatusChange: (status: LiveTutorStatus) => {
          logger.info('Orchestrator status changed', {
            userId: user.id,
            status,
          });
        },
        onTranscriptChange: (transcript: string, interim: string) => {
          logger.info('Orchestrator transcript', {
            userId: user.id,
            transcriptLength: transcript.length,
            interimLength: interim.length,
          });
        },
        onSubtitleChange: (subtitle: string) => {
          logger.info('Orchestrator subtitle', {
            userId: user.id,
            subtitleLength: subtitle.length,
          });
        },
        onError: (error: string) => {
          logger.error('Orchestrator error', {
            userId: user.id,
            error,
          });
        },
        onConversationMessage: (msg: { role: 'user' | 'assistant'; text: string }) => {
          logger.info('Orchestrator conversation', {
            userId: user.id,
            role: msg.role,
            textLength: msg.text.length,
          });
        },
            }, user.id);

      orchestratorInstances.set(user.id, orchestrator);
      logger.info('Created new orchestrator instance', { userId: user.id });
    }

    if (action === 'send-message') {
      if (!message || typeof message !== 'string' || !message.trim()) {
        return NextResponse.json(
          { error: 'message is required and must be non-empty' },
          { status: 400, headers: corsHeaders }
        );
      }

      try {
        const result = await orchestrator.sendText(message.trim());

        logger.info('Orchestrator sent message', {
          userId: user.id,
          messageLength: message.length,
          responseLength: result.length,
        });

        return NextResponse.json(
          {
            ok: true,
            result,
            conversationId: conversationId || 'live-tutor-session',
          },
          { headers: corsHeaders }
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Send message failed';
        logger.error('Orchestrator send-message error', {
          userId: user.id,
          error: errorMsg,
        });

        return NextResponse.json(
          { error: errorMsg },
          { status: 500, headers: corsHeaders }
        );
      }
    } else if (action === 'interrupt') {
      try {
        await orchestrator.interruptSpeech();

        logger.info('Orchestrator interrupted', { userId: user.id });

        return NextResponse.json(
          { ok: true },
          { headers: corsHeaders }
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Interrupt failed';
        logger.error('Orchestrator interrupt error', {
          userId: user.id,
          error: errorMsg,
        });

        return NextResponse.json(
          { error: errorMsg },
          { status: 500, headers: corsHeaders }
        );
      }
    } else {
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400, headers: corsHeaders }
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Orchestration failed';
    logger.error('Live Tutor orchestrate error', { error: message });

    return NextResponse.json(
      { error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}
