import z from "zod";
import { pool } from "../db/connectDB.js";
import { activeRecommendations, ask, starterQuestions } from "../services/assistant/assistant.js";
import { llmEnabled } from "../services/assistant/llm.js";
import { BadRequestError, ValidationError } from "../utils/errorStr.js";
import { validationDetails } from "../utils/validation.js";

// The assistant and recommendations (services/assistant/):
//
//   POST /v1/assistant/ask            { question }   → an answer from the customer's own data
//   GET  /v1/assistant/suggestions                   → starter questions
//   GET  /v1/recommendations                         → "what to do next", best first
//   POST /v1/recommendations/:key/dismiss { days? }  → hide one for a while (default 7 days)
//
// Questions aren't stored or logged.

function parse(schema, body) {
  if (!body || Object.keys(body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const validation = schema.safeParse(body);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

const askSchema = z.strictObject({ question: z.string().trim().min(2, "Ask a question.").max(300, "Keep the question under 300 characters.") });

// POST /v1/assistant/ask
export async function askAssistant(req, res) {
  const { question } = parse(askSchema, req.body);
  return res.status(200).json(await ask(pool, req.user.sub, question));
}

// GET /v1/assistant/suggestions
export async function assistantSuggestions(req, res) {
  return res.status(200).json({ questions: await starterQuestions(pool, req.user.sub), open_model: llmEnabled() });
}

// GET /v1/recommendations?limit=
export async function listRecommendations(req, res) {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 20);
  const recs = await activeRecommendations(pool, req.user.sub);
  return res.status(200).json({ data: recs.slice(0, limit), total: recs.length });
}

const dismissSchema = z.strictObject({ days: z.number().int().min(1).max(90).optional() });

// POST /v1/recommendations/:key/dismiss
export async function dismissRecommendation(req, res) {
  const key = String(req.params.key ?? "");
  if (!key || key.length > 200) throw new ValidationError({ details: { key: ["Unknown recommendation."] } });
  const validation = dismissSchema.safeParse(req.body ?? {});
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const { days = 7 } = validation.data;
  await pool.query(
    `INSERT INTO recommendation_dismissals (user_id, rec_key, dismissed_until)
     VALUES ($1, $2, NOW() + make_interval(days => $3))
     ON CONFLICT (user_id, rec_key) DO UPDATE SET dismissed_until = EXCLUDED.dismissed_until`,
    [req.user.sub, key, days],
  );
  return res.status(200).json({ key, dismissed_for_days: days });
}
