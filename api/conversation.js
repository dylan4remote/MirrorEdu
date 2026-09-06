// DELETE /api/conversation
// Body: { conversationId: string }
// Header: Authorization: Bearer <supabase access token>
//
// Deletes a conversation the caller owns; messages go with it via the
// ON DELETE CASCADE foreign key in sql/schema.sql. Like chat.js, all writes
// go through the service role here - the client only ever reads directly.
const { getSupabaseAdmin } = require('../lib/supabaseAdmin');
const { verifyUser } = require('../lib/verifyUser');

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { user, error: authError } = await verifyUser(req);
  if (!user) {
    res.status(401).json({ error: authError });
    return;
  }

  const { conversationId } = req.body || {};
  if (!conversationId || typeof conversationId !== 'string') {
    res.status(400).json({ error: 'conversationId is required.' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();

  // Scoped to user_id even though the service role bypasses RLS - this is
  // what stops one user from deleting another user's conversation by id.
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .select('id');

  if (error) {
    res.status(500).json({ error: `Failed to delete conversation: ${error.message}` });
    return;
  }
  if (!data || data.length === 0) {
    res.status(404).json({ error: 'Conversation not found.' });
    return;
  }

  res.status(200).json({ success: true });
};
