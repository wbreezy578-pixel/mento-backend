# Live Tutor LiveKit proof of concept — Phase 2

Phase 2 provides an isolated server-side publisher for Gemini audio after Mento's existing stateful resampler and 640-byte frame buffer. It is not connected to production session creation yet.

## Audio contract

- PCM16 little-endian, 16kHz, mono.
- Exactly 640 bytes and 20ms per published frame.
- Starts with a 60ms prebuffer.
- Never publishes faster than one frame per 20ms, including after scheduler stalls.
- Does not insert continuous or concealment silence.
- Holds no more than 400ms during exceptional upstream bursts and applies backpressure at the limit.
- Clears the native LiveKit audio source when the active generation is interrupted.
- Rejects late frames from cancelled generations.

`liveTutorLiveKitPcmPublisher.ts` owns the test media clock and generation queue. `liveTutorLiveKitRoomPublisher.ts` uses the official `@livekit/rtc-node` `AudioSource` and publishes a microphone audio track. It creates a separate, subscribe-only room token for the controlled test client. Credentials remain backend-only.

## Runtime gate

The Phase 1 route remains unchanged: normal sessions use `webview-simli`, and the proof-of-concept route is not admitted into the production voice gateway. Phase 3 will attach Simli and own creation/cleanup of this room publisher. This separation prevents an incomplete path from affecting current Live Tutor sessions.

## Live validation

The configured environment had no LiveKit credentials, so validation used an isolated local LiveKit Server 1.13.5 container with development-only credentials. `scripts/validateLiveTutorLiveKitPublisher.ts` connected one publisher and one subscriber, then sent a deterministic one-second 440Hz PCM signal as 40ms source bursts through the production publisher adapter.

Final result:

- 50 of 50 frames published (1,000ms PCM);
- subscriber received 24,000 decoded samples, including 16,968 nonzero samples;
- maximum publisher queue depth: 60ms;
- underruns: 0;
- overflows: 0;
- stale-generation drops: 0;
- maximum scheduler lateness: 15ms.

The received sample count includes WebRTC/decoder framing and is not an identity comparison with source PCM. The test proves a subscriber received continuous non-silent audio through the real server, room, Opus/WebRTC and Node audio-source path. It does not test Gemini, Simli, Android, or physical audio/video alignment. The temporary container was stopped and removed after validation.
