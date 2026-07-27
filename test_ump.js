const https = require("https");
const http = require("http");

const VIDEO_ID = "dQw4w9WgXcQ";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

/* ------------------------------------------------------------------ */
/*  Protobuf encoding helpers                                          */
/* ------------------------------------------------------------------ */

function encodeVarint(n) {
  const out = [];
  let x = BigInt(n);
  while (x > 0x7f) {
    out.push(Number((x & 0x7fn) | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}

function tag(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

function encodeBytes(field, buf) {
  return [...tag(field, 2), ...encodeVarint(buf.length), ...buf];
}

function encodeStringField(field, s) {
  const b = encodeString(s);
  return [...tag(field, 2), ...encodeVarint(b.length), ...b];
}

function encodeInt64(field, n) {
  return [...tag(field, 0), ...encodeVarint(n)];
}

function encodeInt32(field, n) {
  return [...tag(field, 0), ...encodeVarint(n)];
}

function encodeBool(field, v) {
  return [...tag(field, 0), v ? 1 : 0];
}

function encodeFloat(field, n) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(n, 0);
  return [...tag(field, 1), ...buf];
}

function encodeMessage(field, body) {
  return [...tag(field, 2), ...encodeVarint(body.length), ...body];
}

function encodeRepeatedMessage(field, msgs) {
  const out = [];
  for (const m of msgs) {
    out.push(...tag(field, 2), ...encodeVarint(m.length), ...m);
  }
  return out;
}

function encodeString(s) {
  return [...Buffer.from(s, "utf-8")];
}

/* ------------------------------------------------------------------ */
/*  FormatId                                                           */
/*  itag=1(int32) lmt=2(uint64) xtags=3(string)                       */
/* ------------------------------------------------------------------ */

function encodeFormatId(itag, lmt, xtags) {
  const parts = [...encodeInt32(1, itag)];
  if (lmt !== undefined && lmt !== "0" && lmt !== 0) {
    parts.push(...encodeInt64(2, BigInt(lmt)));
  }
  if (xtags) {
    parts.push(...encodeStringField(3, xtags));
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/*  ClientAbrState                                                     */
/*  playbackRate=1(float) playerTimeMs=2(string)                       */
/*  clientViewportIsFlexible=3(bool) bandwidthEstimate=4(string)       */
/*  drcEnabled=5(bool) enabledTrackTypesBitfield=6(int32)              */
/*  audioTrackId=7(string) stickyResolution=8(int32)                   */
/*  lastManualSelectedResolution=9(int32)                              */
/* ------------------------------------------------------------------ */

function encodeClientAbrState(source, playerTimeMs) {
  const parts = [
    ...encodeFloat(1, 1.0),
    ...encodeStringField(2, String(playerTimeMs)),
    ...encodeBool(3, false),
    ...encodeStringField(4, "0"),
  ];
  if (source.width) {
    parts.push(...encodeInt32(6, 1)); // VIDEO_ONLY
    parts.push(...encodeInt32(8, source.height));
    parts.push(...encodeInt32(9, source.height));
  } else {
    parts.push(...encodeInt32(6, 2)); // AUDIO_ONLY
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/*  ClientInfo                                                         */
/*  clientName=1(int32) clientVersion=2(string) osName=3 osVersion=4   */
/* ------------------------------------------------------------------ */

function encodeClientInfo() {
  return [
    ...encodeInt32(1, 1), // WEB
    ...encodeStringField(2, "2.20250923.08.00"),
    ...encodeStringField(3, "Windows"),
    ...encodeStringField(4, "10.0"),
  ];
}

/* ------------------------------------------------------------------ */
/*  StreamerContext                                                    */
/*  poToken=1(bytes) playbackCookie=2(bytes) clientInfo=3(message)     */
/*  sabrContexts=4(repeated) unsentSabrContexts=5(repeated int32)      */
/* ------------------------------------------------------------------ */

function encodeStreamerContext() {
  return [
    ...encodeMessage(3, encodeClientInfo()),
  ];
}

/* ------------------------------------------------------------------ */
/*  VideoPlaybackAbrRequest                                            */
/*  clientAbrState=1(message) bufferedRanges=2(repeated)               */
/*  selectedFormatIds=3(repeated FormatId)                             */
/*  preferredAudioFormatIds=4(repeated FormatId)                       */
/*  preferredVideoFormatIds=5(repeated FormatId)                       */
/*  preferredSubtitleFormatIds=6(repeated)                             */
/*  videoPlaybackUstreamerConfig=7(bytes)                              */
/*  streamerContext=8(message)                                         */
/*  field1000=1000(repeated)                                           */
/* ------------------------------------------------------------------ */

function buildAbrRequest(ustreamerConfig, formats, playerTimeMs) {
  const ustreamerBytes = Buffer.from(
    ustreamerConfig.replaceAll("_", "/").replaceAll("-", "+"),
    "base64"
  );

  const primary = formats[0];
  const clientAbrState = encodeClientAbrState(primary, playerTimeMs);

  const selectedFormats = formats.map(f =>
    encodeFormatId(f.itag, f.lastModified, f.xtags)
  );

  const audioFormats = formats.filter(f => f.mimeType && f.mimeType.startsWith("audio/"));
  const videoFormats = formats.filter(f => f.mimeType && f.mimeType.startsWith("video/"));

  const parts = [
    ...encodeMessage(1, clientAbrState),
    ...encodeRepeatedMessage(3, selectedFormats),
    ...encodeRepeatedMessage(4, audioFormats.map(f => encodeFormatId(f.itag, f.lastModified, f.xtags))),
    ...encodeRepeatedMessage(5, videoFormats.map(f => encodeFormatId(f.itag, f.lastModified, f.xtags))),
    ...encodeBytes(7, ustreamerBytes),
    ...encodeMessage(8, encodeStreamerContext()),
  ];

  return parts;
}

/* ------------------------------------------------------------------ */
/*  UMP Response Parser                                                */
/* ------------------------------------------------------------------ */

function binaryReadByte(bytes, ptr) {
  const b = bytes[ptr.index];
  ptr.index++;
  return b < 0 ? b + 256 : b;
}

function binaryReadEncodedInt(bytes, ptr) {
  const first = binaryReadByte(bytes, ptr);
  const count = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;

  if (count === 1) return first;
  if (count === 2) {
    const b2 = binaryReadByte(bytes, ptr);
    return (first & 63) + 64 * b2;
  }
  if (count === 3) {
    const b2 = binaryReadByte(bytes, ptr);
    const b3 = binaryReadByte(bytes, ptr);
    return (first & 31) + 32 * (b2 + 256 * b3);
  }
  if (count === 4) {
    const b2 = binaryReadByte(bytes, ptr);
    const b3 = binaryReadByte(bytes, ptr);
    const b4 = binaryReadByte(bytes, ptr);
    return (first & 15) + 16 * (b2 + 256 * (b3 + 256 * b4));
  }
  const b2 = binaryReadByte(bytes, ptr);
  const b3 = binaryReadByte(bytes, ptr);
  const b4 = binaryReadByte(bytes, ptr);
  const b5 = binaryReadByte(bytes, ptr);
  ptr.index += 4;
  return b2 + 256 * (b3 + 256 * (b4 + 256 * b5));
}

function parseInitStream(data, ptr) {
  const result = {};
  while (ptr.index < data.length) {
    const t = binaryReadEncodedInt(data, ptr);
    const l = binaryReadEncodedInt(data, ptr);
    if (ptr.index + l > data.length) break;
    switch (t) {
      case 8: result.streamIndex = binaryReadEncodedInt(data, ptr); break;
      case 16: result.segmentIndex = binaryReadEncodedInt(data, ptr); break;
      case 24: result.itag = binaryReadEncodedInt(data, ptr); break;
      case 32: result.lmt = data.subarray(ptr.index, ptr.index + l).toString("utf8"); ptr.index += l; break;
      case 42: result.xtags = data.subarray(ptr.index, ptr.index + l).toString("utf8"); ptr.index += l; break;
      case 56: result.segmentSize = binaryReadEncodedInt(data, ptr); break;
      default: ptr.index += l;
    }
  }
  return result;
}

function parseUMPResponse(data) {
  const streams = {};
  let streamCount = 0;
  const opcodes = [];
  let redirectUrl = null;
  let playbackCookie = null;
  let snackbarId = null;
  let error = null;

  const ptr = { index: 0 };
  while (ptr.index < data.length) {
    const opcode = binaryReadEncodedInt(data, ptr);
    const length = binaryReadEncodedInt(data, ptr);
    if (ptr.index + length > data.length) break;

    const segment = data.subarray(ptr.index, ptr.index + length);
    ptr.index += length;
    opcodes.push({ opcode, length });

    switch (opcode) {
      case 20: {
        streamCount++;
        const sPtr = { index: 0 };
        const streamData = parseInitStream(segment, sPtr);
        if (streamData.streamIndex !== undefined) {
          streams[streamData.streamIndex] = streamData;
        }
        break;
      }
      case 35: {
        const pPtr = { index: 0 };
        while (pPtr.index < segment.length) {
          const t = binaryReadEncodedInt(segment, pPtr);
          const l = binaryReadEncodedInt(segment, pPtr);
          if (pPtr.index + l > segment.length) break;
          if (t === 10) playbackCookie = segment.subarray(pPtr.index, pPtr.index + l).toString("utf8");
          pPtr.index += l;
        }
        break;
      }
      case 43: {
        const rPtr = { index: 0 };
        while (rPtr.index < segment.length) {
          const t = binaryReadEncodedInt(segment, rPtr);
          const l = binaryReadEncodedInt(segment, rPtr);
          if (rPtr.index + l > segment.length) break;
          if (t === 10) redirectUrl = segment.subarray(rPtr.index, rPtr.index + l).toString("utf8");
          rPtr.index += l;
        }
        break;
      }
      case 44: {
        const sPtr = { index: 0 };
        while (sPtr.index < segment.length) {
          const t = binaryReadEncodedInt(segment, sPtr);
          const l = binaryReadEncodedInt(segment, sPtr);
          if (sPtr.index + l > segment.length) break;
          if (t === 10) snackbarId = segment.subarray(sPtr.index, sPtr.index + l).toString("utf8");
          sPtr.index += l;
        }
        break;
      }
      case 50: {
        const ePtr = { index: 0 };
        while (ePtr.index < segment.length) {
          const t = binaryReadEncodedInt(segment, ePtr);
          const l = binaryReadEncodedInt(segment, ePtr);
          if (ePtr.index + l > segment.length) break;
          if (t === 10) error = segment.subarray(ePtr.index, ePtr.index + l).toString("utf8");
          ePtr.index += l;
        }
        break;
      }
    }
  }

  return { streams, streamCount, opcodes, redirectUrl, playbackCookie, snackbarId, error };
}

/* ------------------------------------------------------------------ */
/*  HTTP Helpers                                                       */
/* ------------------------------------------------------------------ */

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}

function postBinary(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Length": body.length,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "Accept": "*/*",
        "TE": "trailers",
      },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  JSON extraction helpers                                            */
/* ------------------------------------------------------------------ */

function parseJsonFrom(html, before, after) {
  const start = html.indexOf(before);
  if (start === -1) return null;
  const jsonStart = start + before.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === before[0] || c === "[") depth++;
    else if (c === after[0] || c === "]") { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  return JSON.parse(html.substring(jsonStart, endIdx));
}

function extractPlayerData(html) {
  const marker = "ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  let depth = 0;
  let endIdx = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  return JSON.parse(html.substring(jsonStart, endIdx));
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log("=== YouTube SABR (VideoPlaybackAbrRequest) Test ===\n");
  console.log(`Video: ${VIDEO_ID}`);

  // 1. Fetch page
  console.log("\n[1] Fetching video page...");
  const html = await fetchPage(VIDEO_URL);
  console.log("    Page fetched successfully.");

  // 2. Extract player response
  console.log("\n[2] Extracting player data...");
  const playerData = extractPlayerData(html);

  const streamingData = playerData?.streamingData;
  if (!streamingData) {
    console.log("    ERROR: No streamingData found.");
    process.exit(1);
  }

  const adaptiveFormats = streamingData.adaptiveFormats || [];
  console.log(`    Found ${adaptiveFormats.length} adaptive formats.`);

  // 3. Pick formats
  const audioFormats = adaptiveFormats.filter(
    (f) => f.mimeType && (f.mimeType.startsWith("audio/mp4") || f.mimeType.startsWith("audio/webm"))
  );
  const videoFormats = adaptiveFormats
    .filter(
      (f) => f.mimeType && (f.mimeType.startsWith("video/mp4") || f.mimeType.startsWith("video/webm"))
    )
    .sort((a, b) => (a.height || 0) - (b.height || 0));

  if (!audioFormats.length || !videoFormats.length) {
    console.log("    ERROR: Could not find suitable audio/video formats.");
    process.exit(1);
  }

  audioFormats.sort((a, b) => (a.averageBitrate || 0) - (b.averageBitrate || 0));
  const audioSource = audioFormats[0];
  const videoSource = videoFormats[0];

  console.log(`    Audio:  itag=${audioSource.itag} ${audioSource.mimeType} ${audioSource.averageBitrate || "?"}bps`);
  console.log(`    Video:  itag=${videoSource.itag} ${videoSource.mimeType} ${videoSource.width}x${videoSource.height}`);

  // 4. Get UMP config
  const ustreamerConfig =
    playerData?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
  if (!ustreamerConfig) {
    console.log("\n    ERROR: No ustreamerConfig found.");
    process.exit(1);
  }
  console.log(`\n    UstreamerConfig present (${ustreamerConfig.length} chars)`);

  // 5. Get SABR URL
  let abrUrl = streamingData.serverAbrStreamingUrl;
  if (!abrUrl) {
    console.log("\n    ERROR: No serverAbrStreamingUrl found.");
    process.exit(1);
  }
  console.log(`\n    SABR URL: ${abrUrl.substring(0, 120)}...`);

  const now = Date.now();

  // TEST 1: Audio-only request
  console.log("\n-----------------------------------------------------------");
  console.log("TEST 1: Audio-only SABR request (itag " + audioSource.itag + ")");
  console.log("-----------------------------------------------------------");

  const audioReq = buildAbrRequest(ustreamerConfig, [audioSource], 0);
  const audioBuf = Buffer.from(audioReq);
  console.log(`  Request size: ${audioBuf.length} bytes`);
  console.log(`  First 20 bytes: ${audioBuf.slice(0, 20).toString("hex")}`);

  try {
    const resp1 = await postBinary(abrUrl, audioBuf);
    console.log(`  HTTP status: ${resp1.status}`);
    console.log(`  Content-Type: ${resp1.headers["content-type"]}`);
    console.log(`  Response size: ${resp1.body.length} bytes`);

    if (resp1.status === 200 && resp1.body.length > 0) {
      const parsed = parseUMPResponse(resp1.body);
      console.log(`  Opcodes: ${parsed.opcodes.map(o => `${o.opcode}(${o.length})`).join(", ")}`);
      console.log(`  InitStreams: ${parsed.streamCount}`);
      for (const [idx, stream] of Object.entries(parsed.streams)) {
        console.log(`    Stream ${idx}: itag=${stream.itag} segIdx=${stream.segmentIndex} size=${stream.segmentSize}`);
      }
      if (parsed.error) console.log(`  Error: ${parsed.error}`);
      if (parsed.redirectUrl) console.log(`  Redirect: ${parsed.redirectUrl.substring(0, 100)}`);
      if (parsed.playbackCookie) console.log(`  PlaybackCookie: ${parsed.playbackCookie.substring(0, 60)}...`);
      console.log("  PASS: Got UMP response with audio stream!");
    } else if (resp1.status === 200 && resp1.body.length === 0) {
      console.log("  FAIL: Empty response body");
    } else {
      console.log(`  FAIL: HTTP ${resp1.status}`);
      if (resp1.body.length > 0 && resp1.body.length < 500) {
        console.log(`  Body: ${resp1.body.toString("utf8").substring(0, 200)}`);
      }
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  // TEST 2: Combined audio+video request
  console.log("\n-----------------------------------------------------------");
  console.log("TEST 2: Combined audio+video SABR request");
  console.log(`  Audio itag: ${audioSource.itag}, Video itag: ${videoSource.itag}`);
  console.log("-----------------------------------------------------------");

  const combinedReq = buildAbrRequest(ustreamerConfig, [videoSource, audioSource], 0);
  const combinedBuf = Buffer.from(combinedReq);
  console.log(`  Request size: ${combinedBuf.length} bytes`);
  console.log(`  First 20 bytes: ${combinedBuf.slice(0, 20).toString("hex")}`);

  try {
    // Fetch fresh URL for second request (URLs may be single-use)
    const html2 = await fetchPage(VIDEO_URL);
    const playerData2 = extractPlayerData(html2);
    const abrUrl2 = playerData2?.streamingData?.serverAbrStreamingUrl;
    if (!abrUrl2) { console.log("  ERROR: Could not get fresh SABR URL"); return; }

    const resp2 = await postBinary(abrUrl2, combinedBuf);
    console.log(`  HTTP status: ${resp2.status}`);
    console.log(`  Content-Type: ${resp2.headers["content-type"]}`);
    console.log(`  Response size: ${resp2.body.length} bytes`);

    if (resp2.status === 200 && resp2.body.length > 0) {
      const parsed = parseUMPResponse(resp2.body);
      console.log(`  Opcodes: ${parsed.opcodes.map(o => `${o.opcode}(${o.length})`).join(", ")}`);
      console.log(`  InitStreams: ${parsed.streamCount}`);
      for (const [idx, stream] of Object.entries(parsed.streams)) {
        console.log(`    Stream ${idx}: itag=${stream.itag} segIdx=${stream.segmentIndex} size=${stream.segmentSize}`);
      }
      if (parsed.error) console.log(`  Error: ${parsed.error}`);
      if (parsed.redirectUrl) console.log(`  Redirect: ${parsed.redirectUrl.substring(0, 100)}`);
      if (parsed.playbackCookie) console.log(`  PlaybackCookie: ${parsed.playbackCookie.substring(0, 60)}...`);
      const hasAudio = Object.values(parsed.streams).some(s => s.itag === audioSource.itag);
      const hasVideo = Object.values(parsed.streams).some(s => s.itag === videoSource.itag);
      console.log(`  Has audio (itag ${audioSource.itag}): ${hasAudio}`);
      console.log(`  Has video (itag ${videoSource.itag}): ${hasVideo}`);
      if (hasAudio && hasVideo) {
        console.log("  PASS: Got UMP response with BOTH audio and video!");
      } else if (hasAudio || hasVideo) {
        console.log("  PARTIAL: Got only one stream");
      }
    } else if (resp2.status === 200 && resp2.body.length === 0) {
      console.log("  FAIL: Empty response body");
    } else {
      console.log(`  FAIL: HTTP ${resp2.status}`);
      if (resp2.body.length > 0 && resp2.body.length < 500) {
        console.log(`  Body: ${resp2.body.toString("utf8").substring(0, 200)}`);
      }
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  // Summary
  console.log("\n===========================================================");
  console.log("SUMMARY");
  console.log("===========================================================");
  console.log(`  Audio format:  itag=${audioSource.itag} ${audioSource.mimeType}`);
  console.log(`  Video format:  itag=${videoSource.itag} ${videoSource.mimeType} ${videoSource.width}x${videoSource.height}`);
  console.log(`  Proto: VideoPlaybackAbrRequest (from googlevideo)`);
  console.log("===========================================================");
}

main().catch(console.error);
