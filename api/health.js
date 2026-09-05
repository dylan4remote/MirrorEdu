// GET /api/health
// Verifies the server is correctly configured without spending any
// generation tokens: client.models.retrieve() is a metadata-only call that
// confirms the API key is valid AND that ANTHROPIC_MODEL is a real model id,
// at zero cost. Returns specific, actionable errors instead of a bare 500.
const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const problems = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) problems.push('SUPABASE_URL is not set in Vercel.');
  if (!supabaseAnonKey) problems.push('SUPABASE_ANON_KEY is not set in Vercel.');
  if (!supabaseServiceRoleKey) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set in Vercel.');

  if (!apiKey) {
    problems.push('ANTHROPIC_API_KEY is not set in Vercel.');
  }
  if (!model) {
    problems.push('ANTHROPIC_MODEL is not set in Vercel.');
  }

  if (!apiKey || !model) {
    res.status(500).json({ ok: false, problems });
    return;
  }

  const client = new Anthropic({ apiKey });

  try {
    const retrieved = await client.models.retrieve(model);
    if (problems.length > 0) {
      // Anthropic side is fine, but something else (Supabase) is missing.
      res.status(500).json({ ok: false, problems });
      return;
    }
    res.status(200).json({
      ok: true,
      model: retrieved.id,
      displayName: retrieved.display_name,
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      problems.push(
        "Anthropic rejected this key: check ANTHROPIC_API_KEY is copied correctly from console.anthropic.com.",
      );
    } else if (error instanceof Anthropic.NotFoundError) {
      problems.push(
        `Anthropic does not recognize the model "${model}". Check ANTHROPIC_MODEL against a valid id from docs.claude.com/en/docs/about-claude/models.`,
      );
    } else if (error instanceof Anthropic.APIError) {
      problems.push(`Anthropic API error (status ${error.status}): ${error.message}`);
    } else {
      problems.push(`Unexpected error contacting Anthropic: ${error.message}`);
    }
    res.status(500).json({ ok: false, problems });
  }
};
