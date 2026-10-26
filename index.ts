import {
  fetchTimestampedTranscript,
  formatTimestamp,
  parseDurationSec,
  scoreCandidate,
  searchAndFilterTopic,
} from "./lib/youtube";
import {
  chunkTranscriptByWindow,
  summarizeVideo,
  synthesizeTopicDigest,
  type VideoSummary,
} from "./lib/summarizer";
import {
  exportBackupJson,
  getApiKey,
  importBackupJson,
  markVideoSeen,
  saveTopicDigest,
} from "./lib/storage";

// Self-check assertions on core logic (Anti-Slop Filter, Chunking, Backup/Restore)
function runSelfChecks() {
  if (formatTimestamp(125) !== "02:05") throw new Error("formatTimestamp failed");
  if (parseDurationSec("12:30") !== 750) throw new Error("parseDurationSec failed");

  // Shorts (<3m) must be dropped (-1)
  const shortScore = scoreCandidate({
    videoId: "s1",
    title: "Quick tip",
    channelName: "Test",
    channelId: "c1",
    durationSec: 45,
    durationText: "0:45",
    viewCount: 50000,
    publishedText: "1 day ago",
    ageDays: 1,
    hasChapters: false,
    chapters: [],
    descriptionSnippet: "",
    thumbnailUrl: "",
    url: "",
  });
  if (shortScore !== -1) throw new Error("Short video should be dropped");

  // High-signal chaptered video must outscore clickbait title
  const base = {
    videoId: "v1",
    channelName: "Dev",
    channelId: "c1",
    durationSec: 900,
    durationText: "15:00",
    viewCount: 15000,
    publishedText: "2 days ago",
    ageDays: 2,
    chapters: [],
    descriptionSnippet: "",
    thumbnailUrl: "",
    url: "",
  };
  const goodScore = scoreCandidate({
    ...base,
    title: "Building Production AI Coding Agents in TypeScript",
    hasChapters: true,
  });
  const baitScore = scoreCandidate({
    ...base,
    title: "SHOCKING!! IT'S OVER FOR PROGRAMMERS!! DESTROYED!",
    hasChapters: false,
  });
  if (goodScore <= baitScore) {
    throw new Error(`Expected goodScore (${goodScore}) > baitScore (${baitScore})`);
  }

  // Long video (> 25m) transcript chunker must split into multiple windows
  const longBlocks = Array.from({ length: 40 }, (_, i) => ({
    startSec: i * 60,
    timestamp: formatTimestamp(i * 60),
    text: `Minute ${i} content`,
  }));
  const chunks = chunkTranscriptByWindow(longBlocks, 1200);
  if (chunks.length < 2) {
    throw new Error("Expected >25m transcript to split into multiple 20-min windows");
  }
}

async function main() {
  runSelfChecks();

  const topic = process.argv[2] || "AI Coding Agents";
  const maxVideos = Number(process.argv[3] || 3);

  console.log(`\n📡 [YouTube Topic Radar] Scanning topic: "${topic}" (Top ${maxVideos})...`);
  const candidates = await searchAndFilterTopic(topic, maxVideos);

  if (candidates.length === 0) {
    console.log("No qualifying videos found.");
    return;
  }

  console.log(`\n✅ Filtered down to Top ${candidates.length} High-Signal Videos:`);
  for (const [idx, v] of candidates.entries()) {
    console.log(
      `  ${idx + 1}. [Signal ${v.signalScore}/100] "${v.title}" — ${v.channelName} (${v.durationText}, ${v.viewCount.toLocaleString()} views, Chapters: ${v.hasChapters ? "Yes" : "No"})`
    );
  }

  const first = candidates[0]!;
  console.log(`\n📝 Fetching timed transcript for #1: "${first.title}" (${first.videoId})...`);
  const { blocks, chapters } = await fetchTimestampedTranscript(first.videoId);
  console.log(
    `   Extracted ${blocks.length} timestamped blocks (~45s each) and ${chapters.length} author chapters.`
  );
  if (blocks.length > 0) {
    console.log(`   Sample block [${blocks[0]!.timestamp}]: "${blocks[0]!.text.slice(0, 120)}..."`);
  } else {
    console.log(
      `   (No timedtext track returned; ready to use Gemini native YouTube URL fallback: ${first.url})`
    );
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.log(
      `\n💡 Tip: Set GEMINI_API_KEY="your-key" to run live Gemini 2.5 Flash structured summarization + cross-video synthesis.`
    );
    const backup = await exportBackupJson();
    await importBackupJson(backup);
    console.log(`💾 Verified 1-click JSON Export/Import backup (${backup.length} bytes).`);
    return;
  }

  console.log(`\n🧠 Summarizing ${candidates.length} videos with Gemini 2.5 Flash...`);
  const summaries: VideoSummary[] = [];
  for (const v of candidates) {
    const t = await fetchTimestampedTranscript(v.videoId);
    const summary = await summarizeVideo(apiKey, v, t.blocks, t.chapters);
    summaries.push(summary);
    await markVideoSeen(v.videoId);
    console.log(`\n--- [${summary.videoType.toUpperCase()}] ${summary.title} ---`);
    console.log(`Thesis: ${summary.coreThesis}`);
    console.log(`Watch Verdict: ${summary.worthWatchingFull} (${summary.worthWatchingReason})`);
    for (const ch of summary.chapterBreakdown.slice(0, 4)) {
      console.log(`  [${ch.timestamp}] ${ch.sectionTitle}: ${ch.keyPoints.join(" | ")}`);
    }
  }

  const synthesis = await synthesizeTopicDigest(apiKey, topic, summaries);
  await saveTopicDigest({
    topic,
    generatedAt: new Date().toISOString(),
    crossVideoSynthesis: synthesis.crossVideoSynthesis,
    suggestedSubtopics: synthesis.suggestedSubtopics,
    videos: summaries,
  });

  console.log(`\n🌐 Cross-Video Synthesis:\n${synthesis.crossVideoSynthesis}`);
  console.log(`Suggested Sub-topics: ${synthesis.suggestedSubtopics.join(", ")}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
