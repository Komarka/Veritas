"use strict";

const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_GEMINI_ATTEMPTS = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const USER_PROMPT_PREFIX =
  "Fact-check and analyze the following claim. Return verdict, analysis, and facts in the same primary language as the claim. If the claim mixes languages, use the language used most in the claim:";

const TEXT_SYSTEM_INSTRUCTION = [
  "You are Veritas AI, a fact-checking and media-manipulation analysis backend for a Chrome extension.",
  "You must use Google Search grounding to find current facts, official data, rebuttals, and cross-checks.",
  "Return exactly one valid JSON object and no Markdown, no code fences, and no explanatory text outside JSON.",
  "The response is rendered in a compact intelligence dashboard, so keep verdict short, analysis focused, and facts easy to scan.",
  "Detect the primary language of the submitted claim and write verdict, analysis, and facts in that same language.",
  "If the claim is in English, answer in English. If it is in Russian, answer in Russian. If mixed, answer in the dominant language.",
  "The JSON object must match this shape:",
  '{"query": "original checked text", "score": 0, "verdict": "short verdict in the input language", "analysis": "detailed logical-fallacy and manipulation analysis in the input language", "facts": "facts found through Google Search in the input language", "sources": ["https://verified-source.example"], "alerts": [{"id": "alert_01", "severity": "warning", "title": "contextual alert title", "description": "short query-specific risk description", "details": "optional deeper AI explanation", "url": "https://optional-counter-evidence.example"}]}',
  "score must be an integer from 0 to 100, where 100 means fully supported and 0 means false or severe disinformation.",
  "analysis should be 2 to 4 concise sentences explaining the reasoning and any manipulation, missing context, or logical fallacy.",
  "facts should be 2 to 4 concise sentences with the strongest verified facts found through search.",
  "sources should contain 3 to 8 real absolute HTTP/HTTPS URLs used to support the analysis when available.",
  "alerts must be contextual only to this submitted query, not global notifications.",
  "Generate 0 to 5 alerts. Use severity critical for direct disinformation, phishing/spoofed domains, or dangerous fabricated claims; warning for emotional manipulation, clickbait, missing context, or distorted quotes; info for helpful source metadata, cache-like heavily checked claims, or publisher bias context.",
  "Each alert must include severity, title, description, and optional details or url. Use the same language as the verdict where possible.",
].join(" ");

const IMAGE_SYSTEM_INSTRUCTION = [
  "You are Veritas AI, a multimodal image fact-checking and AI/deepfake detection backend for a Chrome extension.",
  "Analyze the submitted image as both an OCR fact-checker and an image synthesis/deepfake detector.",
  "Extract visible text, captions, usernames, claims, screenshots, posts, headlines, and other assertions from the image.",
  "Use Google Search grounding to verify extracted text, visible claims, screenshots, posts, and source context when possible.",
  "Inspect the image pixels for AI-generation or manipulation markers: unnatural smoothing, warped text, blended letters, distorted logos, inconsistent shadows, face or hand artifacts, compression mismatches, screenshot fabrication, and layout anomalies.",
  "Return exactly one valid JSON object and no Markdown, no code fences, and no explanatory text outside JSON.",
  "Use the dominant language found in the image text when possible; otherwise answer in English.",
  "The JSON object must match this shape:",
  '{"query": "image or visible text context", "score": 0, "verdict": "short text", "isAiGenerated": false, "aiProbability": 0, "aiAnalysis": "visual/deepfake explanation", "textAnalysis": "OCR and search-grounded fact-check", "sources": ["https://verified-source.example"], "alerts": [{"id": "alert_01", "severity": "critical", "title": "contextual alert title", "description": "short image-specific risk description", "details": "optional deeper AI explanation", "url": "https://optional-counter-evidence.example"}]}',
  "score must be an integer from 0 to 100 representing overall trust in the image and its claims.",
  "aiProbability must be an integer from 0 to 100 representing likelihood of AI generation, deepfake, or synthetic fabrication.",
  "isAiGenerated must be true when AI generation, deepfake, or synthetic fabrication is more likely than not.",
  "aiAnalysis should explain visual evidence in 2 to 5 concise sentences.",
  "textAnalysis should explain extracted text and Google Search verification in 2 to 5 concise sentences.",
  "sources should contain real absolute HTTP/HTTPS URLs used to support the textAnalysis when available.",
  "alerts must be contextual only to this submitted image/query, not global notifications.",
  "Generate 0 to 5 alerts. Use severity critical for very high AI/deepfake probability, malicious clone domains, fabricated screenshots, or direct disinformation; warning for visible manipulation, missing context, clickbait or emotional triggers; info for helpful image/source metadata or publisher bias context.",
  "Each alert must include severity, title, description, and optional details or url. Use the dominant language found in the image when possible.",
].join(" ");

if (!admin.apps.length) {
  admin.initializeApp();
}

function extractBearerToken(req) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function authenticateRequest(req) {
  const idToken = extractBearerToken(req);

  if (!idToken) {
    return null;
  }

  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    logger.warn("Invalid Firebase ID token", {
      error: error.message,
    });
    return null;
  }
}

function collectGroundingUrls(response) {
  const urls = new Set();
  const candidates = response.candidates || [];

  for (const candidate of candidates) {
    const chunks = candidate.groundingMetadata?.groundingChunks || [];

    for (const chunk of chunks) {
      const uri = chunk.web?.uri;

      if (typeof uri === "string" && uri.startsWith("http")) {
        urls.add(uri);
      }
    }
  }

  return Array.from(urls);
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || "").trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // Keep a narrow fallback for occasional code fences or surrounding prose.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini did not return a JSON object.");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeSources(parsedSources, groundingUrls) {
  const mergedSources = new Set(
    Array.isArray(parsedSources)
      ? parsedSources.filter(
          (source) => typeof source === "string" && source.startsWith("http"),
        )
      : [],
  );

  for (const url of groundingUrls) {
    mergedSources.add(url);
  }

  return Array.from(mergedSources);
}

function normalizeScore(value) {
  const score = Number.parseInt(value, 10);
  return Number.isInteger(score) ? Math.min(100, Math.max(0, score)) : 0;
}
const ALERT_SEVERITIES = new Set(["critical", "warning", "info"]);

function normalizeAlerts(parsedAlerts) {
  if (!Array.isArray(parsedAlerts)) {
    return [];
  }

  return parsedAlerts
    .map((alert, index) => {
      if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
        return null;
      }

      const severity = String(alert.severity || "info").toLowerCase();
      const title = typeof alert.title === "string" ? alert.title.trim() : "";
      const description =
        typeof alert.description === "string" ? alert.description.trim() : "";

      if (!ALERT_SEVERITIES.has(severity) || !title || !description) {
        return null;
      }

      const id =
        typeof alert.id === "string" && alert.id.trim()
          ? alert.id.trim().replace(/[^a-zA-Z0-9_-]/g, "_")
          : `alert_${String(index + 1).padStart(2, "0")}`;
      const details =
        typeof alert.details === "string" ? alert.details.trim() : "";
      const url =
        typeof alert.url === "string" && alert.url.startsWith("http")
          ? alert.url.trim()
          : "";

      return {
        id,
        severity,
        title,
        description,
        details,
        url,
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}


function normalizeFactCheckResult(rawText, groundingUrls) {
  const parsed = extractJsonObject(rawText);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini returned a non-object JSON response.");
  }

  return {
    query: typeof parsed.query === "string" ? parsed.query : "",
    score: normalizeScore(parsed.score),
    verdict: typeof parsed.verdict === "string" ? parsed.verdict : "",
    analysis: typeof parsed.analysis === "string" ? parsed.analysis : "",
    facts: typeof parsed.facts === "string" ? parsed.facts : "",
    sources: normalizeSources(parsed.sources, groundingUrls),
    alerts: normalizeAlerts(parsed.alerts),
  };
}

function normalizeImageFactCheckResult(rawText, groundingUrls) {
  const parsed = extractJsonObject(rawText);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini returned a non-object JSON response.");
  }

  const aiProbability = normalizeScore(parsed.aiProbability);

  return {
    query: typeof parsed.query === "string" ? parsed.query : "",
    score: normalizeScore(parsed.score),
    verdict: typeof parsed.verdict === "string" ? parsed.verdict : "",
    isAiGenerated:
      typeof parsed.isAiGenerated === "boolean"
        ? parsed.isAiGenerated
        : aiProbability >= 50,
    aiProbability,
    aiAnalysis:
      typeof parsed.aiAnalysis === "string" ? parsed.aiAnalysis : "",
    textAnalysis:
      typeof parsed.textAnalysis === "string" ? parsed.textAnalysis : "",
    sources: normalizeSources(parsed.sources, groundingUrls),
    alerts: normalizeAlerts(parsed.alerts),
  };
}

function wantsEventStream(req) {
  return String(req.get("accept") || "").includes("text/event-stream");
}

function startEventStream(res) {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function sendStreamEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function errorText(error) {
  return `${error?.message || ""} ${error?.stack || ""}`;
}

function isQuotaError(error) {
  const raw = errorText(error);
  return raw.includes("429") || raw.includes("RESOURCE_EXHAUSTED");
}

function isModelOverloadedError(error) {
  const raw = errorText(error);
  return raw.includes("503") || raw.includes("UNAVAILABLE");
}

function publicErrorMessage(error) {
  if (isQuotaError(error)) {
    return "Gemini quota exceeded. Try again later.";
  }

  if (isModelOverloadedError(error)) {
    return "Gemini is temporarily overloaded. Try again in a moment.";
  }

  return "Verification error";
}

function publicErrorStatus(error) {
  if (isQuotaError(error)) {
    return 429;
  }

  if (isModelOverloadedError(error)) {
    return 503;
  }

  return 500;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createAiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY secret is not configured.");
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });
}

async function generateWithRetry(request) {
  const ai = createAiClient();
  let response;
  let lastError;

  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt += 1) {
    try {
      response = await ai.models.generateContent(request);
      break;
    } catch (error) {
      lastError = error;

      if (!isModelOverloadedError(error) || attempt === MAX_GEMINI_ATTEMPTS) {
        throw error;
      }

      logger.warn("Gemini model overloaded, retrying", {
        attempt,
        nextAttempt: attempt + 1,
        error: error.message,
      });
      await wait(900 * attempt);
    }
  }

  if (!response) {
    throw lastError || new Error("Gemini did not return a response.");
  }

  return response;
}

async function generateFactCheck(text, progress) {
  progress?.("searching");

  const response = await generateWithRetry({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${USER_PROMPT_PREFIX}\n\n${text}`,
          },
        ],
      },
    ],
    config: {
      tools: [
        {
          googleSearch: {},
        },
      ],
      systemInstruction: TEXT_SYSTEM_INSTRUCTION,
    },
  });

  progress?.("forming_verdict");

  const rawText = response.text;

  if (!rawText) {
    throw new Error("Gemini returned an empty response.");
  }

  const groundingUrls = collectGroundingUrls(response);
  return normalizeFactCheckResult(rawText, groundingUrls);
}

async function generateImageFactCheck(imageInput, progress) {
  progress?.("searching");

  const imagePrompt = [
    "Analyze this image for visual authenticity and fact-check any visible text or claim.",
    imageInput.imageUrl
      ? `Original image URL for context: ${imageInput.imageUrl}`
      : "No original image URL was provided.",
  ].join("\n\n");

  const response = await generateWithRetry({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: imagePrompt,
          },
          {
            inlineData: {
              mimeType: imageInput.mimeType,
              data: imageInput.imageBase64,
            },
          },
        ],
      },
    ],
    config: {
      tools: [
        {
          googleSearch: {},
        },
      ],
      systemInstruction: IMAGE_SYSTEM_INSTRUCTION,
    },
  });

  progress?.("forming_verdict");

  const rawText = response.text;

  if (!rawText) {
    throw new Error("Gemini returned an empty response.");
  }

  const groundingUrls = collectGroundingUrls(response);
  return normalizeImageFactCheckResult(rawText, groundingUrls);
}

function getRequestPayload(req) {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const imageBase64 =
    typeof req.body?.imageBase64 === "string"
      ? req.body.imageBase64.trim()
      : "";
  const mimeType =
    typeof req.body?.mimeType === "string"
      ? req.body.mimeType.trim().toLowerCase()
      : "";
  const imageUrl =
    typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : "";

  if (text) {
    return { type: "text", text };
  }

  if (!imageBase64 && !mimeType) {
    return null;
  }

  if (!imageBase64 || !mimeType) {
    const error = new Error(
      "Image requests must include imageBase64 and mimeType fields.",
    );
    error.statusCode = 400;
    throw error;
  }

  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    const error = new Error("Unsupported image type. Use PNG, JPEG, or WebP.");
    error.statusCode = 400;
    throw error;
  }

  const byteEstimate = Math.floor((imageBase64.length * 3) / 4);

  if (byteEstimate > MAX_IMAGE_BYTES) {
    const error = new Error("Image is too large. Maximum size is 5 MB.");
    error.statusCode = 400;
    throw error;
  }

  return {
    type: "image",
    imageBase64,
    mimeType,
    imageUrl,
  };
}

function requestErrorStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 400;
}

exports.factCheck = onRequest(
  {
    cors: true,
    secrets: [GEMINI_API_KEY],
  },
  async (req, res) => {
    const streamResponse = wantsEventStream(req);

    try {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.set("Allow", "POST, OPTIONS");
        res.status(405).json({ error: "Method not allowed. Use POST." });
        return;
      }

      const authenticatedUser = await authenticateRequest(req);

      if (!authenticatedUser) {
        res.status(401).json({ error: "Unauthorized." });
        return;
      }

      const payload = getRequestPayload(req);

      if (!payload) {
        res.status(400).json({
          error:
            "Request body must include either a non-empty text field or imageBase64 with mimeType.",
        });
        return;
      }

      const generate = (progress) =>
        payload.type === "image"
          ? generateImageFactCheck(payload, progress)
          : generateFactCheck(payload.text, progress);

      if (streamResponse) {
        startEventStream(res);
        sendStreamEvent(res, { status: "analyzing" });

        try {
          const result = await generate((status) => {
            sendStreamEvent(res, { status });
          });
          sendStreamEvent(res, { result, resultType: payload.type });
          res.end();
        } catch (error) {
          logger.warn("factCheck stream failed", {
            error: error.message,
            stack: error.stack,
          });
          sendStreamEvent(res, {
            error: publicErrorMessage(error),
            status: "error",
          });
          res.end();
        }
        return;
      }

      const result = await generate();
      res.status(200).json(result);
    } catch (error) {
      logger.warn("factCheck failed", {
        error: error.message,
        stack: error.stack,
      });

      if (error?.statusCode) {
        res.status(requestErrorStatus(error)).json({ error: error.message });
        return;
      }

      res.status(publicErrorStatus(error)).json({
        error: publicErrorMessage(error),
      });
    }
  },
);