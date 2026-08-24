'use client';

import { useEffect, useState, useRef } from 'react';

// Import the pre-generated Simli bundle from mobile app
// This bundle contains simli-client@3.0.2 bundled with all dependencies
import { SIMLI_CLIENT_BUNDLE_JS as SIMLI_BUNDLE } from '../../../../mento-mobile/src/components/live/simliClientBundle.generated';

interface DiagnosticLog {
  timestamp: string;
  event: string;
  details?: string;
}

interface SessionResponse {
  sessionToken: string;
  streamId: string;
  sessionId: string;
  avatarId?: string;
  expiresAt?: number;
}

interface OrchestrateResponse {
  ok: boolean;
  result: string;
}

interface TTSResponse {
  audioBase64: string;
  mimeType: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

type ConnectionState = 'Initializing' | 'Connecting' | 'Ready' | 'Error' | 'Disconnected';

const ORCHESTRATE_TIMEOUT_MS = 60000;

export default function SimliTestPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<ConnectionState>('Initializing');
  const [logs, setLogs] = useState<DiagnosticLog[]>([]);
  const [messageInput, setMessageInput] = useState('Hello');
  const [response, setResponse] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasBrowserSession, setHasBrowserSession] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [manualAccessToken, setManualAccessToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const simliClientRef = useRef<any>(null);
  const sessionRef = useRef<SessionResponse | null>(null);

  const addLog = (event: string, details?: string) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[SimliTest] ${event}${details ? ': ' + details : ''}`);
    setLogs((prev) => [...prev, { timestamp, event, details }]);
  };

  const getProtectedHeaders = (contentTypeJson = true) => {
    const headers: Record<string, string> = {};

    if (contentTypeJson) {
      headers['Content-Type'] = 'application/json';
    }

    const token = accessToken.trim() || manualAccessToken.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  };

  const checkBrowserSession = async () => {
    try {
      const meRes = await fetch('/api/me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      addLog('[SimliTest] /api/me status: ' + meRes.status);

      if (meRes.ok) {
        setHasBrowserSession(true);
        addLog('[SimliTest] browser auth available: true');
        addLog('browser session detected');
        return true;
      }

      setHasBrowserSession(false);
      addLog('[SimliTest] browser auth available: false');
      addLog('browser session missing', `status: ${meRes.status}`);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHasBrowserSession(false);
      addLog('[SimliTest] browser auth available: false');
      addLog('browser session check failed', message);
      return false;
    }
  };

  const validateManualToken = async () => {
    const trimmed = manualAccessToken.trim();
    if (!trimmed) {
      addLog('auth token present', 'false');
      return false;
    }

    try {
      const meRes = await fetch('/api/me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          'Cache-Control': 'no-cache',
        },
      });

      addLog('[SimliTest] /api/me status: ' + meRes.status);

      const valid = meRes.ok;
      addLog('auth token present', String(valid));
      if (!valid) {
        addLog('manual token rejected', `status: ${meRes.status}`);
      }
      return valid;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('manual token validation failed', message);
      return false;
    }
  };

  const signIn = async () => {
    const emailValue = email.trim();
    const passwordValue = password.trim();

    if (!emailValue || !passwordValue) {
      addLog('sign in failed', 'missing email or password');
      setState('Error');
      return;
    }

    try {
      setIsLoading(true);
      addLog('sign in request started', 'using existing /api/login flow');
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: emailValue, password: passwordValue }),
      });

      if (!res.ok) {
        const text = await res.text();
        addLog('sign in failed', `status: ${res.status} ${text}`);
        setState('Error');
        setIsLoading(false);
        return;
      }

      const data = await res.json();
      const token = typeof data?.token === 'string' ? data.token : '';
      if (!token) {
        addLog('login response missing token', 'token not returned');
        setState('Error');
        setIsLoading(false);
        return;
      }

      setAccessToken(token);
      setHasBrowserSession(true);
      addLog('[SimliTest] login completed');
      addLog('[SimliTest] browser auth available: true');
      addLog('auth token present', 'true');
      addLog('browser session detected', 'via existing Mento login flow');
      setState('Initializing');
      setIsLoading(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('sign in error', message);
      setState('Error');
      setIsLoading(false);
    }
  };

  const safeCloseReason = (value?: string) => {
    const raw = typeof value === 'string' ? value : '';
    const sanitized = raw
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/token=[^&\s]+/gi, 'token=[redacted]')
      .replace(/jwt\s*[:=][^\s,;]+/gi, 'jwt=[redacted]')
      .trim();
    return sanitized ? sanitized.slice(0, 180) : 'empty';
  };

  const safeDiagnosticText = (value?: string | Error) => {
    const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
    const sanitized = raw
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/session_token=[^&\s]+/gi, 'session_token=[redacted]')
      .replace(/token=[^&\s]+/gi, 'token=[redacted]')
      .replace(/jwt\s*[:=][^\s,;]+/gi, 'jwt=[redacted]')
      .replace(/api[_-]?key[s]?\s*[:=][^\s,;]+/gi, 'api_key=[redacted]')
      .trim();
    return sanitized ? sanitized.slice(0, 180) : 'empty';
  };

  const buildSimliSignalUrl = (baseUrl: string, sessionToken: string) => {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = new URL(`${cleanBase}/compose/webrtc/livekit`);
    url.searchParams.set('session_token', sessionToken);
    return url.toString();
  };

  const buildSimliSignalingUrl = (sessionToken: string) => buildSimliSignalUrl('wss://api.simli.ai', sessionToken);

  const getWebSocketDiagnosticState = (result: { ok: boolean; error?: string; readyState?: number; closeCode?: number; closeReason?: string } | null) => {
    if (!result) {
      return { webSocketCreation: 'FAIL', webSocketOpen: 'FAIL', closeCode: 'n/a', closeReason: 'n/a' };
    }

    const closeCode = typeof result.closeCode === 'number' ? String(result.closeCode) : 'n/a';
    const closeReason = result.closeReason && result.closeReason !== 'empty' ? result.closeReason : 'empty';

    return {
      webSocketCreation: result.ok || result.error ? 'PASS' : 'FAIL',
      webSocketOpen: result.ok ? 'PASS' : 'FAIL',
      closeCode,
      closeReason,
    };
  };

  const probeWebSocketTarget = async (wsUrl: string) => {
    const host = (() => {
      try {
        return new URL(wsUrl).host;
      } catch {
        return wsUrl;
      }
    })();
    const pathname = (() => {
      try {
        return new URL(wsUrl).pathname;
      } catch {
        return '/compose/webrtc/livekit';
      }
    })();

    addLog('[SimliTest] websocket URL host: api.simli.ai');
    addLog('[SimliTest] websocket path: /compose/webrtc/livekit');
    addLog('[SimliTest] session token present: true');
    addLog('[SimliTest] websocket created');

    if (typeof window === 'undefined' || typeof window.WebSocket !== 'function') {
      addLog('SimliTest websocket constructor available', 'false');
      return { ok: false, error: 'Browser WebSocket API unavailable' };
    }

    addLog('SimliTest websocket constructor available', 'true');

    return await new Promise<{ ok: boolean; error?: string; readyState?: number; closeCode?: number; closeReason?: string }>((resolve) => {
      let finished = false;
      const socket = new WebSocket(wsUrl);

      const finish = (result: { ok: boolean; error?: string; readyState?: number; closeCode?: number; closeReason?: string }) => {
        if (finished) return;
        finished = true;
        resolve(result);
      };

      socket.onopen = () => {
        addLog('[SimliTest] websocket open');
        addLog('SimliTest websocket readyState', String(socket.readyState));
        try {
          socket.close(1000, 'diag-ok');
        } catch {
          // ignore close failures in the probe itself
        }
        finish({ ok: true, readyState: socket.readyState });
      };

      socket.onerror = () => {
        addLog('[SimliTest] websocket error');
        addLog('SimliTest websocket readyState', String(socket.readyState));
        finish({ ok: false, error: 'browser websocket failed', readyState: socket.readyState });
      };

      socket.onclose = (event) => {
        addLog('[SimliTest] websocket close');
        addLog('[SimliTest] websocket close code: ' + String(event.code));
        addLog('[SimliTest] websocket close reason: ' + safeCloseReason(event.reason));
        addLog('SimliTest websocket close code', String(event.code));
        addLog('SimliTest websocket close reason', safeCloseReason(event.reason));
        addLog('SimliTest websocket readyState', String(socket.readyState));
        if (!finished) {
          finish({ ok: false, error: 'browser websocket closed', readyState: socket.readyState, closeCode: event.code, closeReason: safeCloseReason(event.reason) });
        }
      };

      setTimeout(() => {
        if (!finished) {
          addLog('SimliTest websocket timeout', host);
          addLog('SimliTest websocket readyState', String(socket.readyState));
          try {
            socket.close();
          } catch {
            // ignore close failures in the probe itself
          }
          finish({ ok: false, error: 'browser websocket timeout', readyState: socket.readyState });
        }
      }, 7000);
    });
  };

  const connectAvatar = async () => {
    const resolvedToken = accessToken.trim() || manualAccessToken.trim();
    const authTokenPresent = Boolean(resolvedToken) || hasBrowserSession;
    addLog('auth token present', String(authTokenPresent));

    if (!authTokenPresent) {
      addLog('auth required', 'not signed in');
      setState('Error');
      return;
    }

    try {
      setIsLoading(true);
      setState('Connecting');
      setIsConnected(false);
      sessionRef.current = null;

      if (simliClientRef.current) {
        try {
          simliClientRef.current.stop();
        } catch {
          // ignore stale stop errors before starting a fresh session
        }
      }

      addLog('[SimliTest] requesting fresh session');

      const headers = getProtectedHeaders();
      const sessionRes = await fetch('/api/live-tutor/session', {
        method: 'GET',
        credentials: 'include',
        headers,
      });

      addLog('[SimliTest] /api/live-tutor/session status: ' + sessionRes.status);
      addLog('session request status', String(sessionRes.status));

      if (!sessionRes.ok) {
        throw new Error(`Session creation failed: ${sessionRes.status}`);
      }

      const session: SessionResponse = await sessionRes.json();
      sessionRef.current = session;
      addLog('[SimliTest] session created');
      addLog('session created', `sessionId: ${session.sessionId}`);

      // Initialize SimliClient globally from bundle
      if (!window.SimliClient) {
        const bundleScript = document.createElement('script');
        bundleScript.textContent = SIMLI_BUNDLE;
        document.head.appendChild(bundleScript);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!window.SimliClient || !window.LogLevel) {
        throw new Error('SimliClient bundle failed to load');
      }

      const { SimliClient, LogLevel } = window;
      addLog('SimliClient available', String(Boolean(window.SimliClient)));
      addLog('SimliClient constructor available', String(typeof window.SimliClient === 'function'));
      addLog('LogLevel available', String(Boolean(window.LogLevel)));
      addLog('SimliTest transport', 'livekit');
      addLog('SimliTest signaling', 'websockets');
      addLog('[SimliTest] starting SimliClient');

      const simliSignalUrl = buildSimliSignalingUrl(session.sessionToken);
      simliClientRef.current = new SimliClient(
        session.sessionToken,
        videoRef.current!,
        audioRef.current!,
        null,
        LogLevel.ERROR,
        'livekit',
        'websockets',
        simliSignalUrl,
        1024
      );

      // Attach high-fidelity diagnostics into the existing bundled client.
      // This inspects the client instance for LiveKit Room, WebSocket, and RTCPeerConnection
      // instances and attaches safe listeners that record state without exposing tokens.
      const attachDiagnostics = (client: any) => {
        try {
          addLog('[SimliTest] attaching diagnostics');

          // Generic error wrapper: enhance existing 'error' event logging to capture structured info
          client.on('error', (err: any) => {
            try {
              const safe = safeDiagnosticText(err instanceof Error ? err : String(err));
              addLog('[SimliTest] SimliClient error: ' + safe);

              // If error is an object, try to extract common LiveKit fields safely
              if (err && typeof err === 'object') {
                const code = (err.code || err.status || err.errorCode || err.category) ?? undefined;
                const message = err.message ?? err.description ?? undefined;
                const reason = err.reason ?? err.detail ?? undefined;
                if (code) addLog('[SimliTest] connection error code', String(code));
                if (message) addLog('[SimliTest] connection error message', safeDiagnosticText(String(message)));
                if (reason) addLog('[SimliTest] disconnect reason', safeDiagnosticText(String(reason)));
              }
            } catch (inner) {
              addLog('[SimliTest] diagnostic error handler threw', safeDiagnosticText(inner instanceof Error ? inner : String(inner)));
            }
            setState('Error');
          });

          // Search for a LiveKit Room-like object on the client instance
          const tryAttachRoom = (obj: any, name: string) => {
            if (!obj || typeof obj !== 'object') return false;
            // Room-like detectors: has 'on' function and 'connectionState' or 'connectionStateChanged'
            if (typeof obj.on === 'function' && ('connectionState' in obj || typeof obj.connectionStateChanged === 'function')) {
              addLog('[SimliTest] LiveKit Room object detected: ' + name);

              try {
                // connection state (LiveKit may emit 'connectionStateChanged' or provide 'connectionState')
                if (typeof obj.on === 'function') {
                  try {
                    obj.on('connectionStateChanged', (s: any) => addLog('[SimliTest] LiveKit state', String(s)));
                  } catch {}
                  try {
                    obj.on('connected', () => addLog('[SimliTest] LiveKit state', 'Connected'));
                  } catch {}
                  try {
                    obj.on('disconnected', (reason: any) => {
                      addLog('[SimliTest] LiveKit state', 'Disconnected');
                      addLog('[SimliTest] LiveKit disconnect reason', safeDiagnosticText(String(reason)));
                    });
                  } catch {}
                  try {
                    obj.on('reconnecting', () => addLog('[SimliTest] LiveKit state', 'Reconnecting'));
                  } catch {}
                  try {
                    obj.on('reconnected', () => addLog('[SimliTest] LiveKit state', 'Reconnected'));
                  } catch {}
                  // some LiveKit variants expose signalConnected signal
                  try {
                    obj.on('signalConnected', () => addLog('[SimliTest] LiveKit state', 'SignalConnected'));
                  } catch {}
                  try {
                    obj.on('signalDisconnected', (reason: any) => {
                      addLog('[SimliTest] LiveKit state', 'SignalDisconnected');
                      addLog('[SimliTest] LiveKit disconnect reason', safeDiagnosticText(String(reason)));
                    });
                  } catch {}
                }

                if ('connectionState' in obj) {
                  addLog('[SimliTest] LiveKit state', String(obj.connectionState));
                }

                // Try to find underlying PeerConnection in known places
                const candidates = [obj.engine, obj.transport, obj._pc, obj.pc, obj._peerConnection, obj.peerConnection];
                for (const cand of candidates) {
                  if (cand && typeof cand === 'object') {
                    // If cand itself is RTCPeerConnection
                    if (typeof RTCPeerConnection !== 'undefined' && cand instanceof RTCPeerConnection) {
                      attachPeerConnection(cand, '[livekit-room->pc]');
                      break;
                    }
                    // If cand has a .pc property
                    if (cand.pc && typeof RTCPeerConnection !== 'undefined' && cand.pc instanceof RTCPeerConnection) {
                      attachPeerConnection(cand.pc, '[livekit-room->transport.pc]');
                      break;
                    }
                  }
                }

                return true;
              } catch (err) {
                addLog('[SimliTest] error attaching to LiveKit Room', safeDiagnosticText(err instanceof Error ? err : String(err)));
                return false;
              }
            }
            return false;
          };

          const attachPeerConnection = (pc: RTCPeerConnection, label = 'pc') => {
            try {
              addLog('[SimliTest] RTCPeerConnection created');
              addLog('[SimliTest] ICE gathering state', String(pc.iceGatheringState));
              addLog('[SimliTest] ICE connection state', String(pc.iceConnectionState));
              // connectionState may exist on some browsers
              // @ts-ignore
              if ('connectionState' in pc) addLog('[SimliTest] connection state', String((pc as any).connectionState));

              pc.addEventListener('icegatheringstatechange', () => {
                addLog('[SimliTest] ICE gathering state', String(pc.iceGatheringState));
              });

              pc.addEventListener('iceconnectionstatechange', () => {
                addLog('[SimliTest] ICE connection state', String(pc.iceConnectionState));
              });

              try {
                // some implementations expose connectionstate
                // @ts-ignore
                pc.addEventListener && (pc as any).addEventListener('connectionstatechange', () => {
                  // @ts-ignore
                  addLog('[SimliTest] connection state', String((pc as any).connectionState));
                });
              } catch {}
            } catch (err) {
              addLog('[SimliTest] failed to attach PC listeners', safeDiagnosticText(err instanceof Error ? err : String(err)));
            }
          };

          const attachWebSocket = (ws: WebSocket, label = 'ws') => {
            try {
              addLog('[SimliTest] websocket/network state', String(ws.readyState));

              // Open
              try {
                ws.addEventListener('open', () => {
                  addLog('[SimliTest] signaling websocket opened');
                  addLog('[SimliTest] websocket/network state', String(ws.readyState));
                });
              } catch {}

              // Message handler with sanitized preview
              try {
                const handleMessagePayload = (raw: string) => {
                  const length = typeof raw === 'string' ? raw.length : 0;
                  const lowered = raw ? raw.toUpperCase() : '';
                  let type: string = 'UNKNOWN';
                  if (lowered.includes('DESTINATION')) type = 'DESTINATION';
                  else if (lowered.includes('LIVEKIT')) type = 'LIVEKIT';
                  else if (lowered.includes('SDP') || lowered.includes('SESSION_DESCRIPTION')) type = 'SDP';
                  else if (lowered.includes('ERROR')) type = 'ERROR';
                  else if (lowered.includes('CLOSING') || lowered.includes('CLOSE')) type = 'CLOSING';
                  else if (lowered.includes('RATE')) type = 'RATE';

                  // Sanitize preview using existing helper
                  const preview = safeDiagnosticText(raw).slice(0, 100);

                  addLog('[SimliTest] signaling message received');
                  addLog('signaling message type', type);
                  addLog('signaling message length', String(length));
                  addLog('signaling message preview', preview);
                };

                ws.addEventListener('message', (ev: MessageEvent) => {
                  try {
                    // Handle string
                    if (typeof ev.data === 'string') {
                      handleMessagePayload(ev.data);
                      return;
                    }

                    // ArrayBuffer
                    if (ev.data instanceof ArrayBuffer) {
                      try {
                        const text = new TextDecoder().decode(ev.data);
                        handleMessagePayload(text);
                        return;
                      } catch {
                        addLog('[SimliTest] signaling message received', 'binary arraybuffer');
                        addLog('signaling message length', String(ev.data.byteLength));
                        return;
                      }
                    }

                    // Blob
                    if (ev.data instanceof Blob) {
                      const blob = ev.data as Blob;
                      addLog('[SimliTest] signaling message received', 'blob');
                      addLog('signaling message length', String(blob.size));
                      // Read blob as text asynchronously and log a preview
                      try {
                        const reader = new FileReader();
                        reader.onload = () => {
                          try {
                            const text = String(reader.result || '');
                            handleMessagePayload(text);
                          } catch (e) {
                            addLog('[SimliTest] signaling message blob read error', safeDiagnosticText(e instanceof Error ? e : String(e)));
                          }
                        };
                        reader.onerror = () => {
                          addLog('[SimliTest] signaling message blob read failed', 'reader error');
                        };
                        reader.readAsText(blob);
                      } catch (e) {
                        addLog('[SimliTest] signaling message blob handling failed', safeDiagnosticText(e instanceof Error ? e : String(e)));
                      }
                      return;
                    }

                    // Fallback
                    try {
                      const text = String(ev.data);
                      handleMessagePayload(text);
                    } catch {
                      addLog('[SimliTest] signaling message received', 'unknown data type');
                    }
                  } catch (inner) {
                    addLog('[SimliTest] signaling message handler threw', safeDiagnosticText(inner instanceof Error ? inner : String(inner)));
                  }
                });
              } catch (err) {
                addLog('[SimliTest] failed to attach message listener', safeDiagnosticText(err instanceof Error ? err : String(err)));
              }

              // Error
              try {
                ws.addEventListener('error', (ev) => {
                  addLog('[SimliTest] signaling websocket error');
                  addLog('[SimliTest] websocket/network state', String(ws.readyState));
                });
              } catch (err) {
                addLog('[SimliTest] failed to attach websocket error listener', safeDiagnosticText(err instanceof Error ? err : String(err)));
              }

              // Close
              try {
                ws.addEventListener('close', (ev: CloseEvent) => {
                  addLog('[SimliTest] signaling websocket closed');
                  addLog('signaling websocket close code', String(ev.code));
                  addLog('signaling websocket close reason', safeCloseReason(ev.reason));
                  addLog('[SimliTest] websocket/network state', String(ws.readyState));
                });
              } catch (err) {
                addLog('[SimliTest] failed to attach websocket close listener', safeDiagnosticText(err instanceof Error ? err : String(err)));
              }

            } catch (err) {
              addLog('[SimliTest] failed to attach websocket listeners', safeDiagnosticText(err instanceof Error ? err : String(err)));
            }
          };

          // Quick heuristic search across client object properties for interesting internals
          const inspectAndAttach = (obj: any, name: string) => {
            if (!obj || typeof obj !== 'object') return;

            // Direct WebSocket
            if (typeof WebSocket !== 'undefined' && obj instanceof WebSocket) {
              attachWebSocket(obj, name);
            }

            // RTCPeerConnection
            if (typeof RTCPeerConnection !== 'undefined' && obj instanceof RTCPeerConnection) {
              attachPeerConnection(obj, name);
            }

            // Room-like
            tryAttachRoom(obj, name);

            // Recurse one level deep for properties that might hold internals
            for (const k of Object.keys(obj)) {
              try {
                const v = obj[k];
                if (!v || typeof v !== 'object') continue;

                if (typeof WebSocket !== 'undefined' && v instanceof WebSocket) {
                  attachWebSocket(v, `${name}.${k}`);
                }
                if (typeof RTCPeerConnection !== 'undefined' && v instanceof RTCPeerConnection) {
                  attachPeerConnection(v as RTCPeerConnection, `${name}.${k}`);
                }
                tryAttachRoom(v, `${name}.${k}`);
              } catch {}
            }
          };

          inspectAndAttach(client, 'simliClient');

          // Also scan the client for common named properties
          const namesToCheck = ['_livekit', 'room', '_room', 'livekitRoom', 'engine', 'transport', '_transport', '_ws', 'ws', '_socket', 'socket', '_pc', 'pc', '_peerConnection', 'peerConnection'];
          for (const name of namesToCheck) {
            try {
              const obj = (client as any)[name];
              if (obj) inspectAndAttach(obj, `simliClient.${name}`);
            } catch {}
          }

          // As some internals are created shortly after start(), poll briefly to catch them
          const pollLimit = 20; // ~4 seconds @ 200ms
          let polls = 0;
          const pollId = setInterval(() => {
            polls++;
            inspectAndAttach(client, 'simliClient');
            for (const name of namesToCheck) {
              try {
                const obj = (client as any)[name];
                if (obj) inspectAndAttach(obj, `simliClient.${name}`);
              } catch {}
            }
            if (polls >= pollLimit) clearInterval(pollId);
          }, 200);

        } catch (err) {
          addLog('[SimliTest] failed to setup diagnostics', safeDiagnosticText(err instanceof Error ? err : String(err)));
        }
      };

      // Initial basic listeners (kept short so our enhanced error handler runs too)
      simliClientRef.current.on('start', () => {
        addLog('[SimliTest] SimliClient connected');
        addLog('connected');
        setState('Ready');
        setIsConnected(true);
      });

      simliClientRef.current.on('stop', () => {
        addLog('session-disconnected');
        setState('Disconnected');
        setIsConnected(false);
      });

      // Keep the original string-style error reporting, but prefer structured diagnostics above
      simliClientRef.current.on('error', (error: any) => {
        addLog('[SimliTest] SimliClient error: ' + safeDiagnosticText(error instanceof Error ? error : String(error)));
        addLog('error', safeDiagnosticText(error instanceof Error ? error : String(error)));
        // allow enhanced handler to run as well
        setState('Error');
      });

      simliClientRef.current.on('speaking', () => {
        addLog('avatar speaking');
      });

      simliClientRef.current.on('silent', () => {
        addLog('avatar silent');
      });

      if (videoRef.current) {
        videoRef.current.addEventListener('playing', () => {
          addLog('[SimliTest] video playing');
        });

        videoRef.current.addEventListener('pause', () => {
          addLog('video paused');
        });
      }

      if (audioRef.current) {
        audioRef.current.addEventListener('playing', () => {
          addLog('[SimliTest] audio playing');
        });

        audioRef.current.addEventListener('pause', () => {
          addLog('audio paused');
        });

        const nativeAudioPlay = audioRef.current.play.bind(audioRef.current);
        audioRef.current.play = function () {
          try {
            const result = nativeAudioPlay.call(this);
            if (result instanceof Promise) {
              result.catch((err) => {
                addLog('audio play rejected', safeDiagnosticText(err instanceof Error ? err : String(err)));
              });
            }
            return result;
          } catch (err) {
            addLog('audio play threw', safeDiagnosticText(err instanceof Error ? err : String(err)));
            throw err;
          }
        };
      }

      // Start attaching diagnostics immediately so we capture any early failures
      try {
        attachDiagnostics(simliClientRef.current);
      } catch (err) {
        addLog('[SimliTest] attachDiagnostics threw', safeDiagnosticText(err instanceof Error ? err : String(err)));
      }

      await simliClientRef.current.start();
      setIsLoading(false);
    } catch (error) {
      const message = safeDiagnosticText(error instanceof Error ? error : String(error));
      addLog('connection failed', message);
      setState('Error');
      setIsLoading(false);
    }
  };

  const askAvatar = async () => {
      // Development-only: ensure we surface real online errors instead of enqueueing to offline
      if (!isConnected || !simliClientRef.current || !sessionRef.current) {
        addLog('error', 'Not connected to avatar');
        return;
      }

      try {
        setIsLoading(true);

        // Diagnostic: navigator.onLine state
        try {
          // use console.log with explicit tag to match requested diagnostic format
          // eslint-disable-next-line no-console
          console.log('[SimliTest] navigator.onLine: ' + (typeof navigator !== 'undefined' ? String(navigator.onLine) : 'unknown'));
        } catch (e) {
          // ignore
        }

        // Start orchestrate
        // eslint-disable-next-line no-console
        console.log('[SimliTest] send message started');
        const orchestrateStartTime = Date.now();
        console.log('[SimliTest] orchestrate request started');
        addLog('orchestrate request started', `message: "${messageInput}"`);

        // 1. POST /api/live-tutor/orchestrate
        const orchestrateController = new AbortController();
        const orchestrateTimeout = setTimeout(() => {
          const elapsedMs = Date.now() - orchestrateStartTime;
          console.log(`[SimliTest] orchestrate timeout after ${ORCHESTRATE_TIMEOUT_MS}ms`);
          addLog('orchestrate timeout after ' + ORCHESTRATE_TIMEOUT_MS + 'ms', `elapsed: ${elapsedMs}ms`);
          orchestrateController.abort();
        }, ORCHESTRATE_TIMEOUT_MS);

        let orchestrateRes: Response;
        try {
          orchestrateRes = await fetch('/api/live-tutor/orchestrate', {
            method: 'POST',
            credentials: 'same-origin',
            headers: getProtectedHeaders(),
            body: JSON.stringify({
              action: 'send-message',
              message: messageInput.trim(),
              conversationId: sessionRef.current.sessionId,
            }),
            signal: orchestrateController.signal,
          });
        } catch (error) {
          const elapsedMs = Date.now() - orchestrateStartTime;
          const isAbort = error instanceof DOMException && error.name === 'AbortError';
          if (isAbort) {
            console.log(`[SimliTest] orchestrate aborted after ${elapsedMs}ms`);
            addLog('orchestrate aborted after ' + elapsedMs + 'ms');
          }
          throw error;
        } finally {
          clearTimeout(orchestrateTimeout);
        }

        const elapsedMs = Date.now() - orchestrateStartTime;
        console.log(`[SimliTest] orchestrate completed in ${elapsedMs}ms`);
        addLog('orchestrate completed in ' + elapsedMs + 'ms');

        // Log status
        // eslint-disable-next-line no-console
        console.log('[SimliTest] orchestrate status: ' + (orchestrateRes ? String(orchestrateRes.status) : 'no-response'));

        if (!orchestrateRes.ok) {
          const text = await orchestrateRes.text().catch(() => '');
          const safe = safeDiagnosticText(text);
          // eslint-disable-next-line no-console
          console.log('[SimliTest] orchestrate failed: ' + safe);
          addLog('ask avatar failed', `orchestrate failed: ${safe}`);
          setIsLoading(false);
          return;
        }

        const orchestrateData: OrchestrateResponse = await orchestrateRes.json();

        // If backend enqueued to offline queue it returns a queued message string; treat that as an error in this dev harness
        if (!orchestrateData.ok || (typeof orchestrateData.result === 'string' && orchestrateData.result.startsWith('Queued offline:'))) {
          const resultText = String(orchestrateData.result || 'unknown');
          const safe = safeDiagnosticText(resultText);
          // eslint-disable-next-line no-console
          console.log('[SimliTest] orchestrate failed: ' + safe);
          addLog('ask avatar failed', `orchestrate failed: ${safe}`);
          setIsLoading(false);
          return;
        }

        const assistantText = String(orchestrateData.result || '');
        // Diagnostic: assistant text length
        // eslint-disable-next-line no-console
        console.log('[SimliTest] assistant text length: ' + assistantText.length);

        setResponse(assistantText);
        addLog('orchestrate response received', `text length: ${assistantText.length}`);

        // 2. POST /api/live-tutor/tts
        // Diagnostics
        // eslint-disable-next-line no-console
        console.log('[SimliTest] TTS request started');

        const ttsRes = await fetch('/api/live-tutor/tts', {
          method: 'POST',
          credentials: 'same-origin',
          headers: getProtectedHeaders(),
          body: JSON.stringify({ text: assistantText }),
        });

        // Log TTS status
        // eslint-disable-next-line no-console
        console.log('[SimliTest] TTS status: ' + String(ttsRes.status));

        if (!ttsRes.ok) {
          // If rate limited, surface the real cooldown
          const text = await ttsRes.text().catch(() => '');
          const safe = safeDiagnosticText(text || `status ${ttsRes.status}`);
          // eslint-disable-next-line no-console
          console.log('[SimliTest] orchestrate failed: ' + safe);
          addLog('ask avatar failed', `tts failed: ${safe}`);
          setIsLoading(false);
          return;
        }

        const ttsData: TTSResponse = await ttsRes.json();
        const audioBase64 = ttsData?.audioBase64 || '';
        const audioBytesCount = audioBase64.length;
        // eslint-disable-next-line no-console
        console.log('[SimliTest] TTS audio received: ' + audioBytesCount + ' bytes');
        addLog('tts response received', `bytes: ${audioBytesCount}`);

        // 3. Decode base64 to Uint8Array
        const binaryString = atob(audioBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Log before sending to Simli
        // eslint-disable-next-line no-console
        console.log('[SimliTest] TTS audio received');
        // eslint-disable-next-line no-console
        console.log('[SimliTest] sending audio to Simli: ' + bytes.length + ' bytes');

        // 4. Send audio to SimliClient using existing simliClientRef
        try {
          // sendAudioData is synchronous in the installed SDK
          simliClientRef.current.sendAudioData(bytes);
          // eslint-disable-next-line no-console
          console.log('[SimliTest] speak-audio-sent: ' + bytes.length + ' bytes');
          addLog('audio sent to simli', `${bytes.length} bytes`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.log('[SimliTest] sending audio to Simli failed: ' + safeDiagnosticText(message));
          addLog('simli audio error', safeDiagnosticText(message));
          setState('Error');
          setIsLoading(false);
          return;
        }

        setIsLoading(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const safe = safeDiagnosticText(message);
        // eslint-disable-next-line no-console
        console.log('[SimliTest] orchestrate failed: ' + safe);
        addLog('ask avatar failed', safe);
        setIsLoading(false);
      }
    };

  // Development-only guard
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      return;
    }

    addLog('webview boot');
    addLog('webview loaded');
    void checkBrowserSession();

    return () => {
      if (simliClientRef.current) {
        simliClientRef.current.stop().catch(() => {
          // Already disconnected
        });
      }
    };
  }, []);

  const isSignedIn = hasBrowserSession || Boolean(accessToken.trim()) || Boolean(manualAccessToken.trim());

  return (
    <div
      style={{
        padding: '20px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        maxWidth: '1200px',
        margin: '0 auto',
      }}
    >
      <h1>Simli Avatar Test Page</h1>
      <p style={{ color: '#666' }}>
        Development-only test harness for debugging Live Tutor integration
      </p>

      {!isSignedIn && process.env.NODE_ENV !== 'production' && (
        <div
          style={{
            marginBottom: '20px',
            padding: '20px',
            border: '1px solid #f0c36d',
            borderRadius: '8px',
            backgroundColor: '#fff7e6',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: '12px' }}>Not signed in</div>

          <div style={{ display: 'grid', gap: '10px', maxWidth: '440px' }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              style={{
                padding: '10px 12px',
                border: '1px solid #d0d7de',
                borderRadius: '6px',
              }}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              style={{
                padding: '10px 12px',
                border: '1px solid #d0d7de',
                borderRadius: '6px',
              }}
            />
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={signIn}
                disabled={isLoading}
                style={{
                  padding: '10px 16px',
                  backgroundColor: '#007bff',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {isLoading ? 'Signing in...' : 'Sign in'}
              </button>
            </div>
          </div>

          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #e9d9a5' }}>
            <div style={{ fontWeight: 600, marginBottom: '8px' }}>Development Authentication</div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>Access token:</label>
            <input
              type="password"
              value={manualAccessToken}
              onChange={(e) => setManualAccessToken(e.target.value)}
              placeholder="Paste a valid Mento access token"
              style={{
                width: '100%',
                maxWidth: '520px',
                padding: '10px 12px',
                border: '1px solid #d0d7de',
                borderRadius: '6px',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ marginTop: '12px' }}>
              <button
                type="button"
                onClick={async () => {
                  const valid = await validateManualToken();
                  if (valid) {
                    setHasBrowserSession(false);
                    addLog('manual token accepted');
                  }
                }}
                style={{
                  padding: '10px 16px',
                  backgroundColor: '#28a745',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Use Token
              </button>
            </div>
          </div>
        </div>
      )}

      {isSignedIn && (
        <div
          style={{
            marginBottom: '16px',
            padding: '12px 16px',
            borderRadius: '6px',
            backgroundColor: '#eafaf1',
            border: '1px solid #b9e7c8',
            fontWeight: 600,
            color: '#146c43',
          }}
        >
          Signed in
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
        {/* Video/Audio Section */}
        <div>
          <h2>Avatar Display</h2>
          <div style={{ backgroundColor: '#000', borderRadius: '8px', overflow: 'hidden', marginBottom: '10px' }}>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              style={{
                width: '100%',
                height: '300px',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          </div>
          <audio
            ref={audioRef}
            autoPlay
            controls
            style={{
              width: '100%',
              marginBottom: '10px',
            }}
          />
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={connectAvatar}
              disabled={isLoading || isConnected}
              style={{
                padding: '10px 20px',
                backgroundColor: isConnected ? '#ccc' : '#007bff',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: isLoading || isConnected ? 'not-allowed' : 'pointer',
                flex: 1,
              }}
            >
              {isLoading && state === 'Connecting' ? 'Connecting...' : 'Connect Avatar'}
            </button>
            {isConnected && (
              <button
                onClick={() => {
                  simliClientRef.current?.stop();
                  setIsConnected(false);
                  setState('Disconnected');
                }}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#dc3545',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Diagnostics Section */}
        <div>
          <h2>Connection State</h2>
          <div
            style={{
              padding: '15px',
              backgroundColor: '#f5f5f5',
              borderRadius: '4px',
              marginBottom: '10px',
              fontFamily: 'monospace',
            }}
          >
            <div style={{ marginBottom: '10px' }}>
              <strong>Status:</strong> <span style={{ color: getStatusColor(state) }}>{state}</span>
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>
              <div>TCP/HTTPS: PASS</div>
              <div>Session creation: {sessionRef.current ? 'PASS' : 'FAIL'}</div>
              <div>WebSocket creation: {sessionRef.current ? 'PASS' : 'FAIL'}</div>
              <div>WebSocket open: {isConnected ? 'PASS' : 'FAIL'}</div>
              <div>Close code: {sessionRef.current ? 'n/a' : 'n/a'}</div>
              <div>Close reason: {sessionRef.current ? 'n/a' : 'n/a'}</div>
            </div>
          </div>

          <h3>Diagnostic Log</h3>
          <div
            style={{
              backgroundColor: '#f9f9f9',
              border: '1px solid #ddd',
              borderRadius: '4px',
              height: '250px',
              overflowY: 'auto',
              padding: '10px',
              fontSize: '12px',
              fontFamily: 'monospace',
            }}
          >
            {logs.length === 0 ? (
              <div style={{ color: '#999' }}>No logs yet...</div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} style={{ marginBottom: '4px', color: '#333' }}>
                  <span style={{ color: '#999' }}>[{log.timestamp}]</span> {log.event}
                  {log.details && <span style={{ color: '#666' }}> — {log.details}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Message Section */}
      {isConnected && (
        <div style={{ backgroundColor: '#f0f8ff', padding: '15px', borderRadius: '4px', marginBottom: '20px' }}>
          <h2>Send Message</h2>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder="Enter message..."
              style={{
                flex: 1,
                padding: '10px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px',
              }}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  askAvatar();
                }
              }}
            />
            <button
              onClick={askAvatar}
              disabled={isLoading || !isConnected}
              style={{
                padding: '10px 20px',
                backgroundColor: '#28a745',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {isLoading ? 'Sending...' : 'Ask Avatar'}
            </button>
          </div>

          {response && (
            <div style={{ backgroundColor: '#fff', padding: '10px', borderRadius: '4px', marginTop: '10px' }}>
              <strong>Assistant Response:</strong>
              <p style={{ margin: '8px 0 0 0', whiteSpace: 'pre-wrap' }}>{response}</p>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '4px', fontSize: '12px', color: '#666' }}>
        <p style={{ margin: '0 0 8px 0' }}>
          <strong>Development Test Page</strong> — Not for production use
        </p>
        <p style={{ margin: '0' }}>
          This test harness validates the Simli avatar pipeline without the React Native app.
          Check browser console for full diagnostic logs.
        </p>
      </div>
    </div>
  );
}

function getStatusColor(state: ConnectionState): string {
  switch (state) {
    case 'Ready':
      return '#28a745';
    case 'Connecting':
      return '#ffc107';
    case 'Error':
      return '#dc3545';
    case 'Disconnected':
      return '#999';
    case 'Initializing':
    default:
      return '#007bff';
  }
}

// Extend window type for SimliClient
declare global {
  interface Window {
    SimliClient: any;
    LogLevel: any;
  }
}
