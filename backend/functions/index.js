"use strict";

const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-flash";

const USER_PROMPT_PREFIX =
  "Fact-check and analyze the following claim. Return verdict, analysis, and facts in the same primary language as the claim. If the claim mixes languages, use the language used most in the claim:";

const SYSTEM_INSTRUCTION = [
  "You are Veritas AI, a fact-checking and media-manipulation analysis backend for a Chrome extension.",
  "You must use Google Search grounding to find current facts, official data, rebuttals, and cross-checks.",
  "Return exactly one valid JSON object and no Markdown, no code fences, and no explanatory text outside JSON.",
  "Detect the primary language of the submitted claim and write verdict, analysis, and facts in that same language.",
  "If the claim is in English, answer in English. If it is in Russian, answer in Russian. If mixed, answer in the dominant language.",
  "The JSON object must match this shape:",
  '{"score": 0, "verdict": "short verdict in the input language", "analysis": "detailed logical-fallacy and manipulation analysis in the input language", "facts": "facts found through Google Search in the input language", "sources": ["https://verified-source.example"]}',
  "score must be an integer from 0 to 100, where 100 means fully supported and 0 means false or severe disinformation.",
  "sources must contain only real absolute HTTP/HTTPS URLs used to support the analysis.",
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
    // Google Search grounding cannot be combined with responseMimeType, so keep
    // a narrow fallback for occasional code fences or surrounding prose.
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

function normalizeFactCheckResult(rawText, groundingUrls) {
  const parsed = extractJsonObject(rawText);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini returned a non-object JSON response.");
  }

  const score = Number.parseInt(parsed.score, 10);
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const mergedSources = new Set(
    sources.filter(
      (source) => typeof source === "string" && source.startsWith("http"),
    ),
  );

  for (const url of groundingUrls) {
    mergedSources.add(url);
  }

  return {
    score: Number.isInteger(score) ? Math.min(100, Math.max(0, score)) : 0,
    verdict: typeof parsed.verdict === "string" ? parsed.verdict : "",
    analysis: typeof parsed.analysis === "string" ? parsed.analysis : "",
    facts: typeof parsed.facts === "string" ? parsed.facts : "",
    sources: Array.from(mergedSources),
  };
}

exports.factCheck = onRequest(
  {
    cors: true,
    secrets: [GEMINI_API_KEY],
  },
  async (req, res) => {
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

      const text =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";

      if (!text) {
        res
          .status(400)
          .json({ error: "Request body must include a non-empty text field." });
        return;
      }

      if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY secret is not configured.");
      }

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
      });

      const response = await ai.models.generateContent({
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
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });

      const rawText = response.text;

      if (!rawText) {
        throw new Error("Gemini returned an empty response.");
      }

      const groundingUrls = collectGroundingUrls(response);
      const result = normalizeFactCheckResult(rawText, groundingUrls);

      res.status(200).json(result);
    } catch (error) {
      logger.error("factCheck failed", {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({ error: "Internal server error." });
    }
  },
);
