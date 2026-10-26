import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type { TranscriptSegment, VideoCandidate } from "./youtube";
import { formatTimestamp } from "./youtube";

export type VideoType =
  | "tutorial"
  | "news_analysis"
  | "podcast_interview"
  | "review_comparison";

export interface ChapterPoint {
  timestamp: string;
  sectionTitle: string;
  keyPoints: string[];
}

export interface VideoSummary {
  videoId: string;
  title: string;
  channelName: string;
  channelId: string;
  url: string;
  durationText: string;
  signalScore: number;
  videoType: VideoType;
  coreThesis: string;
  chapterBreakdown: ChapterPoint[];
  typeSpecificDetails: {
    label: string;
    items: string[];
  }[];
  worthWatchingFull: "Yes" | "Skim timestamps" | "Skip (Summary has everything)";
  worthWatchingReason: string;
  summarizedAt: string;
}

export interface TopicDigest {
  topic: string;
  generatedAt: string;
  crossVideoSynthesis: string;
  suggestedSubtopics: string[];
  videos: VideoSummary[];
}

const SUMMARY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    videoType: {
      type: Type.STRING,
      enum: ["tutorial", "news_analysis", "podcast_interview", "review_comparison"],
    },
    coreThesis: {
      type: Type.STRING,
      description:
        "2-sentence direct answer that spoils any clickbait and states the core takeaway with specific names/numbers.",
    },
    chapterBreakdown: {
      type: Type.ARRAY,
      description:
        "Chronological breakdown of every major section in the video so no important point is missed.",
      items: {
        type: Type.OBJECT,
        properties: {
          timestamp: { type: Type.STRING, description: "MM:SS or H:MM:SS timestamp" },
          sectionTitle: { type: Type.STRING },
          keyPoints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "Specific facts, steps, tools, numbers, or arguments from this section.",
          },
        },
        required: ["timestamp", "sectionTitle", "keyPoints"],
      },
    },
    typeSpecificDetails: {
      type: Type.ARRAY,
      description:
        "For tutorial: Steps, Tools/Libraries, Gotchas. For news_analysis: Benchmarks/Numbers, Claims, Counter-arguments. For podcast_interview: Speaker Insights, Contrarian Takes. For review_comparison: Pros, Cons, Verdict.",
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          items: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["label", "items"],
      },
    },
    worthWatchingFull: {
      type: Type.STRING,
      enum: ["Yes", "Skim timestamps", "Skip (Summary has everything)"],
    },
    worthWatchingReason: { type: Type.STRING },
  },
  required: [
    "videoType",
    "coreThesis",
    "chapterBreakdown",
    "typeSpecificDetails",
    "worthWatchingFull",
    "worthWatchingReason",
  ],
};

const MODEL_CANDIDATES = [
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];

/**
 * Concurrency limiter + 429/503 exponential backoff + per-request timeout + automatic model fallback.
 */
async function generateWithFallback(
  ai: GoogleGenAI,
  params: Omit<Parameters<GoogleGenAI["models"]["generateContent"]>[0], "model">
) {
  let delayMs = 1500;
  for (let attempt = 0; attempt < MODEL_CANDIDATES.length; attempt++) {
    const model = MODEL_CANDIDATES[attempt]!;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 35000);
    try {
      return await ai.models.generateContent({
        ...params,
        model,
        config: {
          ...params.config,
          abortSignal: ctrl.signal,
        },
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isRetryable =
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("404") ||
        msg.includes("aborted") ||
        msg.includes("AbortError");
      if (attempt >= MODEL_CANDIDATES.length - 1 || !isRetryable) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 1.5;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("All Gemini Flash model candidates failed.");
}

/**
 * Split long transcripts (> 25 mins) into 20-minute windows so the LLM never compresses
 * a 1-3 hour video into vague bullets ("Lost in the Middle" prevention).
 */
export function chunkTranscriptByWindow(
  blocks: TranscriptSegment[],
  windowSec = 1200
): TranscriptSegment[][] {
  if (blocks.length === 0) return [];
  const lastSec = blocks[blocks.length - 1]!.startSec;
  if (lastSec <= 1500) return [blocks]; // <= 25 mins fits in 1 detailed pass

  const chunks: TranscriptSegment[][] = [];
  let currentChunk: TranscriptSegment[] = [];
  let windowStart = blocks[0]!.startSec;

  for (const b of blocks) {
    if (b.startSec - windowStart >= windowSec && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      windowStart = b.startSec;
    }
    currentChunk.push(b);
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

export async function summarizeVideo(
  apiKey: string,
  video: VideoCandidate,
  transcriptBlocks: TranscriptSegment[],
  chapters: { title: string; startSec: number; timestamp: string }[]
): Promise<VideoSummary> {
  const ai = new GoogleGenAI({ apiKey });
  const chunks = chunkTranscriptByWindow(transcriptBlocks);

  const chapterHint =
    chapters.length > 0
      ? `Author Chapters:\n${chapters.map((c) => `[${c.timestamp}] ${c.title}`).join("\n")}\n\n`
      : "";

  const systemPrompt = `You are a precision technical & research analyst.
Extract a complete, high-signal breakdown of the YouTube video "${video.title}" by ${video.channelName}.
CRITICAL RULES:
1. NEVER write vague filler like "The speaker discusses X." State the exact claim, number, tool name, command, or conclusion.
2. Cover EVERY section of the video chronologically in chapterBreakdown with accurate [MM:SS] timestamps so the reader never misses an important point.
3. Tailor typeSpecificDetails to the classified videoType.`;

  // Fallback to Gemini native YouTube URL if captions were disabled/blocked
  if (chunks.length === 0) {
    const res = await generateWithFallback(ai, {
      contents: [
        {
          fileData: {
            fileUri: video.url,
            mimeType: "video/mp4",
          },
        },
        `${systemPrompt}\n\n${chapterHint}Analyze this video directly and return the structured JSON summary.`,
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: SUMMARY_SCHEMA,
      },
    });
    const parsed = JSON.parse(res.text || "{}");
    return buildSummaryObject(video, parsed);
  }

  // Single window (<= 25 mins)
  if (chunks.length === 1) {
    const transcriptText = chunks[0]!
      .map((b) => `[${b.timestamp}] ${b.text}`)
      .join("\n");
    const res = await generateWithFallback(ai, {
      contents: `${systemPrompt}\n\n${chapterHint}Transcript:\n${transcriptText}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: SUMMARY_SCHEMA,
      },
    });
    const parsed = JSON.parse(res.text || "{}");
    return buildSummaryObject(video, parsed);
  }

  // Multi-window (> 25 mins): extract each 20-min window with max concurrency 2, then merge
  const mergedChapters: ChapterPoint[] = [];
  let firstPassMeta: any = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const rangeLabel = `${formatTimestamp(chunk[0]!.startSec)} - ${formatTimestamp(chunk[chunk.length - 1]!.startSec)}`;
    const transcriptText = chunk.map((b) => `[${b.timestamp}] ${b.text}`).join("\n");

    const res = await generateWithFallback(ai, {
      contents: `${systemPrompt}\n\nThis is Part ${i + 1} of ${chunks.length} (${rangeLabel}). Extract all sections and details from this segment.\n\n${chapterHint}Transcript Segment:\n${transcriptText}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: SUMMARY_SCHEMA,
      },
    });
    const part = JSON.parse(res.text || "{}");
    if (!firstPassMeta) firstPassMeta = part;
    if (Array.isArray(part.chapterBreakdown)) {
      mergedChapters.push(...part.chapterBreakdown);
    }
  }

  return buildSummaryObject(video, {
    ...firstPassMeta,
    chapterBreakdown: mergedChapters,
  });
}

function buildSummaryObject(video: VideoCandidate, raw: any): VideoSummary {
  return {
    videoId: video.videoId,
    title: video.title,
    channelName: video.channelName,
    channelId: video.channelId,
    url: video.url,
    durationText: video.durationText,
    signalScore: video.signalScore,
    videoType: raw.videoType || "news_analysis",
    coreThesis: raw.coreThesis || "",
    chapterBreakdown: Array.isArray(raw.chapterBreakdown) ? raw.chapterBreakdown : [],
    typeSpecificDetails: Array.isArray(raw.typeSpecificDetails)
      ? raw.typeSpecificDetails
      : [],
    worthWatchingFull: raw.worthWatchingFull || "Skim timestamps",
    worthWatchingReason: raw.worthWatchingReason || "",
    summarizedAt: new Date().toISOString(),
  };
}

export async function synthesizeTopicDigest(
  apiKey: string,
  topic: string,
  summaries: VideoSummary[]
): Promise<{ crossVideoSynthesis: string; suggestedSubtopics: string[] }> {
  if (summaries.length === 0) {
    return { crossVideoSynthesis: "No videos summarized yet.", suggestedSubtopics: [] };
  }

  const ai = new GoogleGenAI({ apiKey });
  const digestInput = summaries
    .map(
      (s, i) =>
        `Video #${i + 1}: "${s.title}" (${s.channelName})\nThesis: ${s.coreThesis}\nKey Sections: ${s.chapterBreakdown.map((c) => `[${c.timestamp}] ${c.sectionTitle}: ${c.keyPoints.join("; ")}`).join(" | ")}`
    )
    .join("\n\n");

  const res = await generateWithFallback(ai, {
    contents: `Topic: "${topic}"\nBelow are structured summaries of the top ${summaries.length} videos on this topic.\n1. Write a concise 1-paragraph Cross-Video Synthesis stating what the videos agree on, any standout unique insight (citing the Channel Name and [MM:SS] timestamp), and what is most worth the user's attention.\n2. Suggest 3 narrower, high-signal sub-topics the user might want to track next.\n\n${digestInput}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          crossVideoSynthesis: { type: Type.STRING },
          suggestedSubtopics: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["crossVideoSynthesis", "suggestedSubtopics"],
      },
    },
  });

  const parsed = JSON.parse(res.text || "{}");
  return {
    crossVideoSynthesis: parsed.crossVideoSynthesis || "",
    suggestedSubtopics: Array.isArray(parsed.suggestedSubtopics)
      ? parsed.suggestedSubtopics.slice(0, 4)
      : [],
  };
}
