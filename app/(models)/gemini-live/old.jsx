"use client";

import { GoogleGenAI, Modality } from "@google/genai";
import { useState, useRef } from "react";

export default function Home() {
  const [userInput, setUserInput] = useState("");
  const [session, setSession] = useState(null);
  const [geminiResponse, setGeminiResponse] = useState("");

  const audioContextRef = useRef(null);
  const nextStartTimeRef = useRef(0);

  const micStreamRef = useRef(null);
  const micContextRef = useRef(null);
  const micProcessorRef = useRef(null);

  const videoRef = useRef(null);
  const videoStreamRef = useRef(null);
  const videoIntervalRef = useRef(null);

  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  async function startLive() {
    const { token } = await fetch("/api/token").then((res) => res.json());

    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: {
        apiVersion: "v1alpha",
      },
    });
    //create the audio and context:
    audioContextRef.current = new AudioContext({
      sampleRate: 24000,
    });
    await audioContextRef.current.resume();

    const newSession = await ai.live.connect({
      model: "gemini-3.8-live",

      config: {
        responseModalities: [Modality.AUDIO],
      },

      callbacks: {
        onopen: () => {
          console.log("Connected");
        },

        onmessage: async (response) => {
          const content = response.serverContent;

          // this is for audio receiving and than playing
          if (content?.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
              if (part.inlineData) {
                const audioData = part.inlineData.data;
                // console.log("Audio received:", audioData);
                playPCM(audioData);
              }
            }
          }

          if (content?.inputTranscription) {
            console.log("User:", content.inputTranscription.text);
          }
          if (content?.outputTranscription) {
            console.log("Gemini:", content.outputTranscription.text);

            setGeminiResponse(
              (prev) => prev + content.outputTranscription.text,
            );
          }
        },

        onerror: (error) => {
          console.log("Error:", error);
        },

        onclose: (event) => {
          console.log("Closed:", event.reason);
        },
      },
    });

    console.log("Session started");

    setSession(newSession);
  }
  function closeSession() {
    if (!session) return;

    session.close();

    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }

    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach((track) => track.stop());
      videoStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setSession(null);

    console.log("Session closed");
  }
  function askGeminiWithText() {
    if (!session) {
      console.log("Start Live first");
      alert("Start Live first");
      return;
    }

    if (!userInput.trim()) return;
    setGeminiResponse("");

    session.sendRealtimeInput({
      text: userInput,
    });

    console.log("You:", userInput);

    setUserInput("");
  }
  function toggleMicrophone() {
    if (micOn) {
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micProcessorRef.current?.disconnect();

      setMicOn(false);
      console.log("Microphone stopped");
    } else {
      startMicrophone();
    }
  }
  function toggleCamera() {
    if (cameraOn) {
      clearInterval(videoIntervalRef.current);

      videoStreamRef.current?.getTracks().forEach((track) => track.stop());

      videoRef.current.srcObject = null;

      setCameraOn(false);
      console.log("Camera stopped");
    } else {
      startCamera();
    }
  }
  ///////// below functions are copy and paste
  function playPCM(base64) {
    const audioContext = audioContextRef.current;

    if (!audioContext) return;

    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);

    for (let i = 0; i < binary.length; i++) {
      view[i] = binary.charCodeAt(i);
    }

    const pcm = new Int16Array(buffer);

    const audioBuffer = audioContext.createBuffer(1, pcm.length, 24000);

    const channel = audioBuffer.getChannelData(0);

    for (let i = 0; i < pcm.length; i++) {
      channel[i] = pcm[i] / 32768;
    }

    const source = audioContext.createBufferSource();

    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    const startTime = Math.max(
      audioContext.currentTime,
      nextStartTimeRef.current,
    );

    source.start(startTime);

    nextStartTimeRef.current = startTime + audioBuffer.duration;
  }

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

  async function startMicrophone() {
    if (!session) {
      console.log("Start Live first");
      alert("Start Live first");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    micStreamRef.current = stream;

    const audioContext = new AudioContext({
      sampleRate: 16000,
    });

    micContextRef.current = audioContext;

    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);

    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    micProcessorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);

      const pcm = floatTo16BitPCM(input);

      const base64Audio = pcmToBase64(pcm);

      session.sendRealtimeInput({
        audio: {
          data: base64Audio,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    };

    source.connect(processor);

    // Keep processor alive without playing microphone audio.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    console.log("Microphone started");
    setMicOn(true);
  }

  async function startCamera() {
    if (!session) {
      alert("Start Live first");
      return;
    }
    setMicOn(true);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });

    videoStreamRef.current = stream;

    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    videoIntervalRef.current = setInterval(() => {
      const video = videoRef.current;

      if (!video || video.readyState < 2) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(
        async (blob) => {
          if (!blob || !session) return;

          const buffer = await blob.arrayBuffer();

          const bytes = new Uint8Array(buffer);

          let binary = "";

          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }

          const base64 = btoa(binary);

          session.sendRealtimeInput({
            video: {
              data: base64,
              mimeType: "image/jpeg",
            },
          });

          console.log("Video frame sent");
        },
        "image/jpeg",
        0.7,
      );
    }, 1000);

    console.log("Camera started");
    setCameraOn(true);
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-2 text-3xl font-bold text-gray-900">
          🎙️ Gemini Live
        </h1>

        <p className="mb-8 text-gray-500">
          Chat with Gemini using text or your microphone.
        </p>

        {/* Live controls */}
        <div className="mb-6 flex gap-3">
          <button
            onClick={startLive}
            className="rounded-xl bg-black px-5 py-3 font-medium text-white transition hover:bg-gray-800"
          >
            🟢 Start Live
          </button>

          {session && (
            <button
              onClick={closeSession}
              className="rounded-xl bg-red-600 px-5 py-3 font-medium text-white transition hover:bg-red-700"
            >
              ⏹️ Close
            </button>
          )}
        </div>

        {/* Input */}
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <label
            htmlFor="userInput"
            className="mb-2 block font-medium text-gray-700"
          >
            💬 Ask Gemini
          </label>

          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="userInput"
              type="text"
              placeholder="Type your question..."
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  askGeminiWithText();
                }
              }}
              className="flex-1 rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-blue-500"
            />

            <button
              onClick={askGeminiWithText}
              className="rounded-xl bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700"
            >
              💬 Ask
            </button>
          </div>

          <div className="mt-4 flex gap-3">
            <button
              onClick={toggleMicrophone}
              className="rounded-full bg-green-600 px-6 py-3 font-medium text-white"
            >
              {micOn ? "🎤 Mic On" : "🔇 Mic Off"}
            </button>

            <button
              onClick={toggleCamera}
              className="rounded-full bg-purple-600 px-6 py-3 font-medium text-white"
            >
              {cameraOn ? "📷 Camera On" : "🚫📷 Camera Off"}
            </button>
          </div>
        </div>

        {/* Gemini response */}
        <div className="mt-6 rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="mb-3 font-semibold text-gray-900">🤖 Gemini</h2>

          <div className="min-h-24 rounded-xl bg-gray-50 p-4">
            <p className="leading-7 text-gray-700">
              {geminiResponse || "Gemini's response will appear here..."}
            </p>
          </div>
        </div>

        <hr />

        {videoRef !== null && (
          <div>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="mt-4 w-full rounded-xl border"
            />
          </div>
        )}
      </div>
    </main>
  );
}
