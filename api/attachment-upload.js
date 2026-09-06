// POST /api/attachment-upload
// Header: Authorization: Bearer <supabase access token>
//
// Token-exchange endpoint for Vercel Blob client uploads. The browser
// uploads the file bytes directly to Blob storage (see js/chat.js), never
// through this function - that's what lets attachments exceed Vercel's
// 4.5MB request body limit. This route only authenticates the caller and
// hands back a short-lived upload token; api/chat.js fetches the resulting
// blob URL server-side when the chat request comes in.
const { handleUpload } = require('@vercel/blob/client');
const { verifyUser } = require('../lib/verifyUser');

const ALLOWED_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

// Anthropic's PDF/image request limit is 32MB total; leave headroom for the
// rest of the request (history, system prompt) that travels alongside it.
const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { user, error: authError } = await verifyUser(req);
  if (!user) {
    res.status(401).json({ error: authError });
    return;
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_ATTACHMENT_TYPES,
        addRandomSuffix: true,
        maximumSizeInBytes: MAX_ATTACHMENT_BYTES,
        tokenPayload: JSON.stringify({ userId: user.id }),
      }),
    });
    res.status(200).json(jsonResponse);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
