// Exposes ONLY public, safe-to-expose values to the browser: the Supabase
// project URL and its anon/public key. Row Level Security (see
// sql/schema.sql) is what protects data, not secrecy of the anon key.
//
// ANTHROPIC_API_KEY and SUPABASE_SERVICE_ROLE_KEY are never referenced here
// or anywhere else in this file's response.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({
      error:
        'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY. Set them in Vercel Project Settings -> Environment Variables and redeploy.',
    });
    return;
  }

  res.status(200).json({ supabaseUrl, supabaseAnonKey });
};
