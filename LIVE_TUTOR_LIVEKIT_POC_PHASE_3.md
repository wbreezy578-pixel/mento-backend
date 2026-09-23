# Live Tutor LiveKit proof of concept — Phase 3

Phase 3 attaches a Simli server-side avatar worker to the isolated LiveKit room. It does not change the normal `webview-simli` Live Tutor route.

## Audio path

The existing Gemini native-audio bridge still produces continuous 16 kHz, mono, PCM16 frames. `liveTutorLiveKitPcmPublisher.ts` retains generation ownership, a 60 ms startup target, a 400 ms hard queue bound, and stale-generation rejection. At the sink, Phase 3 uses LiveKit Agents' `DataStreamAudioOutput` to send private PCM to the Simli participant. Simli then publishes the synchronized avatar audio and video tracks to the room.

This differs from publishing Gemini PCM as a microphone track. The documented Simli worker listens to the private `lk.audio_stream` data stream, and uses `lk.clear_buffer` for immediate interruption.

## Session safety

`liveTutorSimliLiveKitAvatarSession.ts` creates a fresh room participant and Simli worker per proof-of-concept session. The avatar token is scoped to that room and carries `lk.publish_on_behalf` for the Mento agent identity. The Android test token can subscribe but cannot publish. If token creation, attachment, or avatar join fails, the LiveKit room connection is closed.

Completing a Gemini generation closes its audio segment before waiting for Simli's playback-finished event. Interrupting clears both Mento's generation queue and Simli's remote buffer. Closing the proof of concept clears the avatar buffer and disconnects the room.

## Gate and limitation

Both experiment flags remain required, and the production session route remains unavailable for `livekit-simli-poc`. A real Phase 3 media test needs a publicly reachable LiveKit deployment plus `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SIMLI_API_KEY`, and `SIMLI_FACE_ID`. A localhost LiveKit server cannot be reached by Simli's cloud worker.

Once those credentials are configured, `npm run validate:livekit-simli-poc` replays the controlled 16 kHz speech fixture and fails unless the subscriber receives both Simli audio and video. It also reports queue, underrun, overflow, stale-generation, and scheduler metrics for the run.
