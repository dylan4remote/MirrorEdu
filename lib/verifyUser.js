const { getSupabaseAdmin } = require('./supabaseAdmin.js');

// Extracts the Supabase access token from the Authorization header and
// resolves it to a verified user. Never trust a user id sent in the request
// body - it could be forged by the client.
async function verifyUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return { user: null, error: 'Missing Authorization header.' };
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: 'Invalid or expired session. Please sign in again.' };
  }

  return { user: data.user, error: null };
}

module.exports = { verifyUser };
