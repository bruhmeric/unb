"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Zap, Upload, Film, Download, RefreshCw, ShieldCheck, Cpu,
  CheckCircle2, AlertTriangle, Terminal, ChevronRight, Lock,
  FileVideo, Sparkles, Layers, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";

/* ------------------------------------------------------------------ types */

type Phase = "idle" | "ready" | "processing" | "done" | "error";

interface FileMeta {
  width: number;
  height: number;
  duration: number;
}

interface WorkerStats {
  inputBytes: number;
  outputBytes: number;
  audioSamples?: { before: number; after: number };
}

/* ------------------------------------------------------------------ page */

export default function MethodV2Page() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string>("");

  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  const [dragging, setDragging] = useState(false);
  const [stats, setStats] = useState<WorkerStats | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const objectUrlsRef = useRef<string[]>([]);

  /* ---------------------------------------------------- lifecycle helpers */

  const cleanupUrls = useCallback(() => {
    objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrlsRef.current = [];
  }, []);

  useEffect(() => () => {
    cleanupUrls();
    workerRef.current?.terminate();
  }, [cleanupUrls]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  /* ---------------------------------------------------------- file input */

  const acceptFile = useCallback((f: File | null) => {
    if (!f) return;
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const validExt = ["mp4", "mov", "m4v"];
    const validMime = f.type.startsWith("video/");
    if (!validExt.includes(ext) && !validMime) {
      setErrorMsg("Unsupported format. Please select a valid MP4 or MOV video file.");
      setPhase("error");
      return;
    }
    cleanupUrls();
    const url = URL.createObjectURL(f);
    objectUrlsRef.current.push(url);

    setFile(f);
    setPreviewUrl(url);
    setOutputUrl(null);
    setStats(null);
    setErrorMsg("");
    setLogs([]);
    setPhase("ready");

    // Read dimensions via a probe element
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      setMeta({
        width: probe.videoWidth || 1280,
        height: probe.videoHeight || 720,
        duration: Number.isFinite(probe.duration) ? probe.duration : 0,
      });
    };
    probe.src = url;
  }, [cleanupUrls]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    acceptFile(e.dataTransfer.files?.[0] ?? null);
  }, [acceptFile]);

  /* ------------------------------------------------------------- process */

  const processVideo = useCallback(async () => {
    if (!file || phase === "processing") return;
    setPhase("processing");
    setPercent(0);
    setStage("Initializing...");
    setLogs([]);
    setErrorMsg("");

    try {
      const buffer = await file.arrayBuffer();

      const worker = new Worker("/engine/v2-worker.js", { type: "module" });
      workerRef.current?.terminate();
      workerRef.current = worker;

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === "progress") {
          setPercent(msg.percent);
          if (msg.stage) setStage(msg.stage);
          if (msg.log) setLogs((prev) => [...prev, msg.log]);
        } else if (msg.type === "done") {
          const blob = new Blob([msg.buffer], { type: "video/mp4" });
          const url = URL.createObjectURL(blob);
          objectUrlsRef.current.push(url);
          setOutputUrl(url);
          setOutputName(msg.fileName || "video_v2_optimized.mp4");
          if (msg.stats) {
            setStats({
              inputBytes: msg.stats.inputBytes,
              outputBytes: msg.stats.outputBytes,
            });
          }
          setPercent(100);
          setStage("Complete — 100% original quality preserved");
          setPhase("done");
          worker.terminate();
          workerRef.current = null;
        } else if (msg.type === "error") {
          setErrorMsg(msg.error || "Processing failed");
          setPhase("error");
          worker.terminate();
          workerRef.current = null;
        }
      };

      worker.onerror = (err) => {
        setErrorMsg(
          "Worker execution failed: " +
          (err.message || "the engine could not be loaded in this browser."),
        );
        setPhase("error");
      };

      worker.postMessage(
        {
          type: "process",
          buffer,
          fileName: file.name,
          options: {}, // Method V2 is a fixed pipeline — no knobs
        },
        [buffer],
      );
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed processing");
      setPhase("error");
    }
  }, [file, phase]);

  /* ------------------------------------------------------------ download */

  const download = useCallback(() => {
    if (!outputUrl || !outputName) return;
    const a = document.createElement("a");
    a.href = outputUrl;
    a.download = outputName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [outputUrl, outputName]);

  const reset = useCallback(() => {
    cleanupUrls();
    workerRef.current?.terminate();
    workerRef.current = null;
    setFile(null);
    setPreviewUrl(null);
    setMeta(null);
    setOutputUrl(null);
    setOutputName("");
    setStats(null);
    setPercent(0);
    setStage("");
    setLogs([]);
    setErrorMsg("");
    setPhase("idle");
  }, [cleanupUrls]);

  /* ---------------------------------------------------------------- view */

  const fmtMB = (b: number) => (b / 1048576).toFixed(2) + " MB";

  const stepIndex = phase === "idle" ? 0 : phase === "ready" ? 1 : phase === "processing" ? 1 : 2;
  const busy = phase === "processing";

  return (
    <div className="min-h-screen flex flex-col bg-[#060809] text-zinc-100 selection:bg-emerald-500/30">
      {/* ambient glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-96 w-[42rem] rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 h-72 w-72 rounded-full bg-teal-500/10 blur-[100px]" />
      </div>

      {/* ---------------------------------------------------------- header */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#060809]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/20">
              <Zap className="h-5 w-5 text-[#060809]" strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-bold tracking-tight">
                Method <span className="text-emerald-400">V2</span>
              </div>
              <div className="text-[11px] text-zinc-500">Container Enhancer</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/10">
              <Lock className="mr-1 h-3 w-3" /> 100% Client-Side
            </Badge>
            <Badge variant="outline" className="border-white/10 bg-white/5 text-zinc-300 hover:bg-white/5">
              v2.0
            </Badge>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------ main */}
      <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 pb-16">
        {/* ------------------------------------------------------- hero */}
        <section className="pt-12 sm:pt-16 text-center">
          <Badge variant="outline" className="mb-5 border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/10 px-3 py-1">
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Lossless container restructuring
          </Badge>
          <h1 className="mx-auto max-w-3xl text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1]">
            Bypass platform compression.
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
              Keep your quality.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
            Method V2 restructures the MP4 container directly inside your browser —
            unknown movie duration, inflated audio sample tables and a stream-first
            index — so the upload platform keeps your original quality. <span className="text-zinc-200">Zero re-encoding, zero uploads.</span>
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
            {[
              [FileVideo, ".mp4 & .mov"],
              [Cpu, "Web Worker engine"],
              [ShieldCheck, "No server, ever"],
              [Zap, "Seconds per file"],
            ].map(([Icon, label]: any, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-zinc-300">
                <Icon className="h-3.5 w-3.5 text-emerald-400" />
                {label}
              </span>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------- stepper */}
        <section className="mt-12">
          <div className="mx-auto flex max-w-2xl items-center">
            {["Choose Video", "Apply Method", "Download"].map((label, i) => {
              const active = i <= stepIndex;
              const current = i === stepIndex;
              return (
                <div key={label} className={`flex items-center ${i < 2 ? "flex-1" : ""}`}>
                  <div className="flex flex-col items-center gap-1.5">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-full border-2 font-semibold text-sm transition-all ${
                      active
                        ? "border-emerald-400 bg-emerald-400/10 text-emerald-400"
                        : "border-white/10 bg-white/[0.03] text-zinc-600"
                    } ${current && busy ? "animate-pulse" : ""}`}>
                      {active && i < stepIndex ? <CheckCircle2 className="h-5 w-5" /> : i + 1}
                    </div>
                    <span className={`text-[11px] font-medium ${active ? "text-zinc-200" : "text-zinc-600"}`}>
                      {label}
                    </span>
                  </div>
                  {i < 2 && (
                    <div className={`mx-2 mb-5 h-0.5 flex-1 rounded ${i < stepIndex ? "bg-emerald-400/60" : "bg-white/10"}`} />
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* -------------------------------------------- tool card */}
        <section className="mt-6">
          <Card className="overflow-hidden border-white/10 bg-[#0b0f11]/90 shadow-2xl shadow-black/40 backdrop-blur-xl">
            <CardContent className="p-5 sm:p-8">

              {/* STEP 1 — drop zone / preview */}
              {phase === "idle" && (
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Select or drop a video file"
                  onClick={() => inputRef.current?.click()}
                  onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  className={`group flex min-h-64 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
                    dragging
                      ? "border-emerald-400 bg-emerald-400/10 scale-[1.01]"
                      : "border-white/15 bg-white/[0.02] hover:border-emerald-400/50 hover:bg-emerald-400/[0.04]"
                  }`}
                >
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] transition-colors group-hover:border-emerald-400/40">
                    <Upload className="h-7 w-7 text-emerald-400" />
                  </div>
                  <p className="mt-5 text-base font-semibold text-zinc-100">
                    Select video or drag &amp; drop your file here
                  </p>
                  <p className="mt-1.5 text-sm text-zinc-500">
                    Every common container is supported (.mp4, .mov, .m4v)
                  </p>
                  <p className="mt-6 inline-flex items-center gap-1.5 text-xs text-zinc-500">
                    <Lock className="h-3.5 w-3.5 text-emerald-500" />
                    Processing stays on this device — your file is never uploaded.
                  </p>
                </div>
              )}

              {(phase === "ready" || phase === "processing" || phase === "done" || phase === "error") && (
                <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
                  {/* preview player */}
                  <div className="flex flex-col gap-3">
                    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
                      {previewUrl && (
                        <video
                          src={previewUrl}
                          controls
                          playsInline
                          className="aspect-video w-full"
                        />
                      )}
                      <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5">
                        <span className="rounded-md bg-black/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-400 backdrop-blur">
                          source
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                      <span className="inline-flex items-center gap-1.5 font-medium text-zinc-300">
                        <Film className="h-3.5 w-3.5 text-emerald-400" />
                        {file?.name}
                      </span>
                      {meta && (
                        <>
                          <span>{meta.width}×{meta.height}</span>
                          <span>{meta.duration.toFixed(1)}s</span>
                        </>
                      )}
                      <span>{fmtMB(file?.size ?? 0)}</span>
                    </div>
                  </div>

                  {/* controls / progress */}
                  <div className="flex flex-col gap-4">
                    {phase === "ready" && (
                      <>
                        {/* fixed pipeline summary — Method V2 has no options */}
                        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
                          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                            <Layers className="h-4 w-4 text-emerald-400" />
                            Method V2 pipeline (fixed)
                          </div>
                          <ul className="space-y-2 text-xs text-zinc-400">
                            <li className="flex items-start gap-2">
                              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                              <span><span className="text-zinc-200">FastStart</span> — moov index moved ahead of mdat</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                              <span><span className="text-zinc-200">Unknown duration</span> — mvhd v1 duration set to 0xFF…FF</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                              <span><span className="text-zinc-200">10× audio samples</span> — stsz/stts/stsc tables extended</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                              <span><span className="text-zinc-200">Method signature</span> — udta/meta name ".gg/maska"</span>
                            </li>
                          </ul>
                          <p className="text-[11px] leading-relaxed text-zinc-500">
                            Zero re-encoding — every original video &amp; audio byte is kept.
                            Upload the result via <span className="text-zinc-300">TikTok Web (desktop browser)</span> for the bypass to apply.
                          </p>
                        </div>

                        <Button
                          size="lg"
                          onClick={processVideo}
                          className="h-12 w-full text-[15px] font-semibold bg-gradient-to-r from-emerald-500 to-teal-500 text-[#060809] hover:from-emerald-400 hover:to-teal-400 shadow-lg shadow-emerald-500/25"
                        >
                          <Zap className="mr-2 h-5 w-5" />
                          Apply Method
                          <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                        <button
                          onClick={reset}
                          className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
                        >
                          choose a different file
                        </button>
                      </>
                    )}

                    {(phase === "processing" || phase === "done") && (
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            {phase === "done" ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                            ) : (
                              <span className="relative flex h-3 w-3">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                              </span>
                            )}
                            {phase === "done" ? "Success" : "Processing"}
                          </span>
                          <span className={`font-mono text-sm font-semibold ${phase === "done" ? "text-emerald-400" : "text-zinc-300"}`}>
                            {percent}%
                          </span>
                        </div>
                        <Progress
                          value={percent}
                          className="h-2 bg-white/5 *:data-[slot=progress-indicator]:bg-gradient-to-r *:data-[slot=progress-indicator]:from-emerald-500 *:data-[slot=progress-indicator]:to-teal-400"
                        />
                        <p className="mt-2 text-xs text-zinc-500">{stage}</p>
                      </div>
                    )}

                    {phase === "done" && outputUrl && (
                      <>
                        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 text-sm">
                          <div className="flex items-center gap-2 font-semibold text-emerald-400">
                            <Layers className="h-4 w-4" />
                            100% original quality preserved
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                            Lossless container rebuilt — every video &amp; audio byte intact.
                            {stats && (
                              <span className="ml-1 font-mono">
                                ({fmtMB(stats.inputBytes)} → {fmtMB(stats.outputBytes)})
                              </span>
                            )}
                          </p>
                        </div>
                        <Button
                          size="lg"
                          onClick={download}
                          className="h-12 w-full text-[15px] font-semibold bg-gradient-to-r from-emerald-500 to-teal-500 text-[#060809] hover:from-emerald-400 hover:to-teal-400 shadow-lg shadow-emerald-500/25"
                        >
                          <Download className="mr-2 h-5 w-5" />
                          Download Enhanced Video (.mp4)
                        </Button>
                        <Button
                          variant="outline"
                          onClick={reset}
                          className="w-full border-white/15 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06] hover:text-white"
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Process another video
                        </Button>
                      </>
                    )}

                    {phase === "error" && (
                      <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4">
                        <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
                          <AlertTriangle className="h-4 w-4" />
                          Processing failed
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{errorMsg}</p>
                        <Button
                          variant="outline"
                          onClick={reset}
                          className="mt-3 border-white/15 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06] hover:text-white"
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Try another file
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* console log */}
              {(phase === "processing" || phase === "done" || phase === "error") && (
                <div className="mt-6">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    <Terminal className="h-3.5 w-3.5" />
                    Engine log
                  </div>
                  <div
                    ref={logRef}
                    className="max-h-44 overflow-y-auto rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-[11.5px] leading-relaxed"
                  >
                    {logs.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap">
                        <span className={
                          line.startsWith("[SUCCESS]") ? "text-emerald-400"
                          : line.startsWith("[!]") ? "text-amber-400"
                          : line.startsWith("[+]") ? "text-teal-300"
                          : line.startsWith("[ERROR]") ? "text-red-400"
                          : "text-zinc-400"
                        }>
                          {line}
                        </span>
                      </div>
                    ))}
                    {phase === "processing" && (
                      <div className="text-emerald-400">
                        <span className="inline-block h-3 w-1.5 animate-pulse bg-emerald-400" />
                      </div>
                    )}
                  </div>
                </div>
              )}

              <input
                ref={inputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/mov,.mp4,.mov,.m4v"
                className="hidden"
                onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
              />
            </CardContent>
          </Card>
        </section>

        {/* ------------------------------------------ how it works */}
        <section className="mt-16">
          <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
            How the method works
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-sm leading-relaxed text-zinc-400">
            Four lossless transformations to the container — the video and audio
            streams themselves are never touched.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Layers,
                title: "1 — FastStart",
                body: "The moov index atom is relocated before mdat and every edit-list (edts) atom is stripped, producing a clean stream-first container that upload pipelines accept as-is.",
              },
              {
                icon: Zap,
                title: "2 — Unknown duration",
                body: "The movie header (mvhd) is rewritten as version 1 with the duration field set to 0xFFFFFFFFFFFFFFFF (\"unknown\"). Bitrate estimates derived from file size ÷ duration collapse, so the re-encode pass is skipped.",
              },
              {
                icon: Cpu,
                title: "3 — 10× audio samples",
                body: "The audio track's declared sample count is multiplied by 10 via stsz, with 1179-style synthetic 8-byte samples registered in a new chunk after mdat and matching stts / stsc / stco table extensions.",
              },
              {
                icon: Lock,
                title: "4 — Method signature",
                body: "A QuickTime metadata atom is injected under udta/meta — name \".gg/maska\" and ©cmt \"Patched by Compressbase.com\" — marking the container while keeping every original frame byte intact.",
              },
            ].map(({ icon: Icon, title, body }) => (
              <Card key={title} className="border-white/10 bg-[#0b0f11]/80 backdrop-blur">
                <CardContent className="p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10">
                    <Icon className="h-5 w-5 text-emerald-400" />
                  </div>
                  <h3 className="mt-4 text-[15px] font-semibold text-zinc-100">{title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------- faq */}
        <section className="mt-16">
          <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
            FAQ &amp; knowledgebase
          </h2>
          <div className="mx-auto mt-8 max-w-3xl">
            <Accordion type="single" collapsible className="space-y-3">
              {[
                {
                  q: "Will my video lose quality during processing?",
                  a: "No. Method V2 never re-encodes the video or audio streams. It rewrites only the MP4 container's index and timing structures, so every original frame byte is preserved exactly — true lossless.",
                },
                {
                  q: "Is my file uploaded anywhere?",
                  a: "No. The entire engine runs inside a Web Worker in your browser. No server, no upload, no telemetry. You can even disconnect from the internet after the page loads and it still works.",
                },
                {
                  q: "What does the method change, exactly?",
                  a: "Six things: (1) the moov atom is moved before mdat (faststart), (2) edit lists are stripped, (3) the movie header is rewritten as mvhd v1 with duration set to unknown (0xFF×8), (4) the audio track's sample tables are inflated 10x with synthetic 8-byte samples, (5) a synthetic timing run is appended to stts, and (6) the method signature (udta/meta name \".gg/maska\" + ©cmt \"Patched by Compressbase.com\") is stamped. The streams themselves are byte-identical to your export.",
                },
                {
                  q: "Which formats are supported?",
                  a: "MP4 and MOV containers with an audio track (the method operates on the audio sample tables). Videos without an audio track are rejected, since the container surgery requires the 'soun' handler track.",
                },
                {
                  q: "Why does the output play with warnings in some players?",
                  a: "The synthetic audio samples are inert 8-byte patterns registered in the sample tables. Strict decoders may log warnings when they reach them; the platform analyzers these target read the tables, not the bytes. The original media always decodes back perfectly.",
                },
                {
                  q: "How do I use the output?",
                  a: "Export your edit at a high bitrate, run it through Method V2 as the final step, then upload the processed file from a desktop web browser. The method is a container-level timing technique — it works on any account, any region, no privileges required.",
                },
              ].map((item, i) => (
                <AccordionItem
                  key={i}
                  value={`faq-${i}`}
                  className="rounded-xl border border-white/10 bg-[#0b0f11]/80 px-5 backdrop-blur data-[state=open]:border-emerald-500/25"
                >
                  <AccordionTrigger className="py-4 text-left text-[15px] font-medium text-zinc-200 hover:text-emerald-300 hover:no-underline">
                    {item.q}
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 text-[13.5px] leading-relaxed text-zinc-400">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        {/* ---------------------------------------------------- privacy */}
        <section className="mt-12">
          <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.07] to-transparent">
            <CardContent className="flex flex-col items-center gap-3 p-6 text-center sm:flex-row sm:text-left sm:gap-5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
                <ShieldCheck className="h-6 w-6 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-zinc-100">
                  100% client-side processing
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">
                  Your video is processed entirely inside this browser tab in an isolated
                  background thread. There is no backend, no server and no upload step —
                  perfect for confidential footage and maximum performance.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>

      {/* ---------------------------------------------------------- footer */}
      <footer className="relative z-10 mt-auto border-t border-white/5 bg-[#060809]/90">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Zap className="h-4 w-4 text-emerald-500" />
              <span className="font-medium text-zinc-300">Method V2</span>
              <span>· container enhancer</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-600">
              <Info className="h-3.5 w-3.5" />
              Clean-room implementation · runs offline in your browser
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
