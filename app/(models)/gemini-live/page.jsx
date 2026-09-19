"use client";

import { GoogleGenAI, Modality } from "@google/genai";
import { useState, useRef, useEffect } from "react";

// --------------------------------
// SMALL HELPERS
// --------------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatTime(totalSeconds) {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// The API lists tokens per modality (text, audio, video...). Add them up.
function sumDetails(list) {
  return (list || []).reduce((sum, d) => sum + (d.tokenCount || 0), 0);
}

export default function Home() {
  // --------------------------------
  // STATE
  // --------------------------------

  const [userInput, setUserInput] = useState("");
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]); // { role, type, text, turn, done }

  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const [showUsage, setShowUsage] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [sessionUsage, setSessionUsage] = useState({ input: 0, output: 0 });
  const [minuteTokens, setMinuteTokens] = useState(0);

  // camera window: distance from right/top edge of the chat area + width
  const [cam, setCam] = useState({ right: 12, top: 12, w: 192 });

  // --------------------------------
  // REFS
  // --------------------------------

  // Callbacks (mic, camera, ws) live longer than one render,
  // so they read the session from a ref instead of state.
  const sessionRef = useRef(null);

  const audioContextRef = useRef(null);
  const gainRef = useRef(null); // one gain node = volume + mute
  const nextStartTimeRef = useRef(0);

  const micStreamRef = useRef(null);
  const micContextRef = useRef(null);
  const micProcessorRef = useRef(null);

  const videoRef = useRef(null);
  const videoStreamRef = useRef(null);
  const videoIntervalRef = useRef(null);
  const camBoxRef = useRef(null);
  const dragRef = useRef(null);

  const turnRef = useRef(0); // groups user + gemini messages of one exchange
  const usageLogRef = useRef([]); // [{ t, tokens }] for the per-minute count
  const bottomRef = useRef(null);

  // --------------------------------
  // EFFECTS
  // --------------------------------
  function updateMinuteTokens() {
    const cutoff = Date.now() - 60000;

    usageLogRef.current = usageLogRef.current.filter((e) => e.t > cutoff);

    setMinuteTokens(usageLogRef.current.reduce((sum, e) => sum + e.tokens, 0));
  }
  // keep chat scrolled to the newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // volume slider + mute button -> gain node
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = muted ? 0 : volume;
    }
  }, [volume, muted]);

  // refresh the "per minute" number even when nothing is happening
  // useEffect(() => {
  //   const id = setInterval(updateMinuteTokens, 5000);
  //   return () => clearInterval(id);
  // }, []);

  // session timer: runs while connected, keeps the last value after End
  useEffect(() => {
    if (!session) return;

    const start = Date.now();

    const id = setInterval(() => {
      setSessionSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    return () => clearInterval(id);
  }, [session]);

  // --------------------------------
  // CHAT HELPERS
  // --------------------------------

  // Add a streamed chunk to the open message of that role in the current turn,
  // or start a new one. User and Gemini can stream at the same time.
  function addChunk(role, text) {
    const turn = turnRef.current;

    setMessages((prev) => {
      const i = prev.findIndex(
        (m) => m.turn === turn && m.role === role && !m.done,
      );

      if (i === -1) {
        return [...prev, { role, type: "voice", text, turn, done: false }];
      }

      return prev.map((m, j) => (j === i ? { ...m, text: m.text + text } : m));
    });
  }

  // End of a turn: close open messages (stops the cursor) and start a new turn
  function finishTurn() {
    turnRef.current += 1;
    setMessages((prev) => prev.map((m) => (m.done ? m : { ...m, done: true })));
  }

  // --------------------------------
  // TOKEN USAGE
  // --------------------------------

  // Every usage report from the API is added up.
  // Session = running total, Minute = sum of the last 60 seconds.
  function recordUsage(input, output) {
    usageLogRef.current.push({
      t: Date.now(),
      tokens: input + output,
    });

    setSessionUsage((prev) => ({
      input: prev.input + input,
      output: prev.output + output,
    }));

    updateMinuteTokens();
  }

  // --------------------------------
  // SESSION
  // --------------------------------

  async function startLive() {
    try {
      const { token } = await fetch("/api/token").then((res) => res.json());

      const ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: {
          apiVersion: "v1alpha",
        },
      });

      // speaker output: audio -> gain (volume / mute) -> speakers
      const audioContext = new AudioContext({ sampleRate: 24000 });
      await audioContext.resume();

      const gain = audioContext.createGain();
      gain.gain.value = muted ? 0 : volume;
      gain.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      gainRef.current = gain;
      nextStartTimeRef.current = 0;

      // fresh usage numbers for the new session (chat is kept)
      usageLogRef.current = [];
      setSessionUsage({ input: 0, output: 0 });
      setMinuteTokens(0);

      const newSession = await ai.live.connect({
        model: "gemini-3.8-live",

        config: {
          responseModalities: [Modality.AUDIO],

          // Keep transcription enabled
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },

        callbacks: {
          onopen: () => {
            console.log("Connected");
          },

          onmessage: (response) => {
            const content = response.serverContent;

            // TOKEN USAGE
            const usage = response.usageMetadata;

            if (usage) {
              console.log("Usage:", usage); // raw numbers from the API

              // per-modality details are the full picture (they include the
              // conversation context the API re-reads); fall back to totals
              const input =
                sumDetails(usage.promptTokensDetails) ||
                usage.promptTokenCount ||
                0;

              const output =
                sumDetails(usage.responseTokensDetails) ||
                usage.responseTokenCount ||
                usage.candidatesTokenCount ||
                0;

              if (input || output) recordUsage(input, output);
            }

            // USER TRANSCRIPT (streams in chunks)
            if (content?.inputTranscription?.text) {
              console.log("User:", content.inputTranscription.text);
              addChunk("user", content.inputTranscription.text);
            }

            // GEMINI TRANSCRIPT (streams in chunks)
            if (content?.outputTranscription?.text) {
              console.log("Gemini:", content.outputTranscription.text);
              addChunk("gemini", content.outputTranscription.text);
            }

            // GEMINI AUDIO
            if (content?.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData) {
                  playPCM(part.inlineData.data);
                }
              }
            }

            // TURN COMPLETE (or user interrupted Gemini)
            if (content?.turnComplete || content?.interrupted) {
              finishTurn();
            }
          },

          onerror: (error) => {
            console.log("Error:", error);
          },

          onclose: (event) => {
            console.log("Closed:", event.reason);
            cleanup();
          },
        },
      });

      sessionRef.current = newSession;
      setSession(newSession);
    } catch (error) {
      console.log("Start error:", error);
      cleanup();
    }
  }

  // Stops mic, camera, audio and resets the UI. Chat is NOT cleared.
  // Safe to call more than once.
  function cleanup() {
    stopMicrophone();
    stopCamera();

    audioContextRef.current?.close();
    audioContextRef.current = null;
    gainRef.current = null;
    nextStartTimeRef.current = 0;

    sessionRef.current = null;
    setSession(null);

    finishTurn();
  }

  function closeSession() {
    sessionRef.current?.close();
    cleanup();
  }

  function askGeminiWithText() {
    if (!sessionRef.current) {
      alert("Start Live first");
      return;
    }

    if (!userInput.trim()) return;

    const text = userInput.trim();

    setMessages((prev) => [
      ...prev,
      { role: "user", type: "text", text, turn: turnRef.current, done: true },
    ]);

    sessionRef.current.sendRealtimeInput({ text });

    setUserInput("");
  }

  // --------------------------------
  // PLAY GEMINI AUDIO
  // --------------------------------

  function playPCM(base64) {
    const audioContext = audioContextRef.current;

    if (!audioContext || !gainRef.current) return;

    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);

    const audioBuffer = audioContext.createBuffer(1, pcm.length, 24000);
    const channel = audioBuffer.getChannelData(0);

    for (let i = 0; i < pcm.length; i++) {
      channel[i] = pcm[i] / 32768;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainRef.current);

    const startTime = Math.max(
      audioContext.currentTime,
      nextStartTimeRef.current,
    );

    source.start(startTime);

    nextStartTimeRef.current = startTime + audioBuffer.duration;
  }

  // --------------------------------
  // MICROPHONE
  // --------------------------------

  function toggleMicrophone() {
    if (micOn) {
      stopMicrophone();
    } else {
      startMicrophone();
    }
  }

  function stopMicrophone() {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micProcessorRef.current?.disconnect();
    micContextRef.current?.close();

    micStreamRef.current = null;
    micProcessorRef.current = null;
    micContextRef.current = null;

    setMicOn(false);
  }

  async function startMicrophone() {
    if (!sessionRef.current) {
      alert("Start Live first");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      micStreamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      micContextRef.current = audioContext;

      await audioContext.resume();

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      micProcessorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (!sessionRef.current) return;

        const input = event.inputBuffer.getChannelData(0);
        const base64Audio = pcmToBase64(floatTo16BitPCM(input));

        sessionRef.current.sendRealtimeInput({
          audio: {
            data: base64Audio,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      };

      source.connect(processor);

      // processor needs an output to keep running, so route it silently
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      setMicOn(true);
    } catch (error) {
      console.log("Mic error:", error);
      alert("Could not access the microphone");
    }
  }

  // --------------------------------
  // CAMERA
  // --------------------------------

  function toggleCamera() {
    if (cameraOn) {
      stopCamera();
    } else {
      startCamera();
    }
  }

  function stopCamera() {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }

    videoStreamRef.current?.getTracks().forEach((track) => track.stop());
    videoStreamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraOn(false);
  }

  async function startCamera() {
    if (!sessionRef.current) {
      alert("Start Live first");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });

      videoStreamRef.current = stream;

      // <video> is always in the DOM, so this ref is never null
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      // send 1 frame per second
      videoIntervalRef.current = setInterval(() => {
        const video = videoRef.current;

        if (!video || video.readyState < 2 || !sessionRef.current) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const data = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];

        sessionRef.current.sendRealtimeInput({
          video: { data, mimeType: "image/jpeg" },
        });
      }, 1000);

      setCameraOn(true);
    } catch (error) {
      console.log("Camera error:", error);
      stopCamera();
      alert("Could not access the camera");
    }
  }

  // --------------------------------
  // CAMERA WINDOW (drag to move, pull corner to resize)
  // --------------------------------

  function startCamDrag(e, mode) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    dragRef.current = { mode, x: e.clientX, y: e.clientY, ...cam };
  }

  function moveCamDrag(e) {
    const d = dragRef.current;
    const box = camBoxRef.current;

    if (!d || !box) return;

    const parent = box.parentElement;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;

    if (d.mode === "move") {
      setCam((c) => ({
        ...c,
        right: clamp(d.right - dx, 0, parent.clientWidth - box.offsetWidth),
        top: clamp(d.top + dy, 0, parent.clientHeight - box.offsetHeight),
      }));
    } else {
      // corner is bottom-left, so dragging left makes it bigger
      // min 120px, max 480px
      setCam((c) => ({ ...c, w: clamp(d.w - dx, 120, 480) }));
    }
  }

  function stopCamDrag() {
    dragRef.current = null;
  }

  // --------------------------------
  // AUDIO HELPERS
  // --------------------------------

  function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));

      view.setInt16(
        i * 2,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      );
    }

    return new Uint8Array(buffer);
  }

  function pcmToBase64(pcm) {
    let binary = "";

    for (let i = 0; i < pcm.length; i++) {
      binary += String.fromCharCode(pcm[i]);
    }

    return btoa(binary);
  }

  // --------------------------------
  // UI
  // --------------------------------

  // Show each exchange in order: turn by turn, your message before Gemini's.
  // (Voice transcripts can arrive out of order, this keeps the chat readable.)
  const shownMessages = [...messages].sort(
    (a, b) =>
      a.turn - b.turn || (a.role === b.role ? 0 : a.role === "user" ? -1 : 1),
  );

  const sessionTotal = sessionUsage.input + sessionUsage.output;

  const ghostBtn =
    "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";

  const pillBtn = (active) =>
    `rounded-full border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      active
        ? "border-indigo-600 bg-indigo-50 text-indigo-700"
        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
    }`;

  return (
    <main className="flex h-dvh flex-col bg-slate-50 text-slate-900">
      {/* HEADER */}

      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              session ? "animate-pulse bg-emerald-500" : "bg-slate-300"
            }`}
          />
          <div>
            <h1 className="text-base font-semibold leading-tight">
              Gemini Live
            </h1>
            <p className="text-xs text-slate-500">
              {session ? "Connected" : "Not connected"}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setShowUsage((prev) => !prev)}
            className={ghostBtn}
          >
            📊 Usage
          </button>
          <button onClick={() => setMessages([])} className={ghostBtn}>
            Clear chat
          </button>
        </div>
      </header>

      {/* USAGE */}

      {showUsage && (
        <div className="flex shrink-0 flex-wrap gap-x-10 gap-y-3 border-b border-slate-200 bg-white px-4 py-3">
          <div>
            <p className="text-xs text-slate-500">Session time</p>
            <p className="text-xl font-semibold tabular-nums">
              {formatTime(sessionSeconds)}
            </p>
          </div>

          <div>
            <p className="text-xs text-slate-500">Last 60 seconds</p>
            <p className="text-xl font-semibold tabular-nums">
              {minuteTokens.toLocaleString()}
              <span className="ml-1 text-xs font-normal text-slate-400">
                tokens
              </span>
            </p>
          </div>

          <div>
            <p className="text-xs text-slate-500">This session</p>
            <p className="text-xl font-semibold tabular-nums">
              {sessionTotal.toLocaleString()}
              <span className="ml-1 text-xs font-normal text-slate-400">
                tokens
              </span>
            </p>
            <p className="text-xs tabular-nums text-slate-400">
              in {sessionUsage.input.toLocaleString()} / out{" "}
              {sessionUsage.output.toLocaleString()}
            </p>
          </div>
        </div>
      )}

      {/* CHAT (this is the only part that scrolls) */}

      <section className="relative min-h-0 flex-1">
        {/* Camera window. Always rendered so the video ref exists, just hidden when off.
            Drag it anywhere, pull the bottom-left corner to resize. */}
        <div
          ref={camBoxRef}
          onPointerDown={(e) => startCamDrag(e, "move")}
          onPointerMove={moveCamDrag}
          onPointerUp={stopCamDrag}
          onPointerCancel={stopCamDrag}
          title="Drag to move, pull the corner to resize"
          style={{
            right: cam.right,
            top: cam.top,
            width: cam.w,
            touchAction: "none",
          }}
          className={`absolute z-10 cursor-grab select-none overflow-hidden rounded-xl border-2 border-white bg-slate-900 shadow-lg active:cursor-grabbing ${
            cameraOn ? "" : "pointer-events-none opacity-0"
          }`}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="pointer-events-none block w-full"
          />

          <div
            onPointerDown={(e) => startCamDrag(e, "resize")}
            style={{ cursor: "nesw-resize", touchAction: "none" }}
            className="absolute bottom-0 left-0 flex h-7 w-7 items-center justify-center rounded-tr-lg bg-black/50 text-xs text-white"
          >
            ⤢
          </div>
        </div>

        <div className="h-full overflow-y-auto px-4 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {messages.length === 0 && (
              <div className="mt-24 text-center">
                <div className="mb-3 text-4xl">🎙️</div>
                <h2 className="text-lg font-semibold">Talk to Gemini</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Press Start Live, then type or turn on your mic.
                </p>
              </div>
            )}

            {shownMessages.map((message, index) => (
              <div
                key={index}
                className={`flex ${
                  message.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-6 sm:max-w-[75%] ${
                    message.role === "user"
                      ? "rounded-br-md bg-slate-900 text-white"
                      : "rounded-bl-md border border-slate-200 bg-white text-slate-800"
                  }`}
                >
                  {message.text}
                  {!message.done && (
                    <span className="ml-0.5 animate-pulse">▍</span>
                  )}
                </div>
              </div>
            ))}

            <div ref={bottomRef} />
          </div>
        </div>
      </section>

      {/* CONTROLS */}

      <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto max-w-2xl space-y-3">
          {/* TEXT INPUT */}

          <div className="flex gap-2">
            <input
              type="text"
              placeholder={session ? "Type a message..." : "Start Live to chat"}
              value={userInput}
              disabled={!session}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askGeminiWithText();
              }}
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 outline-none focus:border-indigo-500 focus:bg-white disabled:opacity-50"
            />

            <button
              onClick={askGeminiWithText}
              disabled={!session}
              className="rounded-xl bg-indigo-600 px-5 font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>

          {/* ACTIONS */}

          <div className="flex flex-wrap items-center gap-2">
            {session ? (
              <button
                onClick={closeSession}
                className="rounded-full bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700"
              >
                End
              </button>
            ) : (
              <button
                onClick={startLive}
                className="rounded-full bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                Start Live
              </button>
            )}

            <button
              onClick={toggleMicrophone}
              disabled={!session}
              className={pillBtn(micOn)}
            >
              {micOn ? "🎤 Mic on" : "🎤 Mic off"}
            </button>

            <button
              onClick={toggleCamera}
              disabled={!session}
              className={pillBtn(cameraOn)}
            >
              {cameraOn ? "📷 Camera on" : "📷 Camera off"}
            </button>

            <button
              onClick={() => setMuted((prev) => !prev)}
              className={pillBtn(muted)}
            >
              {muted ? "🔇 Muted" : "🔊 Sound on"}
            </button>

            {/* VOLUME */}

            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Volume"
              className="ml-auto w-28 accent-indigo-600"
            />
          </div>
        </div>
      </footer>
    </main>
  );
}
